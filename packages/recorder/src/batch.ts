import { ByteReader, ByteWriter } from '@timecat-js/protocol'
import type { MediaPacket } from '@timecat-js/protocol'

/** Receives encoded events from the capture side. */
export interface EventSink {
    /** A complete event. */
    event(track: number, type: number, time: number, body: Uint8Array): void
    /** A piece of a long event body. The pieces and the body of the next `event` on the track form that event. */
    part(track: number, body: Uint8Array): void
    /** A packet of a media track. */
    media(track: number, packet: MediaPacket): void
    /** A sync point (RFC 0002, 4.4): no event on a page track comes with an earlier time from here on. */
    sync(time: number): void
    /** Hands on everything written since the last commit. */
    commit(): void
}

export type BatchTarget = Omit<EventSink, 'commit'>

const EVENT_RECORD = 0
const PART_RECORD = 1
const MEDIA_RECORD = 2
const SYNC_RECORD = 3

/**
 * Packs what is written between commits into one buffer, which the worker receives without a copy. Records are
 * a `u8` kind, then for events `varuint track, varuint type, varuint time, bytes body`; for parts
 * `varuint track, bytes body`; for media packets `varuint track, u8 key, varuint time, varuint duration,
 * bytes data`; for sync points `varuint time`.
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

    media(track: number, packet: MediaPacket): void {
        const bytes = this.#bytes
        bytes.u8(MEDIA_RECORD)
        bytes.varuint(track)
        bytes.u8(packet.key ? 1 : 0)
        bytes.varuint(packet.time)
        bytes.varuint(packet.duration)
        bytes.bytes(packet.data)
    }

    sync(time: number): void {
        this.#bytes.u8(SYNC_RECORD)
        this.#bytes.varuint(time)
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
        if (kind === SYNC_RECORD) {
            target.sync(reader.varuint())
            continue
        }
        const track = reader.varuint()
        if (kind === PART_RECORD) {
            target.part(track, reader.bytes())
        } else if (kind === MEDIA_RECORD) {
            const key = reader.u8() === 1
            const time = reader.varuint()
            target.media(track, { time, duration: reader.varuint(), key, data: reader.bytes() })
        } else {
            const type = reader.varuint()
            const time = reader.varuint()
            target.event(track, type, time, reader.bytes())
        }
    }
}
