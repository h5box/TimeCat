import { BatchWriter } from './batch.ts'
import { afterTask, Capture, yieldToPage } from './capture.ts'
import { PipelineClient } from './client.ts'
import type { StorageKind } from './pipeline/messages.ts'
import type { PrivacyOptions } from './privacy.ts'

export interface RecordOptions extends PrivacyOptions {
    /**
     * Where finished chunks are kept until `export` or `stop`: `'memory'` (default), or `'opfs'`, the origin
     * private file system, where a recording outlives a crashed page. OPFS needs the worker; without it, memory
     * is used and `onError` says so.
     */
    storage?: StorageKind | undefined
    /**
     * Where encoding, compression and storage run. `true` (default) starts a worker from a bundled script
     * through a `blob:` URL; a URL starts the worker script published as `@timecat-js/recorder/worker` from
     * there instead, for pages whose CSP allows no `blob:` workers; `false` uses the main thread. When a
     * worker cannot start, the main thread takes over without losing data.
     */
    worker?: boolean | string | URL | undefined
    /** Id shared by the segments of one session. Random by default. */
    sessionId?: string | undefined
    /** Index of this page load within the session, from 0. */
    segment?: number | undefined
    /** JSON-compatible data stored in the recording header. */
    meta?: Record<string, unknown> | undefined
    /**
     * Receives the recording while it is written: the header, then each chunk as it is finished. Their
     * concatenation is a complete recording, so this can feed an upload or a live stream.
     */
    onData?: ((bytes: Uint8Array) => void) | undefined
    /** Receives errors that recording survives. Logged to the console by default. */
    onError?: ((error: unknown) => void) | undefined
}

export interface Recorder {
    readonly sessionId: string
    /** Settles once the initial snapshot is written. */
    readonly ready: Promise<void>
    /** Writes pending changes and finishes the open chunks, so storage and `onData` have everything so far. */
    flush(): void
    /** The recording so far, as a TCR file. Recording continues. */
    export(): Promise<Blob>
    /** Stops recording and returns the whole recording, as a TCR file. */
    stop(): Promise<Blob>
}

/** Longest time slice of the snapshot. Well below the 50 ms that make a long task. */
const SLICE_MS = 8
const CHECK_EVERY = 64

/**
 * Starts recording the current page. Throws when an option is invalid, such as a selector that does not parse.
 */
export function record(options: RecordOptions = {}): Recorder {
    const segment = options.segment ?? 0
    if (!Number.isSafeInteger(segment) || segment < 0) {
        throw new RangeError(`segment must be a non-negative integer, got ${segment}`)
    }
    // A copy that is plain JSON, as the header stores it; also fails early on values JSON cannot hold.
    const meta: Record<string, unknown> = JSON.parse(JSON.stringify(options.meta ?? {}))
    const onError = options.onError ?? logError
    const origin = performance.now()
    const startedAt = Date.now()
    const sessionId = options.sessionId ?? randomId()
    const capture = new Capture({
        maskText: options.maskText,
        block: options.block,
        ignore: options.ignore,
        unmaskInputs: options.unmaskInputs,
        window,
        sink: new BatchWriter(batch => client.send(batch)),
        now: () => Math.round(performance.now() - origin),
        sliceMs: SLICE_MS,
        checkEvery: CHECK_EVERY,
        yieldToPage,
        scheduleFlush: afterTask,
        onHidden: () => client.flush(),
        onError
    })
    // Created after the capture, which validates the options, so invalid options start no worker.
    const client = new PipelineClient({
        worker: options.worker ?? true,
        info: { sessionId, segment, startedAt, meta },
        storage: options.storage ?? 'memory',
        onData: options.onData,
        onError
    })
    const ready = capture.start()
    let stopped: Promise<Blob> | undefined
    return {
        sessionId,
        ready,
        flush() {
            capture.flush(true)
            client.flush()
        },
        async export() {
            await ready
            capture.flush(true)
            return client.export()
        },
        stop() {
            stopped ??= ready.then(() => {
                capture.stop()
                return client.stop()
            })
            return stopped
        }
    }
}

function randomId(): string {
    let id = ''
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
        id += byte.toString(16).padStart(2, '0')
    }
    return id
}

function logError(error: unknown): void {
    console.error('[timecat]', error)
}
