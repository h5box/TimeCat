import { ByteWriter, EventWriter } from '@timecat-js/protocol'
import { HTML_NAMESPACE, isComment, isElement, isInput, isRecordable, isText, recordsChildren } from './dom.ts'
import type { FormControl } from './dom.ts'
import type { NodeIds } from './ids.ts'
import { applyTextMask, maskValue, TextMask } from './privacy.ts'
import type { Privacy } from './privacy.ts'
import { TreeWriter } from './tree.ts'
import type { SnapshotGuard } from './tree.ts'

/** Prefix of attribute keys that carry a namespace; NUL cannot occur in attribute names. */
const NAMESPACED = '\0'

/**
 * Mutation records reduced to what changed: which nodes were removed or inserted, which attributes and texts
 * changed. Records only say that something changed; the current state is read when the batch is written, so
 * many changes to one node within a frame cost one entry.
 */
export class MutationBuffer implements SnapshotGuard {
    generation = 0
    readonly removed: Set<Node> = new Set()
    readonly added: Set<Node> = new Set()
    /** Nodes whose child lists changed. */
    readonly parents: Set<Node> = new Set()
    readonly attributes: Map<Element, Set<string>> = new Map()
    readonly texts: Set<Node> = new Set()

    push(records: MutationRecord[]): void {
        for (const record of records) {
            const target = record.target
            if (record.type === 'childList') {
                this.parents.add(target)
                for (const node of record.removedNodes) {
                    this.removed.add(node)
                }
                for (const node of record.addedNodes) {
                    this.added.add(node)
                }
                this.generation++
            } else if (record.type === 'attributes') {
                const name = record.attributeName
                if (name === null || !isElement(target)) {
                    continue
                }
                const namespace = record.attributeNamespace
                let names = this.attributes.get(target)
                if (names === undefined) {
                    names = new Set()
                    this.attributes.set(target, names)
                }
                names.add(namespace === null ? name : `${NAMESPACED}${namespace}${NAMESPACED}${name}`)
            } else {
                this.texts.add(target)
            }
        }
    }

    get isEmpty(): boolean {
        return this.removed.size === 0 && this.added.size === 0 && this.attributes.size === 0 && this.texts.size === 0
    }

    clear(): void {
        this.removed.clear()
        this.added.clear()
        this.parents.clear()
        this.attributes.clear()
        this.texts.clear()
    }
}

/** Conventional prefixes, for naming a namespaced attribute that is gone. */
const PREFIXES: Record<string, string> = {
    'http://www.w3.org/1999/xlink': 'xlink:',
    'http://www.w3.org/XML/1998/namespace': 'xml:',
    'http://www.w3.org/2000/xmlns/': 'xmlns:'
}

/** Turns a mutation buffer into the body of a Mutations event (RFC 0002, section 6.6). */
export class MutationWriter {
    readonly #ids: NodeIds
    readonly #privacy: Privacy
    readonly #writer = new EventWriter()
    readonly #tree: TreeWriter
    readonly #body = new ByteWriter(256)
    readonly #run: Node[] = []

    constructor(ids: NodeIds, privacy: Privacy) {
        this.#ids = ids
        this.#privacy = privacy
        this.#tree = new TreeWriter(this.#writer, ids, privacy)
    }

    /** Form controls the last `write` added, whose current state the input track adds. */
    get controls(): FormControl[] {
        return this.#tree.controls
    }

    /** Returns undefined when no recorded node changed. */
    write(buffer: MutationBuffer): Uint8Array<ArrayBuffer> | undefined {
        const ids = this.#ids
        const privacy = this.#privacy
        const writer = this.#writer
        const tree = this.#tree
        // Ids from here on are given to nodes written by this batch.
        const batchStart = ids.next
        writer.reset()
        tree.controls.length = 0

        const removes: number[] = []
        for (const node of buffer.removed) {
            const id = ids.get(node)
            if (id !== undefined) {
                removes.push(id)
                ids.delete(node)
            }
        }

        // An inserted node is pending until this batch writes it. Its id, if any, is a stale one from a
        // subtree that was detached earlier.
        const added = buffer.added
        const pending = (node: Node): boolean => {
            if (!added.has(node)) {
                return false
            }
            const id = ids.get(node)
            return id === undefined || id < batchStart
        }
        let runs = 0
        const run = this.#run
        for (const node of added) {
            if (!pending(node) || !node.isConnected) {
                continue
            }
            // Write the outermost pending node, which takes everything inserted below it along.
            let top = node
            for (let ancestor = node.parentNode; ancestor !== null; ancestor = ancestor.parentNode) {
                if (pending(ancestor)) {
                    top = ancestor
                }
            }
            const parent = top.parentNode
            const parentId = parent === null ? undefined : ids.get(parent)
            if (
                parent === null ||
                parentId === undefined ||
                (isElement(parent) && (!recordsChildren(parent) || privacy.blocks(parent)))
            ) {
                continue
            }
            // One run covers the neighbouring pending siblings too. It goes before the next sibling the
            // replay already has: one written earlier, or one from this batch.
            let first = top
            for (let sibling = first.previousSibling; sibling !== null && pending(sibling);) {
                first = sibling
                sibling = sibling.previousSibling
            }
            run.length = 0
            let anchor: Node | null = first
            for (; anchor !== null && pending(anchor); anchor = anchor.nextSibling) {
                if (isRecordable(anchor)) {
                    run.push(anchor)
                }
            }
            while (anchor !== null && (pending(anchor) || !ids.has(anchor))) {
                anchor = anchor.nextSibling
            }
            if (run.length === 0) {
                continue
            }
            runs++
            writer.bytes.varuint(parentId)
            writer.bytes.varuint(anchor === null ? 0 : (ids.get(anchor) ?? 0))
            writer.bytes.varuint(run.length)
            const mask = isElement(parent) ? privacy.textMaskIn(parent) : TextMask.None
            for (const item of run) {
                tree.begin(item, HTML_NAMESPACE, mask)
                tree.run()
            }
        }
        const runBytes = writer.take()

        let attributeCount = 0
        for (const [element, names] of buffer.attributes) {
            const id = ids.get(element)
            if (id === undefined || id >= batchStart || !element.isConnected || privacy.blocks(element)) {
                continue
            }
            const masksValue = isInput(element) && privacy.masksValue(element)
            for (const key of names) {
                let name = key
                let value: string | null
                if (key.startsWith(NAMESPACED)) {
                    const [, namespace = '', localName = ''] = key.split(NAMESPACED)
                    const attribute = element.getAttributeNodeNS(namespace, localName)
                    name = attribute?.name ?? (PREFIXES[namespace] ?? '') + localName
                    value = attribute?.value ?? null
                } else {
                    value = element.getAttributeNS(null, key)
                }
                if (masksValue && name === 'value' && value !== null) {
                    value = maskValue(value)
                }
                writer.attributeChange(id, name, value)
                attributeCount++
            }
        }
        const attributeBytes = writer.take()

        let textCount = 0
        for (const node of buffer.texts) {
            const id = ids.get(node)
            if (id === undefined || id >= batchStart || !node.isConnected) {
                continue
            }
            if (isText(node) || isComment(node)) {
                const parent = node.parentElement
                const mask = parent === null ? TextMask.None : privacy.textMaskIn(parent)
                writer.textChange(id, applyTextMask(mask, node.data))
                textCount++
            }
        }
        const textBytes = writer.take()

        if (removes.length === 0 && runs === 0 && attributeCount === 0 && textCount === 0) {
            return undefined
        }
        const body = this.#body
        body.reset()
        body.varuint(removes.length)
        for (const id of removes) {
            body.varuint(id)
        }
        // The sections were written in this order too, so string table references only point backwards.
        body.varuint(runs)
        body.raw(runBytes)
        body.varuint(attributeCount)
        body.raw(attributeBytes)
        body.varuint(textCount)
        body.raw(textBytes)
        return body.finish()
    }
}
