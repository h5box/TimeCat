const encoder = new TextEncoder()

/** Largest byte length prefix a string can need: lengths stay below 2^35. */
const MAX_LENGTH_PREFIX = 5
/** Signed varints are zigzag-encoded, so their magnitude is limited to keep the result a safe integer. */
const MIN_VARINT = -(2 ** 52)
const MAX_VARINT = 2 ** 52 - 1

/** Growable buffer that writes TCR primitives. Multi-byte numbers are little-endian. */
export class ByteWriter {
    #buffer: Uint8Array<ArrayBuffer>
    #view: DataView | undefined
    #offset = 0

    constructor(initialCapacity = 1024) {
        this.#buffer = new Uint8Array(initialCapacity)
    }

    /** Number of bytes written so far. */
    get length(): number {
        return this.#offset
    }

    u8(value: number): void {
        if ((value & 0xff) !== value) {
            throw new RangeError(`u8 must be an integer in [0, 255], got ${value}`)
        }
        this.#ensure(1)
        this.#buffer[this.#offset++] = value
    }

    /** Unsigned LEB128 for any non-negative safe integer (at most 8 bytes). */
    varuint(value: number): void {
        if (value >>> 0 === value) {
            this.#ensure(5)
            const buffer = this.#buffer
            let offset = this.#offset
            while (value > 0x7f) {
                buffer[offset++] = (value & 0x7f) | 0x80
                value >>>= 7
            }
            buffer[offset++] = value
            this.#offset = offset
            return
        }
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError(`varuint must be a non-negative safe integer, got ${value}`)
        }
        // Beyond 32 bits, bitwise operators would truncate, so divide instead.
        this.#ensure(8)
        const buffer = this.#buffer
        let offset = this.#offset
        while (value > 0x7f) {
            buffer[offset++] = (value % 0x80) | 0x80
            value = Math.floor(value / 0x80)
        }
        buffer[offset++] = value
        this.#offset = offset
    }

    /** Zigzag-encoded signed varint for integers in [-2^52, 2^52 - 1]. */
    varint(value: number): void {
        if ((value | 0) === value) {
            this.varuint(((value << 1) ^ (value >> 31)) >>> 0)
            return
        }
        if (!Number.isSafeInteger(value) || value < MIN_VARINT || value > MAX_VARINT) {
            throw new RangeError(`varint must be an integer in [-2^52, 2^52 - 1], got ${value}`)
        }
        this.varuint(value < 0 ? -2 * value - 1 : 2 * value)
    }

    f64(value: number): void {
        this.#ensure(8)
        this.#view ??= new DataView(this.#buffer.buffer)
        this.#view.setFloat64(this.#offset, value, true)
        this.#offset += 8
    }

    /** Bytes without a length prefix. */
    raw(data: Uint8Array): void {
        this.#ensure(data.length)
        this.#buffer.set(data, this.#offset)
        this.#offset += data.length
    }

    /** Bytes with a varuint length prefix. */
    bytes(data: Uint8Array): void {
        this.varuint(data.length)
        this.raw(data)
    }

    /** UTF-8 with a varuint byte-length prefix. Lone surrogates are written as U+FFFD. */
    string(value: string): void {
        const length = value.length
        if (length < 0x80) {
            // ASCII fast path: the byte length equals the string length, so the 1-byte prefix is known upfront.
            this.#ensure(1 + length)
            const buffer = this.#buffer
            const start = this.#offset
            let i = 0
            for (; i < length; i++) {
                const code = value.charCodeAt(i)
                if (code > 0x7f) {
                    break
                }
                buffer[start + 1 + i] = code
            }
            if (i === length) {
                buffer[start] = length
                this.#offset = start + 1 + length
                return
            }
        }
        // Encode after a gap sized for the largest prefix, then write the real prefix and close the gap.
        const maxBytes = length * 3
        this.#ensure(MAX_LENGTH_PREFIX + maxBytes)
        const start = this.#offset
        const textStart = start + MAX_LENGTH_PREFIX
        const { written } = encoder.encodeInto(value, this.#buffer.subarray(textStart, textStart + maxBytes))
        this.varuint(written)
        if (this.#offset !== textStart) {
            this.#buffer.copyWithin(this.#offset, textStart, textStart + written)
        }
        this.#offset += written
    }

    /** Returns a compact copy of the written bytes. The writer keeps its buffer, so `reset()` can reuse it. */
    finish(): Uint8Array<ArrayBuffer> {
        return this.#buffer.slice(0, this.#offset)
    }

    /** Discards the written bytes and keeps the allocated capacity. */
    reset(): void {
        this.#offset = 0
    }

    #ensure(extra: number): void {
        const required = this.#offset + extra
        if (required <= this.#buffer.length) {
            return
        }
        let capacity = Math.max(this.#buffer.length * 2, 256)
        while (capacity < required) {
            capacity *= 2
        }
        const next = new Uint8Array(capacity)
        next.set(this.#buffer.subarray(0, this.#offset))
        this.#buffer = next
        this.#view = undefined
    }
}
