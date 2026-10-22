import { EventType, InputKind, NodeKind, SheetOwner } from '@timecat-js/protocol'
import type {
    AddedRun,
    AdoptedStyleSheetsEvent,
    DocumentNode,
    ElementNode,
    InputChange,
    MutationsEvent,
    ScrollPosition,
    SerializedNode,
    ShadowRootNode,
    SnapshotEvent,
    StyleSheetEvent,
    TcrEvent
} from '@timecat-js/protocol'
import { Assets } from './assets.ts'
import { Canvases } from './canvases.ts'
import {
    HTML_NAMESPACE,
    isCanvas,
    isCharacterData,
    isComment,
    isDoctype,
    isDocument,
    isElement,
    isFrame,
    isHtml,
    isInput,
    isLink,
    isScript,
    isSelect,
    isShadowRoot,
    isStyle,
    isText,
    isTextArea
} from './dom.ts'
import type { LinkedSheets } from './linked-sheets.ts'
import type { PseudoClasses } from './pseudo-classes.ts'
import { FOREIGN_ATTRIBUTES, INERT_SCRIPT_TYPE, sanitize } from './sanitize.ts'
import { changeRules, ConstructedSheets } from './sheets.ts'
import { stateAttribute } from './states.ts'

/** Marks the elements the player adds to the replayed document. */
export const PLAYER_ATTRIBUTE = 'data-timecat-player'

/**
 * Content security policy of the replayed documents, behind the sandbox, which already stops scripts. Styles,
 * images, fonts and media stay allowed: the replay needs them. Frames show documents the player builds, never one
 * loaded from a URL.
 */
const POLICY = "script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'"

/**
 * Undoes the style sheet a browser puts first in each document of an extension, which sets the font of `body`
 * (Chrome's sets `font-family` and `font-size: 75%`), so that the page's own rules decide it, as when it was
 * recorded. `revert-layer` takes the font back to what the page's cascade layers, or the browser's defaults, give.
 */
const EXTENSION_FONT = 'body { font-family: revert-layer; font-size: revert-layer }'

/**
 * The ring browsers draw around an element the keyboard focused, which their own style sheets give `:focus-visible`,
 * for the attribute that stands for it in the replay. In a layer before the page's, so that the page's rules win, as
 * they do over the browser's.
 */
const FOCUS_RING =
    `@layer timecat-player { [${stateAttribute('focus-visible')}] ` +
    '{ outline: auto 1px; outline: auto 1px -webkit-focus-ring-color } }'

/** Attributes whose change can change what a canvas shows. */
const CANVAS_ATTRIBUTES = new Set(['style', 'width', 'height'])

/** Stands in for elements whose recorded name this browser does not accept, so their children still show. */
const INVALID_TAG = 'timecat-invalid'

/** How often a scroll position that does not stick, for example before the content it needs has loaded, is tried. */
const SCROLL_TRIES = 60

export interface MaterializerOptions {
    /** What the recording keeps of `blob:` URLs and fonts. */
    assets?: Assets
    /** The pictures of what is drawn in canvases. */
    canvases?: Canvases
    /** Rewrites the selectors of the states the replay shows; without, they select what they would anyway. */
    pseudoClasses?: PseudoClasses
    /** Rewrites the style sheets the replay links to; without, they stay as they are. */
    links?: LinkedSheets
}

interface PendingScroll {
    x: number
    y: number
    tries: number
}

/** A document the replay shows: its own, or the document of a frame in it. */
interface DocumentState {
    readonly document: Document
    /** The player's base element, first in the document: it resolves URLs against the recorded document's. */
    readonly base: HTMLBaseElement
    /** Recorded `<base>` elements, which decide what relative URLs resolve against. */
    readonly bases: Set<Element>
    /** The recorded document's URL. */
    url: string
    basesChanged: boolean
}

/** Recorded children being put into their parent, in order. */
interface Level {
    readonly parent: Node
    readonly children: readonly SerializedNode[]
    /** The player's base element of the document, which stays where it is. */
    readonly base: Node | undefined
    next: number
    /** The last child put in place; those after it are left from before, until they are put in place or go. */
    last: Node | null
    /** Where each recorded child is in `children` by id, once needed. */
    indexes: Map<number, number> | undefined
}

/**
 * Builds and changes the replayed DOM in a document of its own, by the same rules the indexer's virtual document
 * follows, so a keyframe matches what applying the events before it produces. Recorded content is untrusted:
 * attributes go through `sanitize`, and the document is expected to be in a sandbox without scripts.
 */
export class Materializer {
    readonly #document: Document
    readonly #assets: Assets
    readonly #canvases: Canvases
    readonly #links: LinkedSheets | undefined
    #nodes = new Map<number, Node>()
    #version = 0
    /**
     * While a snapshot is built, the nodes shown before it, which it takes back where it has the same ones: what
     * stays needs no new style, layout or paint, and images and frames do not load again.
     */
    #old: Map<number, Node> | undefined
    readonly #ids = new WeakMap<Node, number>()
    readonly #states = new Map<Document, DocumentState>()
    /** The player's base element of each document, which stays from one snapshot to the next. */
    readonly #bases = new WeakMap<Document, HTMLBaseElement>()
    /** The documents built in frames. */
    readonly #frames = new WeakMap<Element, Document>()
    /** Elements scrolled away from the top, and `<style>` elements whose sheet changed: a snapshot resets both. */
    readonly #scrolled = new WeakSet<Node>()
    readonly #changedSheets = new WeakSet<Element>()
    /** Frames with a document to build in them, once they are in the replayed document. */
    readonly #pending: [HTMLIFrameElement | HTMLFrameElement, DocumentNode][] = []
    readonly #sheets: ConstructedSheets
    /** Puts the replay's URLs for recorded ones into CSS. */
    readonly #rewrite: (text: string) => string
    readonly #scrolls = new Map<Node, PendingScroll>()
    /** Whether the document renders in quirks mode; undefined until it is first written. */
    #quirks: boolean | undefined
    /** Whether the browser styles the font of `body` beyond its defaults; undefined until the document is written. */
    #extensionFont: boolean | undefined

    constructor(document: Document, options: MaterializerOptions = {}) {
        const { assets = new Assets(), canvases = new Canvases(), pseudoClasses } = options
        this.#document = document
        this.#assets = assets
        this.#canvases = canvases
        this.#links = options.links
        this.#rewrite =
            pseudoClasses === undefined
                ? text => assets.rewrite(text)
                : text => pseudoClasses.rewrite(assets.rewrite(text))
        this.#sheets = new ConstructedSheets(this.#rewrite)
    }

    /** Changes with every change to what the document shows. */
    get version(): number {
        return this.#version
    }

    /** The node a recorded id stands for. */
    node(id: number): Node | undefined {
        return this.#nodes.get(id)
    }

    /** The recorded id of a node the replay shows. */
    id(node: Node): number | undefined {
        const id = this.#ids.get(node)
        return id !== undefined && this.#nodes.get(id) === node ? id : undefined
    }

    /**
     * Replaces what the document shows with a snapshot. Nodes it shows already with the same id stay where they
     * can, with their attributes and data changed to the snapshot's, which costs far less than new ones.
     */
    build(snapshot: SnapshotEvent): void {
        this.#version++
        const document = this.#document
        const root = snapshot.root
        const reuse = this.#quirks === root.quirks
        if (!reuse) {
            openDocument(document, root.quirks)
            this.#quirks = root.quirks
            // The empty document shows what the browser puts in every one.
            this.#extensionFont ??= stylesBodyFont(document)
        }
        this.#reset(reuse)
        try {
            this.#build(document, root, reuse)
            this.#buildFrames()
        } finally {
            this.#old = undefined
        }
    }

    /** Shows nothing, as before the first snapshot. */
    clear(): void {
        this.#version++
        this.#reset()
    }

    /** Applies an event other than a snapshot; viewport and pointer events are left to the stage. */
    apply(event: TcrEvent): void {
        this.#version++
        switch (event.type) {
            case EventType.Mutations:
                this.#mutate(event)
                break
            case EventType.Input:
                for (const change of event.changes) {
                    this.#input(change)
                }
                break
            case EventType.Scroll:
                for (const position of event.positions) {
                    this.#scroll(position)
                }
                break
            case EventType.Navigation: {
                const node = this.#nodes.get(event.id)
                const state = node !== undefined && isDocument(node) ? this.#states.get(node) : undefined
                if (state !== undefined) {
                    state.url = event.url
                    state.basesChanged = true
                    this.#updateBase(state)
                }
                break
            }
            case EventType.StyleSheet:
                this.#changeSheet(event)
                break
            case EventType.AdoptedStyleSheets:
                this.#adoptSheets(event)
                break
            default:
                break
        }
    }

    /**
     * Scrolls to the positions received since the last call, after layout. Returns whether some have not stuck
     * yet; those are tried again on the next call.
     */
    flushScrolls(): boolean {
        for (const [node, pending] of this.#scrolls) {
            if (scrollTo(node, pending.x, pending.y) || ++pending.tries >= SCROLL_TRIES) {
                this.#scrolls.delete(node)
            }
        }
        return this.#scrolls.size > 0
    }

    /** Forgets what the document shows, or with `keep`, keeps it for the snapshot built next to take back. */
    #reset(keep = false): void {
        if (keep) {
            this.#old = this.#nodes
            this.#nodes = new Map()
        } else {
            this.#nodes.clear()
            const document = this.#document
            document.replaceChildren()
            document.adoptedStyleSheets = []
        }
        this.#states.clear()
        this.#scrolls.clear()
        this.#pending.length = 0
        this.#sheets.clear()
    }

    /**
     * Builds a recorded document into `document`, which renders in the recorded mode. With `reuse`, `document`
     * shows what was built in it before, which the snapshot changes rather than replaces where it can.
     */
    #build(document: Document, root: DocumentNode, reuse: boolean): void {
        let base = reuse ? this.#bases.get(document) : undefined
        const rootElement = root.children.find(child => child.kind === NodeKind.Element)
        const kept =
            base !== undefined &&
            rootElement !== undefined &&
            document.documentElement !== null &&
            this.#reusable(rootElement, document) === document.documentElement
        if (!kept || base === undefined) {
            // What writing the document made, or showed before, which recorded nodes replace.
            document.replaceChildren()
            base = document.createElement('base')
            base.setAttribute(PLAYER_ATTRIBUTE, '')
            // In the base element, the one element of the player's that stays first in the document, before the
            // page's style sheets. A style element works wherever it is in the document.
            const style = document.createElement('style')
            style.setAttribute(PLAYER_ATTRIBUTE, '')
            style.textContent = this.#extensionFont === true ? `${FOCUS_RING}\n${EXTENSION_FONT}` : FOCUS_RING
            base.append(style)
            this.#bases.set(document, base)
        } else if (!base.isConnected) {
            document.documentElement?.prepend(base)
        }
        const state: DocumentState = { document, base, bases: new Set(), url: root.url, basesChanged: false }
        this.#states.set(document, state)
        this.#register(document, root.id)
        // The viewport keeps the scroll position of what it showed before; a snapshot starts at the top, unless
        // scroll positions after it say otherwise. So do elements, new or not.
        this.#scrolls.set(document, { x: 0, y: 0, tries: 0 })
        if (document.adoptedStyleSheets.length > 0) {
            document.adoptedStyleSheets = []
        }
        this.#assets.addFonts(document)
        // Set before any node is made, so every URL resolves against the recorded document's from the start.
        this.#setBaseUrl(state, firstBaseHref(root))
        if (kept) {
            // The root element stays, and the base element in it.
            this.#createChildren(document, root.children)
        } else {
            this.#buildFresh(document, root, base)
        }
        // Base elements left out of the document, such as in a second root element, may have been found first.
        this.#updateBase(state)
        this.#placeBase(state)
    }

    /** Builds the children of a recorded document into `document`, which has none. */
    #buildFresh(document: Document, root: DocumentNode, base: HTMLBaseElement): void {
        for (const child of root.children) {
            if (child.kind !== NodeKind.Element) {
                const node = this.#create(child, document, document)
                if (node !== undefined) {
                    this.#insert(document, node, null)
                }
                continue
            }
            // The root element goes in first, with the base element, and then its children.
            const element = this.#element(child, document)
            if (this.#insert(document, element, null)) {
                element.prepend(base)
                this.#createChildren(element, child.children)
            }
        }
    }

    /** Builds the documents of the frames attached since the last call, now that the frames are in the document. */
    #buildFrames(): void {
        const pending = this.#pending
        // The documents built here add their own frames.
        for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
            const [frame, root] = next
            // None for a frame that did not make it into the document.
            const document = frame.contentDocument
            if (document !== null && this.#keepsDocument(frame, document, root)) {
                this.#build(document, root, true)
                continue
            }
            this.#forgetFrame(frame)
            if (document !== null) {
                openDocument(document, root.quirks)
                this.#frames.set(frame, document)
                this.#build(document, root, false)
            }
        }
    }

    /**
     * Whether a frame, built before the snapshot being built and still in the document, shows the document built
     * in it then, in the mode the recorded one renders in. A frame put elsewhere loads a new document.
     */
    #keepsDocument(frame: Element, document: Document, root: DocumentNode): boolean {
        const id = this.#ids.get(document)
        return (
            this.#frames.get(frame) === document &&
            id !== undefined &&
            this.#old?.get(id) === document &&
            (document.compatMode === 'BackCompat') === root.quirks
        )
    }

    #register(node: Node, id: number): void {
        this.#nodes.set(id, node)
        this.#ids.set(node, id)
    }

    /** Inserts a node made by `#create`, or forgets it when the DOM refuses it there. */
    #insert(parent: Node, node: Node, before: Node | null): boolean {
        try {
            parent.insertBefore(node, before)
            return true
        } catch {
            // For example a second root element: the virtual document refuses it the same way.
            this.#forget(node)
            return false
        }
    }

    /** Creates a recorded subtree in `document`, to insert into `parent`. Undefined when its root cannot be created. */
    #create(root: SerializedNode, document: Document, parent: Node): Node | undefined {
        const node = this.#single(root, document, parent)
        if (node !== undefined && root.kind === NodeKind.Element) {
            this.#createChildren(node, root.children)
        }
        return node
    }

    /**
     * Creates recorded children of `top` and their subtrees, and inserts them where the DOM takes them. While a
     * snapshot is built, `top` and the nodes taken back may have children from before, which go unless taken back.
     */
    #createChildren(top: Node, children: SerializedNode[]): void {
        const document = documentOf(top)
        const base = this.#states.get(document)?.base
        // Iterative, so any depth works.
        const stack: Level[] = [level(top, children, base)]
        while (stack.length > 0) {
            const current = stack[stack.length - 1]!
            const child = current.children[current.next++]
            if (child === undefined) {
                stack.pop()
                this.#discardRest(current)
                continue
            }
            const parent = current.parent
            if (child.kind === NodeKind.Document || child.kind === NodeKind.ShadowRoot) {
                const root = isElement(parent) ? this.#attach(parent, child) : undefined
                if (root !== undefined) {
                    stack.push(level(root, child.children, base))
                }
                continue
            }
            const node = this.#single(child, document, parent, current)
            if (node !== undefined && this.#place(current, node) && child.kind === NodeKind.Element) {
                stack.push(level(node, child.children, base))
            }
        }
    }

    /**
     * Puts a node after the last one its level put in place. While a snapshot is built, the children from before
     * on the way go, unless the level takes them back later; the player's base element stays.
     */
    #place(current: Level, node: Node): boolean {
        let before: Node | null = null
        if (this.#old !== undefined) {
            before = afterLast(current)
            while (before !== null && before !== node) {
                const next = before.nextSibling
                if (before !== current.base) {
                    if (this.#comesLater(current, before)) {
                        break
                    }
                    this.#discard(before, current.base)
                }
                before = next
            }
        }
        if (before === node || this.#insert(current.parent, node, before)) {
            current.last = node
            return true
        }
        return false
    }

    /** Whether a child from before is taken back later in its level, so it can stay where it is meanwhile. */
    #comesLater(current: Level, node: Node): boolean {
        const id = this.#ids.get(node)
        if (id === undefined || this.#old?.get(id) !== node) {
            return false
        }
        const children = current.children
        current.indexes ??= new Map(children.map((child, i): [number, number] => [child.id, i]))
        const index = current.indexes.get(id)
        return (
            index !== undefined && index >= current.next && this.#reusable(children[index]!, documentOf(node)) === node
        )
    }

    /**
     * Takes back the next child from before in a level for a recorded child of the same kind, when the level
     * takes it back nowhere else: text that a page replaced, rather than changed, only changes.
     */
    #takeNext<T extends CharacterData>(current: Level, is: (node: Node) => node is T, id: number): T | undefined {
        const old = this.#old
        let next = old === undefined ? null : afterLast(current)
        if (next !== null && next === current.base) {
            next = next.nextSibling
        }
        const oldId = next === null ? undefined : this.#ids.get(next)
        if (next === null || oldId === undefined || old?.get(oldId) !== next || !is(next)) {
            return undefined
        }
        if (this.#comesLater(current, next)) {
            return undefined
        }
        old.delete(oldId)
        this.#register(next, id)
        return next
    }

    /** Removes the children from before that a level did not take back. */
    #discardRest(current: Level): void {
        if (this.#old === undefined) {
            return
        }
        let node = afterLast(current)
        while (node !== null) {
            const next = node.nextSibling
            if (node !== current.base) {
                this.#discard(node, current.base)
            }
            node = next
        }
    }

    /**
     * Removes a node from before that the snapshot has not taken back, or not yet: what is in it can still be taken
     * back elsewhere. The player's base element moves out of it first, so URLs keep resolving meanwhile.
     */
    #discard(node: Node, base: Node | undefined): void {
        if (base !== undefined && isElement(node) && node.contains(base)) {
            documentOf(node).documentElement?.prepend(base)
        }
        node.parentNode?.removeChild(node)
    }

    /**
     * Attaches a recorded shadow root to `host` and returns it, to fill. A frame's document is built later, once
     * the frame is in the document. What the host cannot take, as `attachShadow` decides, is left out.
     */
    #attach(host: Element, node: DocumentNode | ShadowRootNode): ShadowRoot | undefined {
        if (node.kind === NodeKind.Document) {
            if (isFrame(host)) {
                this.#pending.push([host, node])
            }
            return undefined
        }
        const shadow = host.shadowRoot
        if (shadow !== null) {
            // A host taken back keeps its shadow root only for the same recorded one.
            if (this.#old?.get(node.id) !== shadow) {
                return undefined
            }
            this.#old.delete(node.id)
            this.#nodes.set(node.id, shadow)
            if (shadow.adoptedStyleSheets.length > 0) {
                shadow.adoptedStyleSheets = []
            }
            return shadow
        }
        let root: ShadowRoot
        try {
            // Open, whatever the recorded mode: no script reads it.
            root = host.attachShadow({ mode: 'open' })
        } catch {
            return undefined
        }
        this.#register(root, node.id)
        return root
    }

    /**
     * Creates one node, without its children, or takes back the one from before; `parent` is where it goes, and
     * `current` the level that puts it there, if any.
     */
    #single(node: SerializedNode, document: Document, parent: Node, current?: Level): Node | undefined {
        let created: Node
        switch (node.kind) {
            case NodeKind.Element:
                return this.#element(node, document)
            case NodeKind.Text: {
                const data = this.#text(parent, node.data)
                const old =
                    this.#take(node, document, isText) ??
                    (current === undefined ? undefined : this.#takeNext(current, isText, node.id))
                if (old !== undefined) {
                    return withData(old, data)
                }
                created = document.createTextNode(data)
                break
            }
            case NodeKind.Comment: {
                const old =
                    this.#take(node, document, isComment) ??
                    (current === undefined ? undefined : this.#takeNext(current, isComment, node.id))
                if (old !== undefined) {
                    return withData(old, node.data)
                }
                created = document.createComment(node.data)
                break
            }
            case NodeKind.Doctype: {
                const old = this.#take(node, document, isDoctype)
                if (old !== undefined) {
                    return old
                }
                try {
                    created = document.implementation.createDocumentType(node.name, node.publicId, node.systemId)
                } catch {
                    // A name the parser accepts but the DOM does not; the doctype only matters to the mode.
                    return undefined
                }
                break
            }
            default:
                return undefined
        }
        this.#register(created, node.id)
        return created
    }

    /** Creates an element with its attributes, without its children, or gives the one from before its attributes. */
    #element(node: ElementNode, document: Document): Element {
        const old = this.#take(node, document, isElement)
        const element = old ?? createElement(document, node)
        const attributes = node.attributes
        let set = 0
        // A link's other attributes say whether the replay takes another style sheet for the one it links to.
        let href = -1
        for (let i = 0; i < attributes.length; i += 2) {
            if (attributes[i] === 'href' && isLink(element)) {
                href = i
            } else if (this.#setAttribute(element, attributes[i]!, attributes[i + 1]!)) {
                set++
            }
        }
        if (href !== -1 && this.#setAttribute(element, 'href', attributes[href + 1]!)) {
            set++
        }
        if (old !== undefined) {
            if (old.attributes.length > set) {
                removeOtherAttributes(old, attributes)
            }
            // At the top, as a new element would be.
            if (this.#scrolled.delete(old)) {
                this.#scrolls.set(old, { x: 0, y: 0, tries: 0 })
            }
        }
        if (isScript(element)) {
            element.setAttribute('type', INERT_SCRIPT_TYPE)
        } else if (isCanvas(element)) {
            this.#canvases.show(element)
        } else if (isHtml(element, 'base')) {
            const state = this.#states.get(document)
            if (state !== undefined) {
                state.bases.add(element)
                state.basesChanged = true
            }
        }
        if (old === undefined) {
            this.#register(element, node.id)
        }
        return element
    }

    /** Sets an attribute as recorded, unless it has that value already. Returns whether the element has it. */
    #setAttribute(element: Element, name: string, value: string | null): boolean {
        const safe = sanitize(element, name, value)
        if (safe === null) {
            element.removeAttribute(name)
            return false
        }
        let rewritten = this.#assets.rewrite(safe)
        if (name === 'href' && this.#links !== undefined && isLink(element)) {
            rewritten = this.#links.href(element, rewritten)
        }
        if (element.getAttribute(name) === rewritten) {
            return true
        }
        const namespace = element.namespaceURI === HTML_NAMESPACE ? undefined : FOREIGN_ATTRIBUTES.get(name)
        try {
            if (namespace === undefined) {
                element.setAttribute(name, rewritten)
            } else {
                element.setAttributeNS(namespace, name, rewritten)
            }
            return true
        } catch {
            // A name this browser's DOM does not accept, though a parser made it.
            return false
        }
    }

    /** Takes back the node a recorded one had before the snapshot being built, if it can show it again. */
    #take<T extends Node>(node: SerializedNode, document: Document, is: (node: Node) => node is T): T | undefined {
        const old = this.#reusable(node, document)
        if (old === undefined || !is(old)) {
            return undefined
        }
        this.#old?.delete(node.id)
        // Under the same id, which it keeps.
        this.#nodes.set(node.id, old)
        return old
    }

    /**
     * The node a recorded one had before the snapshot being built, if it can show it again once given its
     * attributes or data: a node of the same kind and name, in the same document, that holds nothing more.
     */
    #reusable(node: SerializedNode, document: Document): Node | undefined {
        const old = this.#old?.get(node.id)
        if (old === undefined || old.ownerDocument !== document) {
            return undefined
        }
        switch (node.kind) {
            case NodeKind.Element:
                return isElement(old) &&
                    old.localName === node.tag &&
                    (old.namespaceURI ?? '') === node.namespace &&
                    this.#holdsOnlyMarkup(old, node)
                    ? old
                    : undefined
            case NodeKind.Text:
                return isText(old) ? old : undefined
            case NodeKind.Comment:
                return isComment(old) ? old : undefined
            case NodeKind.Doctype:
                return isDoctype(old) &&
                    old.name === node.name &&
                    old.publicId === node.publicId &&
                    old.systemId === node.systemId
                    ? old
                    : undefined
            default:
                // Shadow roots stay with their host, and documents with their frame.
                return undefined
        }
    }

    /**
     * Whether an element from before holds no more than its recorded markup gives it, so it can stand for `node`:
     * no value or selection of a form control, no rules changed in its sheet, no shadow root or frame document
     * the recorded one does not have. Scripts are made anew too, never to run.
     */
    #holdsOnlyMarkup(element: Element, node: ElementNode): boolean {
        if (
            isInput(element) ||
            isTextArea(element) ||
            isSelect(element) ||
            isHtml(element, 'option') ||
            isScript(element) ||
            this.#changedSheets.has(element)
        ) {
            return false
        }
        const shadow = element.shadowRoot
        if (shadow !== null) {
            const old = this.#old
            return node.children.some(child => child.kind === NodeKind.ShadowRoot && old?.get(child.id) === shadow)
        }
        return !this.#frames.has(element) || node.children.some(child => child.kind === NodeKind.Document)
    }

    /** The text of a node in `parent`: the text of style sheets can point at recorded URLs. */
    #text(parent: Node | null, data: string): string {
        return parent !== null && isElement(parent) && isStyle(parent) ? this.#rewrite(data) : data
    }

    #mutate(event: MutationsEvent): void {
        const nodes = this.#nodes
        for (const id of event.removes) {
            this.#remove(id)
        }
        for (const run of event.adds) {
            this.#add(run)
        }
        for (const { id, name, value } of event.attributes) {
            const node = nodes.get(id)
            if (node !== undefined && isElement(node)) {
                this.#setAttribute(node, name, value)
                if (CANVAS_ATTRIBUTES.has(name) && isCanvas(node)) {
                    this.#canvases.show(node)
                }
                const state = name === 'href' ? this.#states.get(node.ownerDocument) : undefined
                if (state !== undefined && state.bases.has(node)) {
                    state.basesChanged = true
                }
            }
        }
        for (const { id, data } of event.texts) {
            const node = nodes.get(id)
            if (node !== undefined && isCharacterData(node)) {
                node.data = this.#text(node.parentNode, data)
            }
        }
        for (const state of this.#states.values()) {
            this.#updateBase(state)
            this.#placeBase(state)
        }
    }

    #remove(id: number): void {
        const node = this.#nodes.get(id)
        if (node === undefined) {
            return
        }
        const parent = node.parentNode
        if (parent !== null) {
            parent.removeChild(node)
            this.#forget(node)
        } else if (isDocument(node) && node !== this.#document) {
            // The document of a frame, which then shows the blank page of a frame that never had one. The replay's
            // own document stays, and shadow roots, the other nodes without a parent, cannot be removed.
            this.#forget(node)
            node.open()
            node.close()
            node.adoptedStyleSheets = []
        }
    }

    #add(run: AddedRun): void {
        const parent = this.#nodes.get(run.parentId)
        if (parent === undefined || !(isElement(parent) || isDocument(parent) || isShadowRoot(parent))) {
            return
        }
        const document = documentOf(parent)
        // A sibling that is unknown, or no longer a child of the parent, appends instead.
        const sibling = run.beforeId === 0 ? undefined : this.#nodes.get(run.beforeId)
        const before = sibling !== undefined && sibling.parentNode === parent ? sibling : null
        for (const child of run.nodes) {
            if (child.kind === NodeKind.Document || child.kind === NodeKind.ShadowRoot) {
                const root = isElement(parent) ? this.#attach(parent, child) : undefined
                if (root !== undefined) {
                    this.#createChildren(root, child.children)
                }
                continue
            }
            const node = this.#create(child, document, parent)
            if (node !== undefined) {
                this.#insert(parent, node, before)
            }
        }
        this.#buildFrames()
    }

    /** Unregisters a removed subtree, with the shadow trees and the documents of frames in it. */
    #forget(root: Node): void {
        const roots = [root]
        for (let top = roots.pop(); top !== undefined; top = roots.pop()) {
            let node: Node | null = top
            while (node !== null) {
                const id = this.#ids.get(node)
                if (id !== undefined && this.#nodes.get(id) === node) {
                    this.#nodes.delete(id)
                }
                this.#scrolls.delete(node)
                if (isElement(node)) {
                    const shadow = node.shadowRoot
                    if (shadow !== null) {
                        roots.push(shadow)
                    }
                    const document = this.#frames.get(node)
                    if (document !== undefined) {
                        this.#frames.delete(node)
                        roots.push(document)
                    }
                    const state = isHtml(node, 'base') ? this.#states.get(node.ownerDocument) : undefined
                    if (state !== undefined && state.bases.delete(node)) {
                        state.basesChanged = true
                    }
                } else if (isDocument(node)) {
                    this.#states.delete(node)
                    this.#sheets.forget(node)
                }
                node = nextInSubtree(node, top)
            }
        }
    }

    /** Forgets the document built in a frame, if any. */
    #forgetFrame(frame: Element): void {
        const document = this.#frames.get(frame)
        if (document !== undefined) {
            this.#frames.delete(frame)
            this.#forget(document)
        }
    }

    #changeSheet(event: StyleSheetEvent): void {
        if (event.owner === SheetOwner.Constructed) {
            this.#sheets.change(event.id, event.changes)
            return
        }
        const node = this.#nodes.get(event.id)
        if (node === undefined || !isElement(node) || !isStyle(node)) {
            return
        }
        // None for a `<style>` that is not CSS, or out of the document.
        const sheet = node.sheet
        if (sheet !== null) {
            changeRules(sheet, event.changes, this.#rewrite)
            this.#changedSheets.add(node)
        }
    }

    #adoptSheets(event: AdoptedStyleSheetsEvent): void {
        const root = this.#nodes.get(event.id)
        if (root === undefined || !(isDocument(root) || isShadowRoot(root))) {
            return
        }
        root.adoptedStyleSheets = this.#sheets.sheetsFor(documentOf(root), event.sheets)
    }

    #input(change: InputChange): void {
        const node = this.#nodes.get(change.id)
        if (node === undefined || !isElement(node)) {
            return
        }
        switch (change.kind) {
            case InputKind.Value:
                if (isInput(node) || isTextArea(node)) {
                    try {
                        node.value = change.value
                    } catch {
                        // File inputs take no value but the empty one.
                    }
                }
                break
            case InputKind.Checked:
                if (isInput(node)) {
                    node.checked = change.checked
                }
                break
            case InputKind.Selection:
                if (isSelect(node)) {
                    select(node, change.selected)
                }
                break
        }
    }

    #scroll(position: ScrollPosition): void {
        const node = this.#nodes.get(position.id)
        if (node !== undefined) {
            // Deleted first, so positions keep the order they came in.
            this.#scrolls.delete(node)
            this.#scrolls.set(node, { x: position.x, y: position.y, tries: 0 })
            if (position.x !== 0 || position.y !== 0) {
                this.#scrolled.add(node)
            }
        }
    }

    /** Points the base element at the recorded document's base URL, after base elements or the URL changed. */
    #updateBase(state: DocumentState): void {
        if (!state.basesChanged) {
            return
        }
        state.basesChanged = false
        // The first base element with a URL in tree order is the one that counts; those of shadow trees do not.
        let first: Element | undefined
        for (const base of state.bases) {
            if (
                base.hasAttribute('href') &&
                base.getRootNode() === state.document &&
                (first === undefined || (first.compareDocumentPosition(base) & DOCUMENT_POSITION_PRECEDING) !== 0)
            ) {
                first = base
            }
        }
        this.#setBaseUrl(state, first?.getAttribute('href') ?? undefined)
    }

    #setBaseUrl(state: DocumentState, href: string | undefined): void {
        const url = href === undefined ? state.url : (URL.parse(href, state.url)?.href ?? state.url)
        if (state.base.getAttribute('href') !== url) {
            state.base.setAttribute('href', url)
        }
    }

    /** Keeps the base element first in the head, or in the root element when there is no head. */
    #placeBase(state: DocumentState): void {
        const document = state.document
        const parent = document.head ?? document.documentElement
        if (parent !== null && parent.firstChild !== state.base) {
            parent.prepend(state.base)
        }
    }
}

const DOCUMENT_POSITION_PRECEDING = 2

/** Whether the browser sets the font of `body` in `document`, which by default has that of the root element. */
function stylesBodyFont(document: Document): boolean {
    const window = document.defaultView
    const body = document.body
    if (window === null || body === null || document.documentElement === null) {
        return false
    }
    const root = window.getComputedStyle(document.documentElement)
    const style = window.getComputedStyle(body)
    return style.fontSize !== root.fontSize || style.fontFamily !== root.fontFamily
}

/** Writes an empty document in the right mode, with the policy that stays for everything built in it. */
function openDocument(document: Document, quirks: boolean): void {
    document.open()
    // The parser decides the mode by the doctype, which also stays out of the replay: builds replace it.
    document.write(
        `${quirks ? '' : '<!DOCTYPE html>'}<meta http-equiv="Content-Security-Policy" content="${POLICY}">` +
            '<meta name="referrer" content="no-referrer">'
    )
    document.close()
}

function level(parent: Node, children: readonly SerializedNode[], base: Node | undefined): Level {
    return { parent, children, base, next: 0, last: null, indexes: undefined }
}

/** The first child of a level's parent after those it put in place. */
function afterLast(current: Level): Node | null {
    return current.last === null ? current.parent.firstChild : current.last.nextSibling
}

function createElement(document: Document, node: ElementNode): Element {
    const namespace = node.namespace
    try {
        return namespace === HTML_NAMESPACE
            ? document.createElement(node.tag)
            : document.createElementNS(namespace === '' ? null : namespace, node.tag)
    } catch {
        return document.createElement(INVALID_TAG)
    }
}

/** Removes the attributes of an element that are not among recorded ones. */
function removeOtherAttributes(element: Element, attributes: readonly string[]): void {
    const names = new Set<string>()
    for (let i = 0; i < attributes.length; i += 2) {
        names.add(attributes[i]!)
    }
    // From the end, as removing shifts those after.
    const own = element.attributes
    for (let i = own.length - 1; i >= 0; i--) {
        const name = own[i]!.name
        if (!names.has(name)) {
            element.removeAttribute(name)
        }
    }
}

function withData(node: CharacterData, data: string): CharacterData {
    if (node.data !== data) {
        node.data = data
    }
    return node
}

/** The document a node belongs to: the node itself for a document. */
function documentOf(node: Node): Document {
    return isDocument(node) ? node : node.ownerDocument!
}

/** The `href` of the first base element of a recorded document, in tree order. */
function firstBaseHref(root: DocumentNode): string | undefined {
    const stack = root.children.toReversed()
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        // Shadow trees and the documents of frames have base URLs of their own.
        if (node.kind !== NodeKind.Element) {
            continue
        }
        if (node.tag === 'base' && node.namespace === HTML_NAMESPACE) {
            const attributes = node.attributes
            for (let i = 0; i < attributes.length; i += 2) {
                if (attributes[i] === 'href') {
                    return attributes[i + 1]
                }
            }
        }
        // Reversed, so the stack visits children in order.
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push(node.children[i]!)
        }
    }
    return undefined
}

/** The node after `node` in tree order, within the subtree of `root`. */
function nextInSubtree(node: Node, root: Node): Node | null {
    if (node.firstChild !== null) {
        return node.firstChild
    }
    let current: Node | null = node
    while (current !== null && current !== root) {
        if (current.nextSibling !== null) {
            return current.nextSibling
        }
        current = current.parentNode
    }
    return null
}

function select(element: HTMLSelectElement, selected: readonly number[]): void {
    if (!element.multiple) {
        element.selectedIndex = selected[0] ?? -1
        return
    }
    const indexes = new Set(selected)
    const options = element.options
    for (let i = 0; i < options.length; i++) {
        options[i]!.selected = indexes.has(i)
    }
}

/** Scrolls an element, or the viewport for a document; returns whether it got there. */
function scrollTo(node: Node, x: number, y: number): boolean {
    // Instant, whatever `scroll-behavior` the page's styles ask for.
    const options: ScrollToOptions = { left: x, top: y, behavior: 'instant' }
    if (isDocument(node)) {
        const view = node.defaultView
        if (view === null) {
            return true
        }
        view.scrollTo(options)
        return Math.abs(view.scrollX - x) <= 1 && Math.abs(view.scrollY - y) <= 1
    }
    if (!isElement(node)) {
        return true
    }
    node.scrollTo(options)
    return Math.abs(node.scrollLeft - x) <= 1 && Math.abs(node.scrollTop - y) <= 1
}
