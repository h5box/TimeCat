import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
    ByteWriter,
    EventType,
    EventWriter,
    InputKind,
    Namespace,
    NodeKind,
    PointerAction,
    PointerType,
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
    | { tag: string; namespace?: string | undefined; attributes?: string[]; children?: Spec[] }

/** Gives a spec preorder ids from `ids.next` on. Elements without a namespace inherit their parent's. */
function build(spec: Spec, ids: { next: number }, parentNamespace: string = Namespace.HTML): SerializedNode {
    const id = ids.next++
    if ('text' in spec) {
        return { kind: NodeKind.Text, id, data: spec.text }
    }
    if ('comment' in spec) {
        return { kind: NodeKind.Comment, id, data: spec.comment }
    }
    const namespace = spec.namespace ?? parentNamespace
    const children = (spec.children ?? []).map(child => build(child, ids, namespace))
    return { kind: NodeKind.Element, id, tag: spec.tag, namespace, attributes: spec.attributes ?? [], children }
}

/** A recorded snapshot: the document is node 1, an optional doctype node 2, then the children in order. */
function snapshotOf(
    children: Spec[],
    options: { doctype?: boolean; url?: string; quirks?: boolean } = {}
): SnapshotEvent {
    const ids = { next: 2 }
    const root: DocumentNode = { kind: NodeKind.Document, id: 1, children: [] }
    if (options.doctype ?? true) {
        root.children.push({ kind: NodeKind.Doctype, id: ids.next++, name: 'html', publicId: '', systemId: '' })
    }
    root.children.push(...children.map(child => build(child, ids)))
    return {
        type: EventType.Snapshot,
        url: options.url ?? 'https://example.com/',
        quirks: options.quirks ?? false,
        explicitIds: false,
        nextId: ids.next,
        root
    }
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

/** Outcome of a snapshot body with flags 0, an empty URL (literal tag 0, length 0) and the given tree bytes. */
function snapshotOutcome(...tree: number[]): string {
    return decodeOutcome(EventType.Snapshot, new Uint8Array([0, 0, 0, ...tree]))
}

const attributeName = fc.constantFrom('class', 'id', 'href', 'data-x', 'xlink:href', 'viewBox', 'aria-label', 'style')
const attributeValue = fc.oneof(
    fc.constantFrom('', 'card', 'btn btn-primary', '0 0 20 20'),
    fc.string({ unit: 'grapheme', maxLength: 80 })
)

const spec = fc.letrec<{ node: Spec; element: Spec; leaf: Spec }>(tie => ({
    node: fc.oneof({ depthSize: 'small', withCrossShrink: true }, tie('leaf'), tie('element')),
    leaf: fc.oneof(
        fc.record({ text: fc.string({ unit: 'grapheme', maxLength: 40 }) }),
        fc.record({ comment: fc.string({ maxLength: 20 }) })
    ),
    element: fc.record({
        tag: fc.constantFrom('div', 'span', 'a', 'svg', 'path', 'foreignObject', 'math', 'x-custom'),
        namespace: fc.option(fc.constantFrom<string>(Namespace.HTML, Namespace.SVG, Namespace.MathML, '', 'urn:x'), {
            nil: undefined
        }),
        attributes: fc
            .uniqueArray(fc.tuple(attributeName, attributeValue), { selector: ([name]) => name, maxLength: 9 })
            .map(pairs => pairs.flat()),
        children: fc.array(tie('node'), { maxLength: 4 })
    })
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
const pointerType = fc.constantFrom(PointerType.Mouse, PointerType.Pen, PointerType.Touch)

/** Mutations whose added nodes are numbered from `firstId`. */
function mutations(firstId: number): fc.Arbitrary<MutationsEvent> {
    return fc
        .record({
            removes: fc.array(smallId, { maxLength: 5 }),
            adds: fc.array(
                fc.record({ parentId: smallId, beforeId: fc.nat(5000), nodes: fc.array(spec.node, { maxLength: 3 }) }),
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
    fc.record({ type: fc.constant(EventType.Navigation), url: fc.webUrl({ withQueryParameters: true }) })
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
            url: 'https://example.com/a/b',
            nextId: 8,
            root: {
                id: 1,
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
            url: 'about:blank',
            quirks: true,
            explicitIds: false,
            nextId: depth + 3,
            root: { kind: NodeKind.Document, id: 1, children: [node] }
        }
        const body = encodeEvent(event)
        const decoded = decodeEvent(EventType.Snapshot, body, { next: 1 })
        expect(decoded).toMatchObject({ quirks: true, nextId: depth + 3 })
        // Comparing the trees directly would recurse 50 000 levels deep; the re-encoding carries the same content.
        expect(decoded && encodeEvent(decoded)).toEqual(body)
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

    it('rejects documents among added nodes', () => {
        const writer = new EventWriter()
        // No removals, then one run under node 1, appended, of one node.
        for (const value of [0, 1, 1, 0, 1]) {
            writer.bytes.varuint(value)
        }
        writer.document(false)
        // No attribute or text changes.
        writer.bytes.varuint(0)
        writer.bytes.varuint(0)
        expect(decodeOutcome(EventType.Mutations, writer.bytes.finish())).toBe('TcrDecodeError')
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

    it('store pointer moves as small column deltas', () => {
        const times = Array.from({ length: 100 }, (_, i) => i * 16)
        const xs = times.map((_, i) => 500 + i)
        const ys = times.map((_, i) => 300 - i)
        const body = encodeEvent({ type: EventType.PointerMoves, pointer: PointerType.Mouse, times, xs, ys })
        // Pointer type and count, then one byte per value: 16 ms gaps and ±1 px steps.
        expect(body.length).toBeLessThan(310)
    })

    it('reject a pointer sample that does not start at offset 0', () => {
        expect(() =>
            encodeEvent({ type: EventType.PointerMoves, pointer: PointerType.Mouse, times: [5], xs: [0], ys: [0] })
        ).toThrow(RangeError)
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
            fc.property(fc.integer({ min: 0, max: 12 }), fc.uint8Array({ maxLength: 200 }), (type, body) => {
                expect(['ok', 'TcrDecodeError']).toContain(decodeOutcome(type, body))
            })
        )
    })

    it('rejects stray end tokens, unknown node kinds and flags', () => {
        expect(snapshotOutcome(NodeKind.End)).toBe('TcrDecodeError')
        expect(snapshotOutcome(6)).toBe('TcrDecodeError')
        // An end token with flags, and flags on a comment.
        expect(snapshotOutcome(NodeKind.Document | 0x08, NodeKind.End | 0x08)).toBe('TcrDecodeError')
        expect(snapshotOutcome(NodeKind.Document | 0x08, NodeKind.Comment | 0x08, 0, 0, NodeKind.End)).toBe(
            'TcrDecodeError'
        )
        expect(snapshotOutcome(NodeKind.Document | 0x10)).toBe('TcrDecodeError')
        // The root must be a document, and only the root.
        expect(snapshotOutcome(NodeKind.Comment, 0, 0)).toBe('TcrDecodeError')
        expect(snapshotOutcome(NodeKind.Document | 0x08, NodeKind.Document, NodeKind.End)).toBe('TcrDecodeError')
        expect(snapshotOutcome(NodeKind.Document)).toBe('ok')
        // Unknown snapshot flags.
        expect(decodeOutcome(EventType.Snapshot, new Uint8Array([4, 0, 0, NodeKind.Document]))).toBe('TcrDecodeError')
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
