import {
    ByteWriter,
    ChunkFlag,
    ChunkKind,
    EventType,
    gzip,
    Track,
    writeChunk,
    writeEventFrame,
    writeFileHeader,
    writeMediaPacket
} from '@timecat-js/protocol'
import type { MediaPacket, SegmentInfo } from '@timecat-js/protocol'
import { readBatch } from '../batch.ts'
import type { BatchTarget } from '../batch.ts'

/** A chunk ends before its payload grows past this, so it usually stays within 64 KiB compressed (RFC 0002, 4.2). */
const MAX_PAYLOAD = 128 * 1024
/** How long a chunk spans at most by default, in recording time and in wall-clock time. */
export const LATENCY = 5000
/** Below this, gzip's own overhead outweighs what it saves. */
const MIN_COMPRESSED = 128
/** How often open chunks are checked for their wall-clock age. */
const AGE_CHECK_INTERVAL = 1000

interface OpenChunk {
    readonly kind: typeof ChunkKind.Events | typeof ChunkKind.Media
    readonly track: number
    /** Events or packets so far; empty while the chunk is closed. */
    readonly payload: ByteWriter
    /** Milliseconds. */
    startTime: number
    /** The time of the last event, in milliseconds; or of the last packet, in microseconds. */
    lastTime: number
    /** Where the chunk ends, in milliseconds. */
    endTime: number
    keyframe: boolean
    /** `performance.now()` when the first event arrived. */
    openedAt: number
}

/**
 * Turns events and media packets into a TCR segment: one open chunk per track, ended by size, by time span or on
 * request, then compressed and handed to `write` in order. Writes run one at a time, so the output order is the
 * order chunks end in, which also gives them their sequence numbers.
 */
export class Pipeline implements BatchTarget {
    readonly #write: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>
    readonly #onError: (error: unknown) => void
    readonly #chunks = new Map<number, OpenChunk>()
    /** Pieces of an event body still to come, by track. */
    readonly #parts = new Map<number, Uint8Array[]>()
    #queue: Promise<void> = Promise.resolve()
    #sequence = 0
    readonly #span: number
    /** The last sync point: page events are not written earlier than this. */
    #syncTime = 0
    readonly #timer: ReturnType<typeof setInterval>

    /** `latency` is how long a chunk spans at most, in milliseconds. */
    constructor(
        info: SegmentInfo,
        write: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>,
        onError: (error: unknown) => void,
        latency: number = LATENCY
    ) {
        this.#write = write
        this.#onError = onError
        this.#span = latency
        const header = new ByteWriter(256)
        writeFileHeader(header, info)
        this.#enqueue(() => write(header.finish()))
        this.#timer = setInterval(this.#endOldChunks, Math.min(AGE_CHECK_INTERVAL, latency))
    }

    /** Takes a batch written by `BatchWriter`. */
    push(batch: Uint8Array): void {
        readBatch(batch, this)
    }

    event(track: number, type: number, time: number, body: Uint8Array): void {
        const parts = this.#parts.get(track)
        if (parts !== undefined) {
            this.#parts.delete(track)
            parts.push(body)
            body = concat(parts)
        }
        if (track < Track.Console) {
            // What a sync point promised for the page tracks.
            time = Math.max(time, this.#syncTime)
        }
        const chunk = this.#open(ChunkKind.Events, track)
        if (
            chunk.payload.length > 0 &&
            // A snapshot starts a chunk, which makes that chunk a keyframe of the DOM track.
            (type === EventType.Snapshot ||
                chunk.payload.length + body.length > MAX_PAYLOAD ||
                time - chunk.startTime >= this.#span)
        ) {
            this.#end(chunk)
        }
        if (chunk.payload.length === 0) {
            this.#start(chunk, time, track !== Track.Dom || type === EventType.Snapshot)
        }
        writeEventFrame(chunk.payload, type, Math.max(0, time - chunk.lastTime), body)
        chunk.lastTime = Math.max(chunk.lastTime, time)
        chunk.endTime = chunk.lastTime
    }

    /** Takes a media packet. A key packet starts a chunk, from which decoding can start. */
    media(track: number, packet: MediaPacket): void {
        const chunk = this.#open(ChunkKind.Media, track)
        if (
            chunk.payload.length > 0 &&
            (packet.key ||
                chunk.payload.length + packet.data.length > MAX_PAYLOAD ||
                packet.time / 1000 - chunk.startTime >= this.#span)
        ) {
            this.#end(chunk)
        }
        if (chunk.payload.length === 0) {
            this.#start(chunk, Math.floor(packet.time / 1000), packet.key)
            chunk.lastTime = chunk.startTime * 1000
        }
        writeMediaPacket(chunk.payload, packet, chunk.lastTime)
        chunk.lastTime = packet.time
        chunk.endTime = Math.max(chunk.endTime, Math.ceil((packet.time + packet.duration) / 1000))
    }

    /** Ends all open chunks and writes a sync chunk, for readers of a live stream (RFC 0002, 4.4). */
    sync(time: number): void {
        this.#syncTime = Math.max(this.#syncTime, time)
        for (const chunk of this.#chunks.values()) {
            this.#end(chunk)
        }
        const startTime = this.#syncTime
        const sequence = this.#sequence++
        this.#enqueue(() => {
            const bytes = new ByteWriter(16)
            const payload = new Uint8Array(0)
            writeChunk(bytes, { kind: ChunkKind.Sync, track: 0, flags: 0, sequence, startTime, duration: 0, payload })
            return this.#write(bytes.finish())
        })
    }

    part(track: number, body: Uint8Array): void {
        const parts = this.#parts.get(track)
        if (parts === undefined) {
            this.#parts.set(track, [body])
        } else {
            parts.push(body)
        }
    }

    /** Ends all open chunks; resolves once everything so far is written. */
    flush(): Promise<void> {
        for (const chunk of this.#chunks.values()) {
            this.#end(chunk)
        }
        return this.#queue
    }

    /** Ends all open chunks and stops the age checks. An event that is still incomplete is dropped. */
    close(): Promise<void> {
        clearInterval(this.#timer)
        this.#parts.clear()
        return this.flush()
    }

    #open(kind: OpenChunk['kind'], track: number): OpenChunk {
        let chunk = this.#chunks.get(track)
        if (chunk === undefined) {
            chunk = {
                kind,
                track,
                payload: new ByteWriter(4096),
                startTime: 0,
                lastTime: 0,
                endTime: 0,
                keyframe: false,
                openedAt: 0
            }
            this.#chunks.set(track, chunk)
        }
        return chunk
    }

    #start(chunk: OpenChunk, time: number, keyframe: boolean): void {
        chunk.startTime = time
        chunk.lastTime = time
        chunk.endTime = time
        chunk.keyframe = keyframe
        chunk.openedAt = performance.now()
    }

    #end(chunk: OpenChunk): void {
        if (chunk.payload.length === 0) {
            return
        }
        const payload = chunk.payload.finish()
        chunk.payload.reset()
        const { kind, track, startTime, endTime, keyframe } = chunk
        const sequence = this.#sequence++
        this.#enqueue(async () => {
            let data = payload
            let flags = keyframe ? ChunkFlag.Keyframe : 0
            // Encoded media hardly compresses.
            if (kind === ChunkKind.Events && payload.length >= MIN_COMPRESSED) {
                const compressed = await gzip(payload)
                if (compressed.length < payload.length) {
                    data = compressed
                    flags |= ChunkFlag.Gzip
                }
            }
            const bytes = new ByteWriter(data.length + 32)
            writeChunk(bytes, { kind, track, flags, sequence, startTime, duration: endTime - startTime, payload: data })
            await this.#write(bytes.finish())
        })
    }

    #enqueue(task: () => void | Promise<void>): void {
        this.#queue = this.#queue.then(task).catch(this.#onError)
    }

    readonly #endOldChunks = (): void => {
        const now = performance.now()
        for (const chunk of this.#chunks.values()) {
            if (chunk.payload.length > 0 && now - chunk.openedAt >= this.#span) {
                this.#end(chunk)
            }
        }
    }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    let length = 0
    for (const part of parts) {
        length += part.length
    }
    const result = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
        result.set(part, offset)
        offset += part.length
    }
    return result
}
