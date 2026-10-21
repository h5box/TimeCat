import { encodeScroll } from '@timecat-js/protocol'
import type { ScrollPosition } from '@timecat-js/protocol'
import { isDocument, isElement } from './dom.ts'
import type { NodeIds } from './ids.ts'

/**
 * Records scroll offsets of the viewport and of elements. Nodes are marked when they scroll; their offsets are
 * read when the scroll event is written, once per flush.
 */
export class ScrollRecorder {
    readonly #ids: NodeIds
    readonly #window: Window
    readonly #document: Document
    readonly #marked = new Set<Node>()
    /** Id and offsets last recorded per node. The replay creates nodes unscrolled, which a new id means. */
    readonly #last = new WeakMap<Node, readonly [id: number, x: number, y: number]>()

    constructor(ids: NodeIds, window: Window) {
        this.#ids = ids
        this.#window = window
        this.#document = window.document
    }

    mark(node: Node): void {
        this.#marked.add(node)
    }

    /** The body of a Scroll event for the marked nodes, or undefined when no offset changed. */
    write(): Uint8Array<ArrayBuffer> | undefined {
        const document = this.#document
        // Scrolling the scrolling element scrolls the viewport, which the document stands for.
        const scrolling = document.scrollingElement
        const positions: ScrollPosition[] = []
        for (const marked of this.#marked) {
            const node = marked === scrolling ? document : marked
            const id = this.#ids.get(node)
            if (id === undefined || !node.isConnected) {
                continue
            }
            let x: number
            let y: number
            if (isDocument(node)) {
                x = Math.round(this.#window.scrollX)
                y = Math.round(this.#window.scrollY)
            } else if (isElement(node)) {
                x = Math.round(node.scrollLeft)
                y = Math.round(node.scrollTop)
            } else {
                continue
            }
            const last = this.#last.get(node)
            const unchanged = last === undefined || last[0] !== id ? x === 0 && y === 0 : last[1] === x && last[2] === y
            if (unchanged) {
                continue
            }
            this.#last.set(node, [id, x, y])
            positions.push({ id, x, y })
        }
        this.#marked.clear()
        return positions.length === 0 ? undefined : encodeScroll({ positions })
    }
}
