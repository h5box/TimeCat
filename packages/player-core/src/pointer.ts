import { PointerAction } from '@timecat-js/protocol'
import { upperBound } from './search.ts'
import type { PointerTrail } from './timeline/types.ts'

/** How long a click stays visible. */
const CLICK_MS = 500
const MAX_CLICKS = 3

interface Click {
    x: number
    y: number
    /** 0 when the button went down, towards 1 as the click fades. */
    progress: number
}

/** Where the recorded pointer is at a time, in viewport pixels. */
export interface PointerState {
    x: number
    y: number
    /** `PointerType`. */
    type: number
    /** A button is down: for touch, whether the finger is on the screen. */
    pressed: boolean
    /** Recent presses, the latest first. */
    clicks: Click[]
}

/** The pointer at `time`, or `undefined` before it first moved or pressed. */
export function pointerAt(trail: PointerTrail, time: number): PointerState | undefined {
    const sample = upperBound(trail.times, time) - 1
    if (sample < 0) {
        return undefined
    }
    const { times, actions, xs, ys } = trail.buttons
    const last = upperBound(times, time) - 1
    const clicks: Click[] = []
    for (let i = last; i >= 0 && clicks.length < MAX_CLICKS; i--) {
        const age = time - times[i]!
        if (age >= CLICK_MS) {
            break
        }
        if (actions[i] === PointerAction.Down) {
            clicks.push({ x: xs[i]!, y: ys[i]!, progress: age / CLICK_MS })
        }
    }
    return {
        x: trail.xs[sample]!,
        y: trail.ys[sample]!,
        type: trail.pointers[sample]!,
        pressed: last >= 0 && actions[last] === PointerAction.Down,
        clicks
    }
}
