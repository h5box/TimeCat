/** How far a playing element may drift from the replay's time, in seconds, before it is moved back. */
const DRIFT = 0.3
/** How far a paused element may be from the replay's time, in seconds: about a frame. */
const STILL = 0.02
/** The playback rates browsers take. */
const MIN_RATE = 1 / 16
const MAX_RATE = 16

/** What an element is to do: play from or show a position, as the replay's clock and the viewer's volume say. */
export interface Playback {
    /** Seconds into the element's media. */
    position: number
    playing: boolean
    rate: number
    volume: number
    muted: boolean
}

/**
 * Brings `element` to `playback`. A browser that does not let it play with sound calls `onBlocked`, after which
 * the player plays muted.
 */
export function drive(element: HTMLMediaElement, playback: Playback, onBlocked: () => void): void {
    const { position, playing, muted } = playback
    const volume = Math.min(Math.max(playback.volume, 0), 1)
    if (element.volume !== volume) {
        element.volume = volume
    }
    if (element.muted !== muted) {
        element.muted = muted
    }
    const target = Math.min(position, seekableEnd(element))
    if (!playing) {
        if (!element.paused) {
            element.pause()
        }
        if (Math.abs(element.currentTime - target) > STILL) {
            element.currentTime = target
        }
        return
    }
    const rate = Math.min(Math.max(playback.rate, MIN_RATE), MAX_RATE)
    if (element.playbackRate !== rate) {
        element.playbackRate = rate
    }
    if (Math.abs(element.currentTime - target) > DRIFT) {
        element.currentTime = target
    }
    if (element.paused) {
        element.play().catch((error: unknown) => {
            // Other rejections, such as a pause meanwhile, need nothing.
            // From the realm of the replay, so not an `Error` of this one.
            if (nameOf(error) === 'NotAllowedError' && !element.muted) {
                onBlocked()
            }
        })
    }
}

/** Stops an element that the replay does not play at the moment. */
export function stop(element: HTMLMediaElement): void {
    if (!element.paused) {
        element.pause()
    }
}

/** The end of the media an element can seek in: of all of it, or of what came so far of a growing stream. */
function seekableEnd(element: HTMLMediaElement): number {
    const { seekable } = element
    if (seekable.length > 0) {
        return seekable.end(seekable.length - 1)
    }
    // Before the metadata loaded, a position is kept for when it has.
    return Infinity
}

function nameOf(error: unknown): unknown {
    return typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined
}
