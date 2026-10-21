import type { Request, Response } from './messages.ts'
import { Pipeline } from './pipeline.ts'
import { MemoryStorage, openStorage } from './storage.ts'
import type { Storage } from './storage.ts'

/**
 * Runs a pipeline driven by requests, answering through `post`. The same code serves the worker and, when no
 * worker can start, the main thread.
 */
export function serve(post: (response: Response) => void): (request: Request) => void {
    let pipeline: Pipeline | undefined
    let storage: Promise<Storage> = Promise.resolve(new MemoryStorage())
    const reportError = (error: unknown): void => post({ type: 'error', error })
    const reply = (id: number, result: Promise<Blob>): void => {
        result.then(
            blob => post({ type: 'result', id, blob }),
            (error: unknown) => post({ type: 'failed', id, error })
        )
    }
    const settled = (): Promise<void> => pipeline?.flush() ?? Promise.resolve()
    return request => {
        switch (request.type) {
            case 'init': {
                const { info, stream, latency } = request
                const opened = openStorage(request.storage, info, reportError)
                storage = opened
                pipeline = new Pipeline(
                    info,
                    async bytes => {
                        ;(await opened).append(bytes)
                        if (stream) {
                            post({ type: 'data', bytes })
                        }
                    },
                    reportError,
                    latency
                )
                post({ type: 'ready' })
                break
            }
            case 'batch':
                pipeline?.push(request.batch)
                break
            case 'flush':
                settled().catch(reportError)
                break
            case 'export':
                reply(
                    request.id,
                    settled().then(async () => (await storage).read())
                )
                break
            case 'stop': {
                const closed = pipeline?.close() ?? Promise.resolve()
                reply(
                    request.id,
                    closed.then(async () => {
                        const kept = await storage
                        const blob = kept.read()
                        await kept.destroy()
                        return blob
                    })
                )
                break
            }
        }
    }
}
