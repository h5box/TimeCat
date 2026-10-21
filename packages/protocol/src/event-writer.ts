import { NodeKind } from './events.ts'
import { StringTableWriter } from './strings.ts'
import { ByteWriter } from './writer.ts'

// Node header: kind in bits 0-2; flags in bits 3-7.
export const KIND_MASK = 0x07
export const HAS_CHILDREN = 0x08
export const HAS_NAMESPACE = 0x10
export const ATTRIBUTE_SHIFT = 5
/** Attribute counts from this value up are written as a separate varuint. */
export const ATTRIBUTE_ESCAPE = 7

// Interning policy: names always; values and text only while short enough to plausibly repeat.
const MAX_INTERNED_VALUE = 64
const MAX_INTERNED_TEXT = 32

/**
 * Writes one event body: TCR primitives plus a string table scoped to the event. The node methods emit the
 * token stream for DOM trees, so a recorder can encode while it walks the DOM, without building objects.
 */
export class EventWriter {
    readonly bytes: ByteWriter
    readonly #strings = new StringTableWriter()

    constructor(bytes: ByteWriter = new ByteWriter()) {
        this.bytes = bytes
    }

    /** Starts a new event body: drops the bytes and the string table. */
    reset(): void {
        this.bytes.reset()
        this.#strings.reset()
    }

    /**
     * Returns the bytes written so far and clears them, but keeps the string table. A long body can be handed on
     * piece by piece this way; the pieces concatenated form the event.
     */
    take(): Uint8Array<ArrayBuffer> {
        const piece = this.bytes.finish()
        this.bytes.reset()
        return piece
    }

    /** A string through the event's string table. */
    string(value: string, intern = true): void {
        this.#strings.write(this.bytes, value, intern)
    }

    document(hasChildren: boolean, id?: number): void {
        this.bytes.u8(NodeKind.Document | (hasChildren ? HAS_CHILDREN : 0))
        if (id !== undefined) {
            this.bytes.varuint(id)
        }
    }

    doctype(name: string, publicId: string, systemId: string, id?: number): void {
        this.bytes.u8(NodeKind.Doctype)
        if (id !== undefined) {
            this.bytes.varuint(id)
        }
        this.string(name)
        this.string(publicId)
        this.string(systemId)
    }

    /**
     * Element header. `namespace` is passed only when it differs from the parent's; the attributes follow as
     * `attributeCount` calls of `attribute()`, then the children (if any) and `end()`.
     */
    element(
        tag: string,
        namespace: string | undefined,
        attributeCount: number,
        hasChildren: boolean,
        id?: number
    ): void {
        const packed = attributeCount < ATTRIBUTE_ESCAPE ? attributeCount : ATTRIBUTE_ESCAPE
        this.bytes.u8(
            NodeKind.Element |
                (hasChildren ? HAS_CHILDREN : 0) |
                (namespace === undefined ? 0 : HAS_NAMESPACE) |
                (packed << ATTRIBUTE_SHIFT)
        )
        if (id !== undefined) {
            this.bytes.varuint(id)
        }
        this.string(tag)
        if (namespace !== undefined) {
            this.string(namespace)
        }
        if (packed === ATTRIBUTE_ESCAPE) {
            this.bytes.varuint(attributeCount)
        }
    }

    attribute(name: string, value: string): void {
        this.string(name)
        this.string(value, value.length <= MAX_INTERNED_VALUE)
    }

    text(data: string, id?: number): void {
        this.bytes.u8(NodeKind.Text)
        if (id !== undefined) {
            this.bytes.varuint(id)
        }
        this.string(data, data.length <= MAX_INTERNED_TEXT)
    }

    comment(data: string, id?: number): void {
        this.bytes.u8(NodeKind.Comment)
        if (id !== undefined) {
            this.bytes.varuint(id)
        }
        this.string(data, data.length <= MAX_INTERNED_TEXT)
    }

    /** Closes the children of the innermost open document or element. */
    end(): void {
        this.bytes.u8(NodeKind.End)
    }

    /** Entry of a mutation's attribute changes; `null` removes the attribute. */
    attributeChange(id: number, name: string, value: string | null): void {
        this.bytes.varuint(id)
        this.string(name)
        if (value === null) {
            this.bytes.u8(0)
        } else {
            this.bytes.u8(1)
            this.string(value, value.length <= MAX_INTERNED_VALUE)
        }
    }

    /** Entry of a mutation's text changes. */
    textChange(id: number, data: string): void {
        this.bytes.varuint(id)
        this.string(data, data.length <= MAX_INTERNED_TEXT)
    }
}
