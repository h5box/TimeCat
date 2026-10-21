import { describe, expect, it } from 'vitest'
import { fromBase64, toBase64 } from '../src/base64.ts'

describe('base64', () => {
    it('round-trips bytes, empty and longer than a slice', () => {
        for (const length of [0, 1, 2, 3, 255, 0x8000, 0x8001, 100_000]) {
            const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 256)
            const text = toBase64(bytes)
            expect(text).toBe(Buffer.from(bytes).toString('base64'))
            expect(fromBase64(text)).toEqual(bytes)
        }
    })
})
