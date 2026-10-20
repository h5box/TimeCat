import { describe, expect, it } from 'vitest'
import { TcrDecodeError, gunzip, gzip } from '../src/index.ts'

const encoder = new TextEncoder()

describe('gzip', () => {
    it('round-trips data', async () => {
        const data = encoder.encode('<div class="product-card">'.repeat(200))
        const compressed = await gzip(data)
        expect(compressed.length).toBeLessThan(data.length / 10)
        expect(await gunzip(compressed)).toEqual(data)
    })

    it('produces a gzip member', async () => {
        const compressed = await gzip(encoder.encode('hello'))
        expect([compressed[0], compressed[1]]).toEqual([0x1f, 0x8b])
    })

    it('round-trips empty input', async () => {
        expect(await gunzip(await gzip(new Uint8Array()))).toEqual(new Uint8Array())
    })

    it('accepts views into a larger buffer', async () => {
        const buffer = encoder.encode('xxhelloxx')
        expect(await gunzip(await gzip(buffer.subarray(2, 7)))).toEqual(encoder.encode('hello'))
    })

    it('rejects corrupt input with TcrDecodeError', async () => {
        await expect(gunzip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(TcrDecodeError)
    })
})
