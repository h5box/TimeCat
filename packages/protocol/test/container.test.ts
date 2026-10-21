import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
    ByteReader,
    ByteWriter,
    ChunkFlag,
    ChunkKind,
    FORMAT_VERSION,
    MAGIC,
    SegmentReader,
    TcrDecodeError,
    Track,
    readChunk,
    readFile,
    readFileHeader,
    writeChunk,
    writeFileHeader
} from '../src/index.ts'
import type { Chunk, SegmentInfo, SegmentItem } from '../src/index.ts'

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

const chunkArbitrary: fc.Arbitrary<Chunk> = fc.record({
    kind: fc.integer({ min: 0, max: 255 }).filter(kind => kind !== MAGIC[0]),
    track: fc.maxSafeNat(),
    flags: fc.constantFrom(0, ChunkFlag.Keyframe, ChunkFlag.Gzip, ChunkFlag.Keyframe | ChunkFlag.Gzip),
    sequence: fc.maxSafeNat(),
    startTime: fc.maxSafeNat(),
    duration: fc.maxSafeNat(),
    payload: fc.uint8Array({ maxLength: 200 })
})

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

    it('reserves the chunk kind that starts the magic bytes', () => {
        const reserved = { ...chunks[1]!, kind: MAGIC[0]! }
        expect(() => readFile(encodeFile(info, [reserved]))).toThrow(/reserved/)
    })

    it('round-trips arbitrary chunks', () => {
        fc.assert(
            fc.property(fc.array(chunkArbitrary, { maxLength: 10 }), items => {
                expect(readFile(encodeFile(info, items)).chunks).toEqual(items)
            })
        )
    })
})

/** Pushes `bytes` cut at `cuts` and returns what came out, and what the reader still holds. */
function readInPieces(bytes: Uint8Array, cuts: number[]): { items: SegmentItem[]; pending: number } {
    const reader = new SegmentReader()
    const items: SegmentItem[] = []
    let start = 0
    for (const cut of cuts.toSorted((a, b) => a - b).concat(bytes.length)) {
        // Copies, as a stream gives new buffers.
        items.push(...reader.push(bytes.slice(start, cut)))
        start = cut
    }
    return { items, pending: reader.pending }
}

describe('segment reader', () => {
    const segments = fc.array(
        fc.record({
            segment: fc.nat(10),
            meta: fc.dictionary(fc.string({ maxLength: 5 }), fc.string({ maxLength: 300 }), { maxKeys: 2 }),
            chunks: fc.array(chunkArbitrary, { maxLength: 5 })
        }),
        { minLength: 1, maxLength: 3 }
    )

    it('reads segments one after the other, however the bytes are cut', () => {
        fc.assert(
            fc.property(segments, fc.array(fc.nat(), { maxLength: 8 }), (parts, positions) => {
                const files = parts.map(part => encodeFile({ ...info, ...part }, part.chunks))
                const bytes = new Uint8Array(files.reduce((length, file) => length + file.length, 0))
                let offset = 0
                for (const file of files) {
                    bytes.set(file, offset)
                    offset += file.length
                }
                const expected = parts.flatMap((part): SegmentItem[] => [
                    { header: { version: FORMAT_VERSION, ...info, segment: part.segment, meta: part.meta } },
                    ...part.chunks.map(chunk => ({ chunk }))
                ])
                const cuts = positions.map(position => position % (bytes.length + 1))
                expect(readInPieces(bytes, cuts)).toEqual({ items: expected, pending: 0 })
            })
        )
    })

    it('holds back a part of a header or a chunk', () => {
        const bytes = encodeFile(info, chunks)
        const reader = new SegmentReader()
        expect(reader.push(bytes.subarray(0, 3))).toEqual([])
        const headerLength = encodeFile(info, []).length
        expect(reader.push(bytes.subarray(3, headerLength + 4))).toHaveLength(1)
        expect(reader.pending).toBe(4)
        expect(reader.push(bytes.subarray(headerLength + 4))).toEqual(chunks.map(chunk => ({ chunk })))
        expect(reader.pending).toBe(0)
    })

    it('rejects bytes that do not start with the magic, as soon as they differ', () => {
        expect(() => new SegmentReader().push(Uint8Array.of(0x54, 0x43, 0x00))).toThrow(TcrDecodeError)
        expect(() => new SegmentReader().push(Uint8Array.of(ChunkKind.Events))).toThrow(TcrDecodeError)
        const bytes = encodeFile(info, [])
        const reader = new SegmentReader()
        reader.push(bytes)
        expect(() => reader.push(Uint8Array.of(0x54, 0x00))).toThrow(TcrDecodeError)
    })

    it('reads sync chunks', () => {
        const sync: Chunk = {
            kind: ChunkKind.Sync,
            track: 0,
            flags: 0,
            sequence: 3,
            startTime: 2500,
            duration: 0,
            payload: new Uint8Array()
        }
        expect(new SegmentReader().push(encodeFile(info, [sync]))[1]).toEqual({ chunk: sync })
    })
})
