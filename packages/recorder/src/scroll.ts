import { encodeScroll } from '@timecat-js/protocol'
import type { ScrollPosition } from '@timecat-js/protocol'
import { isDocument, isElement } from './dom.ts'
import type { NodeIds } from './ids.ts'
import type { Scope } from './tree.ts'

/**
 * Records scroll offsets of viewports, the page's and those of frames, and of elements. Nodes are marked when
 * they scroll; their offsets are read when the scroll event is written, once per flush.
 */
export class ScrollRecorder {
    readonly #ids: NodeIds
    readonly #scope: Scope
    readonly #marked = new Set<Node>()
    /** Id and offsets last recorded per node. The replay creates nodes unscrolled, which a new id means. */
    readonly #last = new WeakMap<Node, readonly [id: number, x: number, y: number]>()

    constructor(ids: NodeIds, scope: Scope) {
        this.#ids = ids
        this.#scope = scope
    }

    mark(node: Node): void {
        this.#marked.add(node)
    }

    /** The body of a Scroll event for the marked nodes, or undefined when no offset changed. */
    write(): Uint8Array<ArrayBuffer> | undefined {
        const positions: ScrollPosition[] = []
        for (const marked of this.#marked) {
            // Scrolling the scrolling element scrolls the viewport, which the document stands for.
            const owner = marked.ownerDocument
            const node = owner !== null && marked === owner.scrollingElement ? owner : marked
            const id = this.#ids.get(node)
            if (id === undefined || !this.#scope.contains(node)) {
                continue
            }
            let x: number
            let y: number
            if (isDocument(node)) {
                const view = node.defaultView
                if (view === null) {
                    continue
                }
                x = Math.round(view.scrollX)
                y = Math.round(view.scrollY)
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
