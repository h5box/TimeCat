import type { MediaTrackWriter, PluginContext, RecorderPlugin } from '@timecat-js/recorder'
import { EncodedCanvas, fit, isTrackProcessor } from './encoded.ts'
import type { ChooseConfig, TrackProcessorConstructor } from './encoded.ts'
import type { Settings } from './settings.ts'
import { StreamedCanvas } from './streamed.ts'

export interface CanvasPluginOptions {
    /** Frames recorded of a canvas in a second at most. Frames come only as it changes. 15 by default. */
    fps?: number | undefined
    /**
     * Longest time between key frames, in milliseconds, which seeking decodes from. Longer times make recordings
     * smaller and seeking slower. 3000 by default.
     */
    keyframeInterval?: number | undefined
    /** Largest width and height of the video; larger canvases are scaled down. 1920 by default. */
    maxSize?: number | undefined
    /** Bits per second of the video of a canvas. By default, 0.05 bits per pixel of each frame, at least 100 kbps. */
    bitrate?: number | undefined
    /**
     * WebCodecs codec strings tried in order; the first `VideoEncoder` supports is used. By default VP9, AV1,
     * H.264 and VP8.
     */
    codecs?: readonly string[] | undefined
}

/** How often the page is looked through for canvases, and canvases for a new size, in milliseconds. */
const SCAN_INTERVAL = 500
/** Size the browser's codecs are tried at before a canvas is recorded. */
const PROBE_SIZE = 640
const MIN_BITRATE = 100_000
const BITS_PER_PIXEL = 0.05

/** H.264 levels of the constrained baseline profile, with the most macroblocks a frame of each may have. */
const H264_LEVELS: readonly [macroblocks: number, level: string][] = [
    [1620, '1E'],
    [3600, '1F'],
    [5120, '20'],
    [8192, '28'],
    [22080, '32'],
    [36864, '33']
]

/**
 * Records canvases, 2D and WebGL alike, as video: what they show, as it changes, encoded with WebCodecs, or with
 * `MediaRecorder` where WebCodecs cannot take the frames of a canvas. Players draw the video into the replayed
 * canvases.
 */
export function canvasPlugin(options: CanvasPluginOptions = {}): RecorderPlugin {
    const fps = options.fps ?? 15
    const keyframeInterval = options.keyframeInterval ?? 3000
    const maxSize = options.maxSize ?? 1920
    for (const [name, value] of [
        ['fps', fps],
        ['keyframeInterval', keyframeInterval],
        ['maxSize', maxSize],
        ['bitrate', options.bitrate ?? 1]
    ] as const) {
        if (!(value > 0 && value < Infinity)) {
            throw new RangeError(`${name} must be a positive number, got ${value}`)
        }
    }
    const { codecs } = options
    if (codecs?.length === 0) {
        throw new RangeError('codecs must name a codec')
    }
    const { bitrate } = options
    const settings: Settings = {
        fps,
        keyframeInterval,
        maxSize,
        bitrate: (width, height) => bitrate ?? Math.max(MIN_BITRATE, Math.round(width * height * fps * BITS_PER_PIXEL))
    }
    return {
        name: 'canvas',
        start: context => startCanvas(context, settings, codecs)
    }
}

type CanvasRecording = EncodedCanvas | StreamedCanvas

function startCanvas(
    context: PluginContext,
    settings: Settings,
    codecs: readonly string[] | undefined
): () => Promise<void> {
    const window = context.window
    const roots: WeakRef<Document | ShadowRoot>[] = []
    context.observeRoots(root => void roots.push(new WeakRef(root)))
    const recordings = new Map<HTMLCanvasElement, CanvasRecording>()
    /** Recordings being stopped, before which their canvases are not recorded anew. */
    const stopping = new Map<HTMLCanvasElement, Promise<void>>()
    /** The tracks of canvases recorded before, which go on if they are recorded again. */
    const writers = new WeakMap<HTMLCanvasElement, MediaTrackWriter>()
    /** Canvases that cannot be recorded, such as those that show content of other origins. */
    const failed = new WeakSet<HTMLCanvasElement>()
    const configs = new Map<string, Promise<VideoEncoderConfig | undefined>>()
    const choose: ChooseConfig = (width, height) => {
        const key = `${width}x${height}`
        let config = configs.get(key)
        if (config === undefined) {
            config = chooseConfig(window.VideoEncoder, codecs ?? defaultCodecs(width, height), width, height, settings)
            configs.set(key, config)
        }
        return config
    }
    const processor: unknown = Reflect.get(window, 'MediaStreamTrackProcessor')
    let encoder: TrackProcessorConstructor | undefined
    let stopped = false
    let timer: ReturnType<typeof setInterval> | undefined

    const stop = (canvas: HTMLCanvasElement, recording: CanvasRecording, flush: boolean): Promise<void> => {
        recordings.delete(canvas)
        const done = recording
            .stop(flush)
            .catch((error: unknown) => context.onError(error))
            .finally(() => {
                const { writer } = recording
                if (writer !== undefined) {
                    writers.set(canvas, writer)
                }
                stopping.delete(canvas)
            })
        stopping.set(canvas, done)
        return done
    }
    const start = (canvas: HTMLCanvasElement, id: number): void => {
        const onFail = (error: unknown): void => {
            failed.add(canvas)
            recordings.delete(canvas)
            context.onError(new Error(`canvas ${id} is not recorded`, { cause: error }))
        }
        const writer = writers.get(canvas)
        try {
            recordings.set(
                canvas,
                encoder === undefined
                    ? new StreamedCanvas(canvas, id, writer, context, settings, onFail)
                    : new EncodedCanvas(canvas, id, writer, context, settings, encoder, choose, onFail)
            )
        } catch (error) {
            onFail(error)
        }
    }
    const scan = (): void => {
        const wanted = new Map<HTMLCanvasElement, number>()
        let alive = 0
        for (const reference of roots) {
            const root = reference.deref()
            if (root === undefined) {
                continue
            }
            roots[alive++] = reference
            for (const canvas of isDocument(root)
                ? root.getElementsByTagName('canvas')
                : root.querySelectorAll('canvas')) {
                const id = context.nodeId(canvas)
                if (
                    id !== 0 &&
                    canvas.isConnected &&
                    canvas.ownerDocument.defaultView !== null &&
                    !failed.has(canvas) &&
                    !context.blocks(canvas)
                ) {
                    wanted.set(canvas, id)
                }
            }
        }
        roots.length = alive
        for (const [canvas, recording] of recordings) {
            if (wanted.get(canvas) !== recording.id) {
                void stop(canvas, recording, false)
            } else if (recording instanceof StreamedCanvas) {
                recording.check()
            }
        }
        for (const [canvas, id] of wanted) {
            if (!recordings.has(canvas) && !stopping.has(canvas)) {
                start(canvas, id)
            }
        }
    }

    const usable = async (): Promise<TrackProcessorConstructor | undefined> => {
        if (!isTrackProcessor(processor) || typeof window.VideoEncoder !== 'function') {
            return undefined
        }
        const [width, height] = fit(PROBE_SIZE, (PROBE_SIZE * 3) / 4, settings.maxSize)
        return (await choose(width, height)) === undefined ? undefined : processor
    }
    const begin = async (): Promise<void> => {
        const [found] = await Promise.all([usable(), context.ready])
        if (!stopped) {
            encoder = found
            scan()
            timer = setInterval(scan, SCAN_INTERVAL)
        }
    }
    begin().catch((error: unknown) => context.onError(error))

    return async () => {
        stopped = true
        clearInterval(timer)
        await Promise.all([
            ...Array.from(recordings, ([canvas, recording]) => stop(canvas, recording, true)),
            ...stopping.values()
        ])
    }
}

/** The first configuration of `codecs` that `Encoder` supports for video of a size. */
async function chooseConfig(
    Encoder: typeof VideoEncoder,
    codecs: readonly string[],
    width: number,
    height: number,
    settings: Settings
): Promise<VideoEncoderConfig | undefined> {
    for (const codec of codecs) {
        const config: VideoEncoderConfig = {
            codec,
            width,
            height,
            bitrate: settings.bitrate(width, height),
            framerate: settings.fps,
            latencyMode: 'realtime'
        }
        try {
            // oxlint-disable-next-line no-await-in-loop -- the first codec supported is taken
            const { supported } = await Encoder.isConfigSupported(config)
            if (supported === true) {
                return config
            }
        } catch {
            // A codec string the browser does not take.
        }
    }
    return undefined
}

/** VP9 and AV1 at a level high enough for any size recorded, H.264 at the level of the size. */
function defaultCodecs(width: number, height: number): string[] {
    const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16)
    let h264 = 'avc1.42E033'
    for (const [most, level] of H264_LEVELS) {
        if (macroblocks <= most) {
            h264 = `avc1.42E0${level}`
            break
        }
    }
    return ['vp09.00.50.08', 'av01.0.12M.08', h264, 'vp8']
}

function isDocument(root: Document | ShadowRoot): root is Document {
    return root.nodeType === root.DOCUMENT_NODE
}
