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
import {
    HTML_NAMESPACE,
    isCharacterData,
    isDocument,
    isElement,
    isFrame,
    isHtml,
    isInput,
    isScript,
    isSelect,
    isShadowRoot,
    isStyle,
    isTextArea
} from './dom.ts'
import { FOREIGN_ATTRIBUTES, INERT_SCRIPT_TYPE, sanitize } from './sanitize.ts'
import { changeRules, ConstructedSheets } from './sheets.ts'

/** Marks the elements the player adds to the replayed document. */
export const PLAYER_ATTRIBUTE = 'data-timecat-player'

/**
 * Content security policy of the replayed documents, behind the sandbox, which already stops scripts. Styles,
 * images, fonts and media stay allowed: the replay needs them. Frames show documents the player builds, never one
 * loaded from a URL.
 */
const POLICY = "script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'"

/** Stands in for elements whose recorded name this browser does not accept, so their children still show. */
const INVALID_TAG = 'timecat-invalid'

/** How often a scroll position that does not stick, for example before the content it needs has loaded, is tried. */
const SCROLL_TRIES = 60

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

/**
 * Builds and changes the replayed DOM in a document of its own, by the same rules the indexer's virtual document
 * follows, so a keyframe matches what applying the events before it produces. Recorded content is untrusted:
 * attributes go through `sanitize`, and the document is expected to be in a sandbox without scripts.
 */
export class Materializer {
    readonly #document: Document
    readonly #assets: Assets
    readonly #nodes = new Map<number, Node>()
    readonly #ids = new WeakMap<Node, number>()
    readonly #states = new Map<Document, DocumentState>()
    /** The documents built in frames. */
    readonly #frames = new WeakMap<Element, Document>()
    /** Frames with a document to build in them, once they are in the replayed document. */
    readonly #pending: [HTMLIFrameElement | HTMLFrameElement, DocumentNode][] = []
    readonly #sheets: ConstructedSheets
    /** Puts the replay's URLs for recorded ones into CSS. */
    readonly #rewrite: (text: string) => string
    readonly #scrolls = new Map<Node, PendingScroll>()
    /** Whether the document renders in quirks mode; undefined until it is first written. */
    #quirks: boolean | undefined

    /** `assets` holds what the recording keeps of `blob:` URLs and fonts. */
    constructor(document: Document, assets: Assets = new Assets([])) {
        this.#document = document
        this.#assets = assets
        this.#rewrite = text => assets.rewrite(text)
        this.#sheets = new ConstructedSheets(this.#rewrite)
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

    /** Replaces what the document shows with a snapshot. */
    build(snapshot: SnapshotEvent): void {
        const document = this.#document
        const root = snapshot.root
        if (this.#quirks !== root.quirks) {
            openDocument(document, root.quirks)
            this.#quirks = root.quirks
        }
        this.#reset()
        this.#build(document, root)
        this.#buildFrames()
    }

    /** Shows nothing, as before the first snapshot. */
    clear(): void {
        this.#reset()
    }

    /** Applies an event other than a snapshot; viewport and pointer events are left to the stage. */
    apply(event: TcrEvent): void {
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

    #reset(): void {
        this.#nodes.clear()
        this.#states.clear()
        this.#scrolls.clear()
        this.#pending.length = 0
        this.#sheets.clear()
        const document = this.#document
        document.replaceChildren()
        document.adoptedStyleSheets = []
    }

    /** Builds a recorded document into `document`, which renders in the recorded mode. */
    #build(document: Document, root: DocumentNode): void {
        // What writing the document made, which recorded nodes replace.
        document.replaceChildren()
        const base = document.createElement('base')
        base.setAttribute(PLAYER_ATTRIBUTE, '')
        const state: DocumentState = { document, base, bases: new Set(), url: root.url, basesChanged: false }
        this.#states.set(document, state)
        this.#register(document, root.id)
        // The viewport keeps the scroll position of what it showed before; a snapshot starts at the top, unless
        // scroll positions after it say otherwise. Elements are new, so they start there anyway.
        this.#scrolls.set(document, { x: 0, y: 0, tries: 0 })
        document.adoptedStyleSheets = []
        this.#assets.addFonts(document)
        // Set before any node exists, so every URL resolves against the recorded document's from the start.
        this.#setBaseUrl(state, firstBaseHref(root))
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
                element.append(base)
                this.#createChildren(element, child.children)
            }
        }
        // Base elements left out of the document, such as in a second root element, may have been found first.
        this.#updateBase(state)
        this.#placeBase(state)
    }

    /** Builds the documents of the frames attached since the last call, now that the frames are in the document. */
    #buildFrames(): void {
        const pending = this.#pending
        // The documents built here add their own frames.
        for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
            const [frame, root] = next
            this.#forgetFrame(frame)
            // None for a frame that did not make it into the document.
            const document = frame.contentDocument
            if (document !== null) {
                openDocument(document, root.quirks)
                this.#frames.set(frame, document)
                this.#build(document, root)
            }
        }
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

    /** Creates recorded children of `top` and their subtrees, and inserts them where the DOM takes them. */
    #createChildren(top: Node, children: SerializedNode[]): void {
        const document = documentOf(top)
        // Iterative, so any depth works.
        const stack: { parent: Node; children: SerializedNode[]; next: number }[] = [{ parent: top, children, next: 0 }]
        while (stack.length > 0) {
            const level = stack[stack.length - 1]!
            const child = level.children[level.next++]
            if (child === undefined) {
                stack.pop()
                continue
            }
            const parent = level.parent
            if (child.kind === NodeKind.Document || child.kind === NodeKind.ShadowRoot) {
                const root = isElement(parent) ? this.#attach(parent, child) : undefined
                if (root !== undefined) {
                    stack.push({ parent: root, children: child.children, next: 0 })
                }
                continue
            }
            const node = this.#single(child, document, parent)
            if (node !== undefined && this.#insert(parent, node, null) && child.kind === NodeKind.Element) {
                stack.push({ parent: node, children: child.children, next: 0 })
            }
        }
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
        if (host.shadowRoot !== null) {
            return undefined
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

    /** Creates one node, without its children; `parent` is where it goes. */
    #single(node: SerializedNode, document: Document, parent: Node): Node | undefined {
        let created: Node
        switch (node.kind) {
            case NodeKind.Element:
                return this.#element(node, document)
            case NodeKind.Text:
                created = document.createTextNode(this.#text(parent, node.data))
                break
            case NodeKind.Comment:
                created = document.createComment(node.data)
                break
            case NodeKind.Doctype:
                try {
                    created = document.implementation.createDocumentType(node.name, node.publicId, node.systemId)
                } catch {
                    // A name the parser accepts but the DOM does not; the doctype only matters to the mode.
                    return undefined
                }
                break
            default:
                return undefined
        }
        this.#register(created, node.id)
        return created
    }

    /** Creates an element with its attributes, without its children. */
    #element(node: ElementNode, document: Document): Element {
        const namespace = node.namespace
        let element: Element
        try {
            element =
                namespace === HTML_NAMESPACE
                    ? document.createElement(node.tag)
                    : document.createElementNS(namespace === '' ? null : namespace, node.tag)
        } catch {
            element = document.createElement(INVALID_TAG)
        }
        const attributes = node.attributes
        for (let i = 0; i < attributes.length; i += 2) {
            this.#setAttribute(element, attributes[i]!, attributes[i + 1]!)
        }
        if (isScript(element)) {
            element.setAttribute('type', INERT_SCRIPT_TYPE)
        } else if (isHtml(element, 'base')) {
            const state = this.#states.get(document)
            if (state !== undefined) {
                state.bases.add(element)
                state.basesChanged = true
            }
        }
        this.#register(element, node.id)
        return element
    }

    #setAttribute(element: Element, name: string, value: string | null): void {
        const safe = sanitize(element, name, value)
        if (safe === null) {
            element.removeAttribute(name)
            return
        }
        const namespace = element.namespaceURI === HTML_NAMESPACE ? undefined : FOREIGN_ATTRIBUTES.get(name)
        try {
            if (namespace === undefined) {
                element.setAttribute(name, this.#assets.rewrite(safe))
            } else {
                element.setAttributeNS(namespace, name, this.#assets.rewrite(safe))
            }
        } catch {
            // A name this browser's DOM does not accept, though a parser made it.
        }
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
        // None for a `<style>` that is not CSS, or out of the document.
        const sheet = node !== undefined && isElement(node) && isStyle(node) ? node.sheet : null
        if (sheet !== null) {
            changeRules(sheet, event.changes, this.#rewrite)
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
        state.base.setAttribute('href', url)
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
