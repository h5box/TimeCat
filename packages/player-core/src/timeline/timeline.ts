import { decodeEvent, EventType } from '@timecat-js/protocol'
import type { TcrEvent, ViewportEvent } from '@timecat-js/protocol'
import { upperBound } from '../search.ts'
import type { Keyframe, TimelineIndex } from './types.ts'

/** The player's view of an index: finds events and keyframes, and decodes events when they are applied. */
export class Timeline {
    readonly index: TimelineIndex
    readonly #keyframeIndexes: Float64Array

    constructor(index: TimelineIndex) {
        this.index = index
        this.#keyframeIndexes = Float64Array.from(index.keyframes, keyframe => keyframe.index)
    }

    /** Number of events at or before `time`. */
    positionAt(time: number): number {
        return upperBound(this.index.events.times, time)
    }

    /** Decodes event `i`; `undefined` for types this player does not know. */
    event(i: number): TcrEvent | undefined {
        const { types, idBases, offsets, lengths, bodies } = this.index.events
        const offset = offsets[i]!
        return decodeEvent(types[i]!, bodies.subarray(offset, offset + lengths[i]!), { next: idBases[i]! })
    }

    /** The last keyframe at or before `position`, leaving out those in `skip`. */
    keyframeAt(position: number, skip: ReadonlySet<Keyframe>): Keyframe | undefined {
        const keyframes = this.index.keyframes
        for (let i = upperBound(this.#keyframeIndexes, position) - 1; i >= 0; i--) {
            const keyframe = keyframes[i]!
            if (!skip.has(keyframe)) {
                return keyframe
            }
        }
        return undefined
    }

    /** Work of applying events `from` to `to - 1`. */
    cost(from: number, to: number): number {
        const costs = this.index.events.costs
        return costs[to]! - costs[from]!
    }

    /** The first viewport size recorded, which stands for the size before it. */
    firstViewport(): ViewportEvent | undefined {
        const { count, types } = this.index.events
        for (let i = 0; i < count; i++) {
            if (types[i] === EventType.Viewport) {
                const event = this.event(i)
                if (event?.type === EventType.Viewport) {
                    return event
                }
            }
        }
        return undefined
    }
}
