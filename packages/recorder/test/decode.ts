import { ChunkFlag, ChunkKind, decodeEvent, gunzip, readEventFrames, readFile } from '@timecat-js/protocol'
import type { Chunk, FileHeader, TcrEvent } from '@timecat-js/protocol'

export interface DecodedEvent {
    track: number
    time: number
    event: TcrEvent
}

export interface DecodedRecording {
    header: FileHeader
    chunks: Chunk[]
    /** Every event, in replay order: by time, then by track. */
    events: DecodedEvent[]
}

/** Decodes a whole recording the way a player orders it. */
export async function decodeRecording(source: Blob | Uint8Array): Promise<DecodedRecording> {
    const bytes = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source
    const { header, chunks } = readFile(bytes)
    const frames: { track: number; type: number; time: number; body: Uint8Array }[] = []
    for (const chunk of chunks) {
        if (chunk.kind !== ChunkKind.Events) {
            continue
        }
        // oxlint-disable-next-line no-await-in-loop -- chunks are few in tests
        const payload = chunk.flags & ChunkFlag.Gzip ? await gunzip(chunk.payload) : chunk.payload
        for (const frame of readEventFrames(payload, chunk.startTime)) {
            frames.push({ track: chunk.track, ...frame })
        }
    }
    // Stable, so events of one track keep their order.
    frames.sort((a, b) => a.time - b.time || a.track - b.track)
    const ids = { next: 1 }
    const events: DecodedEvent[] = []
    for (const frame of frames) {
        const event = decodeEvent(frame.type, frame.body, ids)
        if (event !== undefined) {
            events.push({ track: frame.track, time: frame.time, event })
        }
    }
    return { header, chunks, events }
}

/** The events of one type, narrowed. */
export function eventsOf<T extends TcrEvent['type']>(
    events: readonly DecodedEvent[],
    type: T
): (Extract<TcrEvent, { type: T }> & { time: number })[] {
    const result: (Extract<TcrEvent, { type: T }> & { time: number })[] = []
    for (const { event, time } of events) {
        if (isType(event, type)) {
            result.push({ ...event, time })
        }
    }
    return result
}

function isType<T extends TcrEvent['type']>(event: TcrEvent, type: T): event is Extract<TcrEvent, { type: T }> {
    return event.type === type
}
