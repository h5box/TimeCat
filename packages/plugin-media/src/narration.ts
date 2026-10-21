import { MediaKind } from '@timecat-js/protocol'
import { recordStream } from '@timecat-js/recorder'
import type { PluginContext, StreamRecording } from '@timecat-js/recorder'

/** Containers `MediaRecorder` is asked for, in order: Opus, or AAC where WebM is not recorded, as in Safari. */
const TYPES = [
    'audio/webm;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/mp4'
]

/** Where narration comes from: the microphone, asked for when recording starts, or a stream of the page's. */
export type NarrationSource = true | MediaStream | (() => Promise<MediaStream>)

/**
 * Records narration into an audio track that belongs to no element. Returns a function that stops it, and releases
 * the microphone if it asked for it.
 */
export function startNarration(
    context: PluginContext,
    source: NarrationSource,
    bitsPerSecond: number
): () => Promise<void> {
    let stopped = false
    let recording: StreamRecording | undefined
    let ownTracks: MediaStreamTrack[] = []
    const begin = async (): Promise<void> => {
        let stream: MediaStream
        if (source === true) {
            stream = await context.window.navigator.mediaDevices.getUserMedia({ audio: true })
            ownTracks = stream.getTracks()
        } else {
            stream = typeof source === 'function' ? await source() : source
        }
        if (stopped) {
            return
        }
        // The sound only, of a stream that may have video too.
        recording = recordStream(context, new context.window.MediaStream(stream.getAudioTracks()), {
            kind: MediaKind.Audio,
            targetId: 0,
            types: TYPES,
            bitsPerSecond
        })
    }
    const begun = begin().catch((error: unknown) =>
        context.onError(new Error('narration is not recorded', { cause: error }))
    )
    return async () => {
        stopped = true
        await begun
        try {
            await recording?.stop()
        } finally {
            for (const track of ownTracks) {
                track.stop()
            }
        }
    }
}
