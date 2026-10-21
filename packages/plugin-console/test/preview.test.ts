import { describe, expect, it } from 'vitest'
import { errorHead, preview } from '../src/preview.ts'

const show = (value: unknown, maxLength = 1000): string => preview(value, maxLength)

function named(): void {}

describe('preview', () => {
    it('keeps strings as they are, cut at the length given', () => {
        expect(show('a "quoted" text')).toBe('a "quoted" text')
        expect(show('a'.repeat(20), 10)).toBe(`${'a'.repeat(10)}…`)
        expect(show('a'.repeat(10), 10)).toBe('a'.repeat(10))
    })

    it('shows primitives as a console does', () => {
        expect([-0, 1.5, Number.NaN, 2n, Symbol('s'), undefined, null, true].map(value => show(value))).toEqual([
            '-0',
            '1.5',
            'NaN',
            '2n',
            'Symbol(s)',
            'undefined',
            'null',
            'true'
        ])
        expect(show(named)).toBe('ƒ named()')
    })

    it('shows objects, arrays, maps and sets with their entries', () => {
        expect(show({ a: 1, 'b-c': 'x', nested: { d: [1, 'two'] } })).toBe(
            '{a: 1, "b-c": "x", nested: {d: [1, "two"]}}'
        )
        class Point {
            x = 1
        }
        expect(show(new Point())).toBe('Point {x: 1}')
        const bare: Record<string, number> = Object.create(null)
        bare.k = 1
        expect(show(bare)).toBe('{k: 1}')
        expect(
            show(
                new Map<unknown, unknown>([
                    [1, 'a'],
                    [{ k: 2 }, null]
                ])
            )
        ).toBe('Map(2) {1 => "a", {k: 2} => null}')
        expect(show(new Set([1, 2]))).toBe('Set(2) {1, 2}')
        expect(show(new Uint8Array([1, 2]))).toBe('Uint8Array(2) [1, 2]')
        expect(show([])).toBe('[]')
        expect(show({})).toBe('{}')
    })

    it('stops at depth 3, at 100 entries and at the length given', () => {
        expect(show({ a: { b: { c: { d: 1 } } }, list: [[[[1]]]] })).toBe('{a: {b: {c: [Object]}}, list: [[[Array]]]}')
        const long = Array.from({ length: 150 }, (_, i) => i)
        expect(show(long)).toBe(`[${long.slice(0, 100).join(', ')}, … 50 more]`)
        expect(show({ a: 'x'.repeat(50) }, 10)).toBe('{a: "xxxxx…')
        expect(
            show(
                Array.from({ length: 1000 }, () => ({ a: 1 })),
                20
            )
        ).toBe('[{a: 1}, {a: 1}, {a:…')
    })

    it('marks references to the objects it is inside of', () => {
        const loop: Record<string, unknown> = { name: 'loop' }
        loop.self = loop
        loop.list = [loop]
        expect(show(loop)).toBe('{name: "loop", self: [Circular], list: [[Circular]]}')
        const shared = { s: 1 }
        expect(show({ x: shared, y: shared })).toBe('{x: {s: 1}, y: {s: 1}}')
    })

    it('shows errors, dates and regular expressions by their text', () => {
        expect(show(new TypeError('bad'))).toBe('TypeError: bad')
        expect(show({ error: new Error('inner') })).toBe('{error: Error: inner}')
        expect(show(new Error(''))).toBe('Error')
        expect(show(new Date(Date.UTC(2026, 0, 2)))).toBe('2026-01-02T00:00:00.000Z')
        expect(show(new Date(Number.NaN))).toBe('Invalid Date')
        expect(show(/a+/gu)).toBe('/a+/gu')
        expect(errorHead({ message: 'not an error' })).toBeUndefined()
    })

    it('shows what throws as it is read', () => {
        const throwing = {
            ok: 1,
            get bad(): never {
                throw new Error('no')
            }
        }
        expect(show(throwing)).toBe('{ok: 1, bad: [Thrown: Error: no]}')
        const proxy = new Proxy(
            {},
            {
                ownKeys() {
                    throw new RangeError('keys')
                }
            }
        )
        expect(show(proxy)).toBe('[Thrown: RangeError: keys]')
    })
})
