import { TcrDecodeError } from './errors.ts'
import { ByteReader } from './reader.ts'
import type { ByteWriter } from './writer.ts'

/** A packet of a media track: an encoded chunk of WebCodecs, or the next bytes of a container stream. */
export interface MediaPacket {
    /** Microseconds from the segment start. */
    time: number
    /** Microseconds; 0 when unknown. */
    duration: number
    /** Decoding can start here: a key frame, or the start of a container stream. */
    key: boolean
    data: Uint8Array
}

// Packet flags.
const KEY = 1

/**
 * Appends a packet to a media chunk payload. `previousTime` is the time of the previous packet of the chunk, or
 * the chunk's start time in microseconds for the first one. Packets can go back in time, as video in decoding
 * order does.
 */
export function writeMediaPacket(writer: ByteWriter, packet: MediaPacket, previousTime: number): void {
    writer.u8(packet.key ? KEY : 0)
    writer.varint(packet.time - previousTime)
    writer.varuint(packet.duration)
    writer.bytes(packet.data)
}

/** Splits a media chunk payload into its packets. `startTime` is the chunk's, in milliseconds; data are views. */
export function readMediaPackets(payload: Uint8Array, startTime: number): MediaPacket[] {
    const reader = new ByteReader(payload)
    const packets: MediaPacket[] = []
    let time = startTime * 1000
    while (reader.remaining > 0) {
        const flags = reader.u8()
        if ((flags & ~KEY) !== 0) {
            throw new TcrDecodeError(`unknown media packet flags 0x${flags.toString(16)}`)
        }
        time += reader.varint()
        if (!Number.isSafeInteger(time) || time < 0) {
            throw new TcrDecodeError(`media packet time ${time} is out of range`)
        }
        packets.push({ time, duration: reader.varuint(), key: flags === KEY, data: reader.bytes() })
    }
    return packets
}
