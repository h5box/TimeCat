// Worker entry: runs the pipeline off the main thread. Bundled into a self-contained script, which the recorder
// starts from a blob URL, and also shipped as `@timecat-js/recorder/worker` for pages whose CSP forbids blob
// workers.
import type { Request, Response } from './messages.ts'
import { serve } from './serve.ts'

const handle = serve(post)

self.addEventListener('message', (event: MessageEvent<Request>) => {
    handle(event.data)
})

function post(response: Response): void {
    // The DOM typings describe `self` as a window. In a worker, the second argument is plain options.
    const options = { transfer: [] }
    try {
        self.postMessage(response, options)
    } catch (error) {
        // An error value that cannot be cloned still arrives as its description.
        if (response.type !== 'error' && response.type !== 'failed') {
            throw error
        }
        self.postMessage({ ...response, error: String(response.error) }, options)
    }
}
