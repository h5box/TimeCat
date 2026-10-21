import { MediaKind } from '@timecat-js/protocol'
import type { MediaFormat, MediaTrackWriter, PluginContext } from '@timecat-js/recorder'
import type { CanvasRecording, Settings } from './settings.ts'

/** Frames waiting for the encoder, beyond which the newest frame waits instead, replacing the one before. */
const MAX_QUEUE = 2
/** Width and height of the sample a frame is looked at in for whether it is blank. */
const BLANK_PROBE = 32

/** What `MediaStreamTrackProcessor` is: frames of a video track as a stream. */
interface TrackProcessor {
    readonly readable: ReadableStream<VideoFrame>
}

export type TrackProcessorConstructor = new (init: { track: MediaStreamTrack }) => TrackProcessor

export function isTrackProcessor(value: unknown): value is TrackProcessorConstructor {
    return typeof value === 'function'
}

/** Finds an encoder configuration this browser supports for video of a size. */
export type ChooseConfig = (width: number, height: number) => Promise<VideoEncoderConfig | undefined>

/**
 * A canvas recorded through WebCodecs: its frames, which come as it changes, are encoded into a track of encoded
 * chunks. The canvas is captured as a stream, which gives what it shows, such as WebGL drawing buffers that were
 * cleared since.
 */
export class EncodedCanvas implements CanvasRecording {
    readonly #context: PluginContext
    readonly #settings: Settings
    readonly #choose: ChooseConfig
    readonly #onFail: (error: unknown) => void
    readonly #track: MediaStreamTrack
    readonly #encoder: VideoEncoder
    readonly #reading: Promise<void>
    #id: number
    #writer: MediaTrackWriter | undefined
    #config: VideoEncoderConfig | undefined
    #choosing = false
    /** The newest frame not encoded yet, with its time, while the encoder is busy or being configured. */
    #pending: [frame: VideoFrame, time: number] | undefined
    #lastKey = -Infinity
    /** When the current format was declared, in milliseconds; no packet goes before. */
    #declared = 0
    #lastTime = 0
    #format: MediaFormat | undefined
    #stopped = false

    constructor(
        canvas: HTMLCanvasElement,
        id: number,
        writer: MediaTrackWriter | undefined,
        context: PluginContext,
        settings: Settings,
        processor: TrackProcessorConstructor,
        choose: ChooseConfig,
        onFail: (error: unknown) => void
    ) {
        this.#id = id
        this.#writer = writer
        this.#context = context
        this.#settings = settings
        this.#choose = choose
        this.#onFail = onFail
        // Throws for a canvas that shows content of other origins.
        const track = canvas.captureStream(settings.fps).getVideoTracks()[0]
        if (track === undefined) {
            throw new Error('the canvas gave no video track')
        }
        this.#track = track
        this.#encoder = new context.window.VideoEncoder({
            output: (chunk, metadata) => this.#output(chunk, metadata),
            error: error => this.#fail(error)
        })
        this.#encoder.addEventListener('dequeue', () => this.#encodePending())
        // The stream gives a frame once the canvas changes; what it shows now is taken from it directly.
        if (canvas.width > 0 && canvas.height > 0) {
            const first = new context.window.VideoFrame(canvas, { timestamp: 0 })
            if (isBlank(first, context.window)) {
                first.close()
            } else {
                this.#frame(first)
            }
        }
        this.#reading = this.#read(new processor({ track }).readable.getReader())
    }

    get id(): number {
        return this.#id
    }

    get writer(): MediaTrackWriter | undefined {
        return this.#writer
    }

    async stop(flush: boolean): Promise<void> {
        if (this.#stopped) {
            return
        }
        this.#stopped = true
        this.#track.stop()
        this.#pending?.[0].close()
        this.#pending = undefined
        const encoder = this.#encoder
        if (flush && encoder.state === 'configured') {
            await encoder.flush().catch((error: unknown) => this.#context.onError(error))
        }
        if (encoder.state !== 'closed') {
            encoder.close()
        }
        await this.#reading
    }

    async #read(reader: ReadableStreamDefaultReader<VideoFrame>): Promise<void> {
        try {
            for (;;) {
                // oxlint-disable-next-line no-await-in-loop -- frames come one at a time
                const { value, done } = await reader.read()
                if (done) {
                    return
                }
                this.#frame(value)
            }
        } catch (error) {
            if (!this.#stopped) {
                this.#fail(error)
            }
        }
    }

    /** Takes a frame of the canvas, which it closes. */
    #frame(frame: VideoFrame): void {
        if (this.#stopped) {
            frame.close()
            return
        }
        this.#pending?.[0].close()
        this.#pending = [frame, this.#context.microseconds(this.#context.window.performance.now())]
        this.#encodePending()
    }

    #configure(width: number, height: number): void {
        if (!this.#choosing) {
            this.#choosing = true
            void this.#reconfigure(width, height)
        }
    }

    async #reconfigure(width: number, height: number): Promise<void> {
        let config: VideoEncoderConfig | undefined
        try {
            config = await this.#choose(width, height)
        } catch (error) {
            this.#fail(error)
            return
        } finally {
            this.#choosing = false
        }
        if (this.#stopped) {
            return
        }
        if (config === undefined) {
            this.#fail(new Error(`no codec encodes video of ${width}x${height}`))
            return
        }
        this.#encoder.configure(config)
        this.#config = config
        this.#lastKey = -Infinity
        this.#encodePending()
    }

    #encodePending(): void {
        const pending = this.#pending
        const encoder = this.#encoder
        if (pending === undefined || this.#stopped || encoder.encodeQueueSize >= MAX_QUEUE) {
            return
        }
        const [frame, time] = pending
        const [width, height] = fit(frame.displayWidth, frame.displayHeight, this.#settings.maxSize)
        const config = this.#config
        if (config === undefined || config.width !== width || config.height !== height) {
            // The first frame, or one of a new size: it waits for the encoder to be configured for it.
            this.#configure(width, height)
            return
        }
        this.#pending = undefined
        const keyFrame = time - this.#lastKey >= this.#settings.keyframeInterval * 1000
        if (keyFrame) {
            this.#lastKey = time
        }
        try {
            const copy = new this.#context.window.VideoFrame(frame, { timestamp: time })
            try {
                encoder.encode(copy, { keyFrame })
            } finally {
                copy.close()
            }
        } catch (error) {
            this.#fail(error)
        } finally {
            frame.close()
        }
    }

    #output(chunk: EncodedVideoChunk, metadata: EncodedVideoChunkMetadata | undefined): void {
        if (this.#stopped && this.#encoder.state === 'closed') {
            return
        }
        const decoderConfig = metadata?.decoderConfig
        if (decoderConfig !== undefined) {
            const { description } = decoderConfig
            this.#declare({
                kind: MediaKind.Video,
                targetId: this.#id,
                codec: decoderConfig.codec,
                description: description === undefined ? new Uint8Array(0) : bytesOf(description),
                container: '',
                width: decoderConfig.codedWidth ?? this.#config?.width ?? 0,
                height: decoderConfig.codedHeight ?? this.#config?.height ?? 0,
                sampleRate: 0,
                channels: 0
            })
        }
        const writer = this.#writer
        if (writer === undefined || this.#format === undefined) {
            return
        }
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        // A packet goes after its declaration, which was written as it came, and the packets before.
        const time = Math.max(chunk.timestamp, this.#declared * 1000, this.#lastTime)
        this.#lastTime = time
        writer.write({ time, duration: chunk.duration ?? 0, key: chunk.type === 'key', data })
    }

    #declare(format: MediaFormat): void {
        const context = this.#context
        this.#format = format
        this.#declared = context.now()
        if (this.#writer === undefined) {
            this.#writer = context.openMedia(format, this.#declared)
        } else {
            this.#writer.format(format, this.#declared)
        }
    }

    #fail(error: unknown): void {
        if (this.#stopped) {
            return
        }
        void this.stop(false)
        this.#onFail(error)
    }
}

/** The size of video for a frame: at most `maxSize` either way, and even, as some codecs need. */
export function fit(width: number, height: number, maxSize: number): [width: number, height: number] {
    const scale = Math.min(1, maxSize / Math.max(width, height, 1))
    const even = (length: number): number => Math.max(2, Math.ceil((length * scale) / 2) * 2)
    return [even(width), even(height)]
}

/**
 * Whether a frame shows nothing but black, at a glance: a canvas never drawn shows nothing, and one of WebGL whose
 * drawing buffer was cleared since it was shown gives a frame of nothing, which may be black, for what it shows.
 */
function isBlank(frame: VideoFrame, window: Window & typeof globalThis): boolean {
    const probe = new window.OffscreenCanvas(BLANK_PROBE, BLANK_PROBE).getContext('2d', { willReadFrequently: true })
    if (probe === null) {
        return false
    }
    probe.drawImage(frame, 0, 0, BLANK_PROBE, BLANK_PROBE)
    const data = probe.getImageData(0, 0, BLANK_PROBE, BLANK_PROBE).data
    for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) {
            return false
        }
    }
    return true
}

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
    return ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength))
        : new Uint8Array(source.slice(0))
}
