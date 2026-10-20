import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ByteReader, ByteWriter, TcrDecodeError } from '../src/index.ts'

function encodeUint(value: number): number[] {
    const writer = new ByteWriter()
    writer.varuint(value)
    return [...writer.finish()]
}

function encodeInt(value: number): number[] {
    const writer = new ByteWriter()
    writer.varint(value)
    return [...writer.finish()]
}

const decodeUint = (bytes: number[]): number => new ByteReader(new Uint8Array(bytes)).varuint()
const decodeInt = (bytes: number[]): number => new ByteReader(new Uint8Array(bytes)).varint()

describe('varuint', () => {
    it.each([
        [0, [0x00]],
        [1, [0x01]],
        [127, [0x7f]],
        [128, [0x80, 0x01]],
        [300, [0xac, 0x02]],
        [2 ** 32 - 1, [0xff, 0xff, 0xff, 0xff, 0x0f]],
        [2 ** 32, [0x80, 0x80, 0x80, 0x80, 0x10]],
        [Number.MAX_SAFE_INTEGER, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]]
    ])('encodes %d as unsigned LEB128', (value, bytes) => {
        expect(encodeUint(value)).toEqual(bytes)
        expect(decodeUint(bytes)).toBe(value)
    })

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('rejects %d', value => {
        expect(() => new ByteWriter().varuint(value)).toThrow(RangeError)
    })

    it('round-trips any non-negative safe integer', () => {
        fc.assert(fc.property(fc.maxSafeNat(), value => decodeUint(encodeUint(value)) === value))
    })

    it('rejects truncated input', () => {
        expect(() => decodeUint([0x80])).toThrow(TcrDecodeError)
        expect(() => decodeUint([])).toThrow(TcrDecodeError)
    })

    it('rejects varints longer than 8 bytes', () => {
        expect(() => decodeUint([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01])).toThrow(TcrDecodeError)
    })

    it('rejects values beyond the safe integer range', () => {
        expect(() => decodeUint([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f])).toThrow(TcrDecodeError)
    })
})

describe('varint', () => {
    it.each([
        [0, 0],
        [-1, 1],
        [1, 2],
        [-2, 3],
        [2 ** 31 - 1, 2 ** 32 - 2],
        [-(2 ** 31), 2 ** 32 - 1],
        [2 ** 31, 2 ** 32],
        [2 ** 52 - 1, 2 ** 53 - 2],
        [-(2 ** 52), 2 ** 53 - 1]
    ])('zigzag-encodes %d as %d', (value, zigzag) => {
        expect(encodeInt(value)).toEqual(encodeUint(zigzag))
        expect(decodeInt(encodeInt(value))).toBe(value)
    })

    it.each([2 ** 52, -(2 ** 52) - 1, 0.5, Number.NaN])('rejects %d', value => {
        expect(() => new ByteWriter().varint(value)).toThrow(RangeError)
    })

    it('round-trips integers across the 32-bit fast path and the full range', () => {
        const wide = fc.maxSafeInteger().map(value => Math.trunc(value / 2))
        fc.assert(fc.property(fc.oneof(fc.integer(), wide), value => decodeInt(encodeInt(value)) === value))
    })
})
