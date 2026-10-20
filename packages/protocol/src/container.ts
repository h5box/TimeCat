import { TcrDecodeError } from './errors.ts'
import { ByteReader } from './reader.ts'
import type { ByteWriter } from './writer.ts'

/** "TCR\0" */
export const MAGIC: Uint8Array = new Uint8Array([0x54, 0x43, 0x52, 0x00])

/** Format version written by this implementation; 0 marks the pre-release draft. */
export const FORMAT_VERSION = 0

export const ChunkKind = {
    Events: 1,
    Media: 2
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

/** Parses a complete recording: one header followed by chunks until the end. */
export function readFile(bytes: Uint8Array): { header: FileHeader; chunks: Chunk[] } {
    const reader = new ByteReader(bytes)
    const header = readFileHeader(reader)
    const chunks: Chunk[] = []
    while (reader.remaining > 0) {
        chunks.push(readChunk(reader))
    }
    return { header, chunks }
}
