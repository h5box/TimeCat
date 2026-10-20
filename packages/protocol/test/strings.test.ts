import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ByteReader, ByteWriter, StringTableReader, StringTableWriter, TcrDecodeError } from '../src/index.ts'

describe('string table', () => {
    it('writes an interned string once and references it afterwards', () => {
        const writer = new ByteWriter()
        const table = new StringTableWriter()
        table.write(writer, 'class')
        table.write(writer, 'class')
        table.write(writer, 'id')
        table.write(writer, 'class')

        // tag 1 = literal joining the table, then length + UTF-8; tag 2 + n = reference to entry n
        expect([...writer.finish()]).toEqual([1, 5, ...utf8('class'), 2, 1, 2, ...utf8('id'), 2])
        expect(table.size).toBe(2)
    })

    it('keeps non-interned literals out of the table', () => {
        const writer = new ByteWriter()
        const table = new StringTableWriter()
        table.write(writer, 'text', false)
        table.write(writer, 'text', false)
        expect(table.size).toBe(0)

        const reader = new ByteReader(writer.finish())
        const strings = new StringTableReader()
        expect(strings.read(reader)).toBe('text')
        expect(strings.read(reader)).toBe('text')
        expect(reader.remaining).toBe(0)
    })

    it('rejects references to entries that are not in the table', () => {
        const reader = new ByteReader(new Uint8Array([2]))
        expect(() => new StringTableReader().read(reader)).toThrow(TcrDecodeError)
    })

    it('round-trips arbitrary strings and intern decisions', () => {
        const pool = fc.array(fc.string({ unit: 'grapheme', maxLength: 20 }), { minLength: 1, maxLength: 8 })
        fc.assert(
            fc.property(
                pool.chain(strings => fc.array(fc.tuple(fc.constantFrom(...strings), fc.boolean()), { maxLength: 60 })),
                entries => {
                    const writer = new ByteWriter()
                    const table = new StringTableWriter()
                    for (const [value, intern] of entries) {
                        table.write(writer, value, intern)
                    }
                    const reader = new ByteReader(writer.finish())
                    const strings = new StringTableReader()
                    for (const [value] of entries) {
                        expect(strings.read(reader)).toBe(value)
                    }
                    expect(reader.remaining).toBe(0)
                }
            )
        )
    })

    it('starts over after reset on both sides', () => {
        const writer = new ByteWriter()
        const table = new StringTableWriter()
        table.write(writer, 'a')
        table.reset()
        table.write(writer, 'a')
        expect(table.size).toBe(1)

        const reader = new ByteReader(writer.finish())
        const strings = new StringTableReader()
        expect(strings.read(reader)).toBe('a')
        strings.reset()
        expect(strings.read(reader)).toBe('a')
    })
})

function utf8(value: string): Uint8Array {
    return new TextEncoder().encode(value)
}
