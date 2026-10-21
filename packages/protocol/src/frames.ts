import { TcrDecodeError } from './errors.ts'
import { ByteReader } from './reader.ts'
import type { ByteWriter } from './writer.ts'

/** An event inside an events chunk, with its body still encoded. */
export interface EventFrame {
    type: number
    /** Milliseconds from the segment start. */
    time: number
    body: Uint8Array
}

/**
 * Appends an event to an events chunk payload. `delta` is the time since the previous event of the chunk, or
 * since the chunk's start time for the first one.
 */
export function writeEventFrame(writer: ByteWriter, type: number, delta: number, body: Uint8Array): void {
    writer.varuint(type)
    writer.varuint(delta)
    writer.bytes(body)
}

/** Splits an events chunk payload into its events. Bodies are views into `payload`. */
export function readEventFrames(payload: Uint8Array, startTime: number): EventFrame[] {
    const reader = new ByteReader(payload)
    const frames: EventFrame[] = []
    let time = startTime
    while (reader.remaining > 0) {
        const type = reader.varuint()
        time += reader.varuint()
        if (!Number.isSafeInteger(time)) {
            throw new TcrDecodeError('event time exceeds the safe integer range')
        }
        frames.push({ type, time, body: reader.bytes() })
    }
    return frames
}
