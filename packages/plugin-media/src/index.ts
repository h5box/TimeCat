import type { PluginContext, RecorderPlugin } from '@timecat-js/recorder'
import { startNarration } from './narration.ts'
import type { NarrationSource } from './narration.ts'
import { VideoCapture } from './pixels.ts'
import { isAdvancing, isMediaElement, isVideoElement, STATE_EVENTS, stateOf } from './state.ts'

export type { NarrationSource } from './narration.ts'

export interface MediaPluginOptions {
    /**
     * Records the playback state of `<audio>` and `<video>` elements: playing or not, position, rate, volume and
     * muting, which players follow with the replayed elements, from the sources the page had. `true` by default.
     */
    state?: boolean | undefined
    /**
     * Records what `<video>` elements show and play, as video, for sources a replay cannot load again, such as the
     * `blob:` URLs of streaming players: `true` for every video, or a CSS selector of the videos. Off by default.
     */
    pixels?: boolean | string | undefined
    /** Bits per second of the video recorded of a `<video>`; the browser's default when left out. */
    pixelsBitrate?: number | undefined
    /**
     * Records narration that plays with the replay: `true` for the microphone, which the browser asks the user
     * for when recording starts, or a `MediaStream` of the page's, or a function that gives one, whose sound is
     * recorded. Off by default.
     */
    narration?: false | NarrationSource | undefined
    /** Bits per second of the narration. 32000 by default. */
    narrationBitrate?: number | undefined
}

interface Settings {
    state: boolean
    /** Selector of the videos whose pixels are recorded, or undefined for none. */
    pixels: string | undefined
    pixelsBitrate: number | undefined
    narration: NarrationSource | undefined
    narrationBitrate: number
}

/**
 * Records audio and video: the playback state of `<audio>` and `<video>` elements, optionally what videos show, and
 * optionally narration from the microphone.
 */
export function mediaPlugin(options: MediaPluginOptions = {}): RecorderPlugin {
    const pixels = options.pixels === true ? 'video' : options.pixels === false ? undefined : options.pixels
    if (pixels !== undefined) {
        // Throws a SyntaxError for an invalid selector.
        document.createDocumentFragment().querySelector(pixels)
    }
    const narrationBitrate = options.narrationBitrate ?? 32_000
    for (const [name, value] of [
        ['narrationBitrate', narrationBitrate],
        ['pixelsBitrate', options.pixelsBitrate ?? 1]
    ] as const) {
        if (!(value > 0 && value < Infinity)) {
            throw new RangeError(`${name} must be a positive number, got ${value}`)
        }
    }
    const settings: Settings = {
        state: options.state ?? true,
        pixels,
        pixelsBitrate: options.pixelsBitrate,
        narration: options.narration === false ? undefined : options.narration,
        narrationBitrate
    }
    return {
        name: 'media',
        start: context => startMedia(context, settings)
    }
}

function startMedia(context: PluginContext, settings: Settings): () => Promise<void> {
    const { pixels } = settings
    const listeners = new AbortController()
    const listenerOptions: AddEventListenerOptions = { capture: true, passive: true, signal: listeners.signal }
    const roots: WeakRef<Document | ShadowRoot>[] = []
    const captures = new Map<HTMLVideoElement, VideoCapture>()
    /** Videos whose pixels cannot be recorded, such as those of other origins. */
    const failed = new WeakSet<HTMLVideoElement>()
    let ready = false

    const capture = (element: HTMLMediaElement, id: number): void => {
        if (pixels === undefined || !isVideoElement(element) || failed.has(element) || !element.matches(pixels)) {
            return
        }
        let videoCapture = captures.get(element)
        if (videoCapture === undefined) {
            videoCapture = new VideoCapture(element, context, settings.pixelsBitrate, error => {
                failed.add(element)
                context.onError(new Error(`the pixels of video ${id} are not recorded`, { cause: error }))
            })
            captures.set(element, videoCapture)
        }
        videoCapture.start(id)
    }
    const look = (element: HTMLMediaElement, type: string | undefined): void => {
        const id = context.nodeId(element)
        if (id === 0 || context.blocks(element)) {
            return
        }
        if (settings.state) {
            context.write(stateOf(element, id))
        }
        // Recording what a video shows starts as it first plays.
        if (type === 'playing' || (type === undefined && isAdvancing(element))) {
            capture(element, id)
        }
    }
    const onEvent = (event: Event): void => {
        const { target } = event
        if (ready && isMediaElement(target)) {
            look(target, event.type)
        }
    }
    /** Records the elements of a root as they are. */
    const lookThrough = (root: Document | ShadowRoot): void => {
        for (const element of root.querySelectorAll('audio, video')) {
            if (isMediaElement(element)) {
                look(element, undefined)
            }
        }
    }

    context.observeRoots(root => {
        roots.push(new WeakRef(root))
        for (const type of STATE_EVENTS) {
            root.addEventListener(type, onEvent, listenerOptions)
        }
        if (ready) {
            // The nodes in a root get their ids as it is written, right after it is entered.
            queueMicrotask(() => lookThrough(root))
        }
    })
    const begun = (async () => {
        await context.ready
        if (!listeners.signal.aborted) {
            ready = true
            for (const reference of roots) {
                const root = reference.deref()
                if (root !== undefined) {
                    lookThrough(root)
                }
            }
        }
    })()
    const stopNarration =
        settings.narration === undefined
            ? undefined
            : startNarration(context, settings.narration, settings.narrationBitrate)

    return async () => {
        listeners.abort()
        await begun
        await Promise.all([...Array.from(captures.values(), videoCapture => videoCapture.end()), stopNarration?.()])
    }
}
