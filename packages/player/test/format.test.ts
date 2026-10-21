import { ConsoleLevel, ConsoleSource, EventType } from '@timecat-js/player-core'
import type { ConsoleEvent, NetworkEvent } from '@timecat-js/player-core'
import { describe, expect, it } from 'vitest'
import { fromBase64, toBase64 } from '../src/embed.ts'
import { countUntil, formatSize, formatTime, markersOf, toEntry } from '../src/format.ts'
import type { Entry } from '../src/format.ts'

describe('formatTime', () => {
    it('shows minutes and seconds, and hours from an hour on', () => {
        expect([0, 999, 61_000, 3_599_999, 3_600_000, 36_061_000, -5].map(formatTime)).toEqual([
            '0:00',
            '0:00',
            '1:01',
            '59:59',
            '1:00:00',
            '10:01:01',
            '0:00'
        ])
    })
})

describe('formatSize', () => {
    it('shows bytes, kilobytes and megabytes', () => {
        expect([0, 999, 1500, 2_345_678].map(formatSize)).toEqual(['0 B', '999 B', '1.5 kB', '2.3 MB'])
    })
})

describe('toEntry', () => {
    it('describes console messages by level and source', () => {
        const message: ConsoleEvent = {
            type: EventType.Console,
            level: ConsoleLevel.Warn,
            source: ConsoleSource.Call,
            args: ['low', 'on\nmemory'],
            stack: 'at f (app.js:1:2)'
        }
        expect(toEntry({ time: 5, event: message })).toEqual({
            time: 5,
            kind: 'console',
            tone: 'warn',
            badge: 'warn',
            summary: 'low on memory',
            detail: 'low on\nmemory\nat f (app.js:1:2)',
            text: 'warn low on\nmemory\nat f (app.js:1:2)'
        })
        const uncaught = toEntry({
            time: 0,
            event: { ...message, level: ConsoleLevel.Error, source: ConsoleSource.Exception, stack: '' }
        })
        expect(uncaught).toMatchObject({ tone: 'error', badge: 'uncaught', detail: 'low on\nmemory' })
        const rejection = toEntry({ time: 0, event: { ...message, source: ConsoleSource.Rejection } })
        expect(rejection.badge).toBe('unhandled')
    })

    it('describes requests, failed ones as errors', () => {
        const request: NetworkEvent = {
            type: EventType.Network,
            initiator: 'fetch',
            method: 'GET',
            url: 'https://example.com/a',
            status: 200,
            duration: 12,
            size: 2048,
            error: ''
        }
        expect(toEntry({ time: 0, event: request })).toMatchObject({
            kind: 'network',
            tone: 'info',
            badge: '200',
            summary: 'GET https://example.com/a',
            detail: 'GET https://example.com/a\nfetch · 12 ms · 2.0 kB'
        })
        expect(toEntry({ time: 0, event: { ...request, status: 404 } })).toMatchObject({ tone: 'error', badge: '404' })
        expect(toEntry({ time: 0, event: { ...request, status: 0, size: 0, error: 'abort' } })).toMatchObject({
            tone: 'error',
            badge: 'failed',
            detail: 'GET https://example.com/a\nfetch · 12 ms · abort'
        })
        expect(toEntry({ time: 0, event: { ...request, initiator: 'beacon', status: 0 } })).toMatchObject({
            tone: 'info',
            badge: 'beacon'
        })
    })

    it('describes measurements, in milliseconds or as scores', () => {
        const lcp = toEntry({ time: 0, event: { type: EventType.Perf, metric: 'LCP', value: 1234.6, targetId: 3 } })
        expect(lcp).toMatchObject({ kind: 'perf', badge: 'perf', summary: 'LCP 1235 ms' })
        const cls = toEntry({ time: 0, event: { type: EventType.Perf, metric: 'CLS', value: 0.12345, targetId: 0 } })
        expect(cls.summary).toBe('CLS 0.123')
    })

    it('describes the events of the application with their data', () => {
        const event = { type: EventType.Custom, name: 'checkout', data: '{"total":3}' } as const
        expect(toEntry({ time: 0, event })).toMatchObject({
            kind: 'custom',
            badge: 'event',
            summary: 'checkout {"total":3}',
            detail: 'checkout\n{\n  "total": 3\n}'
        })
        expect(toEntry({ time: 0, event: { ...event, data: 'null' } })).toMatchObject({
            summary: 'checkout',
            detail: 'checkout'
        })
    })
})

function entry(time: number, tone: Entry['tone'], kind: Entry['kind'] = 'console'): Entry {
    return { time, kind, tone, badge: '', summary: '', detail: '', text: '' }
}

describe('markersOf', () => {
    it('marks errors and events of the application, one for each that are close', () => {
        const entries = [
            entry(0, 'error'),
            entry(2, 'error'),
            entry(10, 'info'),
            entry(10, 'info', 'custom'),
            entry(500, 'warn'),
            entry(1000, 'error', 'network'),
            entry(2000, 'error')
        ]
        expect(markersOf(entries, 1000)).toEqual([
            { kind: 'error', at: 0 },
            { kind: 'custom', at: 0.01 },
            // Past the end, it is at the end, with the one there.
            { kind: 'error', at: 1 }
        ])
        expect(markersOf([entry(0, 'error')], 0)).toEqual([{ kind: 'error', at: 0 }])
    })
})

describe('countUntil', () => {
    it('counts the entries at or before a time', () => {
        const entries = [entry(0, 'info'), entry(10, 'info'), entry(10, 'info'), entry(20, 'info')]
        expect([-1, 0, 9, 10, 19, 20, 99].map(time => countUntil(entries, time))).toEqual([0, 1, 1, 3, 3, 4, 4])
        expect(countUntil([], 5)).toBe(0)
    })
})

describe('base64', () => {
    it('encodes bytes in lines that decode as one text', () => {
        const bytes = Uint8Array.from({ length: 60_001 }, (_, i) => (i * 7) % 256)
        const lines = toBase64(bytes)
        expect(lines.length).toBe(3)
        expect(lines.every(line => !line.includes('='))).toBe(false)
        expect(lines.slice(0, -1).every(line => !line.includes('='))).toBe(true)
        expect(fromBase64(lines.join('\n  '))).toEqual(bytes)
        expect(toBase64(new Uint8Array(0))).toEqual([])
        expect(fromBase64('')).toEqual(new Uint8Array(0))
    })
})
