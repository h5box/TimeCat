import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ByteReader, ByteWriter, TcrDecodeError } from '../src/index.ts'

type Op =
    | { type: 'u8'; value: number }
    | { type: 'varuint'; value: number }
    | { type: 'varint'; value: number }
    | { type: 'f64'; value: number }
    | { type: 'bytes'; value: Uint8Array }
    | { type: 'string'; value: string }

const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ type: fc.constant('u8' as const), value: fc.integer({ min: 0, max: 255 }) }),
    fc.record({ type: fc.constant('varuint' as const), value: fc.maxSafeNat() }),
    fc.record({ type: fc.constant('varint' as const), value: fc.integer() }),
    fc.record({ type: fc.constant('f64' as const), value: fc.double() }),
    fc.record({ type: fc.constant('bytes' as const), value: fc.uint8Array({ maxLength: 300 }) }),
    fc.record({ type: fc.constant('string' as const), value: fc.string({ unit: 'grapheme', maxLength: 300 }) })
)

function write(writer: ByteWriter, op: Op): void {
    switch (op.type) {
        case 'u8':
            writer.u8(op.value)
            break
        case 'varuint':
            writer.varuint(op.value)
            break
        case 'varint':
            writer.varint(op.value)
            break
        case 'f64':
            writer.f64(op.value)
            break
        case 'bytes':
            writer.bytes(op.value)
            break
        case 'string':
            writer.string(op.value)
            break
    }
}

function read(reader: ByteReader, type: Op['type']): number | string | Uint8Array {
    switch (type) {
        case 'u8':
            return reader.u8()
        case 'varuint':
            return reader.varuint()
        case 'varint':
            return reader.varint()
        case 'f64':
            return reader.f64()
        case 'bytes':
            return reader.bytes()
        case 'string':
            return reader.string()
        default: {
            const unknown: never = type
            throw new Error(`unknown op ${String(unknown)}`)
        }
    }
}

function roundTripString(value: string): string {
    const writer = new ByteWriter()
    writer.string(value)
    return new ByteReader(writer.finish()).string()
}

describe('ByteWriter and ByteReader', () => {
    it('round-trips a mixed sequence of primitives', () => {
        // A tiny initial capacity exercises buffer growth.
        const writer = new ByteWriter(4)
        writer.u8(255)
        writer.varuint(300)
        writer.varint(-12345)
        writer.f64(Math.PI)
        writer.bytes(new Uint8Array([1, 2, 3]))
        writer.string('héllo 世界 🐱')
        writer.raw(new Uint8Array([9]))

        const reader = new ByteReader(writer.finish())
        expect(reader.u8()).toBe(255)
        expect(reader.varuint()).toBe(300)
        expect(reader.varint()).toBe(-12345)
        expect(reader.f64()).toBe(Math.PI)
        expect(reader.bytes()).toEqual(new Uint8Array([1, 2, 3]))
        expect(reader.string()).toBe('héllo 世界 🐱')
        expect(reader.raw(1)).toEqual(new Uint8Array([9]))
        expect(reader.remaining).toBe(0)
    })

    it('round-trips arbitrary sequences of primitives', () => {
        fc.assert(
            fc.property(fc.array(opArbitrary, { maxLength: 40 }), ops => {
                const writer = new ByteWriter(8)
                for (const op of ops) {
                    write(writer, op)
                }
                const reader = new ByteReader(writer.finish())
                for (const op of ops) {
                    expect(read(reader, op.type)).toEqual(op.value)
                }
                expect(reader.remaining).toBe(0)
            })
        )
    })

    it.each([
        ['empty', ''],
        ['ASCII at the fast-path limit', 'a'.repeat(127)],
        ['ASCII beyond the fast-path limit', 'a'.repeat(5000)],
        ['non-ASCII after an ASCII prefix', 'abcé'],
        ['two-byte characters', 'é'.repeat(1000)],
        ['three-byte characters', '世'.repeat(1000)],
        ['astral characters', '🐱'.repeat(1000)],
        ['control characters', '\u0000\u0001\n\t'],
        ['a leading byte order mark', '﻿text']
    ])('round-trips %s', (_, value) => {
        expect(roundTripString(value)).toBe(value)
    })

    it('replaces lone surrogates with U+FFFD, keeping the UTF-16 length', () => {
        expect(roundTripString('a\uD800b')).toBe('a�b')
        expect(roundTripString('\uDC00')).toBe('�')
        expect(roundTripString('x'.repeat(200) + '\uD800')).toBe('x'.repeat(200) + '�')
    })

    it('reads f64 correctly from a view with a non-zero byte offset', () => {
        const writer = new ByteWriter()
        writer.f64(-0.1)
        const padded = new Uint8Array(11)
        padded.set(writer.finish(), 3)
        expect(new ByteReader(padded.subarray(3)).f64()).toBe(-0.1)
    })

    it('throws TcrDecodeError on truncated input', () => {
        const writer = new ByteWriter()
        writer.string('hello')
        expect(() => new ByteReader(writer.finish().subarray(0, 3)).string()).toThrow(TcrDecodeError)
        expect(() => new ByteReader(new Uint8Array()).u8()).toThrow(TcrDecodeError)
        expect(() => new ByteReader(new Uint8Array(7)).f64()).toThrow(TcrDecodeError)
        expect(() => new ByteReader(new Uint8Array([5, 1, 2])).bytes()).toThrow(TcrDecodeError)
    })

    it.each([256, -1, 1.5])('rejects u8 value %d', value => {
        expect(() => new ByteWriter().u8(value)).toThrow(RangeError)
    })

    it('returns a compact copy from finish and can be reset for reuse', () => {
        const writer = new ByteWriter(1024)
        writer.varuint(1)
        const first = writer.finish()
        expect(first.byteLength).toBe(1)
        expect(first.buffer.byteLength).toBe(1)

        writer.reset()
        expect(writer.length).toBe(0)
        writer.varuint(2)
        expect([...writer.finish()]).toEqual([2])
        expect([...first]).toEqual([1])
    })
})
