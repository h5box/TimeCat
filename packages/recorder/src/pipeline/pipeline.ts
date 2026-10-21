import {
    ByteWriter,
    ChunkFlag,
    ChunkKind,
    EventType,
    gzip,
    Track,
    writeChunk,
    writeEventFrame,
    writeFileHeader
} from '@timecat-js/protocol'
import type { SegmentInfo } from '@timecat-js/protocol'
import { readBatch } from '../batch.ts'
import type { BatchTarget } from '../batch.ts'

/** A chunk ends before its payload grows past this, so it usually stays within 64 KiB compressed (RFC 0002, 4.2). */
const MAX_PAYLOAD = 128 * 1024
/** A chunk ends before it spans more than this, in recording time and in wall-clock time. */
const MAX_SPAN = 5000
/** Below this, gzip's own overhead outweighs what it saves. */
const MIN_COMPRESSED = 128
/** How often open chunks are checked for their wall-clock age. */
const AGE_CHECK_INTERVAL = 1000

interface OpenChunk {
    readonly track: number
    /** Events so far; empty while the chunk is closed. */
    readonly payload: ByteWriter
    startTime: number
    lastTime: number
    keyframe: boolean
    /** `performance.now()` when the first event arrived. */
    openedAt: number
}

/**
 * Turns events into a TCR segment: one open chunk per track, ended by size, by time span or on request, then
 * compressed and handed to `write` in order. Writes run one at a time, so the output order is the order chunks
 * end in, which also gives them their sequence numbers.
 */
export class Pipeline implements BatchTarget {
    readonly #write: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>
    readonly #onError: (error: unknown) => void
    readonly #chunks = new Map<number, OpenChunk>()
    /** Pieces of an event body still to come, by track. */
    readonly #parts = new Map<number, Uint8Array[]>()
    #queue: Promise<void> = Promise.resolve()
    #sequence = 0
    readonly #timer: ReturnType<typeof setInterval>

    constructor(
        info: SegmentInfo,
        write: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>,
        onError: (error: unknown) => void
    ) {
        this.#write = write
        this.#onError = onError
        const header = new ByteWriter(256)
        writeFileHeader(header, info)
        this.#enqueue(() => write(header.finish()))
        this.#timer = setInterval(this.#endOldChunks, AGE_CHECK_INTERVAL)
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
        let chunk = this.#chunks.get(track)
        if (chunk === undefined) {
            chunk = { track, payload: new ByteWriter(4096), startTime: 0, lastTime: 0, keyframe: false, openedAt: 0 }
            this.#chunks.set(track, chunk)
        } else if (
            chunk.payload.length > 0 &&
            // A snapshot starts a chunk, which makes that chunk a keyframe of the DOM track.
            (type === EventType.Snapshot ||
                chunk.payload.length + body.length > MAX_PAYLOAD ||
                time - chunk.startTime >= MAX_SPAN)
        ) {
            this.#end(chunk)
        }
        if (chunk.payload.length === 0) {
            chunk.startTime = time
            chunk.lastTime = time
            chunk.keyframe = track !== Track.Dom || type === EventType.Snapshot
            chunk.openedAt = performance.now()
        }
        writeEventFrame(chunk.payload, type, Math.max(0, time - chunk.lastTime), body)
        chunk.lastTime = Math.max(chunk.lastTime, time)
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

    #end(chunk: OpenChunk): void {
        if (chunk.payload.length === 0) {
            return
        }
        const payload = chunk.payload.finish()
        chunk.payload.reset()
        const { track, startTime, lastTime, keyframe } = chunk
        const sequence = this.#sequence++
        this.#enqueue(async () => {
            let data = payload
            let flags = keyframe ? ChunkFlag.Keyframe : 0
            if (payload.length >= MIN_COMPRESSED) {
                const compressed = await gzip(payload)
                if (compressed.length < payload.length) {
                    data = compressed
                    flags |= ChunkFlag.Gzip
                }
            }
            const bytes = new ByteWriter(data.length + 32)
            writeChunk(bytes, {
                kind: ChunkKind.Events,
                track,
                flags,
                sequence,
                startTime,
                duration: lastTime - startTime,
                payload: data
            })
            await this.#write(bytes.finish())
        })
    }

    #enqueue(task: () => void | Promise<void>): void {
        this.#queue = this.#queue.then(task).catch(this.#onError)
    }

    readonly #endOldChunks = (): void => {
        const now = performance.now()
        for (const chunk of this.#chunks.values()) {
            if (chunk.payload.length > 0 && now - chunk.openedAt >= MAX_SPAN) {
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
