/**
 * The recorder, run in the page's own world: it wraps the page's `console`, `fetch`, form setters, `attachShadow`
 * and CSSOM methods, which a content script's world does not share. The bridge, a content script, hands it a
 * `MessagePort` through `window.postMessage`, then starts and stops it through that port; what it records goes
 * back the same way.
 */
import { canvasPlugin } from '@timecat-js/plugin-canvas'
import { consolePlugin } from '@timecat-js/plugin-console'
import { mediaPlugin } from '@timecat-js/plugin-media'
import { networkPlugin } from '@timecat-js/plugin-network'
import { perfPlugin } from '@timecat-js/plugin-perf'
import { record } from '@timecat-js/recorder'
import type { Recorder, RecorderPlugin } from '@timecat-js/recorder'
import { CHANNEL } from './messages.ts'
import type { FromRecorder, Settings, StartConfig, ToRecorder } from './messages.ts'

/** Marks the page as having the recorder: the background injects it again when a page comes back from the cache. */
const LOADED = Symbol.for('timecat-extension')

if (!Reflect.has(window, LOADED)) {
    Reflect.defineProperty(window, LOADED, { value: true })
    let port: MessagePort | undefined
    let recorder: Recorder | undefined
    /** Recorders start once the one before stopped: stopping unwraps what starting wraps. */
    let queue: Promise<void> = Promise.resolve()

    const run = (task: () => Promise<void> | void): void => {
        queue = queue.then(task).catch(() => undefined)
    }

    const stop = async (): Promise<void> => {
        const stopping = recorder
        recorder = undefined
        await stopping?.stop()
    }

    const start = (to: MessagePort, config: StartConfig): void => {
        try {
            recorder = record({
                sessionId: config.sessionId,
                segment: config.segment,
                latency: config.latency,
                maskText: config.settings.maskText ? 'html' : undefined,
                plugins: pluginsFor(config.settings),
                onData: bytes => send(to, { type: 'data', bytes }),
                onError: error => send(to, { type: 'error', message: describe(error) })
            })
        } catch (error) {
            send(to, { type: 'error', message: describe(error) })
        }
    }

    const receive = (from: MessagePort, message: ToRecorder): void => {
        if (message.type === 'start') {
            run(async () => {
                await stop()
                if (port === from) {
                    start(from, message.config)
                }
            })
        } else {
            run(async () => {
                try {
                    await stop()
                } catch (error) {
                    send(from, { type: 'error', message: describe(error) })
                }
                send(from, { type: 'stopped' })
            })
        }
    }

    window.addEventListener('message', event => {
        const [given] = event.ports
        if (event.source !== window || given === undefined || !isPortMessage(event.data)) {
            return
        }
        event.stopImmediatePropagation()
        port?.close()
        port = given
        given.addEventListener('message', (message: MessageEvent<ToRecorder>) => receive(given, message.data))
        given.start()
    })
}

function send(port: MessagePort, message: FromRecorder): void {
    port.postMessage(message)
}

function pluginsFor(settings: Settings): RecorderPlugin[] {
    // How media elements play is cheap to record, and needed to replay them.
    const plugins = [mediaPlugin({ pixels: settings.video })]
    if (settings.console) {
        plugins.push(consolePlugin())
    }
    if (settings.network) {
        plugins.push(networkPlugin())
    }
    if (settings.perf) {
        plugins.push(perfPlugin())
    }
    if (settings.canvas) {
        plugins.push(canvasPlugin())
    }
    return plugins
}

function isPortMessage(data: unknown): boolean {
    return (
        typeof data === 'object' &&
        data !== null &&
        Reflect.get(data, 'channel') === CHANNEL &&
        Reflect.get(data, 'type') === 'port'
    )
}

function describe(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
