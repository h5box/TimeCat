import {
    ByteWriter,
    encodeAdoptedStyleSheets,
    encodeInput,
    encodeScroll,
    encodeSnapshot,
    encodeStyleSheet,
    EventType,
    Namespace,
    NodeKind,
    SheetChangeKind,
    SheetOwner,
    writeEventFrame
} from '@timecat-js/protocol'
import type {
    AddedRun,
    DocumentNode,
    ElementNode,
    InputChange,
    MutationsEvent,
    ScrollPosition,
    SerializedNode,
    ShadowRootNode,
    SheetChange,
    SnapshotEvent,
    StyleSheetEvent,
    TcrEvent
} from '@timecat-js/protocol'
import { changeRuleTexts } from '../sheets.ts'

type ParentNode = DocumentNode | ElementNode | ShadowRootNode

/** A keyframe's encoded state; see `Keyframe`. */
export interface EncodedState {
    snapshot: Uint8Array<ArrayBuffer>
    input: Uint8Array<ArrayBuffer>
    scroll: Uint8Array<ArrayBuffer>
    /** StyleSheet and AdoptedStyleSheets events, as an events chunk payload, or empty. */
    styles: Uint8Array<ArrayBuffer>
    /** Rules in `styles`, which take work to restore like nodes do. */
    rules: number
}

const EMPTY = new Uint8Array(0)

/** Elements that `attachShadow` takes, besides custom elements. */
const SHADOW_HOSTS = new Set([
    'article',
    'aside',
    'blockquote',
    'body',
    'div',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'main',
    'nav',
    'p',
    'section',
    'span'
])

/**
 * The recorded document as plain data, which the indexer keeps to write keyframes. It applies events by the rules
 * the materializer's DOM applies them by, refusals included, so a keyframe matches the DOM that applying the same
 * events produces. Where it cannot tell what the DOM refuses, it keeps what it is given: the materializer then
 * refuses it when it builds the keyframe, as it did when it applied the events. It takes over the nodes of the
 * events it applies and changes them as later events say.
 */
export class VirtualDocument {
    #root: DocumentNode | undefined
    readonly #nodes = new Map<number, SerializedNode>()
    readonly #parents = new Map<number, ParentNode>()
    /** Last recorded state per control, in the order the states were recorded: later ones may undo earlier ones. */
    readonly #inputs = new Map<number, InputChange>()
    readonly #scrolls = new Map<number, ScrollPosition>()
    /** Changes to the sheets of `<style>` elements since they last parsed their text, by element id. */
    readonly #sheets = new Map<number, SheetChange[]>()
    /** Rules of constructed sheets, by number. */
    readonly #constructed = new Map<number, string[]>()
    /** Constructed sheets that documents and shadow roots adopt, by their id. */
    readonly #adopted = new Map<number, number[]>()

    /** Whether there is a document yet, which takes a snapshot. */
    get loaded(): boolean {
        return this.#root !== undefined
    }

    /** Nodes in the document. */
    get size(): number {
        return this.#nodes.size
    }

    /** Applies an event and returns the work it took, counted in nodes and changes. */
    apply(event: TcrEvent): number {
        switch (event.type) {
            case EventType.Snapshot:
                return this.#snapshot(event)
            case EventType.Mutations:
                return this.#mutate(event)
            case EventType.Input:
                for (const change of event.changes) {
                    if (this.#nodes.has(change.id)) {
                        this.#inputs.delete(change.id)
                        this.#inputs.set(change.id, change)
                    }
                }
                return event.changes.length
            case EventType.Scroll:
                for (const position of event.positions) {
                    if (this.#nodes.has(position.id)) {
                        this.#scrolls.delete(position.id)
                        this.#scrolls.set(position.id, position)
                    }
                }
                return event.positions.length
            case EventType.Navigation: {
                const node = this.#nodes.get(event.id)
                if (node?.kind === NodeKind.Document) {
                    node.url = event.url
                }
                return 1
            }
            case EventType.StyleSheet:
                return this.#changeSheet(event)
            case EventType.AdoptedStyleSheets: {
                const root = this.#nodes.get(event.id)
                if (root?.kind === NodeKind.Document || root?.kind === NodeKind.ShadowRoot) {
                    // Numbers without a sheet yet stay left out, even once they get one.
                    const sheets = event.sheets.filter(number => this.#constructed.has(number))
                    if (sheets.length === 0) {
                        this.#adopted.delete(event.id)
                    } else {
                        this.#adopted.set(event.id, sheets)
                    }
                }
                return 1
            }
            default:
                return 1
        }
    }

    /** The current state as a snapshot with explicit ids, plus the form, scroll and style state on top of it. */
    encode(nextId: number): EncodedState | undefined {
        const root = this.#root
        if (root === undefined) {
            return undefined
        }
        const snapshot = encodeSnapshot({ explicitIds: true, nextId, root })
        const changes = [...this.#inputs.values()]
        const positions = [...this.#scrolls.values()]
        return {
            snapshot,
            input: changes.length === 0 ? EMPTY : encodeInput({ changes }),
            scroll: positions.length === 0 ? EMPTY : encodeScroll({ positions }),
            ...this.#encodeStyles()
        }
    }

    /** Events that bring the sheets of a snapshot to their current state. */
    #encodeStyles(): { styles: Uint8Array<ArrayBuffer>; rules: number } {
        if (this.#constructed.size === 0 && this.#sheets.size === 0) {
            return { styles: EMPTY, rules: 0 }
        }
        const writer = new ByteWriter()
        let rules = 0
        // Constructed sheets first: the first event of a number makes the sheet, which documents then adopt.
        for (const [id, list] of this.#constructed) {
            const changes: SheetChange[] = [{ kind: SheetChangeKind.Replace, rules: list }]
            writeEventFrame(
                writer,
                EventType.StyleSheet,
                0,
                encodeStyleSheet({ owner: SheetOwner.Constructed, id, changes })
            )
            rules += list.length
        }
        for (const [id, changes] of this.#sheets) {
            writeEventFrame(writer, EventType.StyleSheet, 0, encodeStyleSheet({ owner: SheetOwner.Node, id, changes }))
            rules += costOf(changes)
        }
        for (const [id, sheets] of this.#adopted) {
            writeEventFrame(writer, EventType.AdoptedStyleSheets, 0, encodeAdoptedStyleSheets({ id, sheets }))
        }
        return { styles: writer.finish(), rules }
    }

    #snapshot(event: SnapshotEvent): number {
        this.#nodes.clear()
        this.#parents.clear()
        this.#inputs.clear()
        this.#scrolls.clear()
        this.#sheets.clear()
        this.#constructed.clear()
        this.#adopted.clear()
        const root = event.root
        this.#root = root
        return this.#adopt(root, undefined)
    }

    #mutate(event: MutationsEvent): number {
        let cost = 0
        for (const id of event.removes) {
            cost += this.#remove(id)
        }
        for (const run of event.adds) {
            cost += this.#insert(run)
        }
        for (const { id, name, value } of event.attributes) {
            const node = this.#nodes.get(id)
            if (node?.kind === NodeKind.Element) {
                setAttribute(node.attributes, name, value)
                // Chrome and Firefox parse the text of an HTML `<style>` anew when its type is set too. Firefox
                // also does when its media or title is set, which this leaves out.
                if (name === 'type' && node.tag === 'style' && node.namespace === Namespace.HTML) {
                    this.#reparse(node)
                }
            }
        }
        for (const { id, data } of event.texts) {
            const node = this.#nodes.get(id)
            if (node?.kind === NodeKind.Text || node?.kind === NodeKind.Comment) {
                node.data = data
                this.#reparse(this.#parents.get(id))
            }
        }
        return cost + event.attributes.length + event.texts.length
    }

    #remove(id: number): number {
        const node = this.#nodes.get(id)
        const parent = this.#parents.get(id)
        // The document has no parent and stays; shadow roots cannot be removed.
        if (node === undefined || parent === undefined || node.kind === NodeKind.ShadowRoot) {
            return 0
        }
        const index = parent.children.indexOf(node)
        if (index !== -1) {
            parent.children.splice(index, 1)
        }
        this.#reparse(parent)
        return this.#forget(node)
    }

    #insert(run: AddedRun): number {
        const parent = this.#nodes.get(run.parentId)
        if (
            parent?.kind !== NodeKind.Element &&
            parent?.kind !== NodeKind.Document &&
            parent?.kind !== NodeKind.ShadowRoot
        ) {
            return 0
        }
        // A sibling that is unknown, or no longer a child of the parent, appends instead. So do shadow roots and the
        // documents of frames, which are no children in the DOM.
        const sibling = run.beforeId === 0 ? undefined : this.#nodes.get(run.beforeId)
        const before =
            sibling !== undefined && !isRoot(sibling) && this.#parents.get(run.beforeId) === parent
                ? sibling
                : undefined
        const children = parent.children
        let cost = 0
        let inserted = false
        for (const node of run.nodes) {
            if (node.kind === NodeKind.Document || node.kind === NodeKind.ShadowRoot) {
                cost += parent.kind === NodeKind.Element ? this.#attach(parent, node) : 0
                continue
            }
            if (!canInsert(parent, node, before)) {
                continue
            }
            if (before === undefined) {
                children.push(node)
            } else {
                children.splice(children.indexOf(before), 0, node)
            }
            inserted = true
            cost += this.#adopt(node, parent)
        }
        if (inserted) {
            this.#reparse(parent)
        }
        return cost
    }

    /**
     * Attaches a shadow root, or a frame's document in place of the one it had, as the first child of `host`.
     * Returns the work it took.
     */
    #attach(host: ElementNode, node: DocumentNode | ShadowRootNode): number {
        const children = host.children
        const first = children[0]
        let cost = 0
        if (node.kind === NodeKind.ShadowRoot) {
            // A host keeps its first shadow root.
            if (first?.kind === NodeKind.ShadowRoot || !canHostShadow(host)) {
                return 0
            }
        } else {
            if (!isFrame(host)) {
                return 0
            }
            if (first?.kind === NodeKind.Document) {
                children.shift()
                cost += this.#forget(first)
            }
        }
        children.unshift(node)
        return cost + this.#adopt(node, host)
    }

    /** Registers a subtree that was just inserted, leaving out children the DOM refuses. Returns its size. */
    #adopt(root: SerializedNode, parent: ParentNode | undefined): number {
        if (parent !== undefined) {
            this.#parents.set(root.id, parent)
        }
        let count = 0
        const stack = [root]
        for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
            this.#nodes.set(node.id, node)
            count++
            if (
                node.kind === NodeKind.Element ||
                node.kind === NodeKind.Document ||
                node.kind === NodeKind.ShadowRoot
            ) {
                node.children = keptChildren(node)
                for (const child of node.children) {
                    this.#parents.set(child.id, node)
                    stack.push(child)
                }
            }
        }
        return count
    }

    /** Unregisters a removed subtree. Returns its size. */
    #forget(root: SerializedNode): number {
        let count = 0
        const stack = [root]
        for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
            const id = node.id
            this.#nodes.delete(id)
            this.#parents.delete(id)
            this.#inputs.delete(id)
            this.#scrolls.delete(id)
            this.#sheets.delete(id)
            this.#adopted.delete(id)
            count++
            if (
                node.kind === NodeKind.Element ||
                node.kind === NodeKind.Document ||
                node.kind === NodeKind.ShadowRoot
            ) {
                for (const child of node.children) {
                    stack.push(child)
                }
            }
        }
        return count
    }

    /** A `<style>` parses its text anew when its children change, which undoes changes made through the CSSOM. */
    #reparse(parent: ParentNode | undefined): void {
        if (parent !== undefined && isStyle(parent)) {
            this.#sheets.delete(parent.id)
        }
    }

    #changeSheet(event: StyleSheetEvent): number {
        const { id, changes } = event
        if (event.owner === SheetOwner.Constructed) {
            this.#constructed.set(id, changeRuleTexts(this.#constructed.get(id) ?? [], changes))
        } else {
            // Changes to elements without a sheet go nowhere, in the DOM too.
            const node = this.#nodes.get(id)
            if (node !== undefined && isStyle(node)) {
                this.#sheets.set(id, foldChanges(this.#sheets.get(id) ?? [], changes))
            }
        }
        return costOf(changes)
    }
}

/**
 * Whether the DOM accepts `node` as a child of `parent`, inserted before `before` (a child of `parent`) or
 * appended. Mirrors the DOM's pre-insertion validity check for the node kinds a recording contains; shadow roots
 * and the documents of frames are no children in the DOM, see `#attach`.
 */
function canInsert(parent: ParentNode, node: SerializedNode, before: SerializedNode | undefined): boolean {
    if (parent.kind !== NodeKind.Document) {
        return node.kind !== NodeKind.Doctype && !isRoot(node)
    }
    const children = parent.children
    const index = before === undefined ? children.length : children.indexOf(before)
    switch (node.kind) {
        case NodeKind.Comment:
            return true
        case NodeKind.Element:
            return (
                !children.some(child => child.kind === NodeKind.Element) &&
                !children.slice(index).some(child => child.kind === NodeKind.Doctype)
            )
        case NodeKind.Doctype:
            return (
                !children.some(child => child.kind === NodeKind.Doctype) &&
                !children.slice(0, index).some(child => child.kind === NodeKind.Element)
            )
        default:
            return false
    }
}

/** The children `parent` keeps of those recorded: a document keeps those it takes when they are appended in order. */
function keptChildren(parent: ParentNode): SerializedNode[] {
    const children = parent.children
    if (parent.kind === NodeKind.Document) {
        const kept: SerializedNode[] = []
        for (const child of children) {
            if (canInsert({ ...parent, children: kept }, child, undefined)) {
                kept.push(child)
            }
        }
        return kept
    }
    const keeps = (child: SerializedNode, index: number): boolean =>
        canInsert(parent, child, undefined) ||
        // The decoder lets shadow roots and documents come only first.
        (index === 0 && parent.kind === NodeKind.Element && canAttach(parent, child))
    return children.every(keeps) ? children : children.filter(keeps)
}

/** Whether `host` takes `node` as its shadow root or the document it shows. */
function canAttach(host: ElementNode, node: SerializedNode): boolean {
    return node.kind === NodeKind.ShadowRoot ? canHostShadow(host) : node.kind === NodeKind.Document && isFrame(host)
}

/** Whether `attachShadow` may take the element. Custom element names it refuses, such as `font-face`, pass. */
function canHostShadow(element: ElementNode): boolean {
    return element.namespace === Namespace.HTML && (SHADOW_HOSTS.has(element.tag) || element.tag.includes('-'))
}

function isFrame(element: ElementNode): boolean {
    return element.namespace === Namespace.HTML && (element.tag === 'iframe' || element.tag === 'frame')
}

function isStyle(node: SerializedNode): boolean {
    return (
        node.kind === NodeKind.Element &&
        node.tag === 'style' &&
        (node.namespace === Namespace.HTML || node.namespace === Namespace.SVG)
    )
}

/** Shadow roots and the documents of frames, which hang off their element rather than being its children. */
function isRoot(node: SerializedNode): boolean {
    return node.kind === NodeKind.Document || node.kind === NodeKind.ShadowRoot
}

/** `changes` after `list`, as one Replace once there is one. Changes `list`. */
function foldChanges(list: SheetChange[], changes: readonly SheetChange[]): SheetChange[] {
    let result = list
    for (const change of changes) {
        const head = result[0]
        if (change.kind === SheetChangeKind.Replace) {
            // A copy, which the following changes change.
            result = [{ kind: SheetChangeKind.Replace, rules: [...change.rules] }]
        } else if (head?.kind === SheetChangeKind.Replace) {
            head.rules = changeRuleTexts(head.rules, [change])
        } else {
            result.push(change)
        }
    }
    return result
}

/** Work of applying sheet changes: a rule each. */
function costOf(changes: readonly SheetChange[]): number {
    let cost = 0
    for (const change of changes) {
        cost += change.kind === SheetChangeKind.Replace ? change.rules.length : 1
    }
    return cost
}

/** Sets or, for `null`, removes an attribute in a flattened name/value list. */
function setAttribute(attributes: string[], name: string, value: string | null): void {
    for (let i = 0; i < attributes.length; i += 2) {
        if (attributes[i] === name) {
            if (value === null) {
                attributes.splice(i, 2)
            } else {
                attributes[i + 1] = value
            }
            return
        }
    }
    if (value !== null) {
        attributes.push(name, value)
    }
}
