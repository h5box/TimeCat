import { decodeEvent, EventType, gunzip, readEventFrames } from '@timecat-js/protocol'
import type {
    ConsoleEvent,
    CustomDataEvent,
    NetworkEvent,
    PerfEvent,
    SnapshotEvent,
    TcrEvent,
    ViewportEvent
} from '@timecat-js/protocol'
import { Assets } from './assets.ts'
import { Materializer } from './materializer.ts'
import { pointerAt } from './pointer.ts'
import { Stage } from './stage.ts'
import type { SegmentSource } from './timeline/build.ts'
import { indexStream, loadIndex, revive } from './timeline/client.ts'
import type { LoadOptions } from './timeline/client.ts'
import type { IndexResponse } from './timeline/messages.ts'
import { Timeline } from './timeline/timeline.ts'
import type { Keyframe, TimelineIndex } from './timeline/types.ts'

/** A recording segment, as written by the recorder: a TCR file as a blob, a buffer or a view of one. */
export type RecordingSource = Blob | ArrayBuffer | ArrayBufferView

export interface PlayerOptions {
    /**
     * Element the replay fills; it must be in the document. One without a height of its own gets the proportions
     * of the recorded viewport.
     */
    container: Element
    /**
     * Where the recording is indexed. `true` (default) starts a worker from a bundled script through a `blob:`
     * URL; a URL starts the worker script published as `@timecat-js/player-core/worker` from there instead, for
     * pages whose CSP allows no `blob:` workers; `false` uses the main thread. When a worker cannot start, the main
     * thread takes over.
     */
    worker?: boolean | string | URL | undefined
    /**
     * Seeking builds the DOM from the nearest keyframe, then applies the events after it. The indexer adds a
     * keyframe once the events since the last one take this much work, counted in nodes and changes, or half the
     * size of the document if that is more. Smaller values make seeking faster and take more memory. Default 2000.
     */
    keyframeInterval?: number | undefined
    /** Playback rate; 1 (default) is real time. */
    speed?: number | undefined
    /** Starts playing once loaded. */
    autoplay?: boolean | undefined
    /** Receives errors that playback survives, such as an event that does not apply. Logged by default. */
    onError?: ((error: unknown) => void) | undefined
}

/** Something recorded beside the page: a console message, a request, a measurement or an application's event. */
export type DataEvent = ConsoleEvent | NetworkEvent | PerfEvent | CustomDataEvent

export interface TimedEvent {
    /** When it happened, on the clock of `currentTime`. */
    readonly time: number
    readonly event: DataEvent
}

/**
 * Plays a recording in a sandboxed frame. Times are in milliseconds from the first recorded event. Dispatches
 * `play`, `pause`, `ended`, `timeupdate` while playing and after seeking, and `durationchange` when more of a live
 * recording came or it ended.
 */
export interface Player extends EventTarget {
    readonly sessionId: string
    /** When recording started, in epoch milliseconds. */
    readonly startedAt: number
    /** Metadata from the header of the first segment. */
    readonly meta: Readonly<Record<string, unknown>>
    /** Problems the recording was read despite, such as a truncated last chunk. */
    readonly warnings: readonly string[]
    /** From the first event to the last thing recorded; for a live recording, to the last that can be played. */
    readonly duration: number
    /**
     * More of the recording is to come, as from a stream: `duration` grows as it does, and playing on at its end
     * waits for more rather than ending.
     */
    readonly live: boolean
    readonly currentTime: number
    readonly paused: boolean
    /** Playback rate; 1 is real time. */
    speed: number
    /** The replayed document, to look at: changing it breaks the replay. */
    readonly document: Document
    /** Console messages, requests, measurements and events of the application so far, in time order. */
    readonly events: readonly TimedEvent[]
    /** Plays from the current time, or from the start once ended. */
    play(): void
    pause(): void
    /** Moves to `time`. Resolves once the replay shows it, or a later time asked for meanwhile. */
    seek(time: number): Promise<void>
    /** Stops playing and removes the replay from its container. */
    destroy(): void
}

const DEFAULT_KEYFRAME_INTERVAL = 2000
/** Decompressed keyframes kept, for seeking back and forth around them. */
const CACHED_SNAPSHOTS = 2
const EMPTY = new Uint8Array(0)

/** A keyframe's snapshot and style events, decompressed. */
interface KeyframeState {
    snapshot: SnapshotEvent
    styles: Uint8Array
}

/**
 * Loads a recording, made of one or more segments of a session, and shows its start in `options.container`. From a
 * stream, such as one fed by the recorder's `onData`, the recording plays as it comes: the player is live, and
 * shows the latest it can.
 */
export async function createPlayer(
    source: RecordingSource | readonly RecordingSource[] | ReadableStream<Uint8Array>,
    options: PlayerOptions
): Promise<Player> {
    const { container } = options
    if (!container.isConnected) {
        throw new TypeError('the player container must be in the document')
    }
    const keyframeInterval = options.keyframeInterval ?? DEFAULT_KEYFRAME_INTERVAL
    if (!(keyframeInterval > 0)) {
        throw new RangeError(`keyframeInterval must be positive, got ${keyframeInterval}`)
    }
    const speed = checkSpeed(options.speed ?? 1)
    const onError = options.onError ?? logError
    const loadOptions = { worker: options.worker ?? true, keyframeInterval }
    const stage = Stage.create(container)
    let player: ReplayPlayer
    if (isStream(source)) {
        const feed = new StreamFeed(source, loadOptions, onError)
        try {
            player = new ReplayPlayer(await feed.timeline, await stage, speed, onError)
        } catch (error) {
            feed.stop()
            ;(await stage).destroy()
            throw error
        }
        feed.attach(player)
    } else {
        const sources = (isList(source) ? source : [source]).map(toSegment)
        try {
            player = new ReplayPlayer(new Timeline(await loadIndex(sources, loadOptions)), await stage, speed, onError)
        } catch (error) {
            ;(await stage).destroy()
            throw error
        }
    }
    await player.seek(player.live ? player.duration : 0)
    if (options.autoplay === true) {
        player.play()
    }
    return player
}

/** Indexes a stream: the timeline settles once it has an event to show, then the player takes what comes. */
class StreamFeed {
    readonly timeline: Promise<Timeline>
    readonly stop: () => void
    readonly #onError: (error: unknown) => void
    #player: ReplayPlayer | undefined
    /** Errors before the player took over, the first of which is why there is no timeline, if there is none. */
    readonly #errors: unknown[] = []

    constructor(stream: ReadableStream<Uint8Array>, options: LoadOptions, onError: (error: unknown) => void) {
        this.#onError = onError
        let resolve: (timeline: Timeline) => void = ignore
        let reject: (error: unknown) => void = ignore
        this.timeline = new Promise((resolveTimeline, rejectTimeline) => {
            resolve = resolveTimeline
            reject = rejectTimeline
        })
        let timeline: Timeline | undefined
        const receive = (response: IndexResponse): void => {
            const player = this.#player
            if (response.type === 'index') {
                if (player !== undefined) {
                    player.receive(response.index)
                    return
                }
                if (timeline === undefined) {
                    timeline = new Timeline(response.index)
                } else {
                    timeline.append(response.index)
                }
                // Until the first event, there is nothing to show.
                if (timeline.count > 0 || timeline.done) {
                    resolve(timeline)
                }
            } else if (response.type === 'error') {
                const error = revive(response)
                if (player !== undefined) {
                    player.fail(error)
                    return
                }
                reject(this.#errors[0] ?? error)
                this.#errors.push(error)
                timeline?.finish()
            }
        }
        // A stream that fails ends there: indexing still finishes what came.
        this.stop = indexStream(stream, options, receive, error => {
            if (this.#player === undefined) {
                this.#errors.push(error)
            } else {
                onError(error)
            }
        })
    }

    /** Hands what comes from now on to `player`, which stops the stream once destroyed. */
    attach(player: ReplayPlayer): void {
        this.#player = player
        player.onDestroy = this.stop
        for (const error of this.#errors) {
            this.#onError(error)
        }
    }
}

class ReplayPlayer extends EventTarget implements Player {
    /** Called once destroyed. */
    onDestroy: () => void = ignore
    readonly #timeline: Timeline
    readonly #stage: Stage
    readonly #materializer: Materializer
    readonly #assets: Assets
    readonly #document: Document
    readonly #onError: (error: unknown) => void
    readonly #start: number
    #end: number
    /** Stands for the viewport before the first one recorded. */
    #firstViewport: ViewportEvent | undefined
    readonly #snapshots = new Map<Keyframe, { snapshot: Uint8Array; styles: Uint8Array }>()
    /** Keyframes that failed to decompress, which seeking does without. */
    readonly #broken = new Set<Keyframe>()
    /** Events applied: the document shows the state after the first `#position` events, when `#valid`. */
    #position = 0
    #valid = false
    /** The time shown, on the timeline's clock. */
    #time: number
    #speed: number
    #playing = false
    #anchorTime = 0
    #anchorNow = 0
    #frame = 0
    #retry = 0
    /** A keyframe being decompressed, after which the document catches up with `#time`. */
    #loading: Promise<void> | undefined
    #events: readonly TimedEvent[] = []
    /** Data payloads of the timeline that `#events` holds. */
    #eventParts = 0
    #destroyed = false

    constructor(timeline: Timeline, stage: Stage, speed: number, onError: (error: unknown) => void) {
        super()
        this.#timeline = timeline
        this.#stage = stage
        this.#document = stage.document
        this.#assets = new Assets()
        for (const statics of timeline.statics) {
            this.#assets.add(readEvents(statics))
        }
        this.#materializer = new Materializer(this.#document, this.#assets)
        this.#onError = onError
        this.#start = timeline.start
        this.#end = Math.max(timeline.end, this.#start)
        this.#firstViewport = timeline.firstViewport()
        this.#time = this.#start
        this.#speed = speed
    }

    get sessionId(): string {
        return this.#timeline.sessionId
    }

    get startedAt(): number {
        return this.#timeline.startedAt
    }

    get meta(): Readonly<Record<string, unknown>> {
        return this.#timeline.meta
    }

    get warnings(): readonly string[] {
        return this.#timeline.warnings
    }

    get duration(): number {
        return this.#end - this.#start
    }

    get live(): boolean {
        return !this.#timeline.done
    }

    get currentTime(): number {
        return (this.#playing ? this.#clock(performance.now()) : this.#time) - this.#start
    }

    get paused(): boolean {
        return !this.#playing
    }

    get speed(): number {
        return this.#speed
    }

    set speed(value: number) {
        checkSpeed(value)
        if (this.#playing) {
            this.#time = this.#clock(performance.now())
            this.#anchor()
        }
        this.#speed = value
    }

    get document(): Document {
        return this.#document
    }

    get events(): readonly TimedEvent[] {
        const parts = this.#timeline.data
        if (this.#eventParts < parts.length) {
            const events = [...this.#events]
            for (const part of parts.slice(this.#eventParts)) {
                events.push(...readDataEvents(part, this.#start))
            }
            this.#eventParts = parts.length
            // Parts come in time order mostly; tracks that end their chunks later may come later.
            const ordered = events.every((event, i) => i === 0 || events[i - 1]!.time <= event.time)
            this.#events = ordered ? events : events.toSorted((a, b) => a.time - b.time)
        }
        return this.#events
    }

    /** Takes the next part of a live recording's index. */
    receive(part: TimelineIndex): void {
        if (this.#destroyed) {
            return
        }
        const timeline = this.#timeline
        timeline.append(part)
        this.#firstViewport ??= timeline.firstViewport()
        if (part.statics.length > 0) {
            this.#assets.add(readEvents(part.statics))
            // What the document shows may use them: it is built again.
            this.#valid = false
            if (!this.#playing) {
                this.#update().catch(this.#onError)
            }
        }
        this.#grow()
    }

    /** A live recording that cannot go on: what came is all there is. */
    fail(error: unknown): void {
        this.#onError(error)
        this.#timeline.finish()
        this.#grow()
    }

    play(): void {
        if (this.#playing || this.#destroyed) {
            return
        }
        if (this.#time >= this.#end && !this.live) {
            this.#time = this.#start
        }
        this.#playing = true
        this.#anchor()
        this.#frame = requestAnimationFrame(this.#tick)
        this.dispatchEvent(new Event('play'))
    }

    pause(): void {
        if (!this.#playing) {
            return
        }
        this.#time = this.#clock(performance.now())
        this.#stop()
        this.dispatchEvent(new Event('pause'))
        this.#update().catch(this.#onError)
    }

    async seek(time: number): Promise<void> {
        if (!Number.isFinite(time)) {
            throw new RangeError(`cannot seek to ${time}`)
        }
        if (this.#destroyed) {
            return
        }
        this.#time = this.#start + Math.min(Math.max(time, 0), this.duration)
        this.#anchor()
        await this.#update()
        this.dispatchEvent(new Event('timeupdate'))
    }

    destroy(): void {
        if (this.#destroyed) {
            return
        }
        this.#destroyed = true
        this.#stop()
        cancelAnimationFrame(this.#retry)
        this.#stage.destroy()
        this.#assets.revoke()
        this.#snapshots.clear()
        this.onDestroy()
    }

    readonly #tick = (now: number): void => {
        this.#frame = 0
        if (!this.#playing) {
            return
        }
        this.#time = this.#clock(now)
        this.#update().catch(this.#onError)
        this.dispatchEvent(new Event('timeupdate'))
        if (this.#time < this.#end) {
            this.#frame = requestAnimationFrame(this.#tick)
            return
        }
        if (this.live) {
            // Waits at the edge, then plays on from there.
            this.#anchor()
            this.#frame = requestAnimationFrame(this.#tick)
            return
        }
        this.#stop()
        this.dispatchEvent(new Event('pause'))
        this.dispatchEvent(new Event('ended'))
    }

    #clock(now: number): number {
        return Math.min(this.#end, this.#anchorTime + Math.max(now - this.#anchorNow, 0) * this.#speed)
    }

    #anchor(): void {
        this.#anchorTime = this.#time
        this.#anchorNow = performance.now()
    }

    /** Takes the timeline's new end, and says when the duration or liveness changed. */
    #grow(): void {
        const end = Math.max(this.#timeline.end, this.#start)
        if (end !== this.#end || this.#timeline.done) {
            this.#end = end
            this.dispatchEvent(new Event('durationchange'))
        }
    }

    #stop(): void {
        this.#playing = false
        cancelAnimationFrame(this.#frame)
        this.#frame = 0
    }

    /** Shows `#time`. Resolves once the document shows it, or a later time asked for meanwhile. */
    #update(): Promise<void> {
        this.#stage.showPointer(pointerAt(this.#timeline.pointer, this.#time))
        if (this.#loading === undefined) {
            let loading: Promise<void> | undefined
            try {
                loading = this.#render()
            } catch (error) {
                return Promise.reject(error)
            }
            if (loading === undefined) {
                return Promise.resolve()
            }
            this.#loading = loading.finally(() => {
                this.#loading = undefined
            })
        }
        return this.#loading
    }

    /**
     * Brings the document to `#time`: forward through the events when that is cheap, from a keyframe otherwise.
     * Returns a promise when a keyframe has to be decompressed first.
     */
    #render(): Promise<void> | undefined {
        if (this.#destroyed) {
            return undefined
        }
        const timeline = this.#timeline
        const target = timeline.positionAt(this.#time)
        const position = this.#position
        const keyframe = timeline.keyframeAt(target, this.#broken)
        const forward = this.#valid && position <= target
        const jump =
            keyframe !== undefined &&
            keyframe.index > position &&
            timeline.cost(position, keyframe.index) > keyframe.cost
        if (!forward || jump) {
            if (keyframe === undefined) {
                this.#clear()
            } else {
                const state = this.#stateOf(keyframe)
                if (state === undefined) {
                    // The time may have moved on meanwhile, so the next render decides afresh.
                    return this.#decompress(keyframe).then(() => this.#render())
                }
                this.#restore(keyframe, state)
            }
        }
        this.#advance(target)
        this.#flushScrolls()
        return undefined
    }

    /** The state a keyframe starts from, or `undefined` while it is still compressed. */
    #stateOf(keyframe: Keyframe): KeyframeState | undefined {
        let event
        let styles: Uint8Array = EMPTY
        if (keyframe.recorded) {
            event = this.#timeline.event(keyframe.index - 1)
        } else {
            const bytes = this.#snapshots.get(keyframe)
            if (bytes === undefined) {
                return undefined
            }
            event = decodeEvent(EventType.Snapshot, bytes.snapshot, { next: 0 })
            styles = bytes.styles
        }
        if (event?.type !== EventType.Snapshot) {
            throw new Error(`keyframe ${keyframe.index} has no snapshot`)
        }
        return { snapshot: event, styles }
    }

    async #decompress(keyframe: Keyframe): Promise<void> {
        try {
            const [snapshot, styles] = await Promise.all([
                gunzip(keyframe.snapshot),
                keyframe.styles.length === 0 ? EMPTY : gunzip(keyframe.styles)
            ])
            const snapshots = this.#snapshots
            snapshots.set(keyframe, { snapshot, styles })
            for (const old of snapshots.keys()) {
                if (snapshots.size <= CACHED_SNAPSHOTS) {
                    break
                }
                snapshots.delete(old)
            }
        } catch (error) {
            this.#broken.add(keyframe)
            this.#onError(error)
        }
    }

    #restore(keyframe: Keyframe, { snapshot, styles }: KeyframeState): void {
        const materializer = this.#materializer
        this.#valid = false
        materializer.build(snapshot)
        for (const event of readEvents(styles)) {
            materializer.apply(event)
        }
        for (const [type, body] of [
            [EventType.Input, keyframe.input],
            [EventType.Scroll, keyframe.scroll]
        ] as const) {
            const event = body.length === 0 ? undefined : decodeEvent(type, body, { next: 0 })
            if (event !== undefined) {
                materializer.apply(event)
            }
        }
        this.#setViewport(keyframe.viewport ?? this.#firstViewport)
        this.#position = keyframe.index
        this.#valid = true
    }

    /** Goes back to before the first snapshot. */
    #clear(): void {
        this.#materializer.clear()
        this.#setViewport(this.#firstViewport)
        this.#position = 0
        this.#valid = true
    }

    /** Applies the events up to `target`, one at a time, so one that fails costs only itself. */
    #advance(target: number): void {
        const timeline = this.#timeline
        const materializer = this.#materializer
        while (this.#position < target) {
            const i = this.#position++
            try {
                const event = timeline.event(i)
                if (event?.type === EventType.Snapshot) {
                    materializer.build(event)
                } else if (event?.type === EventType.Viewport) {
                    this.#setViewport(event)
                } else if (event !== undefined) {
                    materializer.apply(event)
                }
            } catch (error) {
                this.#onError(error)
            }
        }
    }

    #setViewport(viewport: { width: number; height: number } | undefined): void {
        if (viewport !== undefined) {
            this.#stage.setViewport(viewport.width, viewport.height)
        }
    }

    /** Scrolls once layout is done, again on the next frames for positions that did not stick yet. */
    #flushScrolls(): void {
        if (this.#materializer.flushScrolls() && this.#retry === 0 && !this.#destroyed) {
            this.#retry = requestAnimationFrame(() => {
                this.#retry = 0
                this.#flushScrolls()
            })
        }
    }
}

/** Decodes the events of an events chunk payload whose events add no nodes, such as the styles of a keyframe. */
function readEvents(payload: Uint8Array): TcrEvent[] {
    const events: TcrEvent[] = []
    for (const { type, body } of readEventFrames(payload, 0)) {
        const event = decodeEvent(type, body, { next: 0 })
        if (event !== undefined) {
            events.push(event)
        }
    }
    return events
}

function readDataEvents(payload: Uint8Array, start: number): TimedEvent[] {
    const events: TimedEvent[] = []
    for (const { type, time, body } of readEventFrames(payload, 0)) {
        const event = decodeEvent(type, body, { next: 0 })
        if (
            event?.type === EventType.Console ||
            event?.type === EventType.Network ||
            event?.type === EventType.Perf ||
            event?.type === EventType.Custom
        ) {
            events.push({ time: Math.max(0, time - start), event })
        }
    }
    return events
}

function checkSpeed(speed: number): number {
    if (!(speed > 0 && Number.isFinite(speed))) {
        throw new RangeError(`speed must be a positive number, got ${speed}`)
    }
    return speed
}

function isList(source: RecordingSource | readonly RecordingSource[]): source is readonly RecordingSource[] {
    return Array.isArray(source)
}

function isStream(
    source: RecordingSource | readonly RecordingSource[] | ReadableStream<Uint8Array>
): source is ReadableStream<Uint8Array> {
    // Duck-typed, because a stream can come from another realm.
    return 'getReader' in source
}

function toSegment(source: RecordingSource): SegmentSource {
    if (ArrayBuffer.isView(source)) {
        return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    }
    return 'arrayBuffer' in source ? source : new Uint8Array(source)
}

function logError(error: unknown): void {
    console.error('[timecat]', error)
}

function ignore(): void {
    // Nothing to do.
}
