import { createPlayer } from '@timecat-js/player-core'
import { BatchWriter } from '../../src/batch.ts'
import { Capture } from '../../src/capture.ts'
import { Pipeline } from '../../src/pipeline/pipeline.ts'
import type { PrivacyOptions } from '../../src/privacy.ts'
import { describePage } from './describe.ts'

export interface SessionOptions extends PrivacyOptions {
    /** Markup of the recorded page, parsed as a page's would be. */
    html: string
    /** Size of the recorded viewport. */
    width?: number
    height?: number
    /** Changes the page before recording starts. */
    prepare?: (document: Document) => void
    /**
     * Runs between time slices of the snapshot, which are then `checkEvery` nodes long, with the number of the
     * slice that just ended.
     */
    betweenSlices?: (document: Document, slice: number) => void
    checkEvery?: number
    assetBudget?: number
    /** Where the test keeps the closed shadow roots it attaches, when it does before the session is open. */
    closedRoots?: Map<Element, ShadowRoot>
}

/** What the recorded page showed at a time. */
export interface Checkpoint {
    time: number
    state: string
}

/** Values are recorded as typed unless a test asks for masking. */
const UNMASKED = 'input, textarea, select'

const sessions = new Set<Session>()

/** Ends what tests left open. */
export async function closeSessions(): Promise<void> {
    await Promise.all([...sessions].map(session => session.close()))
}

/**
 * Records a page in a frame through the recorder's capture and pipeline, on a clock the test moves. Changes are
 * written when the test flushes, so it knows the time every state is recorded at.
 */
export class Session {
    readonly frame: HTMLIFrameElement
    readonly document: Document
    readonly errors: unknown[] = []
    readonly checkpoints: Checkpoint[] = []
    /** Closed shadow roots the test attached, which the description of the page cannot find on its own. */
    readonly closedRoots: Map<Element, ShadowRoot>
    readonly #capture: Capture
    readonly #pipeline: Pipeline
    readonly #parts: Uint8Array[] = []
    #time = 0
    #closed: Promise<void> | undefined

    private constructor(frame: HTMLIFrameElement, window: Window, options: SessionOptions) {
        this.frame = frame
        this.document = window.document
        this.closedRoots = options.closedRoots ?? new Map()
        const onError = (error: unknown): void => void this.errors.push(error)
        this.#pipeline = new Pipeline(
            { sessionId: 'fidelity', segment: 0, startedAt: 1_760_000_000_000, meta: {} },
            bytes => void this.#parts.push(bytes),
            onError
        )
        const between = options.betweenSlices
        let slice = 0
        this.#capture = new Capture({
            maskText: options.maskText,
            block: options.block,
            ignore: options.ignore,
            unmaskInputs: 'unmaskInputs' in options ? options.unmaskInputs : UNMASKED,
            window,
            sink: new BatchWriter(batch => this.#pipeline.push(batch)),
            now: () => this.#time,
            // Without a callback, the snapshot takes one slice.
            sliceMs: between === undefined ? 60_000 : 0,
            checkEvery: options.checkEvery ?? 64,
            assetBudget: options.assetBudget ?? 8 * 1024 * 1024,
            yieldToPage: () => {
                between?.(this.document, slice++)
                return Promise.resolve()
            },
            // The test flushes.
            scheduleFlush: () => noop,
            onHidden: noop,
            onError
        })
    }

    /** Opens a page in a new frame and records it from the end of its snapshot. */
    static async open(options: SessionOptions): Promise<Session> {
        const frame = document.createElement('iframe')
        frame.style.cssText = `display: block; border: 0; width: ${options.width ?? 640}px; height: ${options.height ?? 480}px`
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
        document.body.append(frame)
        await loaded
        const window = frame.contentWindow
        if (window === null) {
            throw new Error('the frame has no window')
        }
        const page = window.document
        page.open()
        page.write(options.html)
        page.close()
        options.prepare?.(page)
        const session = new Session(frame, window, options)
        sessions.add(session)
        await session.#capture.start()
        return session
    }

    get time(): number {
        return this.#time
    }

    /** Moves the clock on. */
    wait(ms: number): void {
        this.#time += ms
    }

    /** Writes what changed so far, at the current time. */
    flush(): void {
        this.#capture.flush(true)
    }

    /** Writes a sync point, as a live recording does now and then. */
    sync(): void {
        this.flush()
        this.#capture.sync()
    }

    /** Flushes, notes what the page shows, and moves the clock on so that later changes come after. */
    checkpoint(): void {
        this.flush()
        const state = describePage(this.document, host => host.shadowRoot ?? this.closedRoots.get(host) ?? null)
        this.checkpoints.push({ time: this.#time, state })
        this.#time++
    }

    /**
     * Like `checkpoint`, with what `describe` says the page shows, which may wait for what loads, such as images.
     * Changes made meanwhile come after the checkpoint.
     */
    async checkpointAs(describe: Describe): Promise<void> {
        this.flush()
        const time = this.#time++
        this.checkpoints.push({ time, state: await describe(this.document) })
    }

    /** Stops recording, once the content of `blob:` URLs is read, and returns the recording. */
    async finish(): Promise<Uint8Array<ArrayBuffer>> {
        this.flush()
        await this.#capture.settled()
        await this.close()
        return concat(this.#parts)
    }

    /** Stops recording and removes the page. Resolves once the recording is complete. */
    close(): Promise<void> {
        if (this.#closed === undefined) {
            sessions.delete(this)
            this.#capture.stop()
            this.#closed = this.#pipeline.close()
            this.frame.remove()
        }
        return this.#closed
    }
}

/** Says what a page shows, as `describePage` does or in a way of a test's own. */
export type Describe = (document: Document) => string | Promise<string>

/**
 * Plays a recording, seeks to the times given, in their order, and describes what the replay shows at each.
 * Small keyframe intervals make seeks go through keyframes the player wrote itself. With `stream`, the player
 * reads the recording as a live stream, in pieces, and the seeks wait until it ended.
 */
export async function replay(
    recording: Uint8Array,
    times: readonly number[],
    keyframeInterval: number,
    describe: Describe = describePage,
    stream = false
): Promise<string[]> {
    const container = document.createElement('div')
    container.style.cssText = 'width: 320px; height: 240px'
    document.body.append(container)
    const errors: unknown[] = []
    const player = await createPlayer(stream ? streamOf(recording) : recording, {
        container,
        keyframeInterval,
        onError: error => errors.push(error)
    })
    try {
        while (player.live) {
            // oxlint-disable-next-line no-await-in-loop -- the stream comes a part at a time
            await new Promise(resolve => player.addEventListener('durationchange', resolve, { once: true }))
        }
        const states: string[] = []
        for (const time of times) {
            // oxlint-disable-next-line no-await-in-loop -- each seek starts where the last one ended
            await player.seek(time)
            // oxlint-disable-next-line no-await-in-loop -- the replay has to stay at this time meanwhile
            states.push(await describe(player.document))
        }
        if (errors.length > 0 || player.warnings.length > 0) {
            states.push(`errors: ${String(errors)}; warnings: ${player.warnings.join(', ')}`)
        }
        return states
    } finally {
        player.destroy()
        container.remove()
    }
}

/** The bytes of a recording as a stream gives them, in pieces of a few sizes, one task after the other. */
function streamOf(recording: Uint8Array): ReadableStream<Uint8Array> {
    let offset = 0
    let piece = 0
    return new ReadableStream({
        async pull(controller) {
            await new Promise(resolve => setTimeout(resolve, 0))
            const size = [1, 100, 4000][piece++ % 3]!
            controller.enqueue(recording.slice(offset, offset + size))
            offset += size
            if (offset >= recording.length) {
                controller.close()
            }
        }
    })
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    let length = 0
    for (const part of parts) {
        length += part.length
    }
    const result = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
        result.set(part, offset)
        offset += part.length
    }
    return result
}

function noop(): void {}
