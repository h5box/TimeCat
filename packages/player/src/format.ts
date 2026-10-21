import { ConsoleLevel, ConsoleSource, EventType } from '@timecat-js/player-core'
import type { DataEvent, TimedEvent } from '@timecat-js/player-core'

export type Kind = 'console' | 'network' | 'perf' | 'custom'

/** How an entry stands out. */
type Tone = 'error' | 'warn' | 'info'

/** An event recorded beside the page, as the events panel lists it. */
export interface Entry {
    readonly time: number
    readonly kind: Kind
    readonly tone: Tone
    /** A word or two: a console level, an HTTP status, `perf` or `event`. */
    readonly badge: string
    /** One line. */
    readonly summary: string
    /** All there is to show. */
    readonly detail: string
    /** What a search matches, in lower case. */
    readonly text: string
}

/** A mark on the timeline, for errors and the events of the application. */
export interface Marker {
    readonly kind: 'error' | 'custom'
    /** Where on the timeline, from 0 to 1. */
    readonly at: number
}

const LEVELS: Record<ConsoleLevel, string> = {
    [ConsoleLevel.Debug]: 'debug',
    [ConsoleLevel.Log]: 'log',
    [ConsoleLevel.Info]: 'info',
    [ConsoleLevel.Warn]: 'warn',
    [ConsoleLevel.Error]: 'error'
}

/** Metrics that are scores rather than milliseconds. */
const SCORES = new Set(['CLS', 'layout-shift'])

/** Marks of one kind closer than this, as a share of the timeline, make one. */
const MARKER_GAP = 0.005

/** Formats milliseconds as `m:ss`, or `h:mm:ss` from an hour on. */
export function formatTime(ms: number): string {
    const seconds = Math.floor(Math.max(ms, 0) / 1000)
    const s = String(seconds % 60).padStart(2, '0')
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) {
        return `${minutes}:${s}`
    }
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${s}`
}

export function formatSize(bytes: number): string {
    if (bytes < 1000) {
        return `${bytes} B`
    }
    if (bytes < 1_000_000) {
        return `${(bytes / 1000).toFixed(1)} kB`
    }
    return `${(bytes / 1_000_000).toFixed(1)} MB`
}

export function toEntry({ time, event }: TimedEvent): Entry {
    const entry = describe(event)
    return { time, ...entry, text: `${entry.badge} ${entry.detail}`.toLowerCase() }
}

function describe(event: DataEvent): Omit<Entry, 'time' | 'text'> {
    switch (event.type) {
        case EventType.Console: {
            const message = event.args.join(' ')
            let badge = LEVELS[event.level]
            if (event.source === ConsoleSource.Exception) {
                badge = 'uncaught'
            } else if (event.source === ConsoleSource.Rejection) {
                badge = 'unhandled'
            }
            return {
                kind: 'console',
                tone: toneOf(event.level),
                badge,
                summary: oneLine(message),
                detail: event.stack === '' ? message : `${message}\n${event.stack}`
            }
        }
        case EventType.Network: {
            const failed = event.error !== '' || event.status >= 400
            const facts = [event.initiator, `${event.duration} ms`]
            if (event.size > 0) {
                facts.push(formatSize(event.size))
            }
            if (event.error !== '') {
                facts.push(event.error)
            }
            return {
                kind: 'network',
                tone: failed ? 'error' : 'info',
                badge: event.status > 0 ? String(event.status) : event.error === '' ? event.initiator : 'failed',
                summary: `${event.method} ${event.url}`,
                detail: `${event.method} ${event.url}\n${facts.join(' · ')}`
            }
        }
        case EventType.Perf: {
            const value = SCORES.has(event.metric) ? event.value.toFixed(3) : `${Math.round(event.value)} ms`
            return {
                kind: 'perf',
                tone: 'info',
                badge: 'perf',
                summary: `${event.metric} ${value}`,
                detail: `${event.metric} ${value}`
            }
        }
        default: {
            const data = event.data === 'null' ? '' : event.data
            return {
                kind: 'custom',
                tone: 'info',
                badge: 'event',
                summary: oneLine(`${event.name} ${data}`),
                detail: data === '' ? event.name : `${event.name}\n${pretty(data)}`
            }
        }
    }
}

function toneOf(level: ConsoleLevel): Tone {
    if (level === ConsoleLevel.Error) {
        return 'error'
    }
    return level === ConsoleLevel.Warn ? 'warn' : 'info'
}

function oneLine(text: string): string {
    return text.replaceAll(/\s+/gu, ' ').trim()
}

function pretty(json: string): string {
    try {
        return JSON.stringify(JSON.parse(json), null, 2)
    } catch {
        return json
    }
}

/** The marks for `entries` on a timeline `duration` long, one where several of a kind are close. */
export function markersOf(entries: readonly Entry[], duration: number): Marker[] {
    const markers: Marker[] = []
    const last = { error: -1, custom: -1 }
    for (const entry of entries) {
        let kind: Marker['kind'] | undefined
        if (entry.tone === 'error') {
            kind = 'error'
        } else if (entry.kind === 'custom') {
            kind = 'custom'
        }
        if (kind === undefined) {
            continue
        }
        const at = duration > 0 ? Math.min(entry.time / duration, 1) : 0
        if (last[kind] < 0 || at - last[kind] >= MARKER_GAP) {
            markers.push({ kind, at })
            last[kind] = at
        }
    }
    return markers
}

/** How many of `entries`, in time order, happened at `time` or before. */
export function countUntil(entries: readonly { readonly time: number }[], time: number): number {
    let low = 0
    let high = entries.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if ((entries[middle]?.time ?? Infinity) <= time) {
            low = middle + 1
        } else {
            high = middle
        }
    }
    return low
}
