// Worker entry: indexes a recording off the main thread. Bundled into a self-contained script, which the player
// starts from a blob URL, and also shipped as `@timecat-js/player-core/worker` for pages whose CSP forbids blob
// workers.
import { buildIndex } from './build.ts'
import type { IndexRequest, IndexResponse } from './messages.ts'
import { transferables } from './types.ts'

self.addEventListener('message', (event: MessageEvent<IndexRequest>) => {
    void respond(event.data)
})

async function respond(request: IndexRequest): Promise<void> {
    let response: IndexResponse
    let transfer: ArrayBuffer[] = []
    try {
        const index = await buildIndex(request.sources, request)
        response = { type: 'index', index }
        transfer = transferables(index)
    } catch (error) {
        response = failure(error)
    }
    try {
        // The DOM typings describe `self` as a window. In a worker, the second argument is plain options.
        self.postMessage(response, { transfer })
    } catch (error) {
        self.postMessage(failure(error), {})
    }
}

function failure(error: unknown): IndexResponse {
    return error instanceof Error
        ? { type: 'error', name: error.name, message: error.message }
        : { type: 'error', name: 'Error', message: String(error) }
}
