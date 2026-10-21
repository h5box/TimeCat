import type { MediaTrackWriter } from '@timecat-js/recorder'

export interface Settings {
    fps: number
    keyframeInterval: number
    maxSize: number
    /** Bits per second of video of a size. */
    bitrate: (width: number, height: number) => number
}

/** The recording of one canvas. */
export interface CanvasRecording {
    /** The id of the canvas it shows in. */
    readonly id: number
    /** Its track, once declared. */
    readonly writer: MediaTrackWriter | undefined
    /** Stops recording; `flush` writes what is still being encoded. */
    stop(flush: boolean): Promise<void>
}
