import { MediaKind } from '@timecat-js/protocol'
import { isElement, isMedia } from '../dom.ts'
import { upperBound } from '../search.ts'
import { Clip } from './clip.ts'
import type { MediaHost, MediaTime } from './clip.ts'
import { drive, stop } from './element.ts'
import { VideoTrack } from './video.ts'

export type { MediaHost, MediaTime } from './clip.ts'

/** The recorded states of a media element, in time order. */
interface StateTrail {
    times: number[]
    states: { paused: boolean; muted: boolean; currentTime: number; playbackRate: number; volume: number }[]
}

/**
 * Plays the media of a recording along with the replay: the recorded state of `<audio>` and `<video>` elements,
 * video tracks of encoded frames in their canvases, and media files recorded in a container, such as a narration.
 * Loaded once a recording has media.
 */
export class MediaPlayer {
    readonly #host: MediaHost
    readonly #videos = new Map<number, VideoTrack>()
    readonly #clips: Clip[] = []
    /** The last clip of each container track, which the track's next declaration ends. */
    readonly #lastClips = new Map<number, Clip>()
    readonly #trails = new Map<number, StateTrail>()
    /** Declarations and states of the timeline taken so far. */
    #declarations = 0
    #states = 0
    /** Replayed elements that their recorded state played or showed last time. */
    #driven = new Set<HTMLMediaElement>()

    constructor(host: MediaHost) {
        this.#host = host
    }

    /** Brings the media to `now`. */
    show(now: MediaTime): void {
        this.#take()
        const host = this.#host
        const { node } = host
        // A clip that plays in a replayed element takes it over from the element's recorded state.
        const claimed = new Set<HTMLMediaElement>()
        for (const clip of this.#clips) {
            const element = clip.show(now)
            if (element !== undefined) {
                claimed.add(element)
            }
        }
        for (const video of this.#videos.values()) {
            video.show(now.time, node)
        }
        const driven = new Set<HTMLMediaElement>()
        // Ids before the last snapshot may stand for other nodes.
        const since = host.timeline.snapshotBefore(now.time)
        for (const [id, { times, states }] of this.#trails) {
            const element = node(id)
            const i = upperBound(times, now.time) - 1
            if (element === undefined || !isElement(element) || !isMedia(element) || claimed.has(element)) {
                continue
            }
            if (i < 0 || times[i]! < since) {
                continue
            }
            const state = states[i]!
            const playing = now.playing && !state.paused
            const elapsed = state.paused ? 0 : ((now.time - times[i]!) / 1000) * state.playbackRate
            drive(
                element,
                {
                    position: state.currentTime + elapsed,
                    playing,
                    rate: state.playbackRate * now.speed,
                    volume: state.volume * now.volume,
                    muted: state.muted || now.muted
                },
                host.onBlocked
            )
            driven.add(element)
        }
        for (const element of this.#driven) {
            if (!driven.has(element) && !claimed.has(element)) {
                stop(element)
            }
        }
        this.#driven = driven
    }

    destroy(): void {
        for (const clip of this.#clips) {
            clip.destroy()
        }
        for (const video of this.#videos.values()) {
            video.destroy()
        }
        for (const element of this.#driven) {
            stop(element)
        }
    }

    /** Takes the declarations and states that came since. */
    #take(): void {
        const host = this.#host
        const timeline = host.timeline
        const { mediaTracks, mediaStates } = timeline
        for (const { time, event } of mediaTracks.slice(this.#declarations)) {
            const { track } = event
            const last = this.#lastClips.get(track)
            if (last !== undefined) {
                last.end = time
                this.#lastClips.delete(track)
            }
            if (event.container !== '') {
                const clip = new Clip(time, event, host)
                this.#clips.push(clip)
                this.#lastClips.set(track, clip)
            } else if (event.kind === MediaKind.Video) {
                if (!this.#videos.has(track)) {
                    this.#videos.set(track, new VideoTrack(track, timeline, host.onError))
                }
            } else if (!timeline.warnings.some(warning => warning.startsWith(`media track ${track} `))) {
                timeline.warnings.push(`media track ${track} holds encoded audio, which the player does not play`)
            }
        }
        this.#declarations = mediaTracks.length
        for (const { time, event } of mediaStates.slice(this.#states)) {
            let trail = this.#trails.get(event.id)
            if (trail === undefined) {
                trail = { times: [], states: [] }
                this.#trails.set(event.id, trail)
            }
            trail.times.push(time)
            trail.states.push(event)
        }
        this.#states = mediaStates.length
    }
}
