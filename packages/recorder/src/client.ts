import type { SegmentInfo } from '@timecat-js/protocol'
import type { Request, Response, StorageKind } from './pipeline/messages.ts'

export interface ClientOptions {
    /** `true` starts the bundled worker, a URL starts a worker script from there, `false` uses the main thread. */
    worker: boolean | string | URL
    info: SegmentInfo
    storage: StorageKind
    /** How long a chunk spans at most, in milliseconds. */
    latency: number
    onData: ((bytes: Uint8Array) => void) | undefined
    onError: (error: unknown) => void
}

interface PendingResult {
    resolve: (blob: Blob) => void
    reject: (error: unknown) => void
}

/**
 * The page's end of the pipeline. Runs it in a worker when one starts, and on the main thread otherwise:
 * requests are held until the worker reports ready, so a worker that fails to start loses nothing.
 */
export class PipelineClient {
    readonly #options: ClientOptions
    /** Requests not handed on yet; undefined once a worker is ready or the main thread took over. */
    #held: Request[] | undefined
    #worker: Worker | undefined
    #local: ((request: Request) => void) | undefined
    #objectUrl: string | undefined
    #nextId = 0
    readonly #results = new Map<number, PendingResult>()

    constructor(options: ClientOptions) {
        this.#options = options
        this.#held = [
            {
                type: 'init',
                info: options.info,
                storage: options.storage,
                stream: options.onData !== undefined,
                latency: options.latency
            }
        ]
        const worker = options.worker
        if (worker === false) {
            void this.#runLocally()
        } else {
            void this.#startWorker(worker === true ? undefined : worker)
        }
    }

    /** Hands on a batch; its buffer is transferred. */
    send(batch: Uint8Array<ArrayBuffer>): void {
        this.#post({ type: 'batch', batch })
    }

    flush(): void {
        this.#post({ type: 'flush' })
    }

    export(): Promise<Blob> {
        return this.#request('export')
    }

    async stop(): Promise<Blob> {
        try {
            return await this.#request('stop')
        } finally {
            this.#worker?.terminate()
        }
    }

    #request(type: 'export' | 'stop'): Promise<Blob> {
        const id = this.#nextId++
        return new Promise((resolve, reject) => {
            this.#results.set(id, { resolve, reject })
            this.#post({ type, id })
        })
    }

    #post(request: Request): void {
        if (this.#held !== undefined) {
            this.#held.push(request)
        } else if (this.#worker !== undefined) {
            this.#worker.postMessage(request, request.type === 'batch' ? [request.batch.buffer] : [])
        } else {
            this.#local?.(request)
        }
    }

    readonly #receive = (response: Response): void => {
        switch (response.type) {
            case 'ready':
                this.#release()
                break
            case 'data':
                this.#options.onData?.(response.bytes)
                break
            case 'result':
            case 'failed': {
                const pending = this.#results.get(response.id)
                this.#results.delete(response.id)
                if (response.type === 'result') {
                    pending?.resolve(response.blob)
                } else {
                    pending?.reject(response.error)
                }
                break
            }
            case 'error':
                this.#options.onError(response.error)
                break
        }
    }

    async #startWorker(url: string | URL | undefined): Promise<void> {
        let worker: Worker
        try {
            let script = url
            if (script === undefined) {
                const { default: source } = await import('./pipeline/worker.ts?worker-source')
                script = this.#objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
            }
            worker = new Worker(script, { name: 'timecat-recorder' })
        } catch {
            // For example a CSP that forbids the worker, or a chunk that failed to load.
            await this.#runLocally()
            return
        }
        this.#worker = worker
        worker.addEventListener('message', (event: MessageEvent<Response>) => this.#receive(event.data))
        worker.addEventListener('error', event => {
            if (this.#held === undefined) {
                this.#options.onError(event instanceof ErrorEvent ? event.error : new Error('recorder worker failed'))
                return
            }
            // The worker never started (a load or CSP error): replay everything on the main thread.
            event.preventDefault()
            worker.terminate()
            this.#worker = undefined
            this.#revokeUrl()
            void this.#runLocally()
        })
        worker.postMessage(this.#held?.[0], [])
    }

    /** The worker is ready: sends the held requests after the init request, which it already has. */
    #release(): void {
        const held = this.#held
        if (held === undefined || this.#worker === undefined) {
            return
        }
        this.#held = undefined
        this.#revokeUrl()
        for (const request of held.slice(1)) {
            this.#post(request)
        }
    }

    async #runLocally(): Promise<void> {
        try {
            const { serve } = await import('./pipeline/serve.ts')
            const handle = serve(this.#receive)
            const held = this.#held ?? []
            this.#held = undefined
            this.#local = handle
            for (const request of held) {
                handle(request)
            }
        } catch (error) {
            this.#options.onError(error)
        }
    }

    #revokeUrl(): void {
        if (this.#objectUrl !== undefined) {
            URL.revokeObjectURL(this.#objectUrl)
            this.#objectUrl = undefined
        }
    }
}
