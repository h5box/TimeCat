import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
    ByteReader,
    ByteWriter,
    ChunkFlag,
    ChunkKind,
    FORMAT_VERSION,
    MAGIC,
    TcrDecodeError,
    Track,
    readChunk,
    readFile,
    readFileHeader,
    writeChunk,
    writeFileHeader
} from '../src/index.ts'
import type { Chunk, SegmentInfo } from '../src/index.ts'

const info: SegmentInfo = {
    sessionId: 'session-7f3a',
    segment: 2,
    startedAt: 1_760_000_000_000.25,
    meta: { sdk: '0.0.0', viewport: [1280, 720] }
}

const chunks: Chunk[] = [
    {
        kind: ChunkKind.Events,
        track: Track.Dom,
        flags: ChunkFlag.Keyframe | ChunkFlag.Gzip,
        sequence: 0,
        startTime: 0,
        duration: 1500,
        payload: new Uint8Array([1, 2, 3])
    },
    {
        kind: ChunkKind.Events,
        track: Track.Pointer,
        flags: 0,
        sequence: 1,
        startTime: 1500,
        duration: 2000,
        payload: new Uint8Array()
    }
]

function encodeFile(segment: SegmentInfo, items: Chunk[]): Uint8Array {
    const writer = new ByteWriter()
    writeFileHeader(writer, segment)
    for (const chunk of items) {
        writeChunk(writer, chunk)
    }
    return writer.finish()
}

/** Header bytes with the version and flags fields replaced. */
function headerWith(version: number, flags: number): Uint8Array {
    const writer = new ByteWriter()
    writer.raw(MAGIC)
    writer.varuint(version)
    writer.varuint(flags)
    writer.string(info.sessionId)
    writer.varuint(info.segment)
    writer.f64(info.startedAt)
    writer.string('{}')
    return writer.finish()
}

function headerWithMeta(meta: string): Uint8Array {
    const bytes = headerWith(FORMAT_VERSION, 0)
    const writer = new ByteWriter()
    writer.raw(bytes.subarray(0, bytes.length - 3)) // drop the '{}' string (length byte + 2 chars)
    writer.string(meta)
    return writer.finish()
}

describe('container', () => {
    it('round-trips a header followed by chunks', () => {
        const file = readFile(encodeFile(info, chunks))
        expect(file.header).toEqual({ version: FORMAT_VERSION, ...info })
        expect(file.chunks).toEqual(chunks)
    })

    it('starts with the TCR magic bytes', () => {
        expect([...encodeFile(info, []).subarray(0, 4)]).toEqual([0x54, 0x43, 0x52, 0x00])
    })

    it('rejects input without the magic bytes', () => {
        const bytes = encodeFile(info, [])
        bytes[0] = 0x00
        expect(() => readFile(bytes)).toThrow(TcrDecodeError)
    })

    it('rejects versions newer than the reader supports', () => {
        expect(() => readFileHeader(new ByteReader(headerWith(FORMAT_VERSION + 1, 0)))).toThrow(
            /unsupported TCR version/
        )
    })

    it('rejects unknown header flags', () => {
        expect(() => readFileHeader(new ByteReader(headerWith(FORMAT_VERSION, 1)))).toThrow(TcrDecodeError)
    })

    it.each(['[]', 'null', '42', 'not json'])('rejects metadata %j', meta => {
        expect(() => readFileHeader(new ByteReader(headerWithMeta(meta)))).toThrow(TcrDecodeError)
    })

    it('rejects unknown chunk flags when writing and when reading', () => {
        const chunk = { ...chunks[1]!, flags: 0x80 }
        expect(() => writeChunk(new ByteWriter(), chunk)).toThrow(RangeError)
        expect(() => readChunk(new ByteReader(new Uint8Array([ChunkKind.Events, 0x80, 1, 0, 0, 0, 0])))).toThrow(
            TcrDecodeError
        )
    })

    it('rejects a truncated chunk payload', () => {
        const bytes = encodeFile(info, chunks)
        expect(() => readFile(bytes.subarray(0, bytes.length - 1))).toThrow(TcrDecodeError)
    })

    it('passes unknown chunk kinds through so callers can skip them', () => {
        const unknown = { ...chunks[1]!, kind: 99 }
        expect(readFile(encodeFile(info, [unknown])).chunks).toEqual([unknown])
    })

    it('round-trips arbitrary chunks', () => {
        const chunkArbitrary: fc.Arbitrary<Chunk> = fc.record({
            kind: fc.integer({ min: 0, max: 255 }),
            track: fc.maxSafeNat(),
            flags: fc.constantFrom(0, ChunkFlag.Keyframe, ChunkFlag.Gzip, ChunkFlag.Keyframe | ChunkFlag.Gzip),
            sequence: fc.maxSafeNat(),
            startTime: fc.maxSafeNat(),
            duration: fc.maxSafeNat(),
            payload: fc.uint8Array({ maxLength: 200 })
        })
        fc.assert(
            fc.property(fc.array(chunkArbitrary, { maxLength: 10 }), items => {
                expect(readFile(encodeFile(info, items)).chunks).toEqual(items)
            })
        )
    })
})
