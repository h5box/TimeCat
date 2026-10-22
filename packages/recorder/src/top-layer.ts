import { encodeTopLayer, TopLayerKind } from '@timecat-js/protocol'
import type { TopLayerEntry } from '@timecat-js/protocol'
import { isDialog, matches } from './dom.ts'
import type { NodeIds } from './ids.ts'
import type { InnerRoot, Scope } from './tree.ts'

interface Shown {
    readonly element: Element
    readonly kind: TopLayerKind
}

/**
 * Records the modal dialogs and popovers the top layer shows. Showing or hiding one marks it: the `open` attribute
 * of a dialog changes, a popover gets a `beforetoggle` event. What is shown is read when the TopLayer event is
 * written, once per flush. The top layer's order cannot be read: elements go on top in the order they are marked.
 */
export class TopLayerRecorder {
    readonly #ids: NodeIds
    readonly #scope: Scope
    readonly #marked = new Set<Element>()
    /** In the top layer when last looked, from the bottom up. */
    #shown: Shown[] = []
    #written: readonly TopLayerEntry[] = []

    constructor(ids: NodeIds, scope: Scope) {
        this.#ids = ids
        this.#scope = scope
    }

    mark(element: Element): void {
        this.#marked.add(element)
    }

    /**
     * Marks what the top layer shows when the snapshot is written: as their order is not known, modal dialogs go
     * first, then popovers, each in document order.
     */
    found(roots: Iterable<InnerRoot>): void {
        const popovers: Element[] = []
        for (const root of roots) {
            for (const element of root.querySelectorAll('dialog[open], [popover]')) {
                if (isDialog(element) && kindOf(element) === TopLayerKind.Modal) {
                    this.mark(element)
                } else {
                    popovers.push(element)
                }
            }
        }
        for (const element of popovers) {
            this.mark(element)
        }
    }

    /** The body of a TopLayer event, or undefined when the top layer shows what it showed. */
    write(): Uint8Array<ArrayBuffer> | undefined {
        const marked = this.#marked
        if (marked.size === 0 && this.#shown.length === 0) {
            return undefined
        }
        // Removing an element takes it out of the top layer too.
        const shown: Shown[] = []
        for (const { element } of this.#shown) {
            if (!marked.has(element)) {
                add(shown, element)
            }
        }
        for (const element of marked) {
            add(shown, element)
        }
        marked.clear()
        this.#shown = shown
        const entries: TopLayerEntry[] = []
        for (const { element, kind } of shown) {
            const id = this.#ids.get(element)
            if (id !== undefined && this.#scope.contains(element)) {
                entries.push({ id, kind })
            }
        }
        const written = this.#written
        if (entries.length === written.length && entries.every((entry, i) => same(entry, written[i]!))) {
            return undefined
        }
        this.#written = entries
        return encodeTopLayer({ entries })
    }
}

function add(shown: Shown[], element: Element): void {
    const kind = kindOf(element)
    if (kind !== undefined) {
        shown.push({ element, kind })
    }
}

function kindOf(element: Element): TopLayerKind | undefined {
    if (matches(element, ':popover-open')) {
        return TopLayerKind.Popover
    }
    return isDialog(element) && matches(element, ':modal') ? TopLayerKind.Modal : undefined
}

function same(a: TopLayerEntry, b: TopLayerEntry): boolean {
    return a.id === b.id && a.kind === b.kind
}
