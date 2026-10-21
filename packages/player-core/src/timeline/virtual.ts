import { encodeInput, encodeScroll, encodeSnapshot, EventType, NodeKind } from '@timecat-js/protocol'
import type {
    AddedRun,
    DocumentNode,
    ElementNode,
    InputChange,
    MutationsEvent,
    ScrollPosition,
    SerializedNode,
    SnapshotEvent,
    TcrEvent
} from '@timecat-js/protocol'

type ParentNode = DocumentNode | ElementNode

/** A keyframe's encoded state; see `Keyframe`. */
export interface EncodedState {
    snapshot: Uint8Array<ArrayBuffer>
    input: Uint8Array<ArrayBuffer>
    scroll: Uint8Array<ArrayBuffer>
}

const EMPTY = new Uint8Array(0)

/**
 * The recorded document as plain data, which the indexer keeps to write keyframes. It applies events by the rules
 * the materializer's DOM applies them by, refusals included, so a keyframe matches the DOM that applying the same
 * events produces. It takes over the nodes of the events it applies and changes them as later events say.
 */
export class VirtualDocument {
    #root: DocumentNode | undefined
    readonly #nodes = new Map<number, SerializedNode>()
    readonly #parents = new Map<number, ParentNode>()
    /** Last recorded state per control, in the order the states were recorded: later ones may undo earlier ones. */
    readonly #inputs = new Map<number, InputChange>()
    readonly #scrolls = new Map<number, ScrollPosition>()

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
            default:
                return 1
        }
    }

    /** The current state as a snapshot with explicit ids, plus the form and scroll state on top of it. */
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
            scroll: positions.length === 0 ? EMPTY : encodeScroll({ positions })
        }
    }

    #snapshot(event: SnapshotEvent): number {
        this.#nodes.clear()
        this.#parents.clear()
        this.#inputs.clear()
        this.#scrolls.clear()
        const root = event.root
        this.#root = root
        root.children = documentChildren(root.children)
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
            }
        }
        for (const { id, data } of event.texts) {
            const node = this.#nodes.get(id)
            if (node?.kind === NodeKind.Text || node?.kind === NodeKind.Comment) {
                node.data = data
            }
        }
        return cost + event.attributes.length + event.texts.length
    }

    #remove(id: number): number {
        const node = this.#nodes.get(id)
        const parent = this.#parents.get(id)
        // The document has no parent and stays.
        if (node === undefined || parent === undefined) {
            return 0
        }
        const index = parent.children.indexOf(node)
        if (index !== -1) {
            parent.children.splice(index, 1)
        }
        return this.#forget(node)
    }

    #insert(run: AddedRun): number {
        const parent = this.#nodes.get(run.parentId)
        if (parent?.kind !== NodeKind.Element && parent?.kind !== NodeKind.Document) {
            return 0
        }
        // A sibling that is unknown, or no longer a child of the parent, appends instead.
        const sibling = run.beforeId === 0 ? undefined : this.#nodes.get(run.beforeId)
        const before = sibling !== undefined && this.#parents.get(run.beforeId) === parent ? sibling : undefined
        const children = parent.children
        let cost = 0
        for (const node of run.nodes) {
            if (!canInsert(parent, node, before)) {
                continue
            }
            if (before === undefined) {
                children.push(node)
            } else {
                children.splice(children.indexOf(before), 0, node)
            }
            cost += this.#adopt(node, parent)
        }
        return cost
    }

    /** Registers a subtree that was just inserted, leaving out children the DOM refuses. Returns its size. */
    #adopt(root: SerializedNode, parent: ParentNode | undefined): number {
        if (parent !== undefined) {
            this.#parents.set(root.id, parent)
        }
        let count = 0
        const stack = [root]
        while (stack.length > 0) {
            const node = stack.pop()!
            this.#nodes.set(node.id, node)
            count++
            if (node.kind === NodeKind.Element) {
                // Elements cannot have doctypes as children; the decoder already refuses documents there.
                if (node.children.some(child => child.kind === NodeKind.Doctype)) {
                    node.children = node.children.filter(child => child.kind !== NodeKind.Doctype)
                }
            }
            if (node.kind === NodeKind.Element || node.kind === NodeKind.Document) {
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
        while (stack.length > 0) {
            const node = stack.pop()!
            this.#nodes.delete(node.id)
            this.#parents.delete(node.id)
            this.#inputs.delete(node.id)
            this.#scrolls.delete(node.id)
            count++
            if (node.kind === NodeKind.Element || node.kind === NodeKind.Document) {
                stack.push(...node.children)
            }
        }
        return count
    }
}

/**
 * Whether the DOM accepts `node` as a child of `parent`, inserted before `before` (a child of `parent`) or
 * appended. Mirrors the DOM's pre-insertion validity check for the node kinds a recording contains.
 */
function canInsert(parent: ParentNode, node: SerializedNode, before: SerializedNode | undefined): boolean {
    if (parent.kind === NodeKind.Element) {
        return node.kind !== NodeKind.Doctype && node.kind !== NodeKind.Document
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

/** The children a document keeps when they are appended in order: see `canInsert`. */
function documentChildren(children: SerializedNode[]): SerializedNode[] {
    const kept: SerializedNode[] = []
    for (const child of children) {
        if (canInsert({ kind: NodeKind.Document, id: 0, url: '', quirks: false, children: kept }, child, undefined)) {
            kept.push(child)
        }
    }
    return kept
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
