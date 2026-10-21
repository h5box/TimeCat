import { ChunkFlag, EventType, gunzip, readEventFrames, readFile, Track } from '@timecat-js/protocol'
import type { SegmentInfo } from '@timecat-js/protocol'
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
})
