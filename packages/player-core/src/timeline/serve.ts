import { buildIndex, StreamIndexer } from './build.ts'
import type { IndexRequest, IndexResponse } from './messages.ts'

/**
 * Indexes what requests ask for, answering through `post`. The same code serves the worker and, when no worker
 * can start, the main thread.
 */
export function serve(post: (response: IndexResponse) => void): (request: IndexRequest) => void {
    let stream: StreamIndexer | undefined
    const fail = (error: unknown): void => post(failure(error))
    return request => {
        switch (request.type) {
            case 'load':
                buildIndex(request.sources, request).then(index => post({ type: 'index', index }), fail)
                break
            case 'open':
                stream = new StreamIndexer(request, index => post({ type: 'index', index }), fail)
                post({ type: 'ready' })
                break
            case 'bytes':
                stream?.push(request.bytes)
                break
            case 'end':
                stream?.end()
                break
        }
    }
}

export function failure(error: unknown): IndexResponse {
    return error instanceof Error
        ? { type: 'error', name: error.name, message: error.message }
        : { type: 'error', name: 'Error', message: String(error) }
}
