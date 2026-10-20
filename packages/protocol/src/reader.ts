import { TcrDecodeError } from './errors.ts'

// ignoreBOM keeps a leading U+FEFF, which is legitimate content in DOM text.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

/** ceil(53 / 7): enough groups for any safe integer. */
const MAX_VARINT_BYTES = 8
/** Below this length, decoding ASCII by hand beats the TextDecoder call overhead. */
const SHORT_STRING = 16

/**
 * Reads TCR primitives from a byte array. Every read is bounds-checked and throws `TcrDecodeError`
 * on malformed input, because recordings are untrusted data on the replay side.
 */
export class ByteReader {
    readonly #bytes: Uint8Array
    #offset = 0
    #view: DataView | undefined

    constructor(bytes: Uint8Array) {
        this.#bytes = bytes
    }

    get offset(): number {
        return this.#offset
    }

    get remaining(): number {
        return this.#bytes.length - this.#offset
    }

    u8(): number {
        if (this.#offset >= this.#bytes.length) {
            throw truncated('u8')
        }
        return this.#bytes[this.#offset++]!
    }

    varuint(): number {
        const bytes = this.#bytes
        const end = bytes.length
        let offset = this.#offset
        let result = 0
        let scale = 1
        for (let i = 0; i < MAX_VARINT_BYTES; i++) {
            if (offset >= end) {
                throw truncated('varint')
            }
            const byte = bytes[offset++]!
            result += (byte & 0x7f) * scale
            if (byte < 0x80) {
                if (result > Number.MAX_SAFE_INTEGER) {
                    throw new TcrDecodeError('varint exceeds the safe integer range')
                }
                this.#offset = offset
                return result
            }
            scale *= 0x80
        }
        throw new TcrDecodeError(`varint is longer than ${MAX_VARINT_BYTES} bytes`)
    }

    varint(): number {
        const value = this.varuint()
        if (value <= 0xffffffff) {
            return (value >>> 1) ^ -(value & 1)
        }
        return value % 2 === 0 ? value / 2 : -(value + 1) / 2
    }

    f64(): number {
        if (this.remaining < 8) {
            throw truncated('f64')
        }
        this.#view ??= new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength)
        const value = this.#view.getFloat64(this.#offset, true)
        this.#offset += 8
        return value
    }

    /** `length` bytes without a prefix, as a view into the source (no copy). */
    raw(length: number): Uint8Array {
        if (length > this.remaining) {
            throw truncated('bytes')
        }
        const start = this.#offset
        this.#offset += length
        return this.#bytes.subarray(start, this.#offset)
    }

    /** Length-prefixed bytes, as a view into the source (no copy). */
    bytes(): Uint8Array {
        return this.raw(this.varuint())
    }

    /** Length-prefixed UTF-8. Invalid sequences decode to U+FFFD. */
    string(): string {
        const length = this.varuint()
        if (length > this.remaining) {
            throw truncated('string')
        }
        const bytes = this.#bytes
        const start = this.#offset
        const end = start + length
        this.#offset = end
        if (length < SHORT_STRING) {
            let result = ''
            for (let i = start; i < end; i++) {
                const byte = bytes[i]!
                if (byte > 0x7f) {
                    return decoder.decode(bytes.subarray(start, end))
                }
                result += String.fromCharCode(byte)
            }
            return result
        }
        return decoder.decode(bytes.subarray(start, end))
    }
}

function truncated(what: string): TcrDecodeError {
    return new TcrDecodeError(`unexpected end of data while reading ${what}`)
}
