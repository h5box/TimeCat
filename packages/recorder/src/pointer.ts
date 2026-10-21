import { encodePointerButton, encodePointerMoves, EventType, PointerType, Track } from '@timecat-js/protocol'
import type { PointerAction } from '@timecat-js/protocol'
import type { EventSink } from './batch.ts'

/** A batch of pointer moves is written once it spans this long. */
export const MAX_MOVES_SPAN = 1000
const MAX_MOVES = 200

/**
 * Records the primary pointer. Moves are collected into batches stored column by column, which compress far
 * better than one event per move; button events end the current batch, so events stay in time order.
 */
export class PointerRecorder {
    readonly #sink: EventSink
    #pointer: PointerType = PointerType.Mouse
    #start = 0
    readonly #times: number[] = []
    readonly #xs: number[] = []
    readonly #ys: number[] = []

    constructor(sink: EventSink) {
        this.#sink = sink
    }

    /** Whether moves are waiting to be written. */
    get pending(): boolean {
        return this.#times.length > 0
    }

    /** The time of the moves waiting to be written: they are written as one event at this time. */
    get start(): number {
        return this.#start
    }

    move(time: number, pointer: PointerType, x: number, y: number): void {
        const count = this.#times.length
        if (count > 0) {
            if (pointer !== this.#pointer || time - this.#start >= MAX_MOVES_SPAN || count >= MAX_MOVES) {
                this.#writeMoves()
            } else if (x === this.#xs[count - 1] && y === this.#ys[count - 1]) {
                return
            }
        }
        if (this.#times.length === 0) {
            this.#start = time
            this.#pointer = pointer
        }
        this.#times.push(time - this.#start)
        this.#xs.push(x)
        this.#ys.push(y)
    }

    button(
        time: number,
        action: PointerAction,
        pointer: PointerType,
        button: number,
        x: number,
        y: number,
        targetId: number
    ): void {
        this.#writeMoves()
        this.#sink.event(
            Track.Pointer,
            EventType.PointerButton,
            time,
            encodePointerButton({ action, pointer, button, x, y, targetId })
        )
    }

    /** Writes the pending moves if they span long enough by `time`, or in any case with `force`. */
    flush(time: number, force: boolean): void {
        if (this.#times.length > 0 && (force || time - this.#start >= MAX_MOVES_SPAN)) {
            this.#writeMoves()
        }
    }

    #writeMoves(): void {
        const times = this.#times
        if (times.length === 0) {
            return
        }
        const body = encodePointerMoves({ pointer: this.#pointer, times, xs: this.#xs, ys: this.#ys })
        this.#sink.event(Track.Pointer, EventType.PointerMoves, this.#start, body)
        times.length = 0
        this.#xs.length = 0
        this.#ys.length = 0
    }
}

export function pointerTypeOf(event: PointerEvent): PointerType {
    const type = event.pointerType
    return type === 'touch' ? PointerType.Touch : type === 'pen' ? PointerType.Pen : PointerType.Mouse
}
