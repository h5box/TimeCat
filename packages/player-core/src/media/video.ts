import type { MediaTrackEvent } from '@timecat-js/protocol'
import { isCanvas, isElement } from '../dom.ts'
import { upperBound } from '../search.ts'
import type { Timeline } from '../timeline/timeline.ts'

/** Decoder timestamps are packet numbers, above a count of restarts that tells stale frames apart. */
const GENERATION = 2 ** 32

/**
 * Shows a video track of encoded frames in the replayed canvas it belongs to: decodes from the last key packet
 * before the time shown, then on from there while the time moves forward.
 */
export class VideoTrack {
    readonly #track: number
    readonly #timeline: Timeline
    readonly #onError: (error: unknown) => void
    #decoder: VideoDecoder | undefined
    /** The declaration the decoder is configured for. */
    #configured: MediaTrackEvent | undefined
    #generation = 0
    /** The next packet to decode; -1 when the decoder needs to start from a key packet. */
    #next = -1
    /** The packet whose frame is to show. */
    #wanted = -1
    #frame: VideoFrame | undefined
    #canvas: HTMLCanvasElement | undefined
    /** Declarations the decoder failed on, which are not tried again. */
    readonly #failed = new WeakSet<MediaTrackEvent>()
    #attempt: MediaTrackEvent | undefined

    constructor(track: number, timeline: Timeline, onError: (error: unknown) => void) {
        this.#track = track
        this.#timeline = timeline
        this.#onError = onError
    }

    /** Shows the frame at `time` in the canvas that `node` finds. */
    show(time: number, node: (id: number) => Node | undefined): void {
        const packets = this.#timeline.packets(this.#track)
        const target = packets === undefined ? -1 : upperBound(packets.times, time) - 1
        const declaration = this.#declarationAt(time)
        const element = declaration === undefined ? undefined : node(declaration.targetId)
        const canvas = element !== undefined && isElement(element) && isCanvas(element) ? element : undefined
        if (packets === undefined || target < 0 || declaration?.codec === '' || canvas === undefined) {
            this.#wanted = -1
            return
        }
        if (canvas !== this.#canvas) {
            // A canvas the replay built anew.
            this.#canvas = canvas
            this.#draw()
        }
        if (target === this.#wanted) {
            return
        }
        this.#wanted = target
        let key = target
        while (key >= 0 && !packets.keys[key]) {
            key--
        }
        if (key < 0) {
            return
        }
        if (this.#next < 0 || this.#next > target + 1 || key >= this.#next) {
            this.#restart()
            this.#next = key
        }
        for (; this.#next <= target; this.#next++) {
            if (!this.#decode(this.#next)) {
                this.#next = -1
                return
            }
        }
    }

    destroy(): void {
        this.#close()
        this.#frame?.close()
        this.#frame = undefined
    }

    /** The declaration of this track that holds at `time`. Tracks change their format seldom. */
    #declarationAt(time: number): MediaTrackEvent | undefined {
        const declarations = this.#timeline.mediaTracks
        for (let i = declarations.length - 1; i >= 0; i--) {
            const { time: declared, event } = declarations[i]!
            if (declared <= time && event.track === this.#track) {
                return event
            }
        }
        return undefined
    }

    /** Decodes packet `i`; false when it cannot be. */
    #decode(i: number): boolean {
        const packets = this.#timeline.packets(this.#track)!
        const key = packets.keys[i]!
        const declaration = this.#declarationAt(packets.times[i]!)
        if (declaration === undefined || declaration.codec === '' || this.#failed.has(declaration)) {
            return false
        }
        this.#attempt = declaration
        try {
            if (key && declaration !== this.#configured) {
                this.#configure(declaration)
            }
            const decoder = this.#decoder
            if (decoder === undefined || decoder.state !== 'configured') {
                return false
            }
            decoder.decode(
                new EncodedVideoChunk({
                    type: key ? 'key' : 'delta',
                    timestamp: this.#generation * GENERATION + i,
                    data: packets.data[i]!
                })
            )
            return true
        } catch (error) {
            this.#fail(error)
            return false
        }
    }

    #configure(declaration: MediaTrackEvent): void {
        if (typeof VideoDecoder === 'undefined') {
            throw new Error('this browser cannot decode video tracks: it has no WebCodecs')
        }
        this.#decoder ??= new VideoDecoder({
            output: frame => this.#output(frame),
            error: error => this.#fail(error)
        })
        const { codec, width, height, description } = declaration
        this.#decoder.configure({
            codec,
            codedWidth: width,
            codedHeight: height,
            optimizeForLatency: true,
            ...(description.length > 0 ? { description } : {})
        })
        this.#configured = declaration
    }

    /** Drops what the decoder has queued, so it can start again from a key packet. */
    #restart(): void {
        this.#generation++
        const decoder = this.#decoder
        if (decoder !== undefined && decoder.state === 'configured') {
            decoder.reset()
        }
        this.#configured = undefined
    }

    #output(frame: VideoFrame): void {
        const generation = Math.floor(frame.timestamp / GENERATION)
        const packet = frame.timestamp % GENERATION
        // Frames up to the one wanted are shown as they come, so the video moves on while decoding lags behind.
        if (generation !== this.#generation || packet > this.#wanted) {
            frame.close()
            return
        }
        this.#frame?.close()
        this.#frame = frame
        this.#draw()
    }

    #draw(): void {
        const canvas = this.#canvas
        const frame = this.#frame
        if (canvas !== undefined && frame !== undefined) {
            canvas.getContext('2d')?.drawImage(frame, 0, 0, canvas.width, canvas.height)
        }
    }

    #fail(error: unknown): void {
        const attempt = this.#attempt
        if (attempt !== undefined && !this.#failed.has(attempt)) {
            this.#failed.add(attempt)
            this.#onError(error)
        }
        this.#close()
        this.#next = -1
    }

    #close(): void {
        const decoder = this.#decoder
        this.#decoder = undefined
        this.#configured = undefined
        if (decoder !== undefined && decoder.state !== 'closed') {
            decoder.close()
        }
    }
}
