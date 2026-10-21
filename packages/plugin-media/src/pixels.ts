import { MediaKind } from '@timecat-js/protocol'
import { recordStream } from '@timecat-js/recorder'
import type { MediaTrackWriter, PluginContext, StreamRecording } from '@timecat-js/recorder'

/** Containers `MediaRecorder` is asked for, in order, for a video with sound and one without. */
const WITH_AUDIO = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
    'video/webm',
    'video/mp4'
]
/** How long tracks may keep coming and going before a file starts with them: a source gives them one by one. */
const SETTLE = 50

const WITHOUT_AUDIO = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/mp4;codecs=avc1.42E01F',
    'video/webm',
    'video/mp4'
]

/**
 * What a `<video>` shows and plays, recorded with `MediaRecorder` into a container track: a file for each set of
 * tracks the video gives, as a new source does, all in the same track.
 */
export class VideoCapture {
    readonly #video: HTMLVideoElement
    readonly #context: PluginContext
    readonly #bitsPerSecond: number | undefined
    readonly #onFail: (error: unknown) => void
    #id = 0
    #writer: MediaTrackWriter | undefined
    /** What the video gives, whose tracks come and go with its sources. */
    #captured: MediaStream | undefined
    #recording: StreamRecording | undefined
    #active = false
    #settling: ReturnType<typeof setTimeout> | undefined
    /** Files end and start one after the other: a file ends once its last bytes are written. */
    #queue: Promise<void> = Promise.resolve()

    constructor(
        video: HTMLVideoElement,
        context: PluginContext,
        bitsPerSecond: number | undefined,
        onFail: (error: unknown) => void
    ) {
        this.#video = video
        this.#context = context
        this.#bitsPerSecond = bitsPerSecond
        this.#onFail = onFail
    }

    /** Starts recording, unless it is; `id` is the video's id in the recording. */
    start(id: number): void {
        this.#id = id
        if (this.#active) {
            return
        }
        try {
            const capture: unknown = Reflect.get(this.#video, 'captureStream')
            if (typeof capture !== 'function') {
                throw new Error('the browser cannot capture what a video shows')
            }
            // Throws for a video of another origin.
            const captured: unknown = Reflect.apply(capture, this.#video, [])
            if (!isStream(captured)) {
                throw new TypeError('captureStream gave no stream')
            }
            captured.addEventListener('addtrack', this.#onTracks)
            captured.addEventListener('removetrack', this.#onTracks)
            this.#captured = captured
        } catch (error) {
            this.#onFail(error)
            return
        }
        this.#active = true
        this.#onTracks()
    }

    /** Stops recording; settles once the last bytes are written. */
    end(): Promise<void> {
        if (this.#active) {
            this.#active = false
            this.#queue = this.#queue.then(() => this.#close())
        }
        return this.#queue
    }

    /** A new file for the tracks the video gives now. `MediaRecorder` records the tracks it started with only. */
    readonly #onTracks = (): void => {
        clearTimeout(this.#settling)
        this.#settling = setTimeout(() => {
            this.#queue = this.#queue.then(() => this.#next())
        }, SETTLE)
    }

    #begin(): void {
        const captured = this.#captured
        const tracks = captured?.getTracks().filter(track => track.readyState === 'live') ?? []
        // Without tracks, until the next source gives some.
        if (!this.#active || tracks.length === 0) {
            return
        }
        try {
            const stream = new this.#context.window.MediaStream(tracks)
            this.#recording = recordStream(this.#context, stream, {
                kind: MediaKind.Video,
                targetId: this.#id,
                types: stream.getAudioTracks().length > 0 ? WITH_AUDIO : WITHOUT_AUDIO,
                bitsPerSecond: this.#bitsPerSecond,
                writer: this.#writer
            })
            this.#writer = this.#recording.writer
        } catch (error) {
            this.#active = false
            this.#release()
            this.#onFail(error)
        }
    }

    /** Ends the file, and starts the next with the tracks the video gives now. */
    async #next(): Promise<void> {
        await this.#finish()
        this.#begin()
    }

    async #close(): Promise<void> {
        await this.#finish()
        this.#release()
    }

    async #finish(): Promise<void> {
        const recording = this.#recording
        this.#recording = undefined
        await recording?.stop()
    }

    #release(): void {
        clearTimeout(this.#settling)
        const captured = this.#captured
        this.#captured = undefined
        captured?.removeEventListener('addtrack', this.#onTracks)
        captured?.removeEventListener('removetrack', this.#onTracks)
        for (const track of captured?.getTracks() ?? []) {
            track.stop()
        }
    }
}

function isStream(value: unknown): value is MediaStream {
    return typeof value === 'object' && value !== null && 'getAudioTracks' in value && 'getTracks' in value
}
