import { encodeConsole, encodeCustom, encodeNetwork, encodePerf, EventType, Track } from '@timecat-js/protocol'
import type { ConsoleEvent, CustomDataEvent, NetworkEvent, PerfEvent } from '@timecat-js/protocol'

/** Events that plugins write, each on its own track. */
export type PluginEvent = ConsoleEvent | NetworkEvent | PerfEvent | CustomDataEvent

/** Records something beside the page, such as console messages or network requests. */
export interface RecorderPlugin {
    /** Names the plugin in errors. */
    readonly name: string
    /**
     * Starts recording, right after the recording of the page starts. Returns a function that stops it, which
     * runs when the recording stops and can still write events, such as measurements that were not final.
     */
    start(context: PluginContext): (() => void) | undefined | void
}

export interface PluginContext {
    /** The window recorded. */
    readonly window: Window & typeof globalThis
    /** The current time of the recording, in milliseconds. */
    now(): number
    /** Turns a `performance.now()` time of the window, such as a performance entry's, into recording time. */
    time(highResolutionTime: number): number
    /**
     * Writes an event, at `time` or now. Times before the last event of the same track are taken as that one's.
     * Does nothing once the recording stopped.
     */
    write(event: PluginEvent, time?: number): void
    /** The id the recording gives `node`, or 0 when it has none: when it is not recorded, or not yet. */
    nodeId(node: Node): number
    /** Reports an error that recording goes on after. */
    onError(error: unknown): void
}

/** What plugins write through. */
export interface PluginHost {
    readonly window: Window & typeof globalThis
    /** `performance.now()` when recording started. */
    readonly origin: number
    write(track: number, type: number, time: number, body: Uint8Array): void
    nodeId(node: Node): number
    onError(error: unknown): void
}

/**
 * Starts `plugins`. Returns a function that stops them; events they write while they stop are kept, and later
 * ones dropped.
 */
export function startPlugins(plugins: readonly RecorderPlugin[], host: PluginHost): () => void {
    let stopped = false
    const time = (highResolutionTime: number): number => Math.max(0, Math.round(highResolutionTime - host.origin))
    const context: PluginContext = {
        window: host.window,
        now: () => time(host.window.performance.now()),
        time,
        write(event, at) {
            if (stopped) {
                return
            }
            const [track, body] = encodePluginEvent(event)
            host.write(track, event.type, at ?? context.now(), body)
        },
        nodeId: node => host.nodeId(node),
        onError: error => host.onError(error)
    }
    const stops: [name: string, stop: () => void][] = []
    for (const plugin of plugins) {
        try {
            const stop = plugin.start(context)
            if (typeof stop === 'function') {
                stops.push([plugin.name, stop])
            }
        } catch (error) {
            host.onError(new Error(`plugin ${plugin.name} did not start`, { cause: error }))
        }
    }
    return () => {
        if (stopped) {
            return
        }
        for (const [name, stop] of stops) {
            try {
                stop()
            } catch (error) {
                host.onError(new Error(`plugin ${name} did not stop`, { cause: error }))
            }
        }
        stopped = true
    }
}

function encodePluginEvent(event: PluginEvent): [track: number, body: Uint8Array] {
    switch (event.type) {
        case EventType.Console:
            return [Track.Console, encodeConsole(event)]
        case EventType.Network:
            return [Track.Network, encodeNetwork(event)]
        case EventType.Perf:
            return [Track.Perf, encodePerf(event)]
        default:
            return [Track.Custom, encodeCustom(event)]
    }
}
