import { TcrDecodeError } from './errors.ts'
import type { ByteReader } from './reader.ts'
import type { ByteWriter } from './writer.ts'

// Every table-backed string starts with a varuint tag.
const LITERAL = 0
const LITERAL_INTERNED = 1
const FIRST_REFERENCE = 2

/**
 * Encoder side of a string table: a string written with `intern` is stored once, later writes of the
 * same string become a short reference. Which strings to intern is the writer's choice; the reader
 * only follows the tags, so the policy can change without breaking the format.
 */
export class StringTableWriter {
    readonly #indexes = new Map<string, number>()

    /** Number of interned strings. */
    get size(): number {
        return this.#indexes.size
    }

    write(writer: ByteWriter, value: string, intern = true): void {
        const index = this.#indexes.get(value)
        if (index !== undefined) {
            writer.varuint(FIRST_REFERENCE + index)
            return
        }
        if (intern) {
            this.#indexes.set(value, this.#indexes.size)
        }
        writer.varuint(intern ? LITERAL_INTERNED : LITERAL)
        writer.string(value)
    }

    reset(): void {
        this.#indexes.clear()
    }
}

/** Decoder side of a string table. */
export class StringTableReader {
    readonly #strings: string[] = []

    read(reader: ByteReader): string {
        const tag = reader.varuint()
        if (tag >= FIRST_REFERENCE) {
            const value = this.#strings[tag - FIRST_REFERENCE]
            if (value === undefined) {
                throw new TcrDecodeError(`string reference ${tag - FIRST_REFERENCE} is not in the table`)
            }
            return value
        }
        const value = reader.string()
        if (tag === LITERAL_INTERNED) {
            this.#strings.push(value)
        }
        return value
    }

    reset(): void {
        this.#strings.length = 0
    }
}
