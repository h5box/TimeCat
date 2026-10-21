import { EventType } from '@timecat-js/protocol'
import type { MediaStateEvent } from '@timecat-js/protocol'

/** Events of media elements after which their playback state is written. */
export const STATE_EVENTS = [
    'play',
    'playing',
    'pause',
    'waiting',
    'seeked',
    'ratechange',
    'volumechange',
    'ended',
    'emptied',
    'loadedmetadata'
] as const

/** `HTMLMediaElement.HAVE_FUTURE_DATA`: an element that has less waits for data and does not move on. */
const HAVE_FUTURE_DATA = 3
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

/** Whether `target` is an `<audio>` or `<video>` element, of any realm. */
export function isMediaElement(target: EventTarget | Node | null): target is HTMLMediaElement {
    return (
        target !== null &&
        'localName' in target &&
        (target.localName === 'audio' || target.localName === 'video') &&
        'namespaceURI' in target &&
        target.namespaceURI === HTML_NAMESPACE
    )
}

export function isVideoElement(element: HTMLMediaElement): element is HTMLVideoElement {
    return element.localName === 'video'
}

/** Whether `element` moves on: it plays, and has the data to. */
export function isAdvancing(element: HTMLMediaElement): boolean {
    return !element.paused && !element.ended && element.readyState >= HAVE_FUTURE_DATA
}

/**
 * The playback state of `element`. One that waits for data is recorded as paused, since its position does not move
 * on, and as playing again once it does.
 */
export function stateOf(element: HTMLMediaElement, id: number): MediaStateEvent {
    const { currentTime, playbackRate, volume } = element
    return {
        type: EventType.MediaState,
        id,
        paused: !isAdvancing(element),
        muted: element.muted,
        currentTime: Number.isFinite(currentTime) ? currentTime : 0,
        playbackRate: Number.isFinite(playbackRate) ? playbackRate : 1,
        volume
    }
}
