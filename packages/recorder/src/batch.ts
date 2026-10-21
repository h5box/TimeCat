import { ByteReader, ByteWriter } from '@timecat-js/protocol'

/** Receives encoded events from the capture side. */
export interface EventSink {
    /** A complete event. */
    event(track: number, type: number, time: number, body: Uint8Array): void
    /** A piece of a long event body. The pieces and the body of the next `event` on the track form that event. */
    part(track: number, body: Uint8Array): void
    /** Hands on everything written since the last commit. */
    commit(): void
}

export type BatchTarget = Omit<EventSink, 'commit'>

const EVENT_RECORD = 0
const PART_RECORD = 1

/**
 * Packs what is written between commits into one buffer, which the worker receives without a copy. Records are
 * `u8 kind, varuint track, [varuint type, varuint time], bytes body`; type and time only for events.
 */
export class BatchWriter implements EventSink {
    readonly #bytes = new ByteWriter(4096)
    readonly #send: (batch: Uint8Array<ArrayBuffer>) => void

    constructor(send: (batch: Uint8Array<ArrayBuffer>) => void) {
        this.#send = send
    }

    event(track: number, type: number, time: number, body: Uint8Array): void {
        const bytes = this.#bytes
        bytes.u8(EVENT_RECORD)
        bytes.varuint(track)
        bytes.varuint(type)
        bytes.varuint(time)
        bytes.bytes(body)
    }

    part(track: number, body: Uint8Array): void {
        const bytes = this.#bytes
        bytes.u8(PART_RECORD)
        bytes.varuint(track)
        bytes.bytes(body)
    }

    commit(): void {
        const bytes = this.#bytes
        if (bytes.length > 0) {
            const batch = bytes.finish()
            bytes.reset()
            this.#send(batch)
        }
    }
}

/** Replays the records of a batch. Bodies are views into `batch`. */
export function readBatch(batch: Uint8Array, target: BatchTarget): void {
    const reader = new ByteReader(batch)
    while (reader.remaining > 0) {
        const kind = reader.u8()
        const track = reader.varuint()
        if (kind === PART_RECORD) {
            target.part(track, reader.bytes())
        } else {
            const type = reader.varuint()
            const time = reader.varuint()
            target.event(track, type, time, reader.bytes())
        }
    }
}
