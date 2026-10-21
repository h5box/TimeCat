/**
 * The content script of every page while a tab is recorded. It asks the background whether its tab is; if so, the
 * background injects the recorder into the page's world, and the bridge passes messages between the two: the
 * runtime port to the background carries JSON only, so the bytes of the recording go in base64.
 */
import { toBase64 } from './base64.ts'
import { CHANNEL, PORT_NAME } from './messages.ts'
import type { FromRecorder, StartConfig, ToBackground, ToBridge, ToRecorder } from './messages.ts'

/** The port to the background while this page is recorded, or is asking whether it is. */
let background: chrome.runtime.Port | undefined
/** The port to the recorder in the page's world, once it started. */
let recorder: MessagePort | undefined
/** What the recorder started with, until it stops. */
let recording: StartConfig | undefined
let seq = 0

function send(message: ToBackground): void {
    const port = background
    port?.postMessage(message)
}

function tell(message: ToRecorder): void {
    const port = recorder
    port?.postMessage(message)
}

/** Opens a port to the background and sends `first` on it; `false` when the extension is gone. */
function connect(first: ToBackground): boolean {
    let port: chrome.runtime.Port
    try {
        port = chrome.runtime.connect({ name: PORT_NAME })
    } catch {
        // The extension was reloaded or removed: this script is left over.
        return false
    }
    background = port
    port.onMessage.addListener((message: ToBridge) => {
        if (background === port) {
            receive(port, message)
        }
    })
    port.onDisconnect.addListener(() => {
        if (background !== port) {
            return
        }
        background = undefined
        // The service worker stopped, as it does when a hidden page sends too little to keep it running: what
        // comes from now on goes to the next.
        const resumed =
            recording !== undefined &&
            connect({ type: 'resume', session: recording.sessionId, segment: recording.segment })
        if (!resumed) {
            stopRecording()
        }
    })
    port.postMessage(first)
    return true
}

function hello(): void {
    connect({ type: 'hello', url: location.href, title: document.title })
}

function receive(port: chrome.runtime.Port, message: ToBridge): void {
    switch (message.type) {
        case 'start': {
            const channel = new MessageChannel()
            recorder?.close()
            recorder = channel.port1
            recording = message.config
            seq = 0
            channel.port1.addEventListener('message', (event: MessageEvent<FromRecorder>) => {
                if (recorder === channel.port1) {
                    forward(event.data)
                }
            })
            channel.port1.start()
            window.postMessage({ channel: CHANNEL, type: 'port' }, '*', [channel.port2])
            tell({ type: 'start', config: message.config })
            break
        }
        case 'stop':
            tell({ type: 'stop' })
            break
        case 'idle':
            background = undefined
            port.disconnect()
            stopRecording()
            break
    }
}

function forward(message: FromRecorder): void {
    switch (message.type) {
        case 'data':
            send({ type: 'data', seq: seq++, base64: toBase64(message.bytes) })
            break
        case 'stopped':
            recording = undefined
            send({ type: 'stopped' })
            break
        case 'error':
            send({ type: 'error', message: message.message })
            break
    }
}

/** Stops the recorder, if it runs, with nowhere for what it still gives to go. */
function stopRecording(): void {
    tell({ type: 'stop' })
    recorder = undefined
    recording = undefined
}

/** The title comes with the page; the URL can change before it does. */
function sendPage(): void {
    if (recording !== undefined) {
        send({ type: 'page', url: location.href, title: document.title })
    }
}

document.addEventListener('DOMContentLoaded', sendPage)
window.addEventListener('load', sendPage)
// A page that comes back from the back/forward cache is a new page of the recording: what it recorded before is in
// the page it was then, and its port closed when it went into the cache.
window.addEventListener('pageshow', event => {
    if (event.persisted) {
        const port = background
        background = undefined
        port?.disconnect()
        stopRecording()
        hello()
    }
})

hello()
