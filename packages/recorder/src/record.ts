import { encodeCustom, EventType, Track } from '@timecat-js/protocol'
import { BatchWriter } from './batch.ts'
import { afterTask, Capture, yieldToPage } from './capture.ts'
import { PipelineClient } from './client.ts'
import type { StorageKind } from './pipeline/messages.ts'
import { LATENCY } from './pipeline/pipeline.ts'
import { startPlugins } from './plugins.ts'
import type { RecorderPlugin } from './plugins.ts'
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
    /**
     * Bytes of `blob:` content and font data the recording keeps, all together: such content is gone once the page
     * is, so the recording keeps a copy. Content that does not fit in what is left is not recorded. 8 MiB by
     * default; 0 records none.
     */
    assetBudget?: number | undefined
    /** Id shared by the segments of one session. Random by default. */
    sessionId?: string | undefined
    /** Index of this page load within the session, from 0. */
    segment?: number | undefined
    /** JSON-compatible data stored in the recording header. */
    meta?: Record<string, unknown> | undefined
    /** Record more than the page, such as console messages (`@timecat-js/plugin-console`). */
    plugins?: readonly RecorderPlugin[] | undefined
    /**
     * Receives the recording while it is written: the header, then each chunk as it is finished. Their
     * concatenation is a complete recording, so this can feed an upload or a live stream, which a player can
     * play as it comes.
     */
    onData?: ((bytes: Uint8Array) => void) | undefined
    /**
     * How long, in milliseconds, it takes at most until what was recorded is stored, and with `onData`, until a
     * live player can play it. Chunks end at least this often, and so lower values make for a larger recording.
     * 5000 by default, at least 100.
     */
    latency?: number | undefined
    /** Receives errors that recording survives. Logged to the console by default. */
    onError?: ((error: unknown) => void) | undefined
}

export interface Recorder {
    readonly sessionId: string
    /** Settles once the initial snapshot is written. */
    readonly ready: Promise<void>
    /**
     * Records an event of the application's own, such as a user signing in, with data that `JSON.stringify` takes.
     * Throws when it does not. Does nothing once the recording stopped.
     */
    addEvent(name: string, data?: unknown): void
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
const ASSET_BUDGET = 8 * 1024 * 1024
const MIN_LATENCY = 100

/**
 * Starts recording the current page. Throws when an option is invalid, such as a selector that does not parse.
 */
export function record(options: RecordOptions = {}): Recorder {
    const segment = options.segment ?? 0
    if (!Number.isSafeInteger(segment) || segment < 0) {
        throw new RangeError(`segment must be a non-negative integer, got ${segment}`)
    }
    const assetBudget = options.assetBudget ?? ASSET_BUDGET
    if (!(assetBudget >= 0)) {
        throw new RangeError(`assetBudget must be a non-negative number, got ${assetBudget}`)
    }
    const latency = options.latency ?? LATENCY
    if (!(latency >= MIN_LATENCY && latency < Infinity)) {
        throw new RangeError(`latency must be a number of milliseconds from ${MIN_LATENCY}, got ${latency}`)
    }
    const streaming = options.onData !== undefined
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
        assetBudget,
        yieldToPage,
        scheduleFlush: afterTask,
        onHidden: () => {
            if (streaming) {
                capture.sync()
            }
            client.flush()
        },
        onError
    })
    // Created after the capture, which validates the options, so invalid options start no worker.
    const client = new PipelineClient({
        worker: options.worker ?? true,
        info: { sessionId, segment, startedAt, meta },
        storage: options.storage ?? 'memory',
        latency,
        onData: options.onData,
        onError
    })
    const ready = capture.start()
    const stopPlugins = startPlugins(options.plugins ?? [], {
        window,
        origin,
        write: (track, type, time, body) => capture.write(track, type, time, body),
        mediaTrack: (event, time) => capture.mediaTrack(event, time),
        media: (track, packet) => capture.media(track, packet),
        ready,
        nodeId: node => capture.nodeId(node),
        blocks: element => capture.blocks(element),
        observeRoots: observer => capture.observeRoots(observer),
        onError
    })
    const flush = (): void => {
        capture.flush(true)
        if (streaming) {
            capture.sync()
        }
        client.flush()
    }
    // A live player plays up to the last sync point, so they come even when the page is quiet.
    const heartbeat = streaming ? setInterval(flush, latency) : undefined
    let stopped: Promise<Blob> | undefined
    return {
        sessionId,
        ready,
        addEvent(name, data = null) {
            // `undefined`, functions and symbols have no JSON text.
            const json: unknown = JSON.stringify(data)
            if (typeof json !== 'string') {
                throw new TypeError(`the data of event ${name} has no JSON form`)
            }
            if (stopped === undefined) {
                const time = Math.round(performance.now() - origin)
                capture.write(Track.Custom, EventType.Custom, time, encodeCustom({ name, data: json }))
            }
        },
        flush,
        async export() {
            await ready
            capture.flush(true)
            await capture.settled()
            return client.export()
        },
        stop() {
            const pluginsStopped = stopPlugins()
            clearInterval(heartbeat)
            stopped ??= ready.then(async () => {
                await pluginsStopped
                capture.flush(true)
                await capture.settled()
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
