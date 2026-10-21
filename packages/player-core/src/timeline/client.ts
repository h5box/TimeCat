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
    let objectUrl: string | undefined
    let worker: Worker
    try {
        let script = url
        if (script === undefined) {
            const { default: source } = await import('./worker.ts?worker-source')
            script = objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        }
        worker = new Worker(script, { name: 'timecat-player' })
    } catch {
        // For example a CSP that forbids the worker, or a chunk that failed to load.
        return undefined
    }
    try {
        return await new Promise<TimelineIndex | undefined>((resolve, reject) => {
            worker.addEventListener('message', (event: MessageEvent<IndexResponse>) => {
                const response = event.data
                if (response.type === 'index') {
                    resolve(response.index)
                } else {
                    reject(revive(response.name, response.message))
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
            const request: IndexRequest = { sources: copies, keyframeInterval }
            worker.postMessage(
                request,
                copies.flatMap(copy => ('arrayBuffer' in copy ? [] : [copy.buffer]))
            )
        })
    } finally {
        worker.terminate()
        if (objectUrl !== undefined) {
            URL.revokeObjectURL(objectUrl)
        }
    }
}

/** The error the worker reported, as indexing on the main thread throws it. */
function revive(name: string, message: string): Error {
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
