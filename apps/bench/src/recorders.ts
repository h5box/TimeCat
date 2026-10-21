import { createRequire } from 'node:module'
import path from 'node:path'
import { bundlePage } from './bundle.ts'

export interface RecordedData {
    events: number
    /** Size of the recorded data before compression: rrweb's events as JSON, TimeCat's chunks uncompressed. */
    rawBytes: number
    /** Size of what an upload sends: rrweb's JSON gzipped, TimeCat's recording, compressed chunk by chunk. */
    gzipBytes: number
    /** Main-thread time to turn the recorded events into the upload format, once recording stops. */
    serializeMs: number
}

/**
 * A recorder under test. `start`, `settle` and `stop` are serialized and run inside the page, so they must not
 * capture anything from the Node side.
 */
export interface RecorderAdapter {
    name: string
    /** Bundle injected before any page script runs. */
    initScript?: { path: string } | { content: string }
    /** Starts recording and resolves with how long the start call blocked the main thread. */
    start: () => number | Promise<number>
    /**
     * Resolves once the recorder has done its main-thread work for what the scenario did, such as a snapshot
     * taken in slices, so that it counts.
     */
    settle?: () => Promise<void>
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
    initScript: { path: rrwebUmd },
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

const timecat: RecorderAdapter = {
    name: 'timecat',
    initScript: { content: await bundlePage('timecat.ts') },
    start: () => {
        const bench = window.timecatBench
        const api = window.timecat
        if (!bench || !api) {
            throw new Error('bench harness or TimeCat is not installed')
        }
        return bench.inPageTask(() => {
            const startedAt = performance.now()
            bench.recordStart = startedAt
            // Inputs are masked by default, as rrweb's are with maskAllInputs.
            api.recorder = api.record()
            return performance.now() - startedAt
        })
    },
    settle: async () => {
        await window.timecat?.recorder?.ready
    },
    stop: async () => {
        const recorder = window.timecat?.recorder
        if (!recorder || !window.timecat) {
            throw new Error('TimeCat is not recording')
        }
        // Events are encoded as they are written, which the main-thread time includes, and compressed in the
        // worker. What is left for the main thread at the end is writing the last changes.
        const serializeStart = performance.now()
        recorder.flush()
        const serializeMs = performance.now() - serializeStart
        const blob = await recorder.stop()
        const { events, rawBytes } = await window.timecat.summarize(blob)
        // The recording is compressed already, chunk by chunk: its size is what an upload sends.
        return { events, rawBytes, gzipBytes: blob.size, serializeMs }
    }
}

export const recorders: Record<string, RecorderAdapter> = { none, rrweb, timecat }
