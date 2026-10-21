import {
    ByteWriter,
    ChunkFlag,
    ChunkKind,
    encodeEvent,
    EventType,
    Namespace,
    NodeKind,
    Track,
    writeChunk,
    writeEventFrame,
    writeFileHeader
} from '@timecat-js/protocol'
import type { DocumentNode, SegmentInfo, SerializedNode, SnapshotEvent, TcrEvent } from '@timecat-js/protocol'
import { isDocument, isInput, isShadowRoot, isStyle, isTextArea } from '../src/dom.ts'

/**
 * Test-side description of a node; `build` numbers it the way implicit ids are assigned. A shadow root or a frame's
 * document goes first among the children of its element.
 */
export type Spec =
    | { text: string }
    | { comment: string }
    | { shadow: Spec[] }
    | { document: Spec[]; url?: string; quirks?: boolean }
    | { tag: string; namespace?: string | undefined; attributes?: string[]; children?: Spec[] }

/** Gives a spec preorder ids from `ids.next` on. Elements without a namespace inherit their parent's. */
export function build(spec: Spec, ids: { next: number }, parentNamespace: string = Namespace.HTML): SerializedNode {
    const id = ids.next++
    if ('text' in spec) {
        return { kind: NodeKind.Text, id, data: spec.text }
    }
    if ('comment' in spec) {
        return { kind: NodeKind.Comment, id, data: spec.comment }
    }
    if ('shadow' in spec) {
        return { kind: NodeKind.ShadowRoot, id, closed: false, children: spec.shadow.map(child => build(child, ids)) }
    }
    if ('document' in spec) {
        return {
            kind: NodeKind.Document,
            id,
            url: spec.url ?? 'https://example.com/frame/page.html',
            quirks: spec.quirks ?? false,
            children: spec.document.map(child => build(child, ids))
        }
    }
    const namespace = spec.namespace ?? parentNamespace
    const children = (spec.children ?? []).map(child => build(child, ids, namespace))
    return { kind: NodeKind.Element, id, tag: spec.tag, namespace, attributes: spec.attributes ?? [], children }
}

/** A recorded snapshot: the document is node 1, an optional doctype node 2, then the children in order. */
export function snapshotOf(
    children: Spec[],
    options: { doctype?: boolean; url?: string; quirks?: boolean } = {}
): SnapshotEvent {
    const ids = { next: 2 }
    const root: DocumentNode = {
        kind: NodeKind.Document,
        id: 1,
        url: options.url ?? 'https://example.com/app/page.html',
        quirks: options.quirks ?? false,
        children: []
    }
    if (options.doctype ?? true) {
        root.children.push({ kind: NodeKind.Doctype, id: ids.next++, name: 'html', publicId: '', systemId: '' })
    }
    root.children.push(...children.map(child => build(child, ids)))
    return { type: EventType.Snapshot, explicitIds: false, nextId: ids.next, root }
}

/** `<html><head></head><body>...</body></html>`: html is 3, head 4, body 5, the body's nodes from 6 on. */
export function pageOf(body: Spec[], options: { head?: Spec[]; url?: string } = {}): SnapshotEvent {
    return snapshotOf(
        [
            {
                tag: 'html',
                children: [
                    { tag: 'head', children: options.head ?? [] },
                    { tag: 'body', children: body }
                ]
            }
        ],
        options.url === undefined ? {} : { url: options.url }
    )
}

export function mutations(changes: Partial<Omit<Extract<TcrEvent, { type: 2 }>, 'type'>>): TcrEvent {
    return { type: EventType.Mutations, removes: [], adds: [], attributes: [], texts: [], ...changes }
}

export interface Timed {
    time: number
    event: TcrEvent
}

const TRACKS: Record<number, number> = {
    [EventType.Snapshot]: Track.Dom,
    [EventType.Mutations]: Track.Dom,
    [EventType.Input]: Track.Input,
    [EventType.PointerMoves]: Track.Pointer,
    [EventType.PointerButton]: Track.Pointer,
    [EventType.Scroll]: Track.Scroll,
    [EventType.Viewport]: Track.Viewport,
    [EventType.Navigation]: Track.Navigation,
    [EventType.StyleSheet]: Track.Dom,
    [EventType.AdoptedStyleSheets]: Track.Dom,
    [EventType.FontFace]: Track.Assets,
    [EventType.Asset]: Track.Assets,
    [EventType.Console]: Track.Console,
    [EventType.Network]: Track.Network,
    [EventType.Perf]: Track.Perf,
    [EventType.Custom]: Track.Custom
}

export const SESSION: SegmentInfo = { sessionId: 'player-test', segment: 0, startedAt: 1_760_000_000_000, meta: {} }

/** Writes a TCR file with one chunk per event, in the order given, numbered from `firstSequence`. */
export function writeRecording(
    events: readonly Timed[],
    info: Partial<SegmentInfo> = {},
    firstSequence = 0
): Uint8Array<ArrayBuffer> {
    const writer = new ByteWriter()
    writeFileHeader(writer, { ...SESSION, ...info })
    for (const [i, { time, event }] of events.entries()) {
        const payload = new ByteWriter()
        writeEventFrame(payload, event.type, 0, encodeEvent(event))
        writeChunk(writer, {
            kind: ChunkKind.Events,
            track: TRACKS[event.type]!,
            flags: event.type === EventType.Snapshot ? ChunkFlag.Keyframe : 0,
            sequence: firstSequence + i,
            startTime: time,
            duration: 0,
            payload: payload.finish()
        })
    }
    return writer.finish()
}

/** The chunks `writeRecording` writes, without the header, as a stream goes on after it. */
export function writeChunks(events: readonly Timed[], firstSequence: number): Uint8Array<ArrayBuffer> {
    return writeRecording(events, {}, firstSequence).slice(writeRecording([]).length)
}

/** A sync chunk: page events after it come at `time` or later. */
export function writeSync(time: number, sequence: number): Uint8Array<ArrayBuffer> {
    const writer = new ByteWriter()
    const payload = new Uint8Array(0)
    writeChunk(writer, { kind: ChunkKind.Sync, track: 0, flags: 0, sequence, startTime: time, duration: 0, payload })
    return writer.finish()
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
    let offset = 0
    for (const part of parts) {
        bytes.set(part, offset)
        offset += part.length
    }
    return bytes
}

/** One line per node, indented by depth, with sorted attributes, so trees compare as text. */
export function describeTree(root: SerializedNode): string {
    const lines: string[] = []
    const visit = (node: SerializedNode, depth: number): void => {
        const indent = '  '.repeat(depth)
        switch (node.kind) {
            case NodeKind.Document:
                lines.push(`${indent}#document`)
                break
            case NodeKind.ShadowRoot:
                lines.push(`${indent}#shadow-root`)
                break
            case NodeKind.Doctype:
                lines.push(`${indent}<!DOCTYPE ${node.name}>`)
                return
            case NodeKind.Text:
                lines.push(`${indent}${JSON.stringify(node.data)}`)
                return
            case NodeKind.Comment:
                lines.push(`${indent}<!--${node.data}-->`)
                return
            case NodeKind.Element: {
                const pairs: [string, string][] = []
                for (let i = 0; i < node.attributes.length; i += 2) {
                    pairs.push([node.attributes[i]!, node.attributes[i + 1]!])
                }
                lines.push(`${indent}${openTag(node.namespace, node.tag, pairs)}`)
                break
            }
        }
        for (const child of node.children) {
            visit(child, depth + 1)
        }
    }
    visit(root, 0)
    return lines.join('\n')
}

export interface DescribeOptions {
    /** The document to show in a frame, if any: the initial document of a frame is no recorded one. */
    frameDocument?: (frame: Element) => Document | undefined
    /** Also shows what the markup does not: the values of form controls and the rules of style sheets. */
    state?: boolean
}

/** `describeTree` for a DOM, leaving out what the player adds. */
export function describeDom(root: Node, options: DescribeOptions = {}): string {
    const { frameDocument = none, state = false } = options
    const lines: string[] = []
    const visit = (node: Node, depth: number): void => {
        const indent = '  '.repeat(depth)
        if (isDoctype(node)) {
            lines.push(`${indent}<!DOCTYPE ${node.name}>`)
            return
        }
        if (isCharacterData(node)) {
            lines.push(`${indent}${node.nodeType === 3 ? JSON.stringify(node.data) : `<!--${node.data}-->`}`)
            return
        }
        if (isElement(node)) {
            if (node.hasAttribute('data-timecat-player')) {
                return
            }
            const pairs = [...node.attributes].map(({ name, value }): [string, string] => [name, value])
            lines.push(`${indent}${openTag(node.namespaceURI ?? '', node.localName, pairs)}`)
            if (state) {
                lines.push(...stateOf(node).map(line => `${indent}  ${line}`))
            }
            const content = node.shadowRoot ?? frameDocument(node)
            if (content !== undefined) {
                visit(content, depth + 1)
            }
        } else {
            lines.push(`${indent}${node.nodeType === 11 ? '#shadow-root' : '#document'}`)
            const adopted = isDocument(node) || isShadowRoot(node) ? node.adoptedStyleSheets : []
            if (state && adopted.length > 0) {
                lines.push(`${indent}  @adopted ${JSON.stringify(adopted.map(rulesOf))}`)
            }
        }
        for (const child of node.childNodes) {
            visit(child, depth + 1)
        }
    }
    visit(root, 0)
    return lines.join('\n')
}

/** What an element holds besides its markup. */
function stateOf(element: Element): string[] {
    if (isInput(element)) {
        return [`@value ${JSON.stringify(element.value)}`, ...(element.checked ? ['@checked'] : [])]
    }
    if (isTextArea(element)) {
        return [`@value ${JSON.stringify(element.value)}`]
    }
    const sheet = isStyle(element) ? element.sheet : null
    return sheet === null ? [] : [`@rules ${JSON.stringify(rulesOf(sheet))}`]
}

function rulesOf(sheet: CSSStyleSheet): string[] {
    return [...sheet.cssRules].map(rule => rule.cssText)
}

function none(): undefined {
    return undefined
}

// Node checks that work across realms: tested documents live in frames.
export function isElement(node: Node): node is Element {
    return node.nodeType === 1
}

function isCharacterData(node: Node): node is CharacterData {
    return node.nodeType === 3 || node.nodeType === 8
}

function isDoctype(node: Node): node is DocumentType {
    return node.nodeType === 10
}

function openTag(namespace: string, tag: string, attributes: [string, string][]): string {
    const prefix = namespace === Namespace.SVG ? 'svg:' : namespace === Namespace.MathML ? 'math:' : ''
    const sorted = attributes.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `<${prefix}${tag}${sorted.map(([name, value]) => ` ${name}=${JSON.stringify(value)}`).join('')}>`
}
