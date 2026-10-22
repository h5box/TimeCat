import { TopLayerKind } from '@timecat-js/protocol'
import type { FocusEvent, TopLayerEntry, TopLayerEvent } from '@timecat-js/protocol'
import { HTML_NAMESPACE, isDialog, isDocument, isElement, isFrame, isShadowRoot } from './dom.ts'
import type { Materializer } from './materializer.ts'
import type { PointerState } from './pointer.ts'
import type { PseudoClasses } from './pseudo-classes.ts'
import { stateAttribute } from './states.ts'
import type { State } from './states.ts'
import type { Timeline } from './timeline/timeline.ts'
import type { At } from './timeline/types.ts'

/** Deepest the pointer is followed into shadow trees and frames. */
const MAX_DEPTH = 32

interface Shown {
    readonly element: HTMLElement
    readonly kind: TopLayerKind
}

interface Point {
    readonly x: number
    readonly y: number
}

/**
 * Shows what the recorded user did that the replay, which no one interacts with, does not do by itself: the element
 * focused, and those under the pointer and pressed, get attributes that the rewritten style sheets select (see
 * `PseudoClasses`); the dialogs and popovers shown go into the top layer, where only script puts them.
 */
export class Interaction {
    readonly #timeline: Timeline
    readonly #materializer: Materializer
    readonly #document: Document
    readonly #pseudoClasses: PseudoClasses
    /** The elements each state's attribute is on. */
    readonly #marked = new Map<State, Set<Element>>()
    /** Shown in the top layer, from the bottom up. */
    #shown: Shown[] = []
    /** What is shown: the materializer's version, the events, the points the pointer was at and pressed. */
    #version = -1
    #focus: FocusEvent | undefined
    #topLayer: TopLayerEvent | undefined
    #hovered: Point | undefined
    #pressed: Point | undefined

    constructor(timeline: Timeline, materializer: Materializer, document: Document, pseudoClasses: PseudoClasses) {
        this.#timeline = timeline
        this.#materializer = materializer
        this.#document = document
        this.#pseudoClasses = pseudoClasses
    }

    /** Shows the states at `time`, after the document shows it. */
    show(time: number, pointer: PointerState | undefined): void {
        const version = this.#materializer.version
        // Changes to the document may have taken the states away, or moved what is under the pointer.
        const changed = version !== this.#version
        this.#version = version
        const timeline = this.#timeline
        // Ids before the last snapshot may stand for other nodes.
        const since = timeline.snapshotBefore(time)
        const topLayer = latest(timeline.topLayer, time, since)
        if (changed || topLayer !== this.#topLayer) {
            this.#topLayer = topLayer
            this.#showTopLayer(topLayer?.entries ?? [])
        }
        const focus = latest(timeline.focus, time, since)
        if (changed || focus !== this.#focus) {
            this.#focus = focus
            this.#showFocus(focus)
        }
        // No rule needs the pointer, mostly, which spares finding what is under it.
        const used = this.#pseudoClasses.used
        const hovered = used.has('hover') ? pointer : undefined
        if (changed || !samePoint(hovered, this.#hovered)) {
            this.#hovered = hovered && { x: hovered.x, y: hovered.y }
            this.#mark('hover', hovered === undefined ? [] : this.#chain(this.#hit(hovered), true))
        }
        // `:active` stays on what the press started on.
        const pressed = used.has('active') ? pointer?.press : undefined
        if (changed || !samePoint(pressed, this.#pressed)) {
            this.#pressed = pressed
            this.#mark('active', pressed === undefined ? [] : this.#chain(this.#hit(pressed), true))
        }
    }

    /** Shows the states anew next time, as when a style sheet that selects them loaded. */
    invalidate(): void {
        this.#version = -1
    }

    #showFocus(event: FocusEvent | undefined): void {
        const node = event === undefined || event.id === 0 ? undefined : this.#materializer.node(event.id)
        const element = node !== undefined && isElement(node) && node.isConnected ? node : undefined
        // Hosts have the focus too when it is inside them, but frames do not, nor what the frames are in.
        const focused: Element[] = []
        for (let current = element ?? null; current !== null; current = this.#outer(current, false)) {
            focused.push(current)
        }
        this.#mark('focus', focused)
        this.#mark('focus-visible', element !== undefined && event?.visible === true ? [element] : [])
        this.#mark('focus-within', element === undefined ? [] : this.#chain(element, false))
    }

    /** Sets the attribute of `state` on `elements`, and only them. */
    #mark(state: State, elements: readonly Element[]): void {
        const old = this.#marked.get(state)
        if (elements.length === 0 && (old === undefined || old.size === 0)) {
            return
        }
        const name = stateAttribute(state)
        const marked = new Set(elements)
        for (const element of old ?? []) {
            if (!marked.has(element)) {
                element.removeAttribute(name)
            }
        }
        // A snapshot built since may have taken it away from elements it kept.
        for (const element of marked) {
            if (!element.hasAttribute(name)) {
                element.setAttribute(name, '')
            }
        }
        this.#marked.set(state, marked)
    }

    /** The element at a point of the viewport, in shadow trees and frames too. */
    #hit(point: Point): Element | null {
        let { x, y } = point
        let element = this.#document.elementFromPoint(x, y)
        for (let depth = 0; element !== null && depth < MAX_DEPTH; depth++) {
            let inner: Element | null = null
            const root = element.shadowRoot
            if (root !== null) {
                inner = root.elementFromPoint(x, y)
            } else if (isFrame(element)) {
                const document = element.contentDocument
                const view = element.ownerDocument.defaultView
                if (document !== null && view !== null) {
                    // The frame's viewport is its content box.
                    const box = element.getBoundingClientRect()
                    const style = view.getComputedStyle(element)
                    x -= box.left + element.clientLeft + Number.parseFloat(style.paddingLeft)
                    y -= box.top + element.clientTop + Number.parseFloat(style.paddingTop)
                    inner = document.elementFromPoint(x, y)
                }
            }
            if (inner === null || inner === element) {
                break
            }
            element = inner
        }
        return element
    }

    /** `element` and the elements it shows in, up to the root element: slots and hosts, and frames if `frames`. */
    #chain(element: Element | null, frames: boolean): Element[] {
        const chain: Element[] = []
        for (let current = element; current !== null; current = current.assignedSlot ?? this.#parent(current, frames)) {
            chain.push(current)
        }
        return chain
    }

    #parent(element: Element, frames: boolean): Element | null {
        const parent = element.parentNode
        return parent !== null && isElement(parent) ? parent : this.#outer(element, frames)
    }

    /** The host of the shadow tree `element` is in, or, if `frames`, the frame of its document. */
    #outer(element: Element, frames: boolean): Element | null {
        const root = element.getRootNode()
        if (isShadowRoot(root)) {
            return root.host
        }
        // The replay's own document is in the player's frame, which is not part of the replay.
        return frames && isDocument(root) && root !== this.#document ? (root.defaultView?.frameElement ?? null) : null
    }

    /** Shows the elements in the top layer, from the bottom up, keeping those shown below the first that is not. */
    #showTopLayer(entries: readonly TopLayerEntry[]): void {
        const wanted: Shown[] = []
        for (const { id, kind } of entries) {
            const node = this.#materializer.node(id)
            if (node !== undefined && isElement(node) && isHtmlElement(node) && node.isConnected) {
                wanted.push({ element: node, kind })
            }
        }
        const shown = this.#shown.filter(({ element }) => inTopLayer(element))
        let kept = 0
        while (kept < shown.length && kept < wanted.length && sameShown(shown[kept]!, wanted[kept]!)) {
            kept++
        }
        for (let i = shown.length - 1; i >= kept; i--) {
            hide(shown[i]!.element)
        }
        for (let i = kept; i < wanted.length; i++) {
            show(wanted[i]!, wanted[i - 1]?.element)
        }
        this.#shown = wanted.filter(({ element }) => inTopLayer(element))
    }
}

/** The last of `entries` at or before `time`, unless it came before the snapshot at `since`. */
function latest<T>(entries: readonly At<T>[], time: number, since: number): T | undefined {
    let low = 0
    let high = entries.length
    while (low < high) {
        const middle = (low + high) >>> 1
        if (entries[middle]!.time <= time) {
            low = middle + 1
        } else {
            high = middle
        }
    }
    const entry = entries[low - 1]
    return entry !== undefined && entry.time >= since ? entry.event : undefined
}

function samePoint(a: Point | undefined, b: Point | undefined): boolean {
    return a === b || (a !== undefined && b !== undefined && a.x === b.x && a.y === b.y)
}

function sameShown(a: Shown, b: Shown): boolean {
    return a.element === b.element && a.kind === b.kind
}

function isHtmlElement(element: Element): element is HTMLElement {
    return element.namespaceURI === HTML_NAMESPACE
}

function inTopLayer(element: Element): boolean {
    return matches(element, ':modal') || matches(element, ':popover-open')
}

/** Whether `element` matches `selector`: false for one this browser does not know. */
function matches(element: Element, selector: string): boolean {
    try {
        return element.matches(selector)
    } catch {
        return false
    }
}

/**
 * Puts an element in the top layer. Recorded attributes stay as they were: a modal dialog's `open` attribute can
 * go, and it stays modal. Showing would move the focus to it, out of the viewer's page, but an inert element takes
 * none.
 */
function show({ element, kind }: Shown, below: Element | undefined): void {
    const inert = element.hasAttribute('inert')
    element.inert = true
    try {
        if (kind === TopLayerKind.Modal && isDialog(element)) {
            const open = element.hasAttribute('open')
            // An open dialog cannot be shown as modal.
            element.removeAttribute('open')
            element.showModal()
            if (!open) {
                element.removeAttribute('open')
            }
        } else if (kind === TopLayerKind.Popover) {
            // Showing a popover hides others but those it was shown from, which its invoker tells.
            const source = invoker(element, below)
            element.showPopover(source === undefined ? undefined : { source })
        }
    } catch {
        // Not in a state to be shown, such as a popover whose `popover` attribute is gone.
    } finally {
        if (!inert) {
            element.inert = false
        }
    }
}

function hide(element: HTMLElement): void {
    try {
        if (matches(element, ':popover-open')) {
            element.hidePopover()
        } else if (isDialog(element)) {
            // A dialog without the attribute does not close, though modal.
            const open = element.hasAttribute('open')
            element.setAttribute('open', '')
            element.close()
            if (open) {
                element.setAttribute('open', '')
            }
        }
    } catch {
        // Gone from the top layer meanwhile.
    }
}

/** An element that names `popover` as what it shows, preferably one in the element shown below it. */
function invoker(popover: HTMLElement, below: Element | undefined): HTMLElement | undefined {
    const root = popover.getRootNode()
    const id = popover.id
    if (id === '' || !(isDocument(root) || isShadowRoot(root))) {
        return undefined
    }
    const value = CSS.escape(id)
    let found: HTMLElement | undefined
    for (const element of root.querySelectorAll(`[popovertarget="${value}"], [commandfor="${value}"]`)) {
        if (isHtmlElement(element)) {
            if (below?.contains(element) === true) {
                return element
            }
            found ??= element
        }
    }
    return found
}
