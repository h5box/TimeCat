import { TcrDecodeError } from '@timecat-js/protocol'
import type { IndexOptions, SegmentSource } from './build.ts'
import type { IndexRequest, IndexResponse } from './messages.ts'
import type { TimelineIndex } from './types.ts'

export interface LoadOptions extends IndexOptions {
    /** `true` starts the bundled worker, a URL starts a worker script from there, `false` uses the main thread. */
    worker: boolean | string | URL
}

/**
 * Indexes the segments of a recording, in a worker when one starts and on the main thread otherwise. The sources
 * are copied for the worker, so the caller's buffers stay usable.
 */
export async function loadIndex(sources: readonly SegmentSource[], options: LoadOptions): Promise<TimelineIndex> {
    const { worker, keyframeInterval } = options
    if (worker !== false) {
        const index = await indexInWorker(sources, keyframeInterval, worker === true ? undefined : worker)
        if (index !== undefined) {
            return index
        }
    }
    const { buildIndex } = await import('./build.ts')
    return buildIndex(sources, { keyframeInterval })
}

/** Resolves to `undefined` when no worker could start or it failed, so the caller can index on its own. */
async function indexInWorker(
    sources: readonly SegmentSource[],
    keyframeInterval: number,
    url: string | URL | undefined
): Promise<TimelineIndex | undefined> {
    const started = await startWorker(url)
    if (started === undefined) {
        return undefined
    }
    const { worker, stop } = started
    try {
        return await new Promise<TimelineIndex | undefined>((resolve, reject) => {
            worker.addEventListener('message', (event: MessageEvent<IndexResponse>) => {
                const response = event.data
                if (response.type === 'index') {
                    resolve(response.index)
                } else if (response.type === 'error') {
                    reject(revive(response))
                }
            })
            // A script that does not load, or a worker that breaks: indexing on the main thread still works.
            worker.addEventListener('error', event => {
                event.preventDefault()
                resolve(undefined)
            })
            worker.addEventListener('messageerror', () => resolve(undefined))
            // Copies of exactly the bytes of each view, handed over without a second copy. Blobs are shared.
            const copies = sources.map(source => ('arrayBuffer' in source ? source : source.slice()))
            const request: IndexRequest = { type: 'load', sources: copies, keyframeInterval }
            worker.postMessage(
                request,
                copies.flatMap(copy => ('arrayBuffer' in copy ? [] : [copy.buffer]))
            )
        })
    } finally {
        stop()
    }
}

/**
 * Indexes the bytes of `stream` as they come, in a worker when one starts and on the main thread otherwise, and
 * hands the parts of the index, or the error that ends indexing, to `receive`. A stream that fails is taken to end
 * there, and its error goes to `onError`. Returns a function that stops reading and indexing.
 */
export function indexStream(
    stream: ReadableStream<Uint8Array>,
    options: LoadOptions,
    receive: (response: IndexResponse) => void,
    onError: (error: unknown) => void
): () => void {
    const client = new StreamClient(options, receive)
    const reader = stream.getReader()
    let stopped = false
    const read = async (): Promise<void> => {
        try {
            for (;;) {
                // oxlint-disable-next-line no-await-in-loop -- a stream is read one piece after the other
                const { done, value } = await reader.read()
                if (done || stopped) {
                    break
                }
                if (!ArrayBuffer.isView(value)) {
                    throw new TypeError('a recording stream must give bytes')
                }
                // A copy, which the worker takes without another.
                client.post({
                    type: 'bytes',
                    bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
                })
            }
        } catch (error) {
            if (!stopped) {
                onError(error)
            }
        }
        client.post({ type: 'end' })
    }
    void read()
    return () => {
        stopped = true
        reader.cancel().catch(() => undefined)
        client.stop()
    }
}

/** The page's end of indexing a stream: requests wait until a worker runs, so one that fails to start loses none. */
class StreamClient {
    readonly #receive: (response: IndexResponse) => void
    /** Requests not handed on yet; undefined once a worker is ready or the main thread took over. */
    #held: IndexRequest[] | undefined
    #worker: (() => void) | undefined
    #send: ((request: IndexRequest) => void) | undefined
    #stopped = false

    constructor(options: LoadOptions, receive: (response: IndexResponse) => void) {
        this.#receive = receive
        this.#held = [{ type: 'open', keyframeInterval: options.keyframeInterval }]
        const { worker } = options
        if (worker === false) {
            void this.#runLocally()
        } else {
            void this.#startWorker(worker === true ? undefined : worker)
        }
    }

    post(request: IndexRequest): void {
        if (this.#stopped) {
            return
        }
        if (this.#held === undefined) {
            this.#send?.(request)
        } else {
            this.#held.push(request)
        }
    }

    stop(): void {
        this.#stopped = true
        this.#held = undefined
        this.#worker?.()
    }

    async #startWorker(url: string | URL | undefined): Promise<void> {
        const started = await startWorker(url)
        if (started === undefined || this.#stopped) {
            started?.stop()
            if (!this.#stopped) {
                await this.#runLocally()
            }
            return
        }
        const { worker, stop } = started
        this.#worker = stop
        worker.addEventListener('message', (event: MessageEvent<IndexResponse>) => {
            const response = event.data
            if (response.type !== 'ready') {
                this.#receive(response)
                return
            }
            const held = this.#held ?? []
            this.#held = undefined
            this.#send = request => worker.postMessage(request, request.type === 'bytes' ? [request.bytes.buffer] : [])
            for (const request of held.slice(1)) {
                this.#send(request)
            }
        })
        worker.addEventListener('error', event => {
            event.preventDefault()
            if (this.#held === undefined) {
                this.#receive({ type: 'error', name: 'Error', message: 'the indexing worker failed' })
                return
            }
            // The worker never started: everything is still held, for the main thread.
            stop()
            this.#worker = undefined
            void this.#runLocally()
        })
        worker.postMessage(this.#held?.[0], [])
    }

    async #runLocally(): Promise<void> {
        try {
            const { serve } = await import('./serve.ts')
            if (this.#stopped) {
                return
            }
            const handle = serve(response => {
                if (!this.#stopped && response.type !== 'ready') {
                    this.#receive(response)
                }
            })
            const held = this.#held ?? []
            this.#held = undefined
            this.#send = handle
            for (const request of held) {
                handle(request)
            }
        } catch (error) {
            this.#receive(failure(error))
        }
    }
}

/** Starts the bundled worker, or the worker script at `url`; `undefined` when it cannot start. */
async function startWorker(url: string | URL | undefined): Promise<{ worker: Worker; stop: () => void } | undefined> {
    let objectUrl: string | undefined
    try {
        let script = url
        if (script === undefined) {
            const { default: source } = await import('./worker.ts?worker-source')
            script = objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        }
        const worker = new Worker(script, { name: 'timecat-player' })
        return {
            worker,
            stop() {
                worker.terminate()
                if (objectUrl !== undefined) {
                    URL.revokeObjectURL(objectUrl)
                    objectUrl = undefined
                }
            }
        }
    } catch {
        // For example a CSP that forbids the worker, or a chunk that failed to load.
        if (objectUrl !== undefined) {
            URL.revokeObjectURL(objectUrl)
        }
        return undefined
    }
}

/** The error the worker reported, as indexing on the main thread throws it. */
export function revive({ name, message }: { name: string; message: string }): Error {
    switch (name) {
        case 'TcrDecodeError':
            return new TcrDecodeError(message)
        case 'RangeError':
            return new RangeError(message)
        default: {
            const error = new Error(message)
            error.name = name
            return error
        }
    }
}

function failure(error: unknown): IndexResponse {
    return error instanceof Error
        ? { type: 'error', name: error.name, message: error.message }
        : { type: 'error', name: 'Error', message: String(error) }
}
