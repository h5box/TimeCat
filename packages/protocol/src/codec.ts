import { TcrDecodeError } from './errors.ts'
import {
    ATTRIBUTE_ESCAPE,
    ATTRIBUTE_SHIFT,
    EventWriter,
    HAS_CHILDREN,
    HAS_NAMESPACE,
    KIND_MASK
} from './event-writer.ts'
import { EventType, InputKind, Namespace, NodeKind, PointerAction, PointerType } from './events.ts'
import type {
    DocumentNode,
    ElementNode,
    InputChange,
    MutationsEvent,
    SerializedNode,
    SnapshotEvent,
    TcrEvent
} from './events.ts'
import { ByteReader } from './reader.ts'
import { StringTableReader } from './strings.ts'
import type { ByteWriter } from './writer.ts'

/** Snapshot flags. */
const EXPLICIT_IDS = 1
const QUIRKS = 2
const KNOWN_SNAPSHOT_FLAGS = EXPLICIT_IDS | QUIRKS

/**
 * Allocates implicit node ids while decoding. It carries over from event to event: a snapshot resets it, and
 * every node a mutation adds takes the next id.
 */
export interface IdCounter {
    next: number
}

/** Encodes an event body. Node ids are written only for snapshots with `explicitIds`; otherwise they are implied. */
export function encodeEvent(event: TcrEvent): Uint8Array<ArrayBuffer> {
    const w = new EventWriter()
    const bytes = w.bytes
    switch (event.type) {
        case EventType.Snapshot:
            bytes.varuint((event.explicitIds ? EXPLICIT_IDS : 0) | (event.quirks ? QUIRKS : 0))
            w.string(event.url)
            if (event.explicitIds) {
                bytes.varuint(event.nextId)
            }
            writeTree(w, event.root, event.explicitIds)
            break
        case EventType.Mutations:
            bytes.varuint(event.removes.length)
            for (const id of event.removes) {
                bytes.varuint(id)
            }
            bytes.varuint(event.adds.length)
            for (const run of event.adds) {
                bytes.varuint(run.parentId)
                bytes.varuint(run.beforeId)
                bytes.varuint(run.nodes.length)
                for (const node of run.nodes) {
                    writeTree(w, node, false)
                }
            }
            bytes.varuint(event.attributes.length)
            for (const change of event.attributes) {
                w.attributeChange(change.id, change.name, change.value)
            }
            bytes.varuint(event.texts.length)
            for (const change of event.texts) {
                w.textChange(change.id, change.data)
            }
            break
        case EventType.Input:
            bytes.varuint(event.changes.length)
            for (const change of event.changes) {
                writeInputChange(w, change)
            }
            break
        case EventType.PointerMoves: {
            const { times, xs, ys } = event
            const count = times.length
            if (count === 0 || xs.length !== count || ys.length !== count) {
                throw new RangeError('pointer moves need at least one sample and columns of equal length')
            }
            bytes.u8(event.pointer)
            bytes.varuint(count)
            writeDeltas(bytes, times, false)
            writeDeltas(bytes, xs, true)
            writeDeltas(bytes, ys, true)
            break
        }
        case EventType.PointerButton:
            bytes.u8(event.action)
            bytes.u8(event.pointer)
            bytes.u8(event.button)
            bytes.varint(event.x)
            bytes.varint(event.y)
            bytes.varuint(event.targetId)
            break
        case EventType.Scroll:
            bytes.varuint(event.positions.length)
            for (const position of event.positions) {
                bytes.varuint(position.id)
                bytes.varint(position.x)
                bytes.varint(position.y)
            }
            break
        case EventType.Viewport:
            bytes.varuint(event.width)
            bytes.varuint(event.height)
            break
        case EventType.Navigation:
            w.string(event.url, false)
            break
    }
    return bytes.finish()
}

/**
 * Decodes an event body. Returns `undefined` for event types this reader does not know, which callers skip.
 * Bytes after the known fields are ignored, so later versions can append fields.
 */
export function decodeEvent(type: number, body: Uint8Array, ids: IdCounter): TcrEvent | undefined {
    const r = new ByteReader(body)
    const strings = new StringTableReader()
    switch (type) {
        case EventType.Snapshot:
            return readSnapshot(r, strings, ids)
        case EventType.Mutations:
            return readMutations(r, strings, ids)
        case EventType.Input: {
            const count = readCount(r, 3)
            const changes: InputChange[] = []
            for (let i = 0; i < count; i++) {
                changes.push(readInputChange(r, strings))
            }
            return { type, changes }
        }
        case EventType.PointerMoves: {
            const pointer = readPointerType(r)
            const count = r.varuint()
            if (count === 0) {
                throw new TcrDecodeError('pointer moves must contain at least one sample')
            }
            // Each sample takes at least three bytes (time delta, x, y).
            if (count * 3 - 1 > r.remaining) {
                throw new TcrDecodeError('pointer sample count exceeds the event size')
            }
            const times = readDeltas(r, count, false)
            const xs = readDeltas(r, count, true)
            const ys = readDeltas(r, count, true)
            return { type, pointer, times, xs, ys }
        }
        case EventType.PointerButton: {
            const action = r.u8()
            if (action !== PointerAction.Down && action !== PointerAction.Up) {
                throw new TcrDecodeError(`unknown pointer action ${action}`)
            }
            const pointer = readPointerType(r)
            const button = r.u8()
            const x = r.varint()
            const y = r.varint()
            const targetId = r.varuint()
            return { type, action, pointer, button, x, y, targetId }
        }
        case EventType.Scroll: {
            const count = readCount(r, 3)
            const positions = []
            for (let i = 0; i < count; i++) {
                positions.push({ id: r.varuint(), x: r.varint(), y: r.varint() })
            }
            return { type, positions }
        }
        case EventType.Viewport:
            return { type, width: r.varuint(), height: r.varuint() }
        case EventType.Navigation:
            return { type, url: strings.read(r) }
        default:
            return undefined
    }
}

function writeTree(w: EventWriter, root: SerializedNode, explicitIds: boolean): void {
    // Iterative, so trees of any depth encode without growing the call stack.
    const stack: { children: SerializedNode[]; namespace: string; next: number }[] = []
    let current: SerializedNode | undefined = root
    let parentNamespace: string = Namespace.HTML
    while (current) {
        const node: SerializedNode = current
        const id = explicitIds ? node.id : undefined
        let children: SerializedNode[] = []
        let namespace = parentNamespace
        switch (node.kind) {
            case NodeKind.Document:
                w.document(node.children.length > 0, id)
                children = node.children
                break
            case NodeKind.Doctype:
                w.doctype(node.name, node.publicId, node.systemId, id)
                break
            case NodeKind.Element: {
                const { attributes } = node
                if (attributes.length % 2 !== 0) {
                    throw new RangeError('element attributes must be name/value pairs')
                }
                namespace = node.namespace
                w.element(
                    node.tag,
                    namespace === parentNamespace ? undefined : namespace,
                    attributes.length / 2,
                    node.children.length > 0,
                    id
                )
                for (let i = 0; i < attributes.length; i += 2) {
                    w.attribute(attributes[i]!, attributes[i + 1]!)
                }
                children = node.children
                break
            }
            case NodeKind.Text:
                w.text(node.data, id)
                break
            case NodeKind.Comment:
                w.comment(node.data, id)
                break
        }
        if (children.length > 0) {
            stack.push({ children, namespace, next: 0 })
        }
        // Move to the next node in document order, closing finished parents on the way.
        current = undefined
        while (stack.length > 0) {
            const frame = stack[stack.length - 1]!
            if (frame.next < frame.children.length) {
                current = frame.children[frame.next++]
                parentNamespace = frame.namespace
                break
            }
            w.end()
            stack.pop()
        }
    }
}

interface OpenNode {
    node: DocumentNode | ElementNode
    namespace: string
}

/**
 * Reads one node and its subtree. `ids` numbers the nodes unless `explicitIds`. Top-level nodes without a
 * namespace of their own are HTML.
 */
function readTree(
    r: ByteReader,
    strings: StringTableReader,
    ids: IdCounter,
    explicitIds: boolean,
    allowDocument: boolean
): SerializedNode {
    const stack: OpenNode[] = []
    for (;;) {
        const header = r.u8()
        const kind = header & KIND_MASK
        const parent = stack[stack.length - 1]
        if (kind === NodeKind.End) {
            if (header !== NodeKind.End || !parent) {
                throw new TcrDecodeError('unexpected end token')
            }
            stack.pop()
            if (stack.length === 0) {
                return parent.node
            }
            continue
        }
        const id = explicitIds ? r.varuint() : ids.next++
        const inherited = parent ? parent.namespace : Namespace.HTML
        let node: SerializedNode
        let opened: OpenNode | undefined
        switch (kind) {
            case NodeKind.Element: {
                const tag = strings.read(r)
                const namespace = header & HAS_NAMESPACE ? strings.read(r) : inherited
                let count = header >>> ATTRIBUTE_SHIFT
                if (count === ATTRIBUTE_ESCAPE) {
                    count = r.varuint()
                }
                // An attribute takes at least two bytes (two string table tags).
                if (count * 2 > r.remaining) {
                    throw new TcrDecodeError('attribute count exceeds the event size')
                }
                const attributes: string[] = []
                for (let i = 0; i < count; i++) {
                    attributes.push(strings.read(r), strings.read(r))
                }
                const element: ElementNode = { kind, id, tag, namespace, attributes, children: [] }
                node = element
                if (header & HAS_CHILDREN) {
                    opened = { node: element, namespace }
                }
                break
            }
            case NodeKind.Text:
            case NodeKind.Comment:
                checkNoFlags(header)
                node = { kind, id, data: strings.read(r) }
                break
            case NodeKind.Document: {
                if (!allowDocument || parent) {
                    throw new TcrDecodeError('a document node can only be the root of a snapshot')
                }
                if (header & ~(KIND_MASK | HAS_CHILDREN)) {
                    throw new TcrDecodeError(`unknown node flags 0x${header.toString(16)}`)
                }
                const document: DocumentNode = { kind, id, children: [] }
                node = document
                if (header & HAS_CHILDREN) {
                    opened = { node: document, namespace: Namespace.HTML }
                }
                break
            }
            case NodeKind.Doctype:
                checkNoFlags(header)
                node = { kind, id, name: strings.read(r), publicId: strings.read(r), systemId: strings.read(r) }
                break
            default:
                throw new TcrDecodeError(`unknown node kind ${kind}`)
        }
        if (parent) {
            parent.node.children.push(node)
        }
        if (opened) {
            stack.push(opened)
        } else if (!parent) {
            return node
        }
    }
}

function checkNoFlags(header: number): void {
    if (header & ~KIND_MASK) {
        throw new TcrDecodeError(`unknown node flags 0x${header.toString(16)}`)
    }
}

function readSnapshot(r: ByteReader, strings: StringTableReader, ids: IdCounter): SnapshotEvent {
    const flags = r.varuint()
    if (flags & ~KNOWN_SNAPSHOT_FLAGS) {
        throw new TcrDecodeError(`unknown snapshot flags 0x${flags.toString(16)}`)
    }
    const explicitIds = (flags & EXPLICIT_IDS) !== 0
    const url = strings.read(r)
    const counter: IdCounter = { next: 1 }
    const declaredNextId = explicitIds ? r.varuint() : 0
    const root = readTree(r, strings, counter, explicitIds, true)
    if (root.kind !== NodeKind.Document) {
        throw new TcrDecodeError('a snapshot must start with a document node')
    }
    const nextId = explicitIds ? declaredNextId : counter.next
    ids.next = nextId
    return { type: EventType.Snapshot, url, quirks: (flags & QUIRKS) !== 0, explicitIds, nextId, root }
}

function readMutations(r: ByteReader, strings: StringTableReader, ids: IdCounter): MutationsEvent {
    const removes: number[] = []
    const removeCount = readCount(r, 1)
    for (let i = 0; i < removeCount; i++) {
        removes.push(r.varuint())
    }
    const adds = []
    const runCount = readCount(r, 3)
    for (let i = 0; i < runCount; i++) {
        const parentId = r.varuint()
        const beforeId = r.varuint()
        const nodeCount = readCount(r, 1)
        const nodes: SerializedNode[] = []
        for (let j = 0; j < nodeCount; j++) {
            nodes.push(readTree(r, strings, ids, false, false))
        }
        adds.push({ parentId, beforeId, nodes })
    }
    const attributes = []
    const attributeCount = readCount(r, 3)
    for (let i = 0; i < attributeCount; i++) {
        const id = r.varuint()
        const name = strings.read(r)
        const present = r.u8()
        if (present > 1) {
            throw new TcrDecodeError(`invalid attribute presence ${present}`)
        }
        attributes.push({ id, name, value: present ? strings.read(r) : null })
    }
    const texts = []
    const textCount = readCount(r, 2)
    for (let i = 0; i < textCount; i++) {
        texts.push({ id: r.varuint(), data: strings.read(r) })
    }
    return { type: EventType.Mutations, removes, adds, attributes, texts }
}

function writeInputChange(w: EventWriter, change: InputChange): void {
    const bytes = w.bytes
    bytes.varuint(change.id)
    bytes.u8(change.kind)
    switch (change.kind) {
        case InputKind.Value:
            w.string(change.value, false)
            break
        case InputKind.Checked:
            bytes.u8(change.checked ? 1 : 0)
            break
        case InputKind.Selection:
            bytes.varuint(change.selected.length)
            for (const index of change.selected) {
                bytes.varuint(index)
            }
            break
    }
}

function readInputChange(r: ByteReader, strings: StringTableReader): InputChange {
    const id = r.varuint()
    const kind = r.u8()
    switch (kind) {
        case InputKind.Value:
            return { kind, id, value: strings.read(r) }
        case InputKind.Checked: {
            const checked = r.u8()
            if (checked > 1) {
                throw new TcrDecodeError(`invalid checked state ${checked}`)
            }
            return { kind, id, checked: checked === 1 }
        }
        case InputKind.Selection: {
            const count = readCount(r, 1)
            const selected: number[] = []
            for (let i = 0; i < count; i++) {
                selected.push(r.varuint())
            }
            return { kind, id, selected }
        }
        default:
            throw new TcrDecodeError(`unknown input change kind ${kind}`)
    }
}

function readPointerType(r: ByteReader): PointerType {
    const pointer = r.u8()
    if (pointer !== PointerType.Mouse && pointer !== PointerType.Pen && pointer !== PointerType.Touch) {
        throw new TcrDecodeError(`unknown pointer type ${pointer}`)
    }
    return pointer
}

/** First value as is (times start at 0 and are left out), then differences to the previous value. */
function writeDeltas(bytes: ByteWriter, values: number[], signed: boolean): void {
    let previous = values[0]!
    if (signed) {
        bytes.varint(previous)
    } else if (previous !== 0) {
        throw new RangeError('the first pointer sample must be at time offset 0')
    }
    for (let i = 1; i < values.length; i++) {
        const value = values[i]!
        if (signed) {
            bytes.varint(value - previous)
        } else {
            bytes.varuint(value - previous)
        }
        previous = value
    }
}

function readDeltas(r: ByteReader, count: number, signed: boolean): number[] {
    let value = signed ? r.varint() : 0
    const values = [value]
    for (let i = 1; i < count; i++) {
        value += signed ? r.varint() : r.varuint()
        if (!Number.isSafeInteger(value)) {
            throw new TcrDecodeError('pointer sample exceeds the safe integer range')
        }
        values.push(value)
    }
    return values
}

/** Reads an item count, rejecting counts that cannot fit in the remaining bytes. */
function readCount(r: ByteReader, minItemBytes: number): number {
    const count = r.varuint()
    if (count * minItemBytes > r.remaining) {
        throw new TcrDecodeError(`count ${count} exceeds the event size`)
    }
    return count
}
