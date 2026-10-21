import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
    ByteWriter,
    ConsoleLevel,
    ConsoleSource,
    EventType,
    EventWriter,
    InputKind,
    Namespace,
    NodeKind,
    PointerAction,
    PointerType,
    SheetChangeKind,
    SheetOwner,
    TcrDecodeError,
    decodeEvent,
    encodeEvent,
    readEventFrames,
    writeEventFrame
} from '../src/index.ts'
import type { DocumentNode, MutationsEvent, SerializedNode, SnapshotEvent, TcrEvent } from '../src/index.ts'

/** Test-side description of a node; `build` numbers it the way implicit ids are assigned. */
type Spec =
    | { text: string }
    | { comment: string }
    /** A shadow root. */
    | { closed: boolean; children: Spec[] }
    /** A frame's document. */
    | { url: string; quirks: boolean; children: Spec[] }
    | {
          tag: string
          namespace?: string | undefined
          attributes?: string[]
          /** A shadow root or document, which goes first. */
          inner?: Spec | undefined
          children?: Spec[]
      }

/**
 * Gives a spec preorder ids from `ids.next` on. Elements without a namespace inherit their parent's; the children
 * of shadow roots and documents start from HTML.
 */
function build(spec: Spec, ids: { next: number }, parentNamespace: string = Namespace.HTML): SerializedNode {
    const id = ids.next++
    if ('text' in spec) {
        return { kind: NodeKind.Text, id, data: spec.text }
    }
    if ('comment' in spec) {
        return { kind: NodeKind.Comment, id, data: spec.comment }
    }
    if ('closed' in spec) {
        return { kind: NodeKind.ShadowRoot, id, closed: spec.closed, children: spec.children.map(c => build(c, ids)) }
    }
    if ('url' in spec) {
        const children = spec.children.map(child => build(child, ids))
        return { kind: NodeKind.Document, id, url: spec.url, quirks: spec.quirks, children }
    }
    const namespace = spec.namespace ?? parentNamespace
    const children = spec.inner === undefined ? [] : [build(spec.inner, ids)]
    for (const child of spec.children ?? []) {
        children.push(build(child, ids, namespace))
    }
    return { kind: NodeKind.Element, id, tag: spec.tag, namespace, attributes: spec.attributes ?? [], children }
}

/** A recorded snapshot: the document is node 1, an optional doctype node 2, then the children in order. */
function snapshotOf(
    children: Spec[],
    options: { doctype?: boolean; url?: string; quirks?: boolean } = {}
): SnapshotEvent {
    const ids = { next: 2 }
    const root: DocumentNode = {
        kind: NodeKind.Document,
        id: 1,
        url: options.url ?? 'https://example.com/',
        quirks: options.quirks ?? false,
        children: []
    }
    if (options.doctype ?? true) {
        root.children.push({ kind: NodeKind.Doctype, id: ids.next++, name: 'html', publicId: '', systemId: '' })
    }
    root.children.push(...children.map(child => build(child, ids)))
    return { type: EventType.Snapshot, explicitIds: false, nextId: ids.next, root }
}

function roundTrip(event: TcrEvent, ids = { next: 1 }): TcrEvent | undefined {
    return decodeEvent(event.type, encodeEvent(event), ids)
}

/** `'ok'`, or the name of what decoding threw. */
function decodeOutcome(type: number, body: Uint8Array): string {
    try {
        decodeEvent(type, body, { next: 1 })
        return 'ok'
    } catch (error) {
        return error instanceof TcrDecodeError ? 'TcrDecodeError' : String(error)
    }
}

/** Outcome of a snapshot body with flags 0 and the given tree bytes. */
function snapshotOutcome(...tree: number[]): string {
    return decodeOutcome(EventType.Snapshot, new Uint8Array([0, ...tree]))
}

/** Outcome of a snapshot with implicit ids whose tree `write` writes. */
function treeOutcome(write: (writer: EventWriter) => void): string {
    const writer = new EventWriter()
    writer.snapshotHeader()
    write(writer)
    return decodeOutcome(EventType.Snapshot, writer.bytes.finish())
}

/** Outcome of a Mutations body with one run under node 1, of `count` nodes that `write` writes. */
function runOutcome(beforeId: number, count: number, write: (writer: EventWriter) => void): string {
    const writer = new EventWriter()
    // No removals, then the run.
    for (const value of [0, 1, 1, beforeId, count]) {
        writer.bytes.varuint(value)
    }
    write(writer)
    // No attribute or text changes.
    writer.bytes.varuint(0)
    writer.bytes.varuint(0)
    return decodeOutcome(EventType.Mutations, writer.bytes.finish())
}

/** A document token with an empty URL (literal tag 0, length 0). */
function documentToken(flags = 0): number[] {
    return [NodeKind.Document | flags, 0, 0]
}

const attributeName = fc.constantFrom('class', 'id', 'href', 'data-x', 'xlink:href', 'viewBox', 'aria-label', 'style')
const attributeValue = fc.oneof(
    fc.constantFrom('', 'card', 'btn btn-primary', '0 0 20 20'),
    fc.string({ unit: 'grapheme', maxLength: 80 })
)

const spec = fc.letrec<{ node: Spec; element: Spec; leaf: Spec; inner: Spec }>(tie => ({
    node: fc.oneof({ depthSize: 'small', withCrossShrink: true }, tie('leaf'), tie('element')),
    leaf: fc.oneof(
        fc.record({ text: fc.string({ unit: 'grapheme', maxLength: 40 }) }),
        fc.record({ comment: fc.string({ maxLength: 20 }) })
    ),
    element: fc.record({
        tag: fc.constantFrom('div', 'span', 'a', 'svg', 'path', 'foreignObject', 'math', 'x-custom', 'iframe'),
        namespace: fc.option(fc.constantFrom<string>(Namespace.HTML, Namespace.SVG, Namespace.MathML, '', 'urn:x'), {
            nil: undefined
        }),
        attributes: fc
            .uniqueArray(fc.tuple(attributeName, attributeValue), { selector: ([name]) => name, maxLength: 9 })
            .map(pairs => pairs.flat()),
        inner: fc.option(tie('inner'), { nil: undefined, freq: 4 }),
        children: fc.array(tie('node'), { maxLength: 4 })
    }),
    inner: fc.oneof(
        { depthSize: 'small' },
        fc.record({ closed: fc.boolean(), children: fc.array(tie('node'), { maxLength: 3 }) }),
        fc.record({ url: fc.webUrl(), quirks: fc.boolean(), children: fc.array(tie('node'), { maxLength: 2 }) })
    )
}))

const snapshot = fc
    .record({
        doctype: fc.boolean(),
        url: fc.webUrl(),
        quirks: fc.boolean(),
        // A document holds no text.
        children: fc.array(
            spec.node.filter(child => !('text' in child)),
            { maxLength: 3 }
        )
    })
    .map(({ children, ...options }) => snapshotOf(children, options))

const smallId = fc.integer({ min: 1, max: 5000 })
const cssRule = fc.oneof(
    fc.constantFrom('.a { color: red; }', '@media (width >= 600px) { .b { margin: 0px; } }'),
    fc.string({ maxLength: 40 })
)
const pointerType = fc.constantFrom(PointerType.Mouse, PointerType.Pen, PointerType.Touch)

/** Mutations whose added nodes are numbered from `firstId`. */
function mutations(firstId: number): fc.Arbitrary<MutationsEvent> {
    return fc
        .record({
            removes: fc.array(smallId, { maxLength: 5 }),
            adds: fc.array(
                fc.oneof(
                    fc.record({
                        parentId: smallId,
                        beforeId: fc.nat(5000),
                        nodes: fc.array(spec.node, { maxLength: 3 })
                    }),
                    // A shadow root attached to an element, or a document loaded into a frame.
                    fc.record({ parentId: smallId, beforeId: fc.constant(0), nodes: fc.tuple(spec.inner) })
                ),
                { maxLength: 4 }
            ),
            attributes: fc.array(
                fc.record({ id: smallId, name: attributeName, value: fc.option(attributeValue, { nil: null }) }),
                { maxLength: 5 }
            ),
            texts: fc.array(fc.record({ id: smallId, data: fc.string({ unit: 'grapheme', maxLength: 30 }) }), {
                maxLength: 5
            })
        })
        .map(({ removes, adds, attributes, texts }): MutationsEvent => {
            const ids = { next: firstId }
            return {
                type: EventType.Mutations,
                removes,
                adds: adds.map(run => ({ ...run, nodes: run.nodes.map(node => build(node, ids)) })),
                attributes,
                texts
            }
        })
}

const otherEvents: fc.Arbitrary<TcrEvent> = fc.oneof(
    fc.record({
        type: fc.constant(EventType.Input),
        changes: fc.array(
            fc.oneof(
                fc.record({
                    kind: fc.constant(InputKind.Value),
                    id: smallId,
                    value: fc.string({ unit: 'grapheme', maxLength: 30 })
                }),
                fc.record({ kind: fc.constant(InputKind.Checked), id: smallId, checked: fc.boolean() }),
                fc.record({
                    kind: fc.constant(InputKind.Selection),
                    id: smallId,
                    selected: fc.array(fc.nat(50), { maxLength: 4 })
                })
            ),
            { maxLength: 4 }
        )
    }),
    fc
        .record({
            pointer: pointerType,
            samples: fc.array(
                fc.tuple(fc.nat(100), fc.integer({ min: -4000, max: 4000 }), fc.integer({ min: -4000, max: 4000 })),
                { minLength: 1, maxLength: 50 }
            )
        })
        .map(({ pointer, samples }): TcrEvent => {
            // Offsets from the first sample: running sums of the gaps.
            const times: number[] = []
            let offset = 0
            for (const [gap] of samples) {
                times.push(offset)
                offset += gap
            }
            return {
                type: EventType.PointerMoves,
                pointer,
                times,
                xs: samples.map(([, x]) => x),
                ys: samples.map(([, , y]) => y)
            }
        }),
    fc.record({
        type: fc.constant(EventType.PointerButton),
        action: fc.constantFrom(PointerAction.Down, PointerAction.Up),
        pointer: pointerType,
        button: fc.integer({ min: 0, max: 5 }),
        x: fc.integer({ min: -10, max: 5000 }),
        y: fc.integer({ min: -10, max: 5000 }),
        targetId: fc.nat(10000)
    }),
    fc.record({
        type: fc.constant(EventType.Scroll),
        positions: fc.array(fc.record({ id: smallId, x: fc.integer({ min: -2000, max: 2000 }), y: fc.nat(100_000) }), {
            maxLength: 4
        })
    }),
    fc.record({ type: fc.constant(EventType.Viewport), width: fc.nat(8000), height: fc.nat(8000) }),
    fc.record({ type: fc.constant(EventType.Navigation), id: smallId, url: fc.webUrl({ withQueryParameters: true }) }),
    fc.record({
        type: fc.constant(EventType.StyleSheet),
        owner: fc.constantFrom(SheetOwner.Node, SheetOwner.Constructed),
        id: smallId,
        changes: fc.array(
            fc.oneof(
                fc.record({ kind: fc.constant(SheetChangeKind.Replace), rules: fc.array(cssRule, { maxLength: 4 }) }),
                fc.record({ kind: fc.constant(SheetChangeKind.Insert), index: fc.nat(50), rule: cssRule }),
                fc.record({ kind: fc.constant(SheetChangeKind.Delete), index: fc.nat(50) })
            ),
            { maxLength: 4 }
        )
    }),
    fc.record({
        type: fc.constant(EventType.AdoptedStyleSheets),
        id: smallId,
        sheets: fc.array(fc.integer({ min: 1, max: 300 }), { maxLength: 5 })
    }),
    fc.record({
        type: fc.constant(EventType.FontFace),
        family: fc.string({ maxLength: 20 }),
        source: fc.oneof(fc.string({ maxLength: 60 }), fc.uint8Array({ maxLength: 100 })),
        descriptors: fc
            .uniqueArray(fc.tuple(fc.constantFrom('weight', 'style', 'unicodeRange', 'display'), fc.string()), {
                selector: ([name]) => name
            })
            .map(pairs => pairs.flat())
    }),
    fc.record({
        type: fc.constant(EventType.Asset),
        url: fc.webUrl(),
        mimeType: fc.constantFrom('image/png', 'font/woff2', ''),
        data: fc.uint8Array({ maxLength: 200 })
    }),
    fc.record({
        type: fc.constant(EventType.Console),
        level: fc.constantFrom(...Object.values(ConsoleLevel)),
        source: fc.constantFrom(...Object.values(ConsoleSource)),
        args: fc.array(fc.string({ unit: 'grapheme', maxLength: 30 }), { maxLength: 4 }),
        stack: fc.string({ maxLength: 60 })
    }),
    fc.record({
        type: fc.constant(EventType.Network),
        initiator: fc.constantFrom('fetch', 'xmlhttprequest', 'img'),
        method: fc.constantFrom('GET', 'POST'),
        url: fc.webUrl({ withQueryParameters: true }),
        status: fc.nat(599),
        duration: fc.nat(100_000),
        size: fc.nat(10_000_000),
        error: fc.string({ maxLength: 20 })
    }),
    fc.record({
        type: fc.constant(EventType.Perf),
        metric: fc.constantFrom('LCP', 'CLS', 'INP'),
        value: fc.double(),
        targetId: fc.nat(10_000)
    }),
    fc.record({ type: fc.constant(EventType.Custom), name: fc.string({ maxLength: 20 }), data: fc.json() })
)

describe('snapshot events', () => {
    it('numbers nodes in document order and inherits namespaces', () => {
        const event = snapshotOf(
            [
                {
                    tag: 'html',
                    children: [
                        {
                            tag: 'body',
                            children: [
                                { text: 'hi' },
                                { tag: 'svg', namespace: Namespace.SVG, children: [{ tag: 'path' }] }
                            ]
                        }
                    ]
                }
            ],
            { url: 'https://example.com/a/b' }
        )
        const counter = { next: 99 }
        // document 1, doctype 2, html 3, body 4, text 5, svg 6, path 7
        expect(roundTrip(event, counter)).toMatchObject({
            nextId: 8,
            root: {
                id: 1,
                url: 'https://example.com/a/b',
                children: [
                    { id: 2, name: 'html' },
                    {
                        id: 3,
                        children: [
                            {
                                id: 4,
                                children: [
                                    { id: 5, data: 'hi' },
                                    {
                                        id: 6,
                                        tag: 'svg',
                                        namespace: Namespace.SVG,
                                        children: [{ id: 7, tag: 'path', namespace: Namespace.SVG }]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        })
        // The snapshot resets the id space: later additions continue after its last node.
        expect(counter.next).toBe(8)
    })

    it('writes a namespace only where it changes', () => {
        const inherited = snapshotOf([{ tag: 'svg', namespace: Namespace.SVG, children: [{ tag: 'path' }] }])
        const switched = snapshotOf([
            { tag: 'svg', namespace: Namespace.SVG, children: [{ tag: 'path', namespace: Namespace.HTML }] }
        ])
        expect(encodeEvent(switched).length).toBeGreaterThan(encodeEvent(inherited).length)
        expect(roundTrip(switched)).toEqual(switched)
    })

    it('round-trips random documents with implicit ids', () => {
        fc.assert(
            fc.property(snapshot, event => {
                const counter = { next: 1 }
                expect(roundTrip(event, counter)).toEqual(event)
                expect(counter.next).toBe(event.nextId)
            })
        )
    })

    it('round-trips explicit ids', () => {
        fc.assert(
            fc.property(snapshot, fc.array(fc.nat(1_000_000), { minLength: 1, maxLength: 400 }), (event, pool) => {
                const explicit = structuredClone(event)
                explicit.explicitIds = true
                explicit.nextId = 1_000_001
                let i = 0
                const pending: SerializedNode[] = [explicit.root]
                for (let node = pending.pop(); node; node = pending.pop()) {
                    node.id = pool[i++ % pool.length]!
                    if ('children' in node) {
                        pending.push(...node.children)
                    }
                }
                const counter = { next: 1 }
                expect(roundTrip(explicit, counter)).toEqual(explicit)
                expect(counter.next).toBe(1_000_001)
            })
        )
    })

    it('encodes and decodes deep trees without exhausting the stack', () => {
        const depth = 50_000
        // Built bottom-up with preorder ids: document 1, divs 2..depth+1, the text last.
        let node: SerializedNode = { kind: NodeKind.Text, id: depth + 2, data: 'deep' }
        for (let i = depth; i >= 1; i--) {
            node = {
                kind: NodeKind.Element,
                id: i + 1,
                tag: 'div',
                namespace: Namespace.HTML,
                attributes: [],
                children: [node]
            }
        }
        const event: SnapshotEvent = {
            type: EventType.Snapshot,
            explicitIds: false,
            nextId: depth + 3,
            root: { kind: NodeKind.Document, id: 1, url: 'about:blank', quirks: true, children: [node] }
        }
        const body = encodeEvent(event)
        const decoded = decodeEvent(EventType.Snapshot, body, { next: 1 })
        expect(decoded).toMatchObject({ nextId: depth + 3, root: { quirks: true } })
        // Comparing the trees directly would recurse 50 000 levels deep; the re-encoding carries the same content.
        expect(decoded && encodeEvent(decoded)).toEqual(body)
    })

    it('puts shadow roots and frame documents first in their element', () => {
        const event = snapshotOf([
            {
                tag: 'x-card',
                inner: { closed: true, children: [{ tag: 'slot' }] },
                children: [{ text: 'light' }]
            },
            {
                tag: 'iframe',
                namespace: Namespace.SVG,
                inner: {
                    url: 'https://example.com/frame',
                    quirks: true,
                    children: [{ tag: 'html', children: [{ tag: 'svg', namespace: Namespace.SVG }] }]
                }
            }
        ])
        // document 1, doctype 2, x-card 3, shadow root 4, slot 5, text 6, iframe 7, document 8, html 9, svg 10
        expect(roundTrip(event)).toMatchObject({
            nextId: 11,
            root: {
                children: [
                    {},
                    {
                        id: 3,
                        children: [
                            { id: 4, kind: NodeKind.ShadowRoot, closed: true, children: [{ id: 5, tag: 'slot' }] },
                            { id: 6, data: 'light' }
                        ]
                    },
                    {
                        id: 7,
                        children: [
                            {
                                id: 8,
                                kind: NodeKind.Document,
                                url: 'https://example.com/frame',
                                quirks: true,
                                // A document's children start from HTML, whatever its frame's namespace.
                                children: [{ id: 9, namespace: Namespace.HTML }]
                            }
                        ]
                    }
                ]
            }
        })
        expect(roundTrip(event)).toEqual(event)
    })

    it('writes attribute counts of seven and more separately', () => {
        const attributes = Array.from({ length: 12 }, (_, i) => [`a${i}`, String(i)]).flat()
        const event = snapshotOf(
            [
                { tag: 'p', attributes },
                { tag: 'i', attributes: attributes.slice(0, 14) },
                { tag: 'b', attributes: attributes.slice(0, 12) }
            ],
            { doctype: false }
        )
        expect(roundTrip(event)).toEqual(event)
    })
})

describe('mutation events', () => {
    it('numbers added nodes from the current counter on', () => {
        const ids = { next: 20 }
        const event: MutationsEvent = {
            type: EventType.Mutations,
            removes: [4, 9],
            adds: [
                { parentId: 3, beforeId: 0, nodes: [build({ tag: 'li', children: [{ text: 'a' }] }, ids)] },
                { parentId: 3, beforeId: 20, nodes: [build({ tag: 'li' }, ids)] }
            ],
            attributes: [
                { id: 7, name: 'class', value: 'on' },
                { id: 7, name: 'hidden', value: null }
            ],
            texts: [{ id: 8, data: 'changed' }]
        }
        const counter = { next: 20 }
        expect(roundTrip(event, counter)).toEqual(event)
        expect(counter.next).toBe(23)
    })

    it('round-trips random batches', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 100_000 }).chain(first => fc.tuple(fc.constant(first), mutations(first))),
                ([first, event]) => {
                    expect(roundTrip(event, { next: first })).toEqual(event)
                }
            )
        )
    })

    it('takes a document or shadow root only as the only node of a run, appended', () => {
        expect(runOutcome(0, 1, writer => writer.document('about:blank', false, false))).toBe('ok')
        expect(runOutcome(0, 1, writer => writer.shadowRoot(false, false))).toBe('ok')
        expect(runOutcome(4, 1, writer => writer.shadowRoot(false, false))).toBe('TcrDecodeError')
        expect(
            runOutcome(0, 2, writer => {
                writer.comment('')
                writer.shadowRoot(false, false)
            })
        ).toBe('TcrDecodeError')
        expect(
            runOutcome(0, 2, writer => {
                writer.document('', false, false)
                writer.comment('')
            })
        ).toBe('TcrDecodeError')
    })
})

describe('other events', () => {
    it('round-trip', () => {
        fc.assert(
            fc.property(otherEvents, event => {
                expect(roundTrip(event)).toEqual(event)
            })
        )
    })

    it('store pointer moves as small second differences', () => {
        const times = Array.from({ length: 100 }, (_, i) => i * 16)
        const xs = times.map((_, i) => 500 + i)
        const ys = times.map((_, i) => 300 - i)
        const body = encodeEvent({ type: EventType.PointerMoves, pointer: PointerType.Mouse, times, xs, ys })
        // Pointer type and count, then one byte per value, nearly all zeros: 16 ms gaps and ±1 px steps throughout.
        expect(body.length).toBeLessThan(310)
        expect(body.filter(byte => byte === 0).length).toBeGreaterThan(290)
    })

    it('reject a pointer sample that does not start at offset 0', () => {
        expect(() =>
            encodeEvent({ type: EventType.PointerMoves, pointer: PointerType.Mouse, times: [5], xs: [0], ys: [0] })
        ).toThrow(RangeError)
    })

    it('reject pointer sample times that go back', () => {
        const moves = { type: EventType.PointerMoves, pointer: PointerType.Mouse, xs: [0, 1, 2], ys: [0, 1, 2] }
        expect(() => encodeEvent({ ...moves, times: [0, 10, 5] })).toThrow(RangeError)
        // Times 0, 10, 20 are written as 10, 0; making the 0 a -15 (zigzag 29) makes the second step -5.
        const decreasing = encodeEvent({ ...moves, times: [0, 10, 20] })
        decreasing[3] = 29
        expect(decodeOutcome(EventType.PointerMoves, decreasing)).toBe('TcrDecodeError')
    })
})

describe('decoding untrusted bodies', () => {
    const samples = fc.oneof(snapshot, mutations(1), otherEvents)

    it('throws TcrDecodeError on every truncation of a valid body', () => {
        fc.assert(
            fc.property(samples, event => {
                const body = encodeEvent(event)
                for (let end = 0; end < body.length; end++) {
                    expect(decodeOutcome(event.type, body.subarray(0, end))).toBe('TcrDecodeError')
                }
            }),
            { numRuns: 60 }
        )
    })

    it('never throws anything but TcrDecodeError on random bytes', () => {
        fc.assert(
            fc.property(fc.integer({ min: 0, max: 20 }), fc.uint8Array({ maxLength: 200 }), (type, body) => {
                expect(['ok', 'TcrDecodeError']).toContain(decodeOutcome(type, body))
            })
        )
    })

    it('rejects stray end tokens, unknown node kinds and flags', () => {
        expect(snapshotOutcome(...documentToken())).toBe('ok')
        expect(snapshotOutcome(...documentToken(0x10))).toBe('ok')
        expect(snapshotOutcome(NodeKind.End)).toBe('TcrDecodeError')
        expect(snapshotOutcome(7)).toBe('TcrDecodeError')
        // An end token with flags, and flags on a comment, a document and a shadow root.
        expect(snapshotOutcome(...documentToken(0x08), NodeKind.End | 0x08)).toBe('TcrDecodeError')
        expect(snapshotOutcome(...documentToken(0x08), NodeKind.Comment | 0x08, 0, 0, NodeKind.End)).toBe(
            'TcrDecodeError'
        )
        expect(snapshotOutcome(...documentToken(0x20))).toBe('TcrDecodeError')
        expect(
            treeOutcome(writer => {
                writer.document('', false, true)
                writer.element('div', undefined, 0, true)
                writer.bytes.u8(NodeKind.ShadowRoot | 0x20)
                writer.end()
                writer.end()
            })
        ).toBe('TcrDecodeError')
        // The root must be a document.
        expect(snapshotOutcome(NodeKind.Comment, 0, 0)).toBe('TcrDecodeError')
        expect(snapshotOutcome(NodeKind.ShadowRoot)).toBe('TcrDecodeError')
        // Unknown snapshot flags.
        expect(decodeOutcome(EventType.Snapshot, new Uint8Array([2, ...documentToken()]))).toBe('TcrDecodeError')
    })

    it('takes documents and shadow roots below the root only first in an element', () => {
        /** A document with a `<div>` whose children `write` writes. */
        const inDiv = (write: (writer: EventWriter) => void): string =>
            treeOutcome(writer => {
                writer.document('', false, true)
                writer.element('div', undefined, 0, true)
                write(writer)
                writer.end()
                writer.end()
            })
        expect(inDiv(writer => writer.shadowRoot(false, false))).toBe('ok')
        expect(inDiv(writer => writer.document('', false, false))).toBe('ok')
        expect(
            inDiv(writer => {
                writer.shadowRoot(true, true)
                writer.element('div', undefined, 0, true)
                writer.shadowRoot(false, false)
                writer.end()
                writer.end()
                writer.text('light')
            })
        ).toBe('ok')
        expect(
            inDiv(writer => {
                writer.text('light')
                writer.shadowRoot(false, false)
            })
        ).toBe('TcrDecodeError')
        expect(
            inDiv(writer => {
                writer.shadowRoot(false, false)
                writer.document('', false, false)
            })
        ).toBe('TcrDecodeError')
        // Not in a document or a shadow root.
        expect(
            treeOutcome(writer => {
                writer.document('', false, true)
                writer.shadowRoot(false, false)
                writer.end()
            })
        ).toBe('TcrDecodeError')
        expect(
            inDiv(writer => {
                writer.shadowRoot(false, true)
                writer.document('', false, false)
                writer.end()
            })
        ).toBe('TcrDecodeError')
    })

    it('rejects counts larger than the body', () => {
        const writer = new ByteWriter()
        writer.varuint(2 ** 40)
        expect(decodeOutcome(EventType.Scroll, writer.finish())).toBe('TcrDecodeError')
    })

    it('skips unknown event types', () => {
        expect(decodeEvent(200, new Uint8Array([1, 2, 3]), { next: 1 })).toBeUndefined()
    })
})

describe('event frames', () => {
    it('round-trip types, times and bodies', () => {
        fc.assert(
            fc.property(
                fc.nat(1_000_000),
                fc.array(fc.tuple(fc.integer({ min: 1, max: 300 }), fc.nat(5000), fc.uint8Array({ maxLength: 40 }))),
                (start, events) => {
                    const writer = new ByteWriter()
                    for (const [type, delta, body] of events) {
                        writeEventFrame(writer, type, delta, body)
                    }
                    let time = start
                    const expected = events.map(([type, delta, body]) => ({ type, time: (time += delta), body }))
                    expect(readEventFrames(writer.finish(), start)).toEqual(expected)
                }
            )
        )
    })

    it('reject truncated frames', () => {
        const writer = new ByteWriter()
        writeEventFrame(writer, 1, 0, new Uint8Array(10))
        expect(() => readEventFrames(writer.finish().subarray(0, 8), 0)).toThrow(TcrDecodeError)
    })
})
