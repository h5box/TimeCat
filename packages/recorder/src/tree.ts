import type { EventWriter } from '@timecat-js/protocol'
import {
    HTML_NAMESPACE,
    isComment,
    isDoctype,
    isDocument,
    isElement,
    isFormControl,
    isFrame,
    isInput,
    isShadowRoot,
    isText,
    recordsChildren
} from './dom.ts'
import type { FormControl } from './dom.ts'
import type { NodeIds } from './ids.ts'
import { applyTextMask, BLOCKED_ATTRIBUTE, maskValue, TextMask } from './privacy.ts'
import type { Privacy } from './privacy.ts'

/** A shadow root, or the document a frame shows. */
export type InnerRoot = ShadowRoot | Document

/**
 * What the recording covers besides the tree of the recorded document: shadow trees, the documents of
 * same-origin frames, and theirs in turn.
 */
export interface Scope {
    /** The shadow root of `host`, or null. Closed ones too, when they were attached while recording. */
    shadowRoot(host: Element): ShadowRoot | null
    /** The document `frame` shows, or null when it shows none the recording can read. */
    frameDocument(frame: HTMLIFrameElement | HTMLFrameElement): Document | null
    /** Called once `root` is written, so its changes are recorded from then on. */
    enter(root: InnerRoot): void
    /** Whether `node` is part of the page: in its tree, in a shadow tree of it, or in the document of a frame. */
    contains(node: Node): boolean
    /** The parent of `node`, or for a shadow root its host, for a frame's document the frame. */
    parent(node: Node): Node | null
}

/**
 * Lets a snapshot keep its place while the page changes between time slices. Fed by the mutation observer,
 * which is attached before the snapshot starts.
 */
export interface SnapshotGuard {
    /** Changes whenever child lists changed, so open frames re-check their cursor. */
    readonly generation: number
    /** Nodes removed from a parent since the snapshot started, including moved nodes. */
    readonly removed: ReadonlySet<Node>
    /** Nodes inserted since the snapshot started, including moved nodes. */
    readonly added: ReadonlySet<Node>
}

interface Frame {
    parent: Node
    /** Next child to visit. */
    next: Node | null
    /** Namespace of `parent`, which children without their own inherit. */
    namespace: string
    /** Mask of the text directly below `parent`. */
    mask: TextMask
    /** Guard generation the cursor was last checked at. */
    checked: number
}

/**
 * Writes DOM subtrees as TCR node tokens, assigning ids in the order nodes are written. Iterative, so any
 * depth works, and resumable, so a snapshot can be split into time slices.
 *
 * With a guard (snapshots), the writer only visits nodes that were in place when recording started and have not
 * moved since: inserted and moved nodes are skipped, because the mutations that follow the snapshot add them.
 * Changes inside already written parts reach the recording the same way, as those mutations. Shadow trees and
 * frame documents are observed from the time they are written, so for them, "since" starts there.
 */
export class TreeWriter {
    /** Form controls written, whose current state the input track adds. The caller empties it. */
    readonly controls: FormControl[] = []
    /** Elements written with a scroll offset, when reading them was requested. The caller empties it. */
    readonly scrolled: Element[] = []
    /**
     * Whether to look for scrolled elements, which takes layout. Elements a page inserts are not scrolled yet,
     * unlike those of a snapshot, or of a document that loaded into a frame.
     */
    readScroll: boolean

    readonly #writer: EventWriter
    readonly #ids: NodeIds
    readonly #privacy: Privacy
    readonly #scope: Scope
    readonly #guard: SnapshotGuard | undefined
    readonly #frames: Frame[] = []

    constructor(
        writer: EventWriter,
        ids: NodeIds,
        privacy: Privacy,
        scope: Scope,
        guard?: SnapshotGuard,
        readScroll = false
    ) {
        this.#writer = writer
        this.#ids = ids
        this.#privacy = privacy
        this.#scope = scope
        this.#guard = guard
        this.readScroll = readScroll
    }

    /**
     * Writes `node` and opens its subtree for `run`. `mask` is the mask of the text around the node. Returns
     * false, writing nothing, when the node is of a kind that is not recorded.
     */
    begin(node: Node, parentNamespace: string, mask: TextMask): boolean {
        return this.#visit(node, parentNamespace, mask)
    }

    /**
     * Writes the open subtree. `shouldYield` is asked every `checkEvery` steps, never before the first, so that
     * every call gets on; once it returns true, the walk stops and returns false, and the next call continues
     * it. Returns true when the subtree is complete.
     */
    run(shouldYield?: () => boolean, checkEvery = 64): boolean {
        const frames = this.#frames
        const guard = this.#guard
        const ids = this.#ids
        let count = 0
        while (frames.length > 0) {
            if (shouldYield !== undefined && count >= checkEvery) {
                count = 0
                if (shouldYield()) {
                    return false
                }
            }
            count++
            const frame = frames[frames.length - 1]!
            if (guard !== undefined && frame.checked !== guard.generation) {
                this.#check(frame, guard)
            }
            const child = frame.next
            if (child === null) {
                this.#writer.end()
                frames.pop()
                continue
            }
            frame.next = child.nextSibling
            if (guard !== undefined && (ids.has(child) || guard.added.has(child))) {
                continue
            }
            this.#visit(child, frame.namespace, frame.mask)
        }
        return true
    }

    /** Re-validates a frame's cursor after child lists changed during a pause. */
    #check(frame: Frame, guard: SnapshotGuard): void {
        frame.checked = guard.generation
        if (guard.removed.has(frame.parent)) {
            // The parent left its place; the mutations after the snapshot remove it, or insert it anew.
            frame.next = null
            return
        }
        const next = frame.next
        if (next === null || (next.parentNode === frame.parent && !guard.removed.has(next))) {
            return
        }
        // The cursor node moved. The children still to visit are the ones that never moved and have no id yet,
        // which keep their order; scanning from the start finds the first of them.
        let child = frame.parent.firstChild
        while (child !== null && (this.#ids.has(child) || guard.added.has(child))) {
            child = child.nextSibling
        }
        frame.next = child
    }

    #visit(node: Node, parentNamespace: string, mask: TextMask): boolean {
        const writer = this.#writer
        if (isElement(node)) {
            this.#element(node, parentNamespace, mask)
        } else if (isText(node)) {
            this.#ids.assign(node)
            writer.text(mask === TextMask.None ? node.data : applyTextMask(mask, node.data))
        } else if (isComment(node)) {
            this.#ids.assign(node)
            writer.comment(mask === TextMask.None ? node.data : applyTextMask(mask, node.data))
        } else if (isDoctype(node)) {
            this.#ids.assign(node)
            writer.doctype(node.name, node.publicId, node.systemId)
        } else if (isDocument(node) || isShadowRoot(node)) {
            this.#inner(node, mask)
        } else {
            return false
        }
        return true
    }

    /** Writes a shadow root or a frame's document, whose text has the mask `mask`, and opens its children. */
    #inner(root: InnerRoot, mask: TextMask): void {
        this.#ids.assign(root)
        const first = root.firstChild
        if (isDocument(root)) {
            this.#writer.document(root.URL, root.compatMode === 'BackCompat', first !== null)
        } else {
            this.#writer.shadowRoot(root.mode === 'closed', first !== null)
        }
        this.#scope.enter(root)
        if (first !== null) {
            this.#push(root, first, HTML_NAMESPACE, mask)
        }
    }

    /** The shadow root or document shown inside `element`, if it is to be written with the element. */
    #innerOf(element: Element): InnerRoot | null {
        const scope = this.#scope
        const inner = scope.shadowRoot(element) ?? (isFrame(element) ? scope.frameDocument(element) : null)
        // A snapshot leaves roots that came after it started to the mutations that follow, as it does nodes.
        return inner === null || this.#guard?.added.has(inner) === true ? null : inner
    }

    #element(element: Element, parentNamespace: string, parentMask: TextMask): void {
        this.#ids.assign(element)
        const writer = this.#writer
        const privacy = this.#privacy
        const tag = element.localName
        const namespace = element.namespaceURI ?? ''
        const ownNamespace = namespace === parentNamespace ? undefined : namespace
        if (privacy.blocks(element)) {
            const { width, height } = element.getBoundingClientRect()
            const className = element.getAttribute('class')
            writer.element(tag, ownNamespace, className === null ? 2 : 3, false)
            writer.attribute(BLOCKED_ATTRIBUTE, '')
            writer.attribute('style', `width:${Math.round(width)}px;height:${Math.round(height)}px`)
            if (className !== null) {
                writer.attribute('class', className)
            }
            return
        }
        const control = isFormControl(element) ? element : undefined
        const masksValue = control !== undefined && isInput(control) && privacy.masksValue(control)
        const attributes = element.attributes
        const count = attributes.length
        const records = recordsChildren(element)
        const first = records ? element.firstChild : null
        const inner = records ? this.#innerOf(element) : null
        writer.element(tag, ownNamespace, count, first !== null || inner !== null)
        for (let i = 0; i < count; i++) {
            const attribute = attributes[i]!
            const name = attribute.name
            writer.attribute(name, masksValue && name === 'value' ? maskValue(attribute.value) : attribute.value)
        }
        if (control !== undefined) {
            this.controls.push(control)
        }
        if (this.readScroll && (element.scrollTop !== 0 || element.scrollLeft !== 0)) {
            this.scrolled.push(element)
        }
        if (first !== null || inner !== null) {
            const mask = privacy.textMaskBelow(element, parentMask)
            // The inner root comes first: its frame goes on top, and the element's own children follow it.
            this.#push(element, first, namespace, mask)
            if (inner !== null) {
                this.#inner(inner, mask)
            }
        }
    }

    #push(parent: Node, first: Node | null, namespace: string, mask: TextMask): void {
        this.#frames.push({ parent, next: first, namespace, mask, checked: this.#guard?.generation ?? 0 })
    }
}
