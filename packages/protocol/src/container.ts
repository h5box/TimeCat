import { TcrDecodeError } from './errors.ts'
import { ByteReader } from './reader.ts'
import type { ByteWriter } from './writer.ts'

/** "TCR\0" */
export const MAGIC: Uint8Array = new Uint8Array([0x54, 0x43, 0x52, 0x00])

/** Format version written by this implementation; 0 marks the pre-release draft. */
export const FORMAT_VERSION = 0

export const ChunkKind = {
    Events: 1,
    Media: 2,
    /**
     * Tells readers of a live stream how far the segment is complete: every event before the chunk's start time
     * on the tracks of the page, `Dom` to `Media`, is in an earlier chunk. Track 0, no payload.
     */
    Sync: 3
} as const

export type ChunkKind = (typeof ChunkKind)[keyof typeof ChunkKind]

export const ChunkFlag = {
    /** The chunk can be decoded without any earlier chunk of its track. */
    Keyframe: 1,
    /** The payload is gzip-compressed. */
    Gzip: 2
} as const

const KNOWN_CHUNK_FLAGS = ChunkFlag.Keyframe | ChunkFlag.Gzip

/** What a recorder knows about the segment it writes. */
export interface SegmentInfo {
    sessionId: string
    /** Page load index within the session, starting at 0. */
    segment: number
    /** Wall-clock start of the segment in epoch milliseconds; chunk times are relative to it. */
    startedAt: number
    /** Free-form JSON metadata such as SDK version or viewport. */
    meta: Record<string, unknown>
}

export interface FileHeader extends SegmentInfo {
    version: number
}

export interface Chunk {
    /** A `ChunkKind`; readers skip kinds they do not know. */
    kind: number
    track: number
    /** Bit set of `ChunkFlag`. */
    flags: number
    /** Position within the segment, starting at 0. */
    sequence: number
    /** Milliseconds from the segment start. */
    startTime: number
    /** Milliseconds covered by the chunk. */
    duration: number
    payload: Uint8Array
}

export function writeFileHeader(writer: ByteWriter, info: SegmentInfo): void {
    writer.raw(MAGIC)
    writer.varuint(FORMAT_VERSION)
    writer.varuint(0) // header flags, reserved
    writer.string(info.sessionId)
    writer.varuint(info.segment)
    writer.f64(info.startedAt)
    writer.string(JSON.stringify(info.meta))
}

export function readFileHeader(reader: ByteReader): FileHeader {
    const magic = reader.raw(MAGIC.length)
    if (!MAGIC.every((byte, i) => magic[i] === byte)) {
        throw new TcrDecodeError('not a TCR stream: bad magic bytes')
    }
    const version = reader.varuint()
    if (version > FORMAT_VERSION) {
        throw new TcrDecodeError(`unsupported TCR version ${version}, this reader supports up to ${FORMAT_VERSION}`)
    }
    const flags = reader.varuint()
    if (flags !== 0) {
        throw new TcrDecodeError(`unsupported header flags 0x${flags.toString(16)}`)
    }
    const sessionId = reader.string()
    const segment = reader.varuint()
    const startedAt = reader.f64()
    let meta: unknown
    try {
        meta = JSON.parse(reader.string())
    } catch (error) {
        throw new TcrDecodeError('header metadata is not valid JSON', { cause: error })
    }
    if (!isJsonObject(meta)) {
        throw new TcrDecodeError('header metadata must be a JSON object')
    }
    return { version, sessionId, segment, startedAt, meta }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function writeChunk(writer: ByteWriter, chunk: Chunk): void {
    if ((chunk.flags & ~KNOWN_CHUNK_FLAGS) !== 0) {
        throw new RangeError(`unknown chunk flags 0x${chunk.flags.toString(16)}`)
    }
    writer.u8(chunk.kind)
    writer.u8(chunk.flags)
    writer.varuint(chunk.track)
    writer.varuint(chunk.sequence)
    writer.varuint(chunk.startTime)
    writer.varuint(chunk.duration)
    writer.bytes(chunk.payload)
}

/** Reads one chunk. The payload is a view into the reader's bytes. */
export function readChunk(reader: ByteReader): Chunk {
    const kind = reader.u8()
    if (kind === MAGIC[0]) {
        // Where segments follow each other, this kind is the first byte of the next header.
        throw new TcrDecodeError(`chunk kind 0x${kind.toString(16)} is reserved: it starts a segment header`)
    }
    const flags = reader.u8()
    if ((flags & ~KNOWN_CHUNK_FLAGS) !== 0) {
        throw new TcrDecodeError(`unsupported chunk flags 0x${flags.toString(16)}`)
    }
    const track = reader.varuint()
    const sequence = reader.varuint()
    const startTime = reader.varuint()
    const duration = reader.varuint()
    const payload = reader.bytes()
    return { kind, track, flags, sequence, startTime, duration, payload }
}

/** Parses a complete segment: one header followed by chunks until the end. */
export function readFile(bytes: Uint8Array): { header: FileHeader; chunks: Chunk[] } {
    const reader = new ByteReader(bytes)
    const header = readFileHeader(reader)
    const chunks: Chunk[] = []
    while (reader.remaining > 0) {
        chunks.push(readChunk(reader))
    }
    return { header, chunks }
}

/** A header or a chunk, as a `SegmentReader` reads them. */
export type SegmentItem = { header: FileHeader; chunk?: undefined } | { header?: undefined; chunk: Chunk }

const EMPTY = new Uint8Array(0)

/**
 * Reads the segments of a session from bytes that come in pieces, such as a live stream: one segment after the
 * other, each a header and its chunks. Headers and chunks come out once they are whole.
 */
export class SegmentReader {
    #buffer: Uint8Array = EMPTY
    #started = false

    /** Bytes held back, which do not make a whole header or chunk yet. */
    get pending(): number {
        return this.#buffer.length
    }

    /**
     * Takes the next bytes and returns the headers and chunks they complete. Payloads are views into the bytes
     * given, which must not change afterwards. Throws `TcrDecodeError` for bytes that are not a recording.
     */
    push(bytes: Uint8Array): SegmentItem[] {
        const buffer = this.#buffer.length === 0 ? bytes : concat(this.#buffer, bytes)
        const items: SegmentItem[] = []
        let offset = 0
        while (offset < buffer.length) {
            const header = buffer[offset] === MAGIC[0] || !this.#started
            if (header && !startsWithMagic(buffer, offset)) {
                throw new TcrDecodeError('not a TCR stream: bad magic bytes')
            }
            const end = header ? headerEnd(buffer, offset) : chunkEnd(buffer, offset)
            if (end === undefined) {
                break
            }
            const reader = new ByteReader(buffer.subarray(offset, end))
            if (header) {
                items.push({ header: readFileHeader(reader) })
                this.#started = true
            } else {
                items.push({ chunk: readChunk(reader) })
            }
            offset = end
        }
        // A copy, so that what is held back does not keep all of `buffer` alive.
        this.#buffer = offset === buffer.length ? EMPTY : buffer.slice(offset)
        return items
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length)
    result.set(a)
    result.set(b, a.length)
    return result
}

/** Whether the bytes from `offset` are the magic, or as much of it as there is. */
function startsWithMagic(bytes: Uint8Array, offset: number): boolean {
    for (let i = 0; i < MAGIC.length && offset + i < bytes.length; i++) {
        if (bytes[offset + i] !== MAGIC[i]) {
            return false
        }
    }
    return true
}

/**
 * Where the varuint at `offset` ends and its value, or `undefined` when the bytes stop first. A varuint too long
 * to be valid ends at its eighth byte, and reading it fails.
 */
function varuintAt(bytes: Uint8Array, offset: number): [end: number, value: number] | undefined {
    let value = 0
    let scale = 1
    for (let i = offset; i < offset + 8; i++) {
        if (i >= bytes.length) {
            return undefined
        }
        const byte = bytes[i]!
        value += (byte & 0x7f) * scale
        if (byte < 0x80) {
            return [i + 1, value]
        }
        scale *= 0x80
    }
    return [offset + 8, 0]
}

/** Where `varuints` varuints from `offset`, then `skip` more bytes, end; `undefined` when the bytes stop first. */
function fieldsEnd(bytes: Uint8Array, offset: number, varuints: number, skip: number): number | undefined {
    let end = offset
    for (let i = 0; i < varuints; i++) {
        const field = varuintAt(bytes, end)
        if (field === undefined) {
            return undefined
        }
        end = field[0]
    }
    return end + skip
}

/** Where the length-prefixed field at `offset` ends. */
function prefixedEnd(bytes: Uint8Array, offset: number): number | undefined {
    const length = varuintAt(bytes, offset)
    return length === undefined ? undefined : length[0] + length[1]
}

/** Where the header at `offset` ends, or `undefined` when the bytes stop first. */
function headerEnd(bytes: Uint8Array, offset: number): number | undefined {
    // magic, version, flags, sessionId, segment, startedAt, meta
    let end = fieldsEnd(bytes, offset + MAGIC.length, 2, 0)
    end = end === undefined ? undefined : prefixedEnd(bytes, end)
    end = end === undefined ? undefined : fieldsEnd(bytes, end, 1, 8)
    end = end === undefined ? undefined : prefixedEnd(bytes, end)
    return end === undefined || end > bytes.length ? undefined : end
}

/** Where the chunk at `offset` ends, or `undefined` when the bytes stop first. */
function chunkEnd(bytes: Uint8Array, offset: number): number | undefined {
    // kind, flags, track, sequence, startTime, duration, payload
    const end = fieldsEnd(bytes, offset + 2, 4, 0)
    const payloadEnd = end === undefined ? undefined : prefixedEnd(bytes, end)
    return payloadEnd === undefined || payloadEnd > bytes.length ? undefined : payloadEnd
}
