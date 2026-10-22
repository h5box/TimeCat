import { encodeFocus } from '@timecat-js/protocol'
import { isFrame, matches } from './dom.ts'
import type { NodeIds } from './ids.ts'
import type { Scope } from './tree.ts'

/** Deepest a focused element is looked for: shadow trees and frames in each other. */
const MAX_DEPTH = 32

/**
 * Records which element has focus. Focus events mark it as changed; the element is looked up when the Focus event
 * is written, once per flush, so focus that moves from one element to the next costs one look.
 */
export class FocusRecorder {
    readonly #ids: NodeIds
    readonly #scope: Scope
    #changed = false
    /** What was recorded last: the replay starts with nothing focused. */
    #id = 0
    #visible = false

    constructor(ids: NodeIds, scope: Scope) {
        this.#ids = ids
        this.#scope = scope
    }

    /** Whether an element is recorded as focused, which removing it may change without a focus event. */
    get focused(): boolean {
        return this.#id !== 0
    }

    mark(): void {
        this.#changed = true
    }

    /** The body of a Focus event, or undefined when the focus stayed where it was. */
    write(document: Document): Uint8Array<ArrayBuffer> | undefined {
        if (!this.#changed) {
            return undefined
        }
        this.#changed = false
        const element = this.#focused(document)
        const id = element === null ? 0 : (this.#ids.get(element) ?? 0)
        const visible = element !== null && id !== 0 && matches(element, ':focus-visible')
        if (id === this.#id && visible === this.#visible) {
            return undefined
        }
        this.#id = id
        this.#visible = visible
        return encodeFocus({ id, visible })
    }

    /**
     * The innermost element with focus. Documents and shadow roots each know which of their elements has it,
     * which for a host or a frame means the focus is inside. Frames do not match `:focus`, though, and the
     * document of one may have nothing focused, nor the frame be of the page's origin: then no element has it.
     */
    #focused(document: Document): Element | null {
        const chain: Element[] = []
        let element = document.activeElement
        while (element !== null && chain.length < MAX_DEPTH) {
            chain.push(element)
            const root = this.#scope.shadowRoot(element)
            element = root === null ? (isFrame(element) ? frameFocus(element) : null) : root.activeElement
        }
        return chain.findLast(focused => matches(focused, ':focus')) ?? null
    }
}

function frameFocus(frame: HTMLIFrameElement | HTMLFrameElement): Element | null {
    // None for a cross-origin frame.
    return frame.contentDocument?.activeElement ?? null
}
