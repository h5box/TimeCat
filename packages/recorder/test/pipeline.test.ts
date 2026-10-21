import {
    ChunkFlag,
    ChunkKind,
    EventType,
    FIRST_DYNAMIC_TRACK,
    gunzip,
    readEventFrames,
    readFile,
    readMediaPackets,
    Track
} from '@timecat-js/protocol'
import type { MediaPacket, SegmentInfo } from '@timecat-js/protocol'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BatchWriter } from '../src/batch.ts'
import { Pipeline } from '../src/pipeline/pipeline.ts'

const info: SegmentInfo = { sessionId: 'pipeline-test', segment: 1, startedAt: 1_760_000_000_000, meta: { a: 1 } }
const MAX_PAYLOAD = 128 * 1024
const MAX_SPAN = 5000

interface Written {
    track: number
    type: number
    time: number
    body: Uint8Array
}

/** Runs events through a pipeline and reads the file back. */
async function roundTrip(events: readonly Written[]) {
    const parts: Uint8Array[] = []
    const errors: unknown[] = []
    const pipeline = new Pipeline(
        info,
        bytes => void parts.push(bytes),
        error => void errors.push(error)
    )
    for (const { track, type, time, body } of events) {
        pipeline.event(track, type, time, body)
    }
    await pipeline.close()
    expect(errors).toEqual([])
    const file = readFile(concat(parts))
    const chunks = await Promise.all(
        file.chunks.map(async chunk => {
            const payload = chunk.flags & ChunkFlag.Gzip ? await gunzip(chunk.payload) : chunk.payload
            return { chunk, payload, frames: readEventFrames(payload, chunk.startTime) }
        })
    )
    return { header: file.header, chunks }
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'))

/** Events with their bodies as hex, which `toEqual` compares far faster than long byte arrays. */
function comparable(events: readonly Written[]): { track: number; type: number; time: number; body: string }[] {
    return events.map(({ track, type, time, body: bytes }) => {
        let hex = ''
        for (const byte of bytes) {
            hex += HEX[byte]
        }
        return { track, type, time, body: hex }
    })
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
    let offset = 0
    for (const part of parts) {
        result.set(part, offset)
        offset += part.length
    }
    return result
}

/** A packet with its data as its length and its first byte, which compare far faster. */
function brief({ data, ...rest }: MediaPacket): Omit<MediaPacket, 'data'> & { size: number; fill: number | undefined } {
    return { ...rest, size: data.length, fill: data[0] }
}

const TYPES: Record<number, number[]> = {
    [Track.Dom]: [EventType.Snapshot, EventType.Mutations],
    [Track.Input]: [EventType.Input],
    [Track.Pointer]: [EventType.PointerMoves, EventType.PointerButton],
    [Track.Scroll]: [EventType.Scroll]
}

const body = fc.oneof(
    { weight: 6, arbitrary: fc.uint8Array({ maxLength: 300 }) },
    // Compressible and large enough to fill chunks quickly.
    {
        weight: 1,
        arbitrary: fc
            .tuple(fc.integer({ min: 1, max: 70_000 }), fc.integer({ min: 0, max: 255 }))
            .map(([length, byte]) => new Uint8Array(length).fill(byte))
    }
)

const event = fc.constantFrom(Track.Dom, Track.Input, Track.Pointer, Track.Scroll).chain(track =>
    fc.record({
        track: fc.constant(track),
        type: fc.constantFrom(...TYPES[track]!),
        delay: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 4000 })),
        body
    })
)

/** Events with times that never decrease, as the capture writes them. */
const recording = fc.array(event, { maxLength: 60 }).map(items => {
    let time = 0
    return items.map(({ track, type, delay, body: bytes }): Written => {
        time += delay
        return { track, type, time, body: bytes }
    })
})

describe('Pipeline', () => {
    it('writes every event once, per track in order, in well-formed chunks', async () => {
        await fc.assert(
            fc.asyncProperty(recording, async events => {
                const { header, chunks } = await roundTrip(events)
                expect(header).toMatchObject(info)
                expect(chunks.map(({ chunk }) => chunk.sequence)).toEqual(chunks.map((_, i) => i))
                for (const track of [Track.Dom, Track.Input, Track.Pointer, Track.Scroll]) {
                    const read = chunks
                        .filter(({ chunk }) => chunk.track === track)
                        .flatMap(({ chunk, frames }) => frames.map(frame => ({ track: chunk.track, ...frame })))
                    expect(comparable(read)).toEqual(comparable(events.filter(item => item.track === track)))
                }
                for (const { chunk, payload, frames } of chunks) {
                    const first = frames[0]!
                    const last = frames[frames.length - 1]!
                    expect(chunk.startTime).toBe(first.time)
                    expect(chunk.duration).toBe(last.time - first.time)
                    // A snapshot starts a chunk, and only those Dom chunks are keyframes.
                    expect(frames.slice(1).some(frame => frame.type === EventType.Snapshot)).toBe(false)
                    const keyframe = chunk.track !== Track.Dom || first.type === EventType.Snapshot
                    expect((chunk.flags & ChunkFlag.Keyframe) !== 0).toBe(keyframe)
                    // Chunks stay within their limits, except one oversized event on its own.
                    expect(frames.length === 1 || payload.length <= MAX_PAYLOAD + 16).toBe(true)
                    expect(last.time - first.time < MAX_SPAN || frames.length === 1).toBe(true)
                    // Compression is kept only where it pays.
                    const compressed = (chunk.flags & ChunkFlag.Gzip) !== 0
                    expect(!compressed || (payload.length >= 128 && chunk.payload.length < payload.length)).toBe(true)
                }
            }),
            { numRuns: 60 }
        )
    })

    it('joins the pieces of a time-sliced event', async () => {
        const parts: Uint8Array[] = []
        const pipeline = new Pipeline(
            info,
            bytes => void parts.push(bytes),
            error => {
                throw error
            }
        )
        const batch = new BatchWriter(bytes => pipeline.push(bytes))
        batch.part(Track.Dom, new Uint8Array([1, 2]))
        batch.commit()
        batch.event(Track.Input, EventType.Input, 3, new Uint8Array([9]))
        batch.part(Track.Dom, new Uint8Array([3]))
        batch.commit()
        batch.event(Track.Dom, EventType.Snapshot, 5, new Uint8Array([4, 5]))
        batch.commit()
        await pipeline.close()
        const { chunks } = readFile(concat(parts))
        const events = chunks.flatMap(chunk => readEventFrames(chunk.payload, chunk.startTime))
        expect(events).toEqual([
            { type: EventType.Input, time: 3, body: new Uint8Array([9]) },
            { type: EventType.Snapshot, time: 5, body: new Uint8Array([1, 2, 3, 4, 5]) }
        ])
    })

    it('drops an event that never completed when it closes', async () => {
        const parts: Uint8Array[] = []
        const pipeline = new Pipeline(
            info,
            bytes => void parts.push(bytes),
            error => {
                throw error
            }
        )
        pipeline.part(Track.Dom, new Uint8Array([1, 2, 3]))
        await pipeline.close()
        expect(readFile(concat(parts)).chunks).toEqual([])
    })

    it('writes media packets in chunks that start at key packets', async () => {
        const packet = fc.record({
            delay: fc.oneof(fc.nat(40_000), fc.nat(3_000_000)),
            duration: fc.nat(40_000),
            key: fc.boolean(),
            size: fc.oneof({ weight: 5, arbitrary: fc.nat(2000) }, { weight: 1, arbitrary: fc.nat(100_000) })
        })
        await fc.assert(
            fc.asyncProperty(fc.array(packet, { minLength: 1, maxLength: 40 }), async items => {
                let time = 1234
                const packets = items.map(({ delay, duration, key, size }, i): MediaPacket => ({
                    time: (time += delay),
                    duration,
                    key: key || i === 0,
                    data: new Uint8Array(size).fill(i)
                }))
                const parts: Uint8Array[] = []
                const pipeline = new Pipeline(
                    info,
                    bytes => void parts.push(bytes),
                    error => {
                        throw error
                    }
                )
                const batch = new BatchWriter(bytes => pipeline.push(bytes))
                for (const item of packets) {
                    batch.media(FIRST_DYNAMIC_TRACK, item)
                }
                batch.commit()
                await pipeline.close()
                const { chunks } = readFile(concat(parts))
                const read = chunks.map(chunk => readMediaPackets(chunk.payload, chunk.startTime))
                expect(read.flat().map(brief)).toEqual(packets.map(brief))
                for (const [i, chunk] of chunks.entries()) {
                    const inChunk = read[i]!
                    expect(chunk).toMatchObject({ kind: ChunkKind.Media, track: FIRST_DYNAMIC_TRACK })
                    expect(chunk.flags).toBe(inChunk[0]!.key ? ChunkFlag.Keyframe : 0)
                    expect(inChunk.slice(1).some(item => item.key)).toBe(false)
                    expect(chunk.startTime).toBe(Math.floor(inChunk[0]!.time / 1000))
                    const end = Math.max(...inChunk.map(item => item.time + item.duration))
                    expect(chunk.startTime + chunk.duration).toBe(Math.ceil(end / 1000))
                    const last = inChunk[inChunk.length - 1]!
                    expect(inChunk.length === 1 || last.time / 1000 - chunk.startTime < MAX_SPAN).toBe(true)
                }
            }),
            { numRuns: 40 }
        )
    })

    it('writes sync chunks after the chunks they complete, and no page event before them', async () => {
        const parts: Uint8Array[] = []
        const pipeline = new Pipeline(
            info,
            bytes => void parts.push(bytes),
            error => {
                throw error
            }
        )
        const batch = new BatchWriter(bytes => pipeline.push(bytes))
        batch.event(Track.Dom, EventType.Mutations, 10, new Uint8Array([1]))
        batch.event(Track.Console, EventType.Console, 5, new Uint8Array([2]))
        batch.sync(100)
        batch.event(Track.Pointer, EventType.PointerButton, 50, new Uint8Array([3]))
        batch.event(Track.Console, EventType.Console, 20, new Uint8Array([4]))
        batch.sync(90)
        batch.commit()
        await pipeline.close()
        const { chunks } = readFile(concat(parts))
        const summary = chunks.map(({ kind, track, startTime, payload }) => ({
            kind,
            track,
            times: kind === ChunkKind.Events ? readEventFrames(payload, startTime).map(frame => frame.time) : startTime
        }))
        expect(summary).toEqual([
            { kind: ChunkKind.Events, track: Track.Dom, times: [10] },
            { kind: ChunkKind.Events, track: Track.Console, times: [5] },
            { kind: ChunkKind.Sync, track: 0, times: 100 },
            // The console is no page track; the pointer event comes after the sync point, so it is moved to it.
            { kind: ChunkKind.Events, track: Track.Console, times: [20] },
            { kind: ChunkKind.Events, track: Track.Pointer, times: [100] },
            // Sync points do not go back.
            { kind: ChunkKind.Sync, track: 0, times: 100 }
        ])
        expect(chunks.map(chunk => chunk.sequence)).toEqual([0, 1, 2, 3, 4, 5])
    })
})
