import type { MediaKind } from '@timecat-js/protocol'
import type { MediaFormat, MediaTrackWriter, PluginContext } from './plugins.ts'

export interface StreamRecordOptions {
    kind: MediaKind
    /** The element the track shows in, or 0 for none. */
    targetId: number
    /** Container types tried in order, as `MediaRecorder.isTypeSupported` takes them; the first supported is used. */
    types: readonly string[]
    /** Bit rate of all the stream's tracks together; the browser's default when left out. */
    bitsPerSecond?: number | undefined
    /** How often the bytes recorded so far are written, in milliseconds. 1000 by default. */
    timeslice?: number | undefined
    /** A track to go on with, as a new file; a new track by default. */
    writer?: MediaTrackWriter | undefined
}

/** A media stream being recorded into a container track. */
export interface StreamRecording {
    readonly writer: MediaTrackWriter
    /** Stops recording; settles once the last bytes are written. */
    stop(): Promise<void>
}

/**
 * Records `stream` with `MediaRecorder` into a container track of the recording, from now on: a file whose bytes are
 * written every `timeslice`. Throws when `MediaRecorder` is missing or records none of the types.
 */
export function recordStream(
    context: PluginContext,
    stream: MediaStream,
    options: StreamRecordOptions
): StreamRecording {
    const Recorder = context.window.MediaRecorder
    if (typeof Recorder !== 'function') {
        throw new Error('MediaRecorder is not available')
    }
    const type = options.types.find(candidate => Recorder.isTypeSupported(candidate))
    if (type === undefined) {
        throw new Error(`MediaRecorder records none of ${options.types.join(', ')}`)
    }
    const { bitsPerSecond } = options
    const recorder = new Recorder(
        stream,
        bitsPerSecond === undefined ? { mimeType: type } : { mimeType: type, bitsPerSecond }
    )
    const settings = stream.getVideoTracks()[0]?.getSettings()
    const format: MediaFormat = {
        kind: options.kind,
        targetId: options.targetId,
        codec: '',
        description: new Uint8Array(0),
        container: type,
        width: settings?.width ?? 0,
        height: settings?.height ?? 0,
        sampleRate: 0,
        channels: 0
    }
    let track: MediaTrackWriter | undefined
    let declared = 0
    let first = true
    let written = Promise.resolve()
    recorder.addEventListener('dataavailable', event => {
        const time = Math.max(context.microseconds(context.window.performance.now()), declared * 1000)
        const data = event.data
        if (data.size === 0 || track === undefined) {
            return
        }
        const writer = track
        // The file starts with the first bytes: decoding starts there.
        const key = first
        first = false
        // Bytes are written in the order they came, however long reading each takes.
        written = written
            .then(async () => writer.write({ time, duration: 0, key, data: new Uint8Array(await data.arrayBuffer()) }))
            .catch((error: unknown) => context.onError(error))
    })
    recorder.addEventListener('error', event => context.onError('error' in event ? event.error : event))
    const stopped = new Promise<void>(resolve => {
        recorder.addEventListener('stop', () => resolve(), { once: true })
    })
    recorder.start(options.timeslice ?? 1000)
    // Declared once recording started, which can fail; its bytes come later.
    declared = context.now()
    track = options.writer
    if (track === undefined) {
        track = context.openMedia(format, declared)
    } else {
        track.format(format, declared)
    }
    return {
        writer: track,
        async stop() {
            if (recorder.state !== 'inactive') {
                recorder.stop()
            }
            await stopped
            await written
        }
    }
}
