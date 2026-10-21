import { EventType, InputKind, NodeKind } from '@timecat-js/protocol'
import type {
    DocumentNode,
    ElementNode,
    InputChange,
    MutationsEvent,
    ScrollPosition,
    SerializedNode,
    SnapshotEvent,
    TcrEvent
} from '@timecat-js/protocol'
import {
    HTML_NAMESPACE,
    isCharacterData,
    isDocument,
    isElement,
    isHtml,
    isInput,
    isScript,
    isSelect,
    isTextArea
} from './dom.ts'
import { FOREIGN_ATTRIBUTES, INERT_SCRIPT_TYPE, sanitize } from './sanitize.ts'

/** Marks the elements the player adds to the replayed document. */
export const PLAYER_ATTRIBUTE = 'data-timecat-player'

/**
 * Content security policy of the replayed document, behind the sandbox, which already stops scripts. Styles,
 * images, fonts and media stay allowed: the replay needs them.
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

/**
 * Builds and changes the replayed DOM in a document of its own, by the same rules the indexer's virtual document
 * follows, so a keyframe matches what applying the events before it produces. Recorded content is untrusted:
 * attributes go through `sanitize`, and the document is expected to be in a sandbox without scripts.
 */
export class Materializer {
    readonly #document: Document
    readonly #nodes = new Map<number, Node>()
    readonly #ids = new WeakMap<Node, number>()
    /** Recorded `<base>` elements, which decide what relative URLs resolve against. */
    readonly #bases = new Set<Element>()
    readonly #scrolls = new Map<Node, PendingScroll>()
    /** The player's base element, first in the document: it resolves URLs against the recorded page's. */
    readonly #base: HTMLBaseElement
    #url = ''
    /** Whether the document renders in quirks mode; undefined until it is first written. */
    #quirks: boolean | undefined
    #basesChanged = false

    constructor(document: Document) {
        this.#document = document
        this.#base = document.createElement('base')
        this.#base.setAttribute(PLAYER_ATTRIBUTE, '')
    }

    /** The node a recorded id stands for. */
    node(id: number): Node | undefined {
        return this.#nodes.get(id)
    }

    /** Replaces what the document shows with a snapshot. */
    build(snapshot: SnapshotEvent): void {
        const document = this.#document
        if (this.#quirks !== snapshot.quirks) {
            this.#open(snapshot.quirks)
        }
        this.#reset()
        this.#url = snapshot.url
        const root = snapshot.root
        this.#register(document, root.id)
        // Set before any node exists, so every URL resolves against the recorded page's from the start.
        this.#setBaseUrl(firstBaseHref(root))
        for (const child of root.children) {
            if (child.kind !== NodeKind.Element) {
                const node = this.#create(child)
                if (node !== undefined) {
                    this.#insert(document, node, null)
                }
                continue
            }
            // The root element goes in first, with the base element, and then its children.
            const element = this.#element(child)
            if (!this.#insert(document, element, null)) {
                continue
            }
            element.append(this.#base)
            for (const grandchild of child.children) {
                const node = this.#create(grandchild)
                if (node !== undefined) {
                    this.#insert(element, node, null)
                }
            }
        }
        // Base elements left out of the document, such as in a second root element, may have been found first.
        this.#updateBase()
        this.#placeBase()
    }

    /** Shows nothing, as before the first snapshot. */
    clear(): void {
        this.#reset()
        this.#url = ''
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
            case EventType.Navigation:
                this.#url = event.url
                this.#basesChanged = true
                this.#updateBase()
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

    /** Writes an empty document in the right mode, with the policy that stays for everything built in it. */
    #open(quirks: boolean): void {
        const document = this.#document
        document.open()
        // The parser decides the mode by the doctype, which also stays out of the replay: builds replace it.
        document.write(
            `${quirks ? '' : '<!DOCTYPE html>'}<meta http-equiv="Content-Security-Policy" content="${POLICY}">` +
                '<meta name="referrer" content="no-referrer">'
        )
        document.close()
        this.#quirks = quirks
    }

    #reset(): void {
        this.#nodes.clear()
        this.#bases.clear()
        this.#scrolls.clear()
        this.#document.replaceChildren()
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

    /** Creates a recorded subtree. Undefined when its root cannot be created. */
    #create(root: SerializedNode): Node | undefined {
        const top = this.#single(root)
        if (top === undefined || root.kind !== NodeKind.Element) {
            return top
        }
        // Iterative, so any depth works.
        const stack: { parent: Node; children: SerializedNode[]; next: number }[] = [
            { parent: top, children: root.children, next: 0 }
        ]
        while (stack.length > 0) {
            const frame = stack[stack.length - 1]!
            const child = frame.children[frame.next++]
            if (child === undefined) {
                stack.pop()
                continue
            }
            const node = this.#single(child)
            if (node !== undefined && this.#insert(frame.parent, node, null) && child.kind === NodeKind.Element) {
                stack.push({ parent: node, children: child.children, next: 0 })
            }
        }
        return top
    }

    /** Creates one node, without its children. */
    #single(node: SerializedNode): Node | undefined {
        const document = this.#document
        let created: Node
        switch (node.kind) {
            case NodeKind.Element:
                return this.#element(node)
            case NodeKind.Text:
                created = document.createTextNode(node.data)
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
    #element(node: ElementNode): Element {
        const document = this.#document
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
            this.#bases.add(element)
            this.#basesChanged = true
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
                element.setAttribute(name, safe)
            } else {
                element.setAttributeNS(namespace, name, safe)
            }
        } catch {
            // A name this browser's DOM does not accept, though a parser made it.
        }
    }

    #mutate(event: MutationsEvent): void {
        const nodes = this.#nodes
        for (const id of event.removes) {
            const node = nodes.get(id)
            const parent = node?.parentNode
            // The document has no parent and stays.
            if (node !== undefined && parent !== null && parent !== undefined) {
                parent.removeChild(node)
                this.#forget(node)
            }
        }
        for (const run of event.adds) {
            const parent = nodes.get(run.parentId)
            if (parent === undefined || !(isElement(parent) || isDocument(parent))) {
                continue
            }
            // A sibling that is unknown, or no longer a child of the parent, appends instead.
            const sibling = run.beforeId === 0 ? undefined : nodes.get(run.beforeId)
            const before = sibling !== undefined && sibling.parentNode === parent ? sibling : null
            for (const child of run.nodes) {
                const node = this.#create(child)
                if (node !== undefined) {
                    this.#insert(parent, node, before)
                }
            }
        }
        for (const { id, name, value } of event.attributes) {
            const node = nodes.get(id)
            if (node !== undefined && isElement(node)) {
                this.#setAttribute(node, name, value)
                if (name === 'href' && this.#bases.has(node)) {
                    this.#basesChanged = true
                }
            }
        }
        for (const { id, data } of event.texts) {
            const node = nodes.get(id)
            if (node !== undefined && isCharacterData(node)) {
                node.data = data
            }
        }
        this.#updateBase()
        this.#placeBase()
    }

    /** Unregisters a removed subtree. */
    #forget(root: Node): void {
        let node: Node | null = root
        while (node !== null) {
            const id = this.#ids.get(node)
            if (id !== undefined && this.#nodes.get(id) === node) {
                this.#nodes.delete(id)
            }
            this.#scrolls.delete(node)
            if (isElement(node) && this.#bases.delete(node)) {
                this.#basesChanged = true
            }
            node = nextInSubtree(node, root)
        }
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

    /** Points the base element at the recorded page's base URL, after base elements or the URL changed. */
    #updateBase(): void {
        if (!this.#basesChanged) {
            return
        }
        this.#basesChanged = false
        // The first base element with a URL in tree order is the one that counts.
        let first: Element | undefined
        for (const base of this.#bases) {
            if (
                base.hasAttribute('href') &&
                (first === undefined || (first.compareDocumentPosition(base) & DOCUMENT_POSITION_PRECEDING) !== 0)
            ) {
                first = base
            }
        }
        this.#setBaseUrl(first?.getAttribute('href') ?? undefined)
    }

    #setBaseUrl(href: string | undefined): void {
        const url = href === undefined ? this.#url : (URL.parse(href, this.#url)?.href ?? this.#url)
        this.#base.setAttribute('href', url)
    }

    /** Keeps the base element first in the head, or in the root element when there is no head. */
    #placeBase(): void {
        const document = this.#document
        const parent = document.head ?? document.documentElement
        if (parent !== null && parent.firstChild !== this.#base) {
            parent.prepend(this.#base)
        }
    }
}

const DOCUMENT_POSITION_PRECEDING = 2

/** The `href` of the first base element in a snapshot, in tree order. */
function firstBaseHref(root: DocumentNode): string | undefined {
    const stack: SerializedNode[] = [root]
    while (stack.length > 0) {
        const node = stack.pop()!
        if (node.kind === NodeKind.Element) {
            if (node.tag === 'base' && node.namespace === HTML_NAMESPACE) {
                const attributes = node.attributes
                for (let i = 0; i < attributes.length; i += 2) {
                    if (attributes[i] === 'href') {
                        return attributes[i + 1]
                    }
                }
            }
        } else if (node.kind !== NodeKind.Document) {
            continue
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
