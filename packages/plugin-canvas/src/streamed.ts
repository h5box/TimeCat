import { MediaKind } from '@timecat-js/protocol'
import { recordStream } from '@timecat-js/recorder'
import type { MediaTrackWriter, PluginContext, StreamRecording } from '@timecat-js/recorder'
import type { CanvasRecording, Settings } from './settings.ts'

/** Containers `MediaRecorder` is asked for, in order. */
const TYPES = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/mp4;codecs=avc1.42E01F',
    'video/mp4;codecs=avc1',
    'video/webm',
    'video/mp4'
]

/**
 * A canvas recorded through `MediaRecorder`, where WebCodecs cannot take its frames: into a container track, a file
 * for each size of the canvas.
 */
export class StreamedCanvas implements CanvasRecording {
    readonly id: number
    readonly #canvas: HTMLCanvasElement
    readonly #context: PluginContext
    readonly #settings: Settings
    readonly #onFail: (error: unknown) => void
    #recording: StreamRecording
    #stream: MediaStream
    #width = 0
    #height = 0
    #restarting: Promise<void> | undefined
    #stopped = false

    constructor(
        canvas: HTMLCanvasElement,
        id: number,
        writer: MediaTrackWriter | undefined,
        context: PluginContext,
        settings: Settings,
        onFail: (error: unknown) => void
    ) {
        this.id = id
        this.#canvas = canvas
        this.#context = context
        this.#settings = settings
        this.#onFail = onFail
        // Throws for a canvas that shows content of other origins.
        ;[this.#stream, this.#recording] = this.#start(writer)
    }

    get writer(): MediaTrackWriter {
        return this.#recording.writer
    }

    /** Starts a new file once the canvas changed size. */
    check(): void {
        const canvas = this.#canvas
        if (
            this.#stopped ||
            this.#restarting !== undefined ||
            (canvas.width === this.#width && canvas.height === this.#height)
        ) {
            return
        }
        this.#restarting = this.#restart()
    }

    async stop(): Promise<void> {
        this.#stopped = true
        await this.#restarting
        await this.#end()
    }

    async #restart(): Promise<void> {
        try {
            await this.#end()
            if (!this.#stopped) {
                ;[this.#stream, this.#recording] = this.#start(this.#recording.writer)
            }
        } catch (error) {
            this.#stopped = true
            this.#onFail(error)
        } finally {
            this.#restarting = undefined
        }
    }

    #start(writer: MediaTrackWriter | undefined): [MediaStream, StreamRecording] {
        const canvas = this.#canvas
        this.#width = canvas.width
        this.#height = canvas.height
        const stream = canvas.captureStream(this.#settings.fps)
        try {
            const recording = recordStream(this.#context, stream, {
                kind: MediaKind.Video,
                targetId: this.id,
                types: TYPES,
                bitsPerSecond: this.#settings.bitrate(canvas.width, canvas.height),
                writer
            })
            return [stream, recording]
        } catch (error) {
            stopTracks(stream)
            throw error
        }
    }

    /** Ends the file, once its last bytes are written. */
    async #end(): Promise<void> {
        const stream = this.#stream
        try {
            await this.#recording.stop()
        } finally {
            stopTracks(stream)
        }
    }
}

function stopTracks(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
        track.stop()
    }
}
