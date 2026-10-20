import { createRequire } from 'node:module'
import path from 'node:path'

export interface RecordedData {
    events: number
    /** UTF-8 bytes of the data as it would be uploaded. */
    rawBytes: number
    gzipBytes: number
    /** Main-thread time to turn the recorded events into the upload format. */
    serializeMs: number
}

/**
 * A recorder under test. `start` and `stop` are serialized and run inside the page, so they must not
 * capture anything from the Node side.
 */
export interface RecorderAdapter {
    name: string
    /** Bundle injected before any page script runs. */
    initScript?: string
    /** Starts recording and resolves with how long the start call blocked the main thread. */
    start: () => number | Promise<number>
    stop: () => Promise<RecordedData>
}

const require = createRequire(import.meta.url)
// @rrweb/record only exports its main entry, so locate the UMD bundle next to it.
const rrwebUmd = path.join(path.dirname(require.resolve('@rrweb/record')), 'record.umd.min.cjs')

/** Control run: the same page and actions without recording, to separate recorder cost from page cost. */
const none: RecorderAdapter = {
    name: 'none',
    start: () => {
        const bench = window.timecatBench
        if (!bench) {
            throw new Error('bench harness is not installed')
        }
        return bench.inPageTask(() => {
            bench.recordStart = performance.now()
            return 0
        })
    },
    stop: () => Promise.resolve({ events: 0, rawBytes: 0, gzipBytes: 0, serializeMs: 0 })
}

const rrweb: RecorderAdapter = {
    name: 'rrweb',
    initScript: rrwebUmd,
    start: () => {
        const bench = window.timecatBench
        const rrwebRecord = window.rrwebRecord
        if (!bench || !rrwebRecord) {
            throw new Error('bench harness or rrweb is not installed')
        }
        return bench.inPageTask(() => {
            const startedAt = performance.now()
            bench.recordStart = startedAt
            // maskAllInputs matches TimeCat's privacy default, so both recorders do the same work on inputs.
            bench.stop = rrwebRecord.record({ emit: event => bench.events.push(event), maskAllInputs: true })
            return performance.now() - startedAt
        })
    },
    stop: async () => {
        const bench = window.timecatBench
        if (!bench) {
            throw new Error('bench harness is not installed')
        }
        bench.stop?.()
        const serializeStart = performance.now()
        const bytes = new TextEncoder().encode(JSON.stringify(bench.events))
        const serializeMs = performance.now() - serializeStart
        const gzip = await new Response(
            new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
        ).arrayBuffer()
        return { events: bench.events.length, rawBytes: bytes.length, gzipBytes: gzip.byteLength, serializeMs }
    }
}

export const recorders: Record<string, RecorderAdapter> = { none, rrweb }
