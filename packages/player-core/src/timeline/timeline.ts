import { decodeEvent, EventType } from '@timecat-js/protocol'
import type { TcrEvent, ViewportEvent } from '@timecat-js/protocol'
import { upperBound } from '../search.ts'
import type { Keyframe, PointerTrail, TimelineIndex } from './types.ts'

/**
 * The player's view of an index: finds events and keyframes, and decodes events when they are applied. A recording
 * that is still coming grows a part at a time.
 */
export class Timeline {
    readonly sessionId: string
    readonly startedAt: number
    readonly meta: Record<string, unknown>
    /** Time of the first event; 0 while there is none. */
    start: number
    /** Time of the last thing recorded; while more is to come, how far the timeline is complete. */
    end: number
    /** Nothing more is to come. */
    done: boolean
    readonly warnings: string[] = []
    readonly keyframes: Keyframe[] = []
    /** FontFace and Asset events, as events chunk payloads, a part at a time. */
    readonly statics: Uint8Array[] = []
    /** Console, Network, Perf and Custom events, as events chunk payloads, a part at a time. */
    readonly data: Uint8Array[] = []
    #count = 0
    readonly #times = new Column(length => new Float64Array(length))
    readonly #types = new Column(length => new Uint8Array(length))
    readonly #idBases = new Column(length => new Float64Array(length))
    readonly #offsets = new Column(length => new Uint32Array(length))
    readonly #lengths = new Column(length => new Uint32Array(length))
    readonly #bodies = new Column(length => new Uint8Array(length))
    readonly #costs = new Column(length => new Float64Array(length))
    readonly #keyframeIndexes: number[] = []
    readonly #pointer = new PointerColumns()
    readonly #buttons = new ButtonColumns()
    #trail: PointerTrail | undefined

    constructor(first: TimelineIndex) {
        this.sessionId = first.sessionId
        this.startedAt = first.startedAt
        this.meta = first.meta
        this.start = first.start
        this.end = first.end
        this.done = first.done
        this.append(first)
    }

    /** Number of events. */
    get count(): number {
        return this.#count
    }

    get pointer(): PointerTrail {
        this.#trail ??= { ...this.#pointer.trail(), buttons: this.#buttons.trail() }
        return this.#trail
    }

    /** Adds the next part of the index. */
    append(part: TimelineIndex): void {
        const { events } = part
        if (this.#count === 0) {
            this.start = part.start
        }
        // The first cost of a part is the work of the parts before.
        this.#costs.add(this.#costs.view.length === 0 ? events.costs : events.costs.subarray(1))
        this.end = part.end
        this.done = part.done
        const base = this.#bodies.view.length
        this.#times.add(events.times)
        this.#types.add(events.types)
        this.#idBases.add(events.idBases)
        this.#offsets.add(base === 0 ? events.offsets : events.offsets.map(offset => offset + base))
        this.#lengths.add(events.lengths)
        this.#bodies.add(events.bodies)
        this.#count += events.count
        for (const keyframe of part.keyframes) {
            this.keyframes.push(keyframe)
            this.#keyframeIndexes.push(keyframe.index)
        }
        this.#pointer.add(part.pointer)
        this.#buttons.add(part.pointer.buttons)
        this.#trail = undefined
        if (part.statics.length > 0) {
            this.statics.push(part.statics)
        }
        if (part.data.length > 0) {
            this.data.push(part.data)
        }
        this.warnings.push(...part.warnings)
    }

    /** Takes it that nothing more is to come, such as when indexing failed. */
    finish(): void {
        this.done = true
    }

    /** Number of events at or before `time`. */
    positionAt(time: number): number {
        return upperBound(this.#times.view, time)
    }

    /** Decodes event `i`; `undefined` for types this player does not know. */
    event(i: number): TcrEvent | undefined {
        const offset = this.#offsets.view[i]!
        const body = this.#bodies.view.subarray(offset, offset + this.#lengths.view[i]!)
        return decodeEvent(this.#types.view[i]!, body, { next: this.#idBases.view[i]! })
    }

    /** The last keyframe at or before `position`, leaving out those in `skip`. */
    keyframeAt(position: number, skip: ReadonlySet<Keyframe>): Keyframe | undefined {
        const keyframes = this.keyframes
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
        const costs = this.#costs.view
        return costs[to]! - costs[from]!
    }

    /** The first viewport size recorded, which stands for the size before it. */
    firstViewport(): ViewportEvent | undefined {
        const types = this.#types.view
        for (let i = 0; i < this.#count; i++) {
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

interface TypedArray<T> extends ArrayLike<number> {
    set(array: ArrayLike<number>, offset?: number): void
    subarray(begin?: number, end?: number): T
}

/** A typed array that grows, with room to spare, so adding to it takes little copying on average. */
class Column<T extends TypedArray<T>> {
    readonly #create: (length: number) => T
    #array: T
    /** The items so far. */
    view: T

    constructor(create: (length: number) => T) {
        this.#create = create
        this.#array = this.view = create(0)
    }

    add(items: T): void {
        const used = this.view.length
        const length = used + items.length
        if (used === 0) {
            // The first items are taken as they are, which is all a recording that is not live needs.
            this.#array = this.view = items
            return
        }
        if (length > this.#array.length) {
            const array = this.#create(Math.max(length, this.#array.length * 2))
            array.set(this.view)
            this.#array = array
        }
        this.#array.set(items, used)
        this.view = this.#array.subarray(0, length)
    }
}

/**
 * The pointer samples of the parts, one after the other. Each part is in time order, and a recording's parts follow
 * each other.
 */
class PointerColumns {
    readonly #times = new Column(length => new Float64Array(length))
    readonly #xs = new Column(length => new Int32Array(length))
    readonly #ys = new Column(length => new Int32Array(length))
    readonly #pointers = new Column(length => new Uint8Array(length))

    add(trail: PointerTrail): void {
        this.#times.add(trail.times)
        this.#xs.add(trail.xs)
        this.#ys.add(trail.ys)
        this.#pointers.add(trail.pointers)
    }

    trail(): Omit<PointerTrail, 'buttons'> {
        return { times: this.#times.view, xs: this.#xs.view, ys: this.#ys.view, pointers: this.#pointers.view }
    }
}

class ButtonColumns {
    readonly #times = new Column(length => new Float64Array(length))
    readonly #actions = new Column(length => new Uint8Array(length))
    readonly #xs = new Column(length => new Int32Array(length))
    readonly #ys = new Column(length => new Int32Array(length))

    add(buttons: PointerTrail['buttons']): void {
        this.#times.add(buttons.times)
        this.#actions.add(buttons.actions)
        this.#xs.add(buttons.xs)
        this.#ys.add(buttons.ys)
    }

    trail(): PointerTrail['buttons'] {
        return { times: this.#times.view, actions: this.#actions.view, xs: this.#xs.view, ys: this.#ys.view }
    }
}
