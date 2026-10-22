import { describe, expect, it } from 'vitest'
import { sameSite } from '../src/downloads.ts'

describe('sameSite', () => {
    it('takes hosts under the same registrable domain, with the same scheme, as one site', () => {
        expect(sameSite('https://www.example.com/a', 'https://img.example.com/b.png')).toBe(true)
        expect(sameSite('https://example.com/', 'https://cdn.example.com/b.png')).toBe(true)
        expect(sameSite('https://shop.example.co.uk/', 'https://img.example.co.uk/b.png')).toBe(true)
        expect(sameSite('http://127.0.0.1:8080/', 'http://127.0.0.1:9000/b.png')).toBe(true)
        expect(sameSite('http://localhost/', 'http://localhost:3000/b.png')).toBe(true)
    })

    it('takes other domains, other schemes and other addresses as other sites', () => {
        expect(sameSite('https://www.example.com/', 'https://cdn.example.net/b.png')).toBe(false)
        expect(sameSite('https://example.com/', 'http://example.com/b.png')).toBe(false)
        expect(sameSite('https://a.example.co.uk/', 'https://b.other.co.uk/b.png')).toBe(false)
        expect(sameSite('http://127.0.0.1/', 'http://127.0.0.2/b.png')).toBe(false)
        expect(sameSite('https://example.com/', 'not a URL')).toBe(false)
    })
})
