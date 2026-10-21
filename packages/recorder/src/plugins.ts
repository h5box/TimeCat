import {
    encodeConsole,
    encodeCustom,
    encodeMediaState,
    encodeNetwork,
    encodePerf,
    EventType,
    FIRST_DYNAMIC_TRACK,
    Track
} from '@timecat-js/protocol'
import type {
    ConsoleEvent,
    CustomDataEvent,
    MediaPacket,
    MediaStateEvent,
    MediaTrackEvent,
    NetworkEvent,
    PerfEvent
} from '@timecat-js/protocol'

/** Events that plugins write, each on its own track. */
export type PluginEvent = ConsoleEvent | NetworkEvent | PerfEvent | CustomDataEvent | MediaStateEvent

/** The format of a media track: WebCodecs chunks of a codec, or a container stream (RFC 0002, 6.21). */
export type MediaFormat = Omit<MediaTrackEvent, 'type' | 'track'>

/** Records something beside the page, such as console messages or network requests. */
export interface RecorderPlugin {
    /** Names the plugin in errors. */
    readonly name: string
    /**
     * Starts recording, right after the recording of the page starts. Returns a function that stops it, which
     * runs when the recording stops and can still write events, such as measurements that were not final, until
     * the promise it returns settles.
     */
    start(context: PluginContext): (() => void | Promise<void>) | undefined | void
}

export interface PluginContext {
    /** The window recorded. */
    readonly window: Window & typeof globalThis
    /** The current time of the recording, in milliseconds. */
    now(): number
    /** Turns a `performance.now()` time of the window, such as a performance entry's, into recording time. */
    time(highResolutionTime: number): number
    /** Like `time`, in microseconds: the unit of media packets. */
    microseconds(highResolutionTime: number): number
    /**
     * Writes an event, at `time` or now. Times before the last event of the same track are taken as that one's.
     * Does nothing once the recording stopped.
     */
    write(event: PluginEvent, time?: number): void
    /**
     * Opens a media track, such as the video of a canvas, with the format of its packets from `time` or now on.
     * Its packets go into the recording as they come.
     */
    openMedia(format: MediaFormat, time?: number): MediaTrackWriter
    /** Settles once the first snapshot of the page is written, which gives the nodes in the page their ids. */
    readonly ready: Promise<void>
    /** The id the recording gives `node`, or 0 when it has none: when it is not recorded, or not yet. */
    nodeId(node: Node): number
    /**
     * Whether the recording leaves out what `element` holds, as the `block` option asks, recording a placeholder
     * instead. Plugins that record what elements show leave it out too.
     */
    blocks(element: Element): boolean
    /**
     * Calls `callback` with each document and shadow root recorded, those so far and those to come: the page's
     * document, the documents of its same-origin frames, and shadow roots. Events that do not leave a shadow tree
     * can be listened to on its root.
     */
    observeRoots(callback: (root: Document | ShadowRoot) => void): void
    /** Reports an error that recording goes on after. */
    onError(error: unknown): void
}

/** Writes the packets of a media track. Does nothing once the recording stopped. */
export interface MediaTrackWriter {
    readonly track: number
    /** Changes the format from `time` or now on, such as for a canvas resized. The next packet is a key packet. */
    format(format: MediaFormat, time?: number): void
    /**
     * Writes a packet. Its time is in microseconds of the recording (`microseconds`), not before the format; the
     * first packet, and the first after a change of format, is a key packet.
     */
    write(packet: MediaPacket): void
}

/** What plugins write through. */
export interface PluginHost {
    readonly window: Window & typeof globalThis
    /** `performance.now()` when recording started. */
    readonly origin: number
    write(track: number, type: number, time: number, body: Uint8Array): void
    mediaTrack(event: Omit<MediaTrackEvent, 'type'>, time: number): void
    media(track: number, packet: MediaPacket): void
    readonly ready: Promise<void>
    nodeId(node: Node): number
    blocks(element: Element): boolean
    observeRoots(observer: (root: Document | ShadowRoot) => void): void
    onError(error: unknown): void
}

/** How long stopping waits for plugins; what one writes later is lost. */
const STOP_TIMEOUT = 2000

/**
 * Starts `plugins`. Returns a function that stops them. What a plugin writes until it stopped is kept, and what it
 * writes later dropped: a plugin stopped once its stop function returned, or the promise it returned settled.
 */
export function startPlugins(plugins: readonly RecorderPlugin[], host: PluginHost): () => Promise<void> {
    const tracks = { next: FIRST_DYNAMIC_TRACK }
    const running: { name: string; stop: (() => void | Promise<void>) | undefined; state: { stopped: boolean } }[] = []
    for (const plugin of plugins) {
        const state = { stopped: false }
        try {
            const stop = plugin.start(createContext(host, state, tracks))
            running.push({ name: plugin.name, stop: typeof stop === 'function' ? stop : undefined, state })
        } catch (error) {
            state.stopped = true
            host.onError(new Error(`plugin ${plugin.name} did not start`, { cause: error }))
        }
    }
    let stopping: Promise<void> | undefined
    return () => {
        stopping ??= Promise.all(
            running.map(async ({ name, stop, state }) => {
                const failed = (error: unknown): void =>
                    host.onError(new Error(`plugin ${name} did not stop`, { cause: error }))
                let result: void | Promise<void> = undefined
                try {
                    result = stop?.()
                } catch (error) {
                    failed(error)
                }
                if (result instanceof Promise) {
                    let timer: ReturnType<typeof setTimeout> | undefined
                    await Promise.race([
                        result.catch(failed),
                        new Promise(resolve => {
                            timer = setTimeout(resolve, STOP_TIMEOUT)
                        })
                    ])
                    clearTimeout(timer)
                }
                state.stopped = true
            })
        ).then(() => undefined)
        return stopping
    }
}

function createContext(host: PluginHost, state: { stopped: boolean }, tracks: { next: number }): PluginContext {
    const time = (highResolutionTime: number): number => Math.max(0, Math.round(highResolutionTime - host.origin))
    const context: PluginContext = {
        window: host.window,
        now: () => time(host.window.performance.now()),
        time,
        microseconds: highResolutionTime => Math.max(0, Math.round((highResolutionTime - host.origin) * 1000)),
        write(event, at) {
            if (state.stopped) {
                return
            }
            const [track, body] = encodePluginEvent(event)
            host.write(track, event.type, at ?? context.now(), body)
        },
        openMedia(first, at) {
            const track = tracks.next++
            const declare = (format: MediaFormat, declaredAt = context.now()): void => {
                if (!state.stopped) {
                    host.mediaTrack({ ...format, track }, declaredAt)
                }
            }
            declare(first, at)
            return {
                track,
                format: declare,
                write(packet) {
                    if (!state.stopped) {
                        host.media(track, packet)
                    }
                }
            }
        },
        ready: host.ready,
        nodeId: node => host.nodeId(node),
        blocks: element => host.blocks(element),
        observeRoots(callback) {
            host.observeRoots(root => {
                if (!state.stopped) {
                    callback(root)
                }
            })
        },
        onError: error => host.onError(error)
    }
    return context
}

function encodePluginEvent(event: PluginEvent): [track: number, body: Uint8Array] {
    switch (event.type) {
        case EventType.Console:
            return [Track.Console, encodeConsole(event)]
        case EventType.Network:
            return [Track.Network, encodeNetwork(event)]
        case EventType.Perf:
            return [Track.Perf, encodePerf(event)]
        case EventType.MediaState:
            return [Track.Media, encodeMediaState(event)]
        default:
            return [Track.Custom, encodeCustom(event)]
    }
}
