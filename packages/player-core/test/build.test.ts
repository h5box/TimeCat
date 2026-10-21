import {
    ByteWriter,
    ChunkFlag,
    ChunkKind,
    decodeEvent,
    EventType,
    gunzip,
    InputKind,
    PointerAction,
    PointerType,
    readEventFrames,
    SheetChangeKind,
    SheetOwner,
    Track,
    writeChunk
} from '@timecat-js/protocol'
import type { TcrEvent } from '@timecat-js/protocol'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildIndex } from '../src/timeline/build.ts'
import { Timeline } from '../src/timeline/timeline.ts'
import type { TimelineIndex } from '../src/timeline/types.ts'
import { VirtualDocument } from '../src/timeline/virtual.ts'
import { operations, recordingOf } from './operations.ts'
import { build, describeTree, mutations, pageOf, SESSION, writeRecording } from './recording.ts'

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
