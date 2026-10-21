// Worker entry: indexes a recording off the main thread. Bundled into a self-contained script, which the player
// starts from a blob URL, and also shipped as `@timecat-js/player-core/worker` for pages whose CSP forbids blob
// workers.
import type { IndexRequest, IndexResponse } from './messages.ts'
import { failure, serve } from './serve.ts'
import { transferables } from './types.ts'

const handle = serve(post)

self.addEventListener('message', (event: MessageEvent<IndexRequest>) => {
    handle(event.data)
})

function post(response: IndexResponse): void {
    try {
        // The DOM typings describe `self` as a window. In a worker, the second argument is plain options.
        self.postMessage(response, { transfer: response.type === 'index' ? transferables(response.index) : [] })
    } catch (error) {
        self.postMessage(failure(error), {})
    }
}
