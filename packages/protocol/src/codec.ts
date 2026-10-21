import { TcrDecodeError } from './errors.ts'
import {
    ATTRIBUTE_ESCAPE,
    ATTRIBUTE_SHIFT,
    CLOSED,
    EventWriter,
    HAS_CHILDREN,
    HAS_NAMESPACE,
    KIND_MASK,
    QUIRKS
} from './event-writer.ts'
import {
    ConsoleLevel,
    ConsoleSource,
    EventType,
    InputKind,
    Namespace,
    NodeKind,
    PointerAction,
    PointerType,
    SheetChangeKind,
    SheetOwner,
    SnapshotFlag
} from './events.ts'
import type {
    AdoptedStyleSheetsEvent,
    AssetEvent,
    ConsoleEvent,
    CustomDataEvent,
    DocumentNode,
    ElementNode,
    FontFaceEvent,
    InputChange,
    InputEvent,
    MutationsEvent,
    NavigationEvent,
    NetworkEvent,
    PerfEvent,
    PointerButtonEvent,
    PointerMovesEvent,
    ScrollEvent,
    SerializedNode,
    ShadowRootNode,
    SheetChange,
    SnapshotEvent,
    StyleSheetEvent,
    TcrEvent,
    ViewportEvent
} from './events.ts'
import { ByteReader } from './reader.ts'
import { StringTableReader } from './strings.ts'
import { ByteWriter } from './writer.ts'

// Font sources: a CSS `src` value, or the font file.
const FONT_URL = 0
const FONT_DATA = 1

/**
 * Allocates implicit node ids while decoding. It carries over from event to event: a snapshot resets it, and
 * every node a mutation adds takes the next id.
 */
export interface IdCounter {
    next: number
}

/**
 * Encodes an event body. The `encode*` functions for each type do the same; importing only those that are used
 * keeps a bundle from carrying the encoders of every event.
 */
export function encodeEvent(event: TcrEvent): Uint8Array<ArrayBuffer> {
    switch (event.type) {
        case EventType.Snapshot:
            return encodeSnapshot(event)
        case EventType.Mutations:
            return encodeMutations(event)
        case EventType.Input:
            return encodeInput(event)
        case EventType.PointerMoves:
            return encodePointerMoves(event)
        case EventType.PointerButton:
            return encodePointerButton(event)
        case EventType.Scroll:
            return encodeScroll(event)
        case EventType.Viewport:
            return encodeViewport(event)
        case EventType.Navigation:
            return encodeNavigation(event)
        case EventType.StyleSheet:
            return encodeStyleSheet(event)
        case EventType.AdoptedStyleSheets:
            return encodeAdoptedStyleSheets(event)
        case EventType.FontFace:
            return encodeFontFace(event)
        case EventType.Asset:
            return encodeAsset(event)
        case EventType.Console:
            return encodeConsole(event)
        case EventType.Network:
            return encodeNetwork(event)
        case EventType.Perf:
            return encodePerf(event)
        case EventType.Custom:
            return encodeCustom(event)
        default:
            throw new RangeError('unknown event type')
    }
}

/** Node ids are written only with `explicitIds`; otherwise they are implied by document order. */
export function encodeSnapshot(event: Omit<SnapshotEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const w = new EventWriter()
    w.snapshotHeader(event.explicitIds ? event.nextId : undefined)
    writeTree(w, event.root, event.explicitIds)
    return w.bytes.finish()
}

export function encodeMutations(event: Omit<MutationsEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const w = new EventWriter()
    const bytes = w.bytes
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
    return bytes.finish()
}

export function encodeInput(event: Omit<InputEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const w = new EventWriter(new ByteWriter(64))
    w.bytes.varuint(event.changes.length)
    for (const change of event.changes) {
        writeInputChange(w, change)
    }
    return w.bytes.finish()
}

export function encodePointerMoves(event: Omit<PointerMovesEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const { times, xs, ys } = event
    const count = times.length
    if (count === 0 || xs.length !== count || ys.length !== count) {
        throw new RangeError('pointer moves need at least one sample and columns of equal length')
    }
    const bytes = new ByteWriter(count * 3 + 16)
    bytes.u8(event.pointer)
    bytes.varuint(count)
    writeColumn(bytes, times, true)
    writeColumn(bytes, xs, false)
    writeColumn(bytes, ys, false)
    return bytes.finish()
}

export function encodePointerButton(event: Omit<PointerButtonEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const bytes = new ByteWriter(32)
    bytes.u8(event.action)
    bytes.u8(event.pointer)
    bytes.u8(event.button)
    bytes.varint(event.x)
    bytes.varint(event.y)
    bytes.varuint(event.targetId)
    return bytes.finish()
}

export function encodeScroll(event: Omit<ScrollEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const bytes = new ByteWriter(64)
    bytes.varuint(event.positions.length)
    for (const position of event.positions) {
        bytes.varuint(position.id)
        bytes.varint(position.x)
        bytes.varint(position.y)
    }
    return bytes.finish()
}

export function encodeViewport(event: Omit<ViewportEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const bytes = new ByteWriter(16)
    bytes.varuint(event.width)
    bytes.varuint(event.height)
    return bytes.finish()
}

export function encodeNavigation(event: Omit<NavigationEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const w = new EventWriter(new ByteWriter(256))
    w.bytes.varuint(event.id)
    w.string(event.url, false)
    return w.bytes.finish()
}

export function encodeStyleSheet(event: Omit<StyleSheetEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const w = new EventWriter()
    const bytes = w.bytes
    bytes.u8(event.owner)
    bytes.varuint(event.id)
    bytes.varuint(event.changes.length)
    for (const change of event.changes) {
        bytes.u8(change.kind)
        switch (change.kind) {
            case SheetChangeKind.Replace:
                bytes.varuint(change.rules.length)
                for (const rule of change.rules) {
                    w.string(rule, false)
                }
                break
            case SheetChangeKind.Insert:
                bytes.varuint(change.index)
                w.string(change.rule, false)
                break
            case SheetChangeKind.Delete:
                bytes.varuint(change.index)
                break
        }
    }
    return bytes.finish()
}

export function encodeAdoptedStyleSheets(event: Omit<AdoptedStyleSheetsEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const bytes = new ByteWriter(64)
    bytes.varuint(event.id)
    bytes.varuint(event.sheets.length)
    for (const id of event.sheets) {
        bytes.varuint(id)
    }
    return bytes.finish()
}

export function encodeFontFace(event: Omit<FontFaceEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const { source, descriptors } = event
    if (descriptors.length % 2 !== 0) {
        throw new RangeError('font face descriptors must be name/value pairs')
    }
    const w = new EventWriter()
    const bytes = w.bytes
    w.string(event.family, false)
    if (typeof source === 'string') {
        bytes.u8(FONT_URL)
        w.string(source, false)
    } else {
        bytes.u8(FONT_DATA)
        bytes.bytes(source)
    }
    bytes.varuint(descriptors.length / 2)
    for (const value of descriptors) {
        w.string(value)
    }
    return bytes.finish()
}

export function encodeAsset(event: Omit<AssetEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const w = new EventWriter(new ByteWriter(event.data.length + 256))
    w.string(event.url, false)
    w.string(event.mimeType, false)
    w.bytes.bytes(event.data)
    return w.bytes.finish()
}

export function encodeConsole(event: Omit<ConsoleEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const w = new EventWriter(new ByteWriter(256))
    const bytes = w.bytes
    bytes.u8(event.level)
    bytes.u8(event.source)
    bytes.varuint(event.args.length)
    for (const arg of event.args) {
        w.string(arg)
    }
    w.string(event.stack, false)
    return bytes.finish()
}

export function encodeNetwork(event: Omit<NetworkEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const w = new EventWriter(new ByteWriter(256))
    const bytes = w.bytes
    w.string(event.initiator, false)
    w.string(event.method, false)
    w.string(event.url, false)
    bytes.varuint(event.status)
    bytes.varuint(event.duration)
    bytes.varuint(event.size)
    w.string(event.error, false)
    return bytes.finish()
}

export function encodePerf(event: Omit<PerfEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const w = new EventWriter(new ByteWriter(64))
    w.string(event.metric, false)
    w.bytes.f64(event.value)
    w.bytes.varuint(event.targetId)
    return w.bytes.finish()
}

export function encodeCustom(event: Omit<CustomDataEvent, 'type'>): Uint8Array<ArrayBuffer> {
    const w = new EventWriter(new ByteWriter(256))
    w.string(event.name, false)
    w.string(event.data, false)
    return w.bytes.finish()
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
            // Each sample takes at least a byte per column; the first one's time is left out.
            if (count * 3 - 1 > r.remaining) {
                throw new TcrDecodeError('pointer sample count exceeds the event size')
            }
            const times = readColumn(r, count, true)
            const xs = readColumn(r, count, false)
            const ys = readColumn(r, count, false)
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
            return { type, id: r.varuint(), url: strings.read(r) }
        case EventType.StyleSheet: {
            const owner = r.u8()
            if (owner !== SheetOwner.Node && owner !== SheetOwner.Constructed) {
                throw new TcrDecodeError(`unknown style sheet owner ${owner}`)
            }
            const id = r.varuint()
            const count = readCount(r, 2)
            const changes: SheetChange[] = []
            for (let i = 0; i < count; i++) {
                changes.push(readSheetChange(r, strings))
            }
            return { type, owner, id, changes }
        }
        case EventType.AdoptedStyleSheets: {
            const id = r.varuint()
            const count = readCount(r, 1)
            const sheets: number[] = []
            for (let i = 0; i < count; i++) {
                sheets.push(r.varuint())
            }
            return { type, id, sheets }
        }
        case EventType.FontFace: {
            const family = strings.read(r)
            const kind = r.u8()
            let source: string | Uint8Array
            if (kind === FONT_URL) {
                source = strings.read(r)
            } else if (kind === FONT_DATA) {
                source = r.bytes()
            } else {
                throw new TcrDecodeError(`unknown font source ${kind}`)
            }
            // A descriptor takes at least two bytes (two string table tags).
            const count = readCount(r, 2)
            const descriptors: string[] = []
            for (let i = 0; i < count; i++) {
                descriptors.push(strings.read(r), strings.read(r))
            }
            return { type, family, source, descriptors }
        }
        case EventType.Asset:
            return { type, url: strings.read(r), mimeType: strings.read(r), data: r.bytes() }
        case EventType.Console: {
            const level = r.u8()
            if (!isValueOf(ConsoleLevel, level)) {
                throw new TcrDecodeError(`unknown console level ${level}`)
            }
            const source = r.u8()
            if (!isValueOf(ConsoleSource, source)) {
                throw new TcrDecodeError(`unknown console source ${source}`)
            }
            const count = readCount(r, 1)
            const args: string[] = []
            for (let i = 0; i < count; i++) {
                args.push(strings.read(r))
            }
            return { type, level, source, args, stack: strings.read(r) }
        }
        case EventType.Network:
            return {
                type,
                initiator: strings.read(r),
                method: strings.read(r),
                url: strings.read(r),
                status: r.varuint(),
                duration: r.varuint(),
                size: r.varuint(),
                error: strings.read(r)
            }
        case EventType.Perf:
            return { type, metric: strings.read(r), value: r.f64(), targetId: r.varuint() }
        case EventType.Custom:
            return { type, name: strings.read(r), data: strings.read(r) }
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
                w.document(node.url, node.quirks, node.children.length > 0, id)
                children = node.children
                namespace = Namespace.HTML
                break
            case NodeKind.ShadowRoot:
                w.shadowRoot(node.closed, node.children.length > 0, id)
                children = node.children
                namespace = Namespace.HTML
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
    node: DocumentNode | ElementNode | ShadowRootNode
    namespace: string
}

/**
 * Reads one node and its subtree. `ids` numbers the nodes unless `explicitIds`. Top-level nodes without a
 * namespace of their own are HTML, as are the children of documents and shadow roots.
 */
function readTree(r: ByteReader, strings: StringTableReader, ids: IdCounter, explicitIds: boolean): SerializedNode {
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
                checkFlags(header, 0)
                node = { kind, id, data: strings.read(r) }
                break
            case NodeKind.Document: {
                checkPlacement(parent)
                checkFlags(header, HAS_CHILDREN | QUIRKS)
                const document: DocumentNode = {
                    kind,
                    id,
                    url: strings.read(r),
                    quirks: (header & QUIRKS) !== 0,
                    children: []
                }
                node = document
                if (header & HAS_CHILDREN) {
                    opened = { node: document, namespace: Namespace.HTML }
                }
                break
            }
            case NodeKind.ShadowRoot: {
                checkPlacement(parent)
                checkFlags(header, HAS_CHILDREN | CLOSED)
                const shadowRoot: ShadowRootNode = { kind, id, closed: (header & CLOSED) !== 0, children: [] }
                node = shadowRoot
                if (header & HAS_CHILDREN) {
                    opened = { node: shadowRoot, namespace: Namespace.HTML }
                }
                break
            }
            case NodeKind.Doctype:
                checkFlags(header, 0)
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

function checkFlags(header: number, allowed: number): void {
    if (header & ~(KIND_MASK | allowed)) {
        throw new TcrDecodeError(`unknown node flags 0x${header.toString(16)}`)
    }
}

/** Below the top of a tree, documents (frame content) and shadow roots come only first in an element. */
function checkPlacement(parent: OpenNode | undefined): void {
    if (parent !== undefined && (parent.node.kind !== NodeKind.Element || parent.node.children.length > 0)) {
        throw new TcrDecodeError('a document or shadow root can only be the first child of an element')
    }
}

function readSnapshot(r: ByteReader, strings: StringTableReader, ids: IdCounter): SnapshotEvent {
    const flags = r.varuint()
    if (flags & ~SnapshotFlag.ExplicitIds) {
        throw new TcrDecodeError(`unknown snapshot flags 0x${flags.toString(16)}`)
    }
    const explicitIds = flags !== 0
    const counter: IdCounter = { next: 1 }
    const declaredNextId = explicitIds ? r.varuint() : 0
    const root = readTree(r, strings, counter, explicitIds)
    if (root.kind !== NodeKind.Document) {
        throw new TcrDecodeError('a snapshot must start with a document node')
    }
    const nextId = explicitIds ? declaredNextId : counter.next
    ids.next = nextId
    return { type: EventType.Snapshot, explicitIds, nextId, root }
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
            const node = readTree(r, strings, ids, false)
            if (
                (node.kind === NodeKind.Document || node.kind === NodeKind.ShadowRoot) &&
                (nodeCount !== 1 || beforeId !== 0)
            ) {
                throw new TcrDecodeError('an added document or shadow root must be the only node of its run')
            }
            nodes.push(node)
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

function readSheetChange(r: ByteReader, strings: StringTableReader): SheetChange {
    const kind = r.u8()
    switch (kind) {
        case SheetChangeKind.Replace: {
            const count = readCount(r, 1)
            const rules: string[] = []
            for (let i = 0; i < count; i++) {
                rules.push(strings.read(r))
            }
            return { kind, rules }
        }
        case SheetChangeKind.Insert:
            return { kind, index: r.varuint(), rule: strings.read(r) }
        case SheetChangeKind.Delete:
            return { kind, index: r.varuint() }
        default:
            throw new TcrDecodeError(`unknown style sheet change ${kind}`)
    }
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

/**
 * A column of pointer samples: the first value as is (times start at 0 and are left out), then second differences,
 * each step minus the step before it (0 before the first). Steady movement makes them 0 and smooth movement keeps
 * them near it, which compresses far better than the steps themselves.
 */
function writeColumn(bytes: ByteWriter, values: number[], time: boolean): void {
    let previous = values[0]!
    if (!time) {
        bytes.varint(previous)
    } else if (previous !== 0) {
        throw new RangeError('the first pointer sample must be at time offset 0')
    }
    let step = 0
    for (let i = 1; i < values.length; i++) {
        const value = values[i]!
        const next = value - previous
        if (time && next < 0) {
            throw new RangeError('pointer sample times must not decrease')
        }
        bytes.varint(next - step)
        step = next
        previous = value
    }
}

function readColumn(r: ByteReader, count: number, time: boolean): number[] {
    let value = time ? 0 : r.varint()
    const values = [value]
    let step = 0
    for (let i = 1; i < count; i++) {
        step += r.varint()
        value += step
        if (!Number.isSafeInteger(step) || !Number.isSafeInteger(value)) {
            throw new TcrDecodeError('pointer sample exceeds the safe integer range')
        }
        if (time && step < 0) {
            throw new TcrDecodeError('pointer sample times must not decrease')
        }
        values.push(value)
    }
    return values
}

/** Whether `value` is one of the values of a group of constants, such as `ConsoleLevel`. */
function isValueOf<T extends number>(constants: Readonly<Record<string, T>>, value: number): value is T {
    for (const constant of Object.values(constants)) {
        if (constant === value) {
            return true
        }
    }
    return false
}

/** Reads an item count, rejecting counts that cannot fit in the remaining bytes. */
function readCount(r: ByteReader, minItemBytes: number): number {
    const count = r.varuint()
    if (count * minItemBytes > r.remaining) {
        throw new TcrDecodeError(`count ${count} exceeds the event size`)
    }
    return count
}
