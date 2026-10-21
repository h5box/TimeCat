import { MediaKind } from '@timecat-js/protocol'
import type { MediaTrackEvent } from '@timecat-js/protocol'
import { isCanvas, isElement, isMedia } from '../dom.ts'
import { lowerBound } from '../search.ts'
import type { Timeline } from '../timeline/timeline.ts'
import { drive, stop } from './element.ts'

/** How long a growing clip played from a blob goes on before the blob is made anew with what came since. */
const BLOB_REFRESH = 3000
/** `HTMLMediaElement.HAVE_CURRENT_DATA`: a frame to show. */
const HAVE_CURRENT_DATA = 2

/** The replay's time and the viewer's settings, which media follow. */
export interface MediaTime {
    time: number
    playing: boolean
    speed: number
    volume: number
    muted: boolean
}

/** What media need of the player. */
export interface MediaHost {
    readonly timeline: Timeline
    /** The replayed node a recorded id stands for. */
    readonly node: (id: number) => Node | undefined
    /** The document the player's own media elements are made in. */
    readonly document: Document
    readonly onError: (error: unknown) => void
    /** Something was drawn in a replayed canvas. */
    readonly onDrawn: (canvas: HTMLCanvasElement) => void
    /** The browser did not let media play with sound before the viewer interacted with the page. */
    readonly onBlocked: () => void
}

/**
 * One file of a container track: its packets from a declaration to the next, put together. It plays in the
 * replayed `<audio>` or `<video>` element it belongs to; or in an element of the player's own, whose frames show in
 * the `<canvas>` it belongs to, and which plays a narration that belongs to no element.
 */
export class Clip {
    /** Where the file's time 0 is on the timeline. */
    readonly start: number
    /** Where the next declaration of the track starts. */
    end: number = Infinity
    readonly #declaration: MediaTrackEvent
    readonly #host: MediaHost
    #element: HTMLMediaElement | undefined
    #source: Source | undefined
    /** The next packet of the track to hand to the source. */
    #next = 0
    #own: HTMLMediaElement | undefined
    /** The player's own element, when it is a video whose frames show in a canvas. */
    #video: HTMLVideoElement | undefined
    #canvas: HTMLCanvasElement | undefined
    /** What was shown last, to show again once more of the media loaded. */
    #now: MediaTime | undefined

    constructor(start: number, declaration: MediaTrackEvent, host: MediaHost) {
        this.start = start
        this.#declaration = declaration
        this.#host = host
    }

    /** Plays or shows the clip at `now`; returns the replayed element it plays in, if it does. */
    show(now: MediaTime): HTMLMediaElement | undefined {
        const host = this.#host
        this.#now = now
        if (now.time < this.start || now.time >= this.end) {
            if (this.#element !== undefined) {
                stop(this.#element)
            }
            return undefined
        }
        const target = host.node(this.#declaration.targetId)
        const replayed = target !== undefined && isElement(target) && isMedia(target) ? target : undefined
        this.#canvas = target !== undefined && isElement(target) && isCanvas(target) ? target : undefined
        const element = replayed ?? this.#ownElement()
        const source = this.#source
        // The replay may build its element anew, or give it its recorded source back.
        if (element !== this.#element || source === undefined || element.getAttribute('src') !== source.url) {
            this.#attach(element)
        }
        this.#feed()
        if (this.#source?.refresh() === true) {
            element.src = this.#source.url
        }
        const { time, playing, speed, volume, muted } = now
        drive(element, { position: (time - this.start) / 1000, playing, rate: speed, volume, muted }, host.onBlocked)
        this.#draw()
        return replayed
    }

    destroy(): void {
        const element = this.#element
        if (element !== undefined) {
            stop(element)
            if (element === this.#own) {
                element.removeAttribute('src')
                element.load()
            }
        }
        this.#source?.destroy()
        this.#source = undefined
    }

    #ownElement(): HTMLMediaElement {
        if (this.#own === undefined) {
            const document = this.#host.document
            let element: HTMLMediaElement
            if (this.#declaration.kind === MediaKind.Video) {
                const video = document.createElement('video')
                video.playsInline = true
                // A frame that comes after a seek shows once it is there. The video is in no document, where
                // `requestVideoFrameCallback` would say so.
                video.addEventListener('seeked', () => this.#draw())
                video.addEventListener('loadeddata', () => this.#draw())
                element = this.#video = video
            } else {
                element = document.createElement('audio')
            }
            element.preload = 'auto'
            // A position past what loaded so far is reached once more did.
            element.addEventListener('durationchange', () => {
                const now = this.#now
                if (now !== undefined && !now.playing) {
                    this.show(now)
                }
            })
            this.#own = element
        }
        return this.#own
    }

    /** Plays the clip in `element`, from a source of its own: one source attaches to one element only. */
    #attach(element: HTMLMediaElement): void {
        if (this.#element !== undefined && this.#element !== element) {
            stop(this.#element)
        }
        this.#source?.destroy()
        const { container } = this.#declaration
        const source =
            typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(container)
                ? new StreamSource(container, this.#host.onError)
                : new BlobSource(container)
        const packets = this.#host.timeline.packets(this.#declaration.track)
        this.#next = packets === undefined ? 0 : lowerBound(packets.times, this.start)
        this.#element = element
        this.#source = source
        element.src = source.url
    }

    /** Hands the source the packets that came since. */
    #feed(): void {
        const timeline = this.#host.timeline
        const packets = timeline.packets(this.#declaration.track)
        const source = this.#source
        if (source === undefined) {
            return
        }
        if (packets !== undefined) {
            const { times, data } = packets
            while (this.#next < times.length && times[this.#next]! < this.end) {
                if (times[this.#next]! >= this.start) {
                    source.append(data[this.#next]!)
                }
                this.#next++
            }
            // A packet of the next file: this one is whole.
            if (this.#next < times.length) {
                source.end()
            }
        }
        if (timeline.done) {
            source.end()
        }
    }

    #draw(): void {
        const canvas = this.#canvas
        const element = this.#video
        const context = canvas?.getContext('2d')
        if (
            canvas !== undefined &&
            element !== undefined &&
            element.readyState >= HAVE_CURRENT_DATA &&
            context != null
        ) {
            context.drawImage(element, 0, 0, canvas.width, canvas.height)
            this.#host.onDrawn(canvas)
        }
    }
}

/** Where an element reads a clip from, as the clip comes. */
interface Source {
    readonly url: string
    append(data: Uint8Array<ArrayBuffer>): void
    /** Nothing more is to come. */
    end(): void
    /** Makes the URL anew when that is how more of the clip comes; whether it did. */
    refresh(): boolean
    destroy(): void
}

/** A clip through Media Source Extensions, which an element plays while it grows. */
class StreamSource implements Source {
    readonly url: string
    readonly #mediaSource = new MediaSource()
    readonly #queue: Uint8Array<ArrayBuffer>[] = []
    readonly #onError: (error: unknown) => void
    #buffer: SourceBuffer | undefined
    #ended = false

    constructor(type: string, onError: (error: unknown) => void) {
        this.#onError = onError
        this.url = URL.createObjectURL(this.#mediaSource)
        this.#mediaSource.addEventListener(
            'sourceopen',
            () => {
                try {
                    const buffer = this.#mediaSource.addSourceBuffer(type)
                    buffer.addEventListener('updateend', () => this.#pump())
                    this.#buffer = buffer
                    this.#pump()
                } catch (error) {
                    onError(error)
                }
            },
            { once: true }
        )
    }

    append(data: Uint8Array<ArrayBuffer>): void {
        this.#queue.push(data)
        this.#pump()
    }

    end(): void {
        this.#ended = true
        this.#pump()
    }

    refresh(): boolean {
        return false
    }

    destroy(): void {
        URL.revokeObjectURL(this.url)
        this.#queue.length = 0
    }

    /** Appends one piece at a time, as a source buffer takes them. */
    #pump(): void {
        const buffer = this.#buffer
        if (buffer === undefined || buffer.updating || this.#mediaSource.readyState !== 'open') {
            return
        }
        const next = this.#queue.shift()
        try {
            if (next !== undefined) {
                buffer.appendBuffer(next)
            } else if (this.#ended) {
                this.#mediaSource.endOfStream()
            }
        } catch (error) {
            this.#onError(error)
        }
    }
}

/** A clip as a blob, for browsers without Media Source Extensions for its type: made anew now and then as it grows. */
class BlobSource implements Source {
    url: string
    readonly #type: string
    readonly #parts: Uint8Array<ArrayBuffer>[] = []
    /** Parts in the blob at `url`. */
    #made = 0
    #madeAt = 0
    #ended = false

    constructor(type: string) {
        this.#type = type
        this.url = URL.createObjectURL(new Blob([], { type }))
    }

    append(data: Uint8Array<ArrayBuffer>): void {
        this.#parts.push(data)
    }

    end(): void {
        this.#ended = true
    }

    refresh(): boolean {
        const parts = this.#parts
        const made = this.#made
        if (parts.length === made || (!this.#ended && made > 0 && performance.now() - this.#madeAt < BLOB_REFRESH)) {
            return false
        }
        URL.revokeObjectURL(this.url)
        this.url = URL.createObjectURL(new Blob(parts, { type: this.#type }))
        this.#made = parts.length
        this.#madeAt = performance.now()
        return true
    }

    destroy(): void {
        URL.revokeObjectURL(this.url)
    }
}
