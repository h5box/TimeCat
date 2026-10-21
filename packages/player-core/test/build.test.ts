import {
    ByteWriter,
    ChunkFlag,
    ChunkKind,
    decodeEvent,
    EventType,
    gunzip,
    InputKind,
    MediaKind,
    PointerAction,
    PointerType,
    readEventFrames,
    SheetChangeKind,
    SheetOwner,
    Track,
    writeChunk
} from '@timecat-js/protocol'
import type { MediaPacket, TcrEvent } from '@timecat-js/protocol'
import * as fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { buildIndex, StreamIndexer } from '../src/timeline/build.ts'
import { Timeline } from '../src/timeline/timeline.ts'
import type { TimelineIndex } from '../src/timeline/types.ts'
import { VirtualDocument } from '../src/timeline/virtual.ts'
import { operations, recordingOf } from './operations.ts'
import {
    build,
    concat,
    describeTree,
    mutations,
    pageOf,
    SESSION,
    writeChunks,
    writeMedia,
    writeRecording,
    writeSync
} from './recording.ts'

const options = { keyframeInterval: 2000 }

function typesOf(index: TimelineIndex): number[] {
    return [...index.events.types]
}

function timesOf(index: TimelineIndex): number[] {
    return [...index.events.times]
}

const page = pageOf([{ tag: 'p', children: [{ text: 'hello' }] }])

/** The events of a keyframe's sheets, which are left uncompressed when there are none. */
function gunzipStyles(styles: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    return styles.length === 0 ? Promise.resolve(styles) : gunzip(styles)
}

function eventsOf(payload: Uint8Array): (TcrEvent | undefined)[] {
    return readEventFrames(payload, 0).map(({ type, body }) => decodeEvent(type, body, { next: 0 }))
}

function treeOf(body: Uint8Array, ids: { next: number }): string {
    const snapshot = decodeEvent(EventType.Snapshot, body, ids)
    return snapshot?.type === EventType.Snapshot ? describeTree(snapshot.root) : 'not a snapshot'
}

describe('buildIndex', () => {
    it('orders events by time, then track, each track in recording order', async () => {
        const recording = writeRecording([
            { time: 10, event: { type: EventType.Input, changes: [{ kind: InputKind.Value, id: 6, value: 'b' }] } },
            { time: 5, event: page },
            { time: 10, event: { type: EventType.Viewport, width: 800, height: 600 } },
            { time: 10, event: mutations({ texts: [{ id: 7, data: 'first' }] }) },
            { time: 10, event: mutations({ texts: [{ id: 7, data: 'second' }] }) },
            { time: 7, event: { type: EventType.Navigation, id: 1, url: 'https://example.com/next' } }
        ])
        const index = await buildIndex([recording], options)
        expect(typesOf(index)).toEqual([
            EventType.Snapshot,
            EventType.Navigation,
            EventType.Mutations,
            EventType.Mutations,
            EventType.Input,
            EventType.Viewport
        ])
        expect(timesOf(index)).toEqual([5, 7, 10, 10, 10, 10])
        const timeline = new Timeline(index)
        expect(timeline.event(2)).toMatchObject({ texts: [{ data: 'first' }] })
        expect(timeline.event(3)).toMatchObject({ texts: [{ data: 'second' }] })
        expect(index).toMatchObject({ sessionId: SESSION.sessionId, startedAt: SESSION.startedAt, start: 5, end: 10 })
        expect(index.warnings).toEqual([])
        // The snapshot's 7 nodes, then one unit per navigation, text change, input change and viewport.
        expect([...index.events.costs]).toEqual([0, 7, 8, 9, 10, 11, 12])
        expect(index.keyframes).toMatchObject([{ index: 1, time: 5, recorded: true, cost: 7 }])
    })

    it('gives each event the next free id before it, which its implicit ids continue from', async () => {
        const ids = { next: page.nextId }
        const added = build({ tag: 'b', children: [{ text: 'x' }] }, ids)
        const index = await buildIndex(
            [
                writeRecording([
                    { time: 0, event: page },
                    { time: 1, event: mutations({ adds: [{ parentId: 5, beforeId: 0, nodes: [added] }] }) },
                    { time: 2, event: mutations({ texts: [{ id: 9, data: 'y' }] }) }
                ])
            ],
            options
        )
        expect([...index.events.idBases]).toEqual([1, 8, 10])
        expect(new Timeline(index).event(1)).toMatchObject({ adds: [{ nodes: [{ id: 8, children: [{ id: 9 }] }] }] })
    })

    it('puts segments one after the other, whatever their clocks say', async () => {
        const first = writeRecording(
            [
                { time: 0, event: page },
                { time: 1000, event: { type: EventType.Viewport, width: 800, height: 600 } }
            ],
            { segment: 0, meta: { first: true } }
        )
        const second = writeRecording([{ time: 20, event: page }], {
            segment: 1,
            startedAt: SESSION.startedAt + 400,
            meta: { first: false }
        })
        const third = writeRecording([{ time: 0, event: page }], { segment: 2, startedAt: SESSION.startedAt + 5000 })
        const index = await buildIndex([third, first, second], options)
        // The second segment starts 400 ms in by its clock, but the first one lasts until 1000 ms.
        expect(timesOf(index)).toEqual([0, 1000, 1020, 5000])
        expect(index.meta).toEqual({ first: true })
        expect(index.keyframes.map(keyframe => keyframe.index)).toEqual([1, 3, 4])
        await expect(buildIndex([first, writeRecording([], { sessionId: 'other' })], options)).rejects.toThrow(
            'segments of different sessions'
        )
        await expect(buildIndex([], options)).rejects.toThrow('no recording')
    })

    it('reads a recording that was cut off, up to where it ends', async () => {
        const recording = writeRecording([
            { time: 0, event: page },
            { time: 5, event: mutations({ texts: [{ id: 7, data: 'kept' }] }) },
            { time: 9, event: mutations({ texts: [{ id: 7, data: 'lost' }] }) }
        ])
        const index = await buildIndex([recording.subarray(0, recording.length - 3)], options)
        expect(timesOf(index)).toEqual([0, 5])
        expect(index.warnings).toEqual([expect.stringContaining('segment 0 is cut short')])
        await expect(buildIndex([new Uint8Array([1, 2, 3, 4])], options)).rejects.toThrow('magic')
    })

    it('leaves out DOM events after one it cannot read, until the next snapshot', async () => {
        const writer = new ByteWriter()
        writer.raw(writeRecording([{ time: 0, event: page }]))
        // A DOM chunk whose payload is not gzip data, though its flags say so.
        writeChunk(writer, {
            kind: ChunkKind.Events,
            track: Track.Dom,
            flags: ChunkFlag.Gzip,
            sequence: 1,
            startTime: 10,
            duration: 0,
            payload: new Uint8Array([1, 2, 3])
        })
        const rest = writeRecording(
            [
                { time: 20, event: mutations({ texts: [{ id: 7, data: 'skipped' }] }) },
                { time: 20, event: { type: EventType.Viewport, width: 640, height: 480 } },
                { time: 30, event: page },
                { time: 40, event: mutations({ texts: [{ id: 7, data: 'applied' }] }) }
            ],
            {},
            2
        )
        // Only the chunks of the second file, after its header.
        const header = writeRecording([]).length
        writer.raw(rest.subarray(header))
        const index = await buildIndex([writer.finish()], options)
        expect(typesOf(index)).toEqual([
            EventType.Snapshot,
            EventType.Viewport,
            EventType.Snapshot,
            EventType.Mutations
        ])
        expect(index.warnings).toEqual([expect.stringContaining('chunk 1 of segment 0 cannot be read')])
    })

    it('skips events of unknown types and reports ones that do not decode', async () => {
        const writer = new ByteWriter()
        writer.raw(writeRecording([{ time: 0, event: page }]))
        // An event type this player does not know, then a body that does not decode.
        for (const [sequence, type] of [200, EventType.Mutations].entries()) {
            const payload = new ByteWriter()
            payload.varuint(type)
            payload.varuint(0)
            payload.bytes(new Uint8Array([0xff]))
            writeChunk(writer, {
                kind: ChunkKind.Events,
                track: Track.Dom,
                flags: 0,
                sequence: sequence + 1,
                startTime: 3,
                duration: 0,
                payload: payload.finish()
            })
        }
        const index = await buildIndex([writer.finish()], options)
        expect(typesOf(index)).toEqual([EventType.Snapshot])
        expect(index.warnings).toEqual([expect.stringContaining('an event at 3 ms cannot be read')])
    })

    it('collects the pointer trail apart from the events', async () => {
        const recording = writeRecording([
            { time: 0, event: page },
            {
                time: 100,
                event: {
                    type: EventType.PointerMoves,
                    pointer: PointerType.Mouse,
                    times: [0, 16, 40],
                    xs: [1, 2, 3],
                    ys: [4, 5, 6]
                }
            },
            {
                time: 150,
                event: {
                    type: EventType.PointerButton,
                    action: PointerAction.Down,
                    pointer: PointerType.Touch,
                    button: 0,
                    x: 7,
                    y: 8,
                    targetId: 6
                }
            }
        ])
        const index = await buildIndex([recording], options)
        expect(typesOf(index)).toEqual([EventType.Snapshot])
        const { pointer } = index
        expect([...pointer.times]).toEqual([100, 116, 140, 150])
        expect([...pointer.xs]).toEqual([1, 2, 3, 7])
        expect([...pointer.ys]).toEqual([4, 5, 6, 8])
        expect([...pointer.pointers]).toEqual([0, 0, 0, PointerType.Touch])
        expect([...pointer.buttons.times]).toEqual([150])
        expect([...pointer.buttons.actions]).toEqual([PointerAction.Down])
        expect(index.end).toBe(150)
    })

    it('keeps fonts and assets apart from the events: they hold for the whole recording', async () => {
        const font: TcrEvent = {
            type: EventType.FontFace,
            family: 'Brand',
            source: 'url("blob:https://example.com/font")',
            descriptors: ['weight', '700']
        }
        const asset: TcrEvent = {
            type: EventType.Asset,
            url: 'blob:https://example.com/font',
            mimeType: 'font/woff2',
            data: new Uint8Array([1, 2, 3])
        }
        const index = await buildIndex(
            [
                writeRecording([
                    { time: 0, event: page },
                    { time: 40, event: font },
                    { time: 50, event: mutations({ texts: [{ id: 7, data: 'x' }] }) },
                    { time: 60, event: asset }
                ])
            ],
            options
        )
        expect(typesOf(index)).toEqual([EventType.Snapshot, EventType.Mutations])
        expect(eventsOf(index.statics)).toEqual([font, asset])
        expect(index.end).toBe(60)
    })

    it('keeps the events recorded beside the page apart, in time order', async () => {
        const log: TcrEvent = { type: EventType.Console, level: 1, source: 0, args: ['hi'], stack: '' }
        const request: TcrEvent = {
            type: EventType.Network,
            initiator: 'fetch',
            method: 'GET',
            url: 'https://example.com/',
            status: 200,
            duration: 12,
            size: 0,
            error: ''
        }
        const custom: TcrEvent = { type: EventType.Custom, name: 'ready', data: 'null' }
        const index = await buildIndex(
            [
                writeRecording([
                    { time: 0, event: page },
                    { time: 70, event: custom },
                    { time: 30, event: log },
                    { time: 50, event: mutations({ texts: [{ id: 7, data: 'x' }] }) },
                    { time: 30, event: request }
                ])
            ],
            options
        )
        expect(typesOf(index)).toEqual([EventType.Snapshot, EventType.Mutations])
        expect(readEventFrames(index.data, 0).map(({ time }) => time)).toEqual([30, 30, 70])
        expect(eventsOf(index.data)).toEqual([log, request, custom])
        expect(index.end).toBe(70)
    })

    it('restores the sheets the CSSOM changed from keyframes, and counts their rules in the cost', async () => {
        // body 5: p 6 ("hello" 7), then a style 8 ("p {}" 9)
        const style = build({ tag: 'style', children: [{ text: 'p {}' }] }, { next: page.nextId })
        const constructed: TcrEvent = {
            type: EventType.StyleSheet,
            owner: SheetOwner.Constructed,
            id: 1,
            changes: [{ kind: SheetChangeKind.Replace, rules: ['a { color: red; }'] }]
        }
        const adopted: TcrEvent = { type: EventType.AdoptedStyleSheets, id: 1, sheets: [1, 2] }
        const inserted: TcrEvent = {
            type: EventType.StyleSheet,
            owner: SheetOwner.Node,
            id: 8,
            changes: [{ kind: SheetChangeKind.Insert, index: 1, rule: 'b { color: blue; }' }]
        }
        const index = await buildIndex(
            [
                writeRecording([
                    { time: 0, event: page },
                    { time: 1, event: constructed },
                    { time: 2, event: adopted },
                    { time: 3, event: mutations({ adds: [{ parentId: 5, beforeId: 0, nodes: [style] }] }) },
                    { time: 4, event: inserted }
                ])
            ],
            { keyframeInterval: 1 }
        )
        expect(index.keyframes.map(keyframe => keyframe.index)).toEqual([1, 5])
        const keyframe = index.keyframes[1]!
        // 9 nodes, the rule of the constructed sheet and the one the CSSOM inserted.
        expect(keyframe.cost).toBe(11)
        // Sheet 2 was never made.
        expect(eventsOf(await gunzip(keyframe.styles))).toEqual([constructed, inserted, { ...adopted, sheets: [1] }])
        expect(index.keyframes[0]!.styles).toEqual(new Uint8Array(0))
    })

    it('writes keyframes that match applying the events before them', async () => {
        await fc.assert(
            fc.asyncProperty(operations(80), fc.integer({ min: 1, max: 40 }), async (steps, interval) => {
                const events = recordingOf(steps)
                const index = await buildIndex([writeRecording(events)], { keyframeInterval: interval })
                expect(index.warnings).toEqual([])
                const timeline = new Timeline(index)
                const { keyframes, events: table } = index
                // Keyframes follow an event and share its time. Recorded ones follow the snapshot they show.
                expect(keyframes.map(keyframe => keyframe.time)).toEqual(
                    keyframes.map(keyframe => table.times[keyframe.index - 1])
                )
                const recorded = keyframes.filter(keyframe => keyframe.recorded)
                expect(recorded.map(keyframe => table.types[keyframe.index - 1])).toEqual(
                    recorded.map(() => EventType.Snapshot)
                )
                const synthetic = keyframes.filter(keyframe => !keyframe.recorded)
                const snapshots = await Promise.all(synthetic.map(keyframe => gunzip(keyframe.snapshot)))
                const styles = await Promise.all(synthetic.map(keyframe => gunzipStyles(keyframe.styles)))
                for (const [n, keyframe] of synthetic.entries()) {
                    // A fresh document, given the events before the keyframe, ends up in the keyframe's state.
                    const reference = new VirtualDocument()
                    for (let i = 0; i < keyframe.index; i++) {
                        reference.apply(timeline.event(i)!)
                    }
                    const expected = reference.encode(0)!
                    const ids = { next: 0 }
                    expect(treeOf(snapshots[n]!, ids)).toBe(treeOf(expected.snapshot, { next: 0 }))
                    expect(keyframe.input).toEqual(expected.input)
                    expect(keyframe.scroll).toEqual(expected.scroll)
                    expect(styles[n]).toEqual(expected.styles)
                    // Mutations after the keyframe go on with the ids it declares.
                    expect(ids.next).toBe(table.idBases[keyframe.index] ?? ids.next)
                }
                // Keyframes come in order, at most one after each event.
                const positions = keyframes.map(keyframe => keyframe.index)
                expect(positions).toEqual(positions.toSorted((a, b) => a - b))
                expect(new Set(positions).size).toBe(positions.length)
            }),
            { numRuns: 40 }
        )
    })
})

/** A stream indexer that hands on what it indexed as soon as it can, and what it handed on. */
function openStream(keyframeInterval = 2000) {
    const parts: TimelineIndex[] = []
    const errors: unknown[] = []
    const indexer = new StreamIndexer(
        { keyframeInterval },
        part => parts.push(part),
        error => errors.push(error),
        0
    )
    /** Waits until a part says that nothing more is to come. */
    const finished = () => vi.waitFor(() => expect(parts.at(-1)?.done).toBe(true))
    return { indexer, parts, errors, finished }
}

function timelineOf(parts: readonly TimelineIndex[]): Timeline {
    const timeline = new Timeline(parts[0]!)
    for (const part of parts.slice(1)) {
        timeline.append(part)
    }
    return timeline
}

/** The columns of an index made of parts, put back together. */
function joined(parts: readonly TimelineIndex[]) {
    return {
        times: parts.flatMap(part => [...part.events.times]),
        types: parts.flatMap(part => [...part.events.types]),
        idBases: parts.flatMap(part => [...part.events.idBases]),
        bodies: parts.flatMap(({ events }) =>
            Array.from(events.offsets, (offset, i) =>
                Array.from(events.bodies.subarray(offset, offset + events.lengths[i]!))
            )
        ),
        costs: [parts[0]!.events.costs[0]!, ...parts.flatMap(part => [...part.events.costs.subarray(1)])],
        keyframes: parts.flatMap(part =>
            part.keyframes.map(({ index, time, cost, recorded, input, scroll }) => ({
                index,
                time,
                cost,
                recorded,
                input: [...input],
                scroll: [...scroll]
            }))
        ),
        pointer: parts.flatMap(part => [...part.pointer.times]),
        data: parts.flatMap(part => eventsOf(part.data))
    }
}

describe('StreamIndexer', () => {
    const log: TcrEvent = { type: EventType.Console, level: 1, source: 0, args: ['hi'], stack: '' }

    it('holds page events back until a sync point says that none before them can come', async () => {
        const { indexer, parts, finished } = openStream()
        indexer.push(
            concat(
                writeRecording([{ time: 0, event: page }]),
                writeChunks(
                    [
                        { time: 50, event: { type: EventType.Viewport, width: 800, height: 600 } },
                        { time: 30, event: log }
                    ],
                    1
                ),
                writeSync(40, 3)
            )
        )
        await vi.waitFor(() => expect(parts).toHaveLength(1))
        // The viewport waits, which a page event of another track before it could still overtake; data does not.
        expect(parts[0]).toMatchObject({ start: 0, end: 40, done: false, sessionId: SESSION.sessionId })
        expect(typesOf(parts[0]!)).toEqual([EventType.Snapshot])
        expect(eventsOf(parts[0]!.data)).toEqual([log])
        indexer.push(
            writeChunks(
                [
                    { time: 45, event: mutations({ texts: [{ id: 7, data: 'x' }] }) },
                    // Before the sync point, which it is taken to come at.
                    { time: 20, event: { type: EventType.Input, changes: [] } }
                ],
                4
            )
        )
        indexer.end()
        await finished()
        const last = parts.at(-1)!
        expect(last).toMatchObject({ end: 50, done: true, warnings: [] })
        expect(joined(parts).types).toEqual([
            EventType.Snapshot,
            EventType.Input,
            EventType.Mutations,
            EventType.Viewport
        ])
        expect(joined(parts).times).toEqual([0, 40, 45, 50])
        const timeline = timelineOf(parts)
        expect(timeline).toMatchObject({ start: 0, end: 50, done: true, count: 4 })
        expect(timeline.event(2)).toMatchObject({ texts: [{ data: 'x' }] })
        // The snapshot's 7 nodes, a text change and a viewport; the input changes nothing.
        expect(timeline.cost(0, 4)).toBe(9)
    })

    it('indexes a stream in pieces of any size as the whole recording, sync points or not', async () => {
        await fc.assert(
            fc.asyncProperty(
                operations(40),
                fc.array(fc.nat(), { maxLength: 6 }),
                fc.array(fc.integer({ min: 1, max: 400 }), { maxLength: 8 }),
                async (steps, syncs, pieces) => {
                    const events = recordingOf(steps)
                    const cut = Math.ceil(events.length / 2)
                    const first = events.slice(0, cut)
                    const second = events
                        .slice(cut)
                        .map(({ time, event }) => ({ time: time - events[cut]!.time, event }))
                    const segments = [
                        writeRecording(first, { segment: 0 }),
                        writeRecording(second, { segment: 1, startedAt: SESSION.startedAt + 10_000 })
                    ]
                    const whole = await buildIndex(segments, { keyframeInterval: 10 })
                    // The same events, with sync points among them that keep their promise.
                    const positions = new Set(syncs.map(sync => sync % (first.length + 1)))
                    let sequence = 0
                    const streamed: Uint8Array[] = [writeRecording([], { segment: 0 })]
                    for (const [i, event] of first.entries()) {
                        if (positions.has(i)) {
                            const time = Math.min(...first.slice(i).map(later => later.time))
                            streamed.push(writeSync(time, sequence++))
                        }
                        streamed.push(writeChunks([event], sequence++))
                    }
                    streamed.push(segments[1]!)
                    const bytes = concat(...streamed)
                    const { indexer, parts, errors, finished } = openStream(10)
                    let offset = 0
                    for (const size of [...pieces, bytes.length]) {
                        indexer.push(bytes.subarray(offset, offset + size))
                        offset += size
                        // oxlint-disable-next-line no-await-in-loop -- lets parts be handed on in between
                        await new Promise(resolve => setTimeout(resolve, 0))
                    }
                    indexer.end()
                    await finished()
                    expect(errors).toEqual([])
                    expect(joined(parts)).toEqual(joined([whole]))
                    const last = parts.at(-1)!
                    expect(last.end).toBe(whole.end)
                    expect(parts.flatMap(part => part.warnings)).toEqual(whole.warnings)
                    // Every part goes on from where the one before ended.
                    expect(parts.map(part => part.start)).toEqual(parts.map(() => whole.start))
                    const timeline = timelineOf(parts)
                    expect(timeline.count).toBe(whole.events.count)
                    expect(timeline.keyframes.map(keyframe => keyframe.index)).toEqual(
                        whole.keyframes.map(keyframe => keyframe.index)
                    )
                    for (let i = 0; i < timeline.count; i++) {
                        expect(timeline.event(i)).toEqual(new Timeline(whole).event(i))
                    }
                }
            ),
            { numRuns: 25 }
        )
    })

    it('says when the bytes are no recording, or end before one starts', async () => {
        const garbage = openStream()
        garbage.indexer.push(new TextEncoder().encode('not a recording at all'))
        expect(garbage.errors).toHaveLength(1)
        garbage.indexer.end()
        const empty = openStream()
        empty.indexer.end()
        await vi.waitFor(() => expect(empty.errors).toHaveLength(1))
        expect(empty.errors[0]).toMatchObject({ message: 'no recording to load' })
        expect(garbage.parts).toEqual([])
        expect(empty.parts).toEqual([])
    })

    it('warns of bytes at the end that make no whole chunk', async () => {
        const { indexer, parts, finished } = openStream()
        const recording = writeRecording([
            { time: 0, event: page },
            { time: 10, event: mutations({ texts: [{ id: 7, data: 'x' }] }) }
        ])
        indexer.push(recording.subarray(0, recording.length - 3))
        indexer.end()
        await finished()
        expect(joined(parts).types).toEqual([EventType.Snapshot])
        expect(parts.flatMap(part => part.warnings)).toEqual([expect.stringContaining('the recording is cut short')])
    })
})

function packet(time: number, key: boolean, byte: number): MediaPacket {
    return { time, duration: 40_000, key, data: new Uint8Array([byte]) }
}

describe('media', () => {
    const declaration: TcrEvent = {
        type: EventType.MediaTrack,
        track: 256,
        kind: MediaKind.Video,
        targetId: 6,
        codec: 'vp8',
        description: new Uint8Array(0),
        container: '',
        width: 64,
        height: 48,
        sampleRate: 0,
        channels: 0
    }
    const state: TcrEvent = {
        type: EventType.MediaState,
        id: 6,
        paused: false,
        muted: true,
        currentTime: 1.5,
        playbackRate: 1,
        volume: 1
    }
    it('keeps media declarations, element states and packets apart from the events', async () => {
        const recording = concat(
            writeRecording([
                { time: 0, event: page },
                { time: 10, event: declaration },
                { time: 20, event: state }
            ]),
            writeMedia(256, [packet(10_500, true, 1), packet(50_500, false, 2)], 3),
            // A chunk that cannot be read: the packets after it wait for the next key packet.
            writeMedia(256, [packet(90_000, false, 3)], 4).map((byte, i, bytes) =>
                i === bytes.length - 2 ? 0x80 : byte
            ),
            writeMedia(256, [packet(130_000, false, 4), packet(170_000, true, 5)], 5),
            writeMedia(257, [packet(0, true, 6)], 6)
        )
        const index = await buildIndex([recording], options)
        expect(typesOf(index)).toEqual([EventType.Snapshot])
        expect(index.media.tracks).toEqual([{ time: 10, event: declaration }])
        expect(index.media.states).toEqual([{ time: 20, event: state }])
        const { packets } = index.media
        expect([...packets.tracks]).toEqual([256, 256, 256, 257])
        expect([...packets.times]).toEqual([10.5, 50.5, 170, 0])
        expect([...packets.durations]).toEqual([40, 40, 40, 40])
        expect([...packets.keys]).toEqual([1, 0, 1, 1])
        expect([...packets.lengths].map((length, i) => packets.data[packets.offsets[i]!])).toEqual([1, 2, 5, 6])
        expect(index.warnings).toEqual([expect.stringContaining('its media is left out')])
        // Media count towards the length of the recording.
        expect(index.end).toBe(210)
        const timeline = new Timeline(index)
        expect(timeline.hasMedia).toBe(true)
        expect(timeline.packets(256)).toMatchObject({ times: [10.5, 50.5, 170], keys: [true, false, true] })
        expect(timeline.snapshotBefore(5)).toBe(0)
        expect(timeline.snapshotBefore(-1)).toBe(-Infinity)
    })
})
