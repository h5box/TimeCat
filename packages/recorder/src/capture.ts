import {
    ByteWriter,
    encodeNavigation,
    encodeViewport,
    EventType,
    EventWriter,
    PointerAction,
    Track
} from '@timecat-js/protocol'
import { AssetRecorder } from './assets.ts'
import type { EventSink } from './batch.ts'
import {
    containerOf,
    HTML_NAMESPACE,
    isDocument,
    isForm,
    isFrame,
    isInput,
    isNode,
    isOptGroup,
    isOption,
    isPointerEvent,
    isSelect,
    isStyle,
    isTextArea
} from './dom.ts'
import { FontRecorder } from './fonts.ts'
import { NodeIds } from './ids.ts'
import { InputRecorder } from './inputs.ts'
import { MutationBuffer, MutationWriter } from './mutations.ts'
import { MAX_MOVES_SPAN, PointerRecorder, pointerTypeOf } from './pointer.ts'
import { Privacy, TextMask } from './privacy.ts'
import type { PrivacyOptions } from './privacy.ts'
import { RealmHooker } from './realm.ts'
import type { RealmHooks } from './realm.ts'
import { ScrollRecorder } from './scroll.ts'
import { SheetRecorder } from './sheets.ts'
import { TreeWriter } from './tree.ts'
import type { InnerRoot, Scope } from './tree.ts'

export interface CaptureOptions extends PrivacyOptions {
    window: Window
    sink: EventSink
    /** Recording time: whole milliseconds since recording started. */
    now: () => number
    /** Longest time slice of the snapshot, in milliseconds. */
    sliceMs: number
    /** Nodes the snapshot writes between looks at the clock. */
    checkEvery: number
    /** Bytes of `blob:` content and font data recorded, all together. */
    assetBudget: number
    /** Lets the page run between snapshot slices. */
    yieldToPage: () => Promise<void>
    /** Runs `flush` soon. Returns a function that cancels it. */
    scheduleFlush: (flush: () => void) => () => void
    /** The page is being hidden and may not come back: what was recorded should be stored now. */
    onHidden: () => void
    onError: (error: unknown) => void
}

const OBSERVE: MutationObserverInit = { childList: true, subtree: true, attributes: true, characterData: true }

/** Events of the frames' windows. */
const FRAME_EVENTS = [
    'input',
    'change',
    'reset',
    'pointermove',
    'pointerdown',
    'pointerup',
    'pointercancel',
    'scroll',
    'popstate',
    'hashchange',
    'DOMContentLoaded'
]

/** Events of the page's window, whose size and visibility frames share. */
const WINDOW_EVENTS = [...FRAME_EVENTS, 'resize', 'pagehide', 'visibilitychange']

/**
 * Events in a shadow tree that its window does not see: they do not leave the tree, or are seen there with the
 * host as their target, as `input` is.
 */
const SHADOW_EVENTS = ['input', 'change', 'reset', 'scroll']

const ORIGIN = [0, 0] as const

/** Initial capacity of the snapshot buffer, which every time slice reuses. */
const SNAPSHOT_BUFFER = 64 * 1024

/**
 * Captures one document: a time-sliced snapshot first, then everything that changes, written as events once the
 * task or the animation frame that changed it ends. The mutation observer is attached before the snapshot, which
 * uses the records as its guard (see `SnapshotGuard`); the changes the snapshot misses follow it as a Mutations
 * event of the same time.
 *
 * The capture covers shadow trees and the documents of same-origin frames as part of the document (it is the
 * `Scope` of the writers): each is observed and listened to from the time it is written.
 */
export class Capture implements EventListenerObject, Scope {
    readonly #options: CaptureOptions
    readonly #window: Window
    readonly #document: Document
    readonly #sink: EventSink
    readonly #ids = new NodeIds()
    readonly #privacy: Privacy
    readonly #buffer = new MutationBuffer()
    readonly #mutations: MutationWriter
    readonly #inputs: InputRecorder
    readonly #pointer: PointerRecorder
    readonly #scroll: ScrollRecorder
    readonly #sheets: SheetRecorder
    readonly #fonts: FontRecorder
    readonly #assets: AssetRecorder
    readonly #observer: MutationObserver
    readonly #listeners = new AbortController()
    readonly #listenerOptions: AddEventListenerOptions = {
        capture: true,
        passive: true,
        signal: this.#listeners.signal
    }
    #realms: RealmHooker | undefined
    /** Documents and shadow roots that are observed and listened to. */
    readonly #watched = new WeakSet<Node>()
    /** Closed shadow roots attached while recording, by host; open ones are found through their host. */
    readonly #closedRoots = new WeakMap<Element, ShadowRoot>()
    /** Frames written, with the document written as their content, or null for none. */
    readonly #frames = new Map<HTMLIFrameElement | HTMLFrameElement, Document | null>()
    /** URL last recorded of each document. */
    readonly #urls = new Map<Document, string>()
    /** The mode each document was written in, which `document.open()` sets anew. */
    readonly #modes = new WeakMap<Document, string>()
    /** Where the viewports of frames' documents are in the page's viewport, until the layout may change. */
    readonly #offsets = new Map<Document, readonly [x: number, y: number] | null>()
    /** `<style>` elements written or whose text changed in a flush, whose sheets are new. */
    readonly #styles = new Set<HTMLStyleElement | SVGStyleElement>()
    /** Flushes wait while the snapshot runs: the ids they would refer to are still being assigned. */
    #snapshotting = true
    #stopped = false
    #cancelFlush: (() => void) | undefined
    #movesTimer: number | undefined
    #viewportChanged = true
    #width = -1
    #height = -1

    /** Throws a `SyntaxError` when a privacy selector is invalid. */
    constructor(options: CaptureOptions) {
        this.#options = options
        this.#window = options.window
        this.#document = options.window.document
        this.#sink = options.sink
        this.#privacy = new Privacy(options, this.#document)
        this.#mutations = new MutationWriter(this.#ids, this.#privacy, this)
        this.#inputs = new InputRecorder(this.#ids, this.#privacy, this)
        this.#pointer = new PointerRecorder(options.sink)
        this.#scroll = new ScrollRecorder(this.#ids, this)
        this.#sheets = new SheetRecorder(this.#ids, this)
        this.#assets = new AssetRecorder({ sink: options.sink, now: options.now, budget: options.assetBudget })
        this.#fonts = new FontRecorder(this.#assets)
        this.#observer = new MutationObserver(records => {
            this.#buffer.push(records)
            this.#requestFlush()
        })
    }

    /**
     * Starts capturing. The first snapshot slice runs before this returns; the promise settles once the snapshot
     * is written. If the snapshot fails, the error is reported and capturing stops.
     */
    start(): Promise<void> {
        this.#realms = new RealmHooker(this.#hooks)
        this.enter(this.#document)
        return this.#snapshot().catch((error: unknown) => {
            this.#options.onError(error)
            this.stop()
        })
    }

    shadowRoot(host: Element): ShadowRoot | null {
        return host.shadowRoot ?? this.#closedRoots.get(host) ?? null
    }

    frameDocument(frame: HTMLIFrameElement | HTMLFrameElement): Document | null {
        if (!this.#frames.has(frame)) {
            // A frame loads its documents after it is inserted; each load may bring a new one.
            frame.addEventListener('load', this, this.#listenerOptions)
        }
        const document = frame.contentDocument
        this.#frames.set(frame, document)
        return document
    }

    enter(root: InnerRoot): void {
        if (isDocument(root)) {
            this.#urls.set(root, root.URL)
            this.#modes.set(root, root.compatMode)
            // A document can be scrolled by the time it is written.
            this.#scroll.mark(root)
        }
        this.#sheets.entered(root)
        if (this.#watched.has(root)) {
            return
        }
        this.#watched.add(root)
        this.#observer.observe(root, OBSERVE)
        if (isDocument(root)) {
            this.#listenToWindow(root)
            this.#fonts.watch(root)
        } else {
            this.#listen(root, SHADOW_EVENTS)
        }
    }

    contains(node: Node): boolean {
        if (!node.isConnected) {
            return false
        }
        const document = isDocument(node) ? node : node.ownerDocument
        if (document === this.#document) {
            return true
        }
        // A frame's document is part of the page while the frame shows it, and the frame is part of the page.
        const frame = document?.defaultView?.frameElement ?? null
        return frame !== null && isFrame(frame) && frame.contentDocument === document && this.contains(frame)
    }

    parent(node: Node): Node | null {
        return node.parentNode ?? containerOf(node, this.#document)
    }

    /** Writes what changed since the last flush. `force` also writes the pointer moves collected so far. */
    flush(force = false): void {
        if (this.#snapshotting || this.#stopped) {
            return
        }
        this.#cancelFlush?.()
        this.#cancelFlush = undefined
        this.#write(this.#options.now(), force)
    }

    /** Settles once the `blob:` content met so far is recorded. */
    settled(): Promise<void> {
        return this.#assets.settled()
    }

    /** Writes the last changes and detaches from the page. */
    stop(): void {
        if (this.#stopped) {
            return
        }
        this.flush(true)
        this.#stopped = true
        this.#observer.disconnect()
        this.#listeners.abort()
        this.#realms?.unhook()
        this.#assets.stop()
        this.#cancelFlush?.()
        this.#cancelFlush = undefined
        clearTimeout(this.#movesTimer)
        this.#frames.clear()
        this.#urls.clear()
        this.#offsets.clear()
    }

    handleEvent(event: Event): void {
        if (this.#stopped) {
            return
        }
        const target = event.target
        // popstate, hashchange and currententrychange only request a flush, which compares the URLs; load, of a
        // frame, does too, which looks for new documents.
        switch (event.type) {
            case 'pointermove':
                if (isPointerEvent(event) && event.isPrimary) {
                    this.#pointerMove(event)
                }
                // Moves need no flush until they span long enough to be written: a timer covers them, so a moving
                // pointer costs no task per move.
                return
            case 'pointerdown':
            case 'pointerup':
            case 'pointercancel':
                if (isPointerEvent(event) && event.isPrimary) {
                    this.#pointerButton(event)
                }
                break
            case 'input':
            case 'change':
                if (isNode(target)) {
                    this.#inputs.mark(target)
                }
                break
            case 'reset':
                if (isNode(target) && isForm(target)) {
                    for (const element of target.elements) {
                        this.#inputs.mark(element)
                    }
                }
                break
            case 'scroll':
                // Frames may have moved in the viewport.
                this.#offsets.clear()
                if (isNode(target)) {
                    this.#scroll.mark(target)
                }
                break
            case 'resize':
                this.#offsets.clear()
                this.#viewportChanged = true
                break
            case 'DOMContentLoaded':
                if (isNode(target) && isDocument(target)) {
                    this.#findDeclarativeRoots(target)
                }
                break
            case 'pagehide':
                this.#hide()
                return
            case 'visibilitychange':
                if (this.#document.visibilityState === 'hidden') {
                    this.#hide()
                }
                return
        }
        this.#requestFlush()
    }

    #pointerMove(event: PointerEvent): void {
        const offset = this.#offsetOf(event.target)
        if (offset !== null) {
            this.#pointer.move(
                this.#options.now(),
                pointerTypeOf(event),
                Math.round(event.clientX + offset[0]),
                Math.round(event.clientY + offset[1])
            )
            this.#awaitMoves()
        }
    }

    #pointerButton(event: PointerEvent): void {
        const offset = this.#offsetOf(event.target)
        if (offset === null) {
            return
        }
        // The target in a shadow tree, where the window sees the host.
        const target = event.composedPath()[0] ?? event.target
        this.#pointer.button(
            this.#options.now(),
            event.type === 'pointerdown' ? PointerAction.Down : PointerAction.Up,
            pointerTypeOf(event),
            Math.min(Math.max(event.button, 0), 255),
            Math.round(event.clientX + offset[0]),
            Math.round(event.clientY + offset[1]),
            isNode(target) ? (this.#ids.get(target) ?? 0) : 0
        )
    }

    async #snapshot(): Promise<void> {
        const document = this.#document
        const { sink, sliceMs, checkEvery } = this.#options
        const writer = new EventWriter(new ByteWriter(SNAPSHOT_BUFFER))
        const tree = new TreeWriter(writer, this.#ids, this.#privacy, this, this.#buffer, true)
        writer.snapshotHeader()
        tree.begin(document, HTML_NAMESPACE, TextMask.None)
        let deadline = performance.now() + sliceMs
        const shouldYield = (): boolean => performance.now() >= deadline
        while (!tree.run(shouldYield, checkEvery)) {
            sink.part(Track.Dom, writer.take())
            sink.commit()
            // oxlint-disable-next-line no-await-in-loop -- each slice must wait for the page's turn
            await this.#options.yieldToPage()
            if (this.#stopped) {
                return
            }
            // Records of changes made right before this continuation may not have been delivered yet.
            this.#buffer.push(this.#observer.takeRecords())
            deadline = performance.now() + sliceMs
        }
        const time = this.#options.now()
        sink.event(Track.Dom, EventType.Snapshot, time, writer.take())
        this.#inputs.added(tree.controls)
        for (const element of tree.scrolled) {
            this.#scroll.mark(element)
        }
        for (const style of tree.styles) {
            this.#styles.add(style)
        }
        this.#assets.request(tree.urls)
        this.#snapshotting = false
        this.#write(time, false)
    }

    #write(time: number, force: boolean): void {
        const sink = this.#sink
        try {
            const buffer = this.#buffer
            buffer.push(this.#observer.takeRecords())
            for (const parent of buffer.parents) {
                if (isDocument(parent)) {
                    this.#documentChanged(parent, buffer)
                }
            }
            this.#checkFrames(buffer)
            if (!buffer.isEmpty) {
                try {
                    this.#markControls(buffer)
                    const mutations = this.#mutations
                    const body = mutations.write(buffer)
                    if (body !== undefined) {
                        sink.event(Track.Dom, EventType.Mutations, time, body)
                    }
                    this.#inputs.added(mutations.controls)
                    for (const element of mutations.scrolled) {
                        this.#scroll.mark(element)
                    }
                    for (const style of mutations.styles) {
                        this.#styles.add(style)
                    }
                    this.#assets.request(mutations.urls)
                } finally {
                    buffer.clear()
                }
            }
            this.#writeStyles(time)
            const input = this.#inputs.write()
            if (input !== undefined) {
                sink.event(Track.Input, EventType.Input, time, input)
            }
            this.#pointer.flush(time, force)
            const scroll = this.#scroll.write()
            if (scroll !== undefined) {
                sink.event(Track.Scroll, EventType.Scroll, time, scroll)
            }
            this.#writeViewport(time)
            this.#writeNavigations(time)
            sink.commit()
        } catch (error) {
            this.#options.onError(error)
        }
        // Changes may have moved frames in the viewport.
        this.#offsets.clear()
        this.#awaitMoves()
    }

    /** Writes what script changed of style sheets, and the font faces it added. */
    #writeStyles(time: number): void {
        const sheets = this.#sheets
        const styles = this.#styles
        for (const style of styles) {
            if (this.#ids.has(style) && this.contains(style)) {
                sheets.styleWritten(style)
            }
        }
        styles.clear()
        sheets.write(this.#sink, time)
        const fonts = this.#fonts
        fonts.write(this.#sink, time)
        const assets = this.#assets
        assets.request(sheets.urls)
        assets.request(fonts.urls)
        sheets.urls.length = 0
        fonts.urls.length = 0
        // Every URL written is requested by now, so the blobs of revoked ones can go.
        assets.forget()
    }

    /**
     * Follows a document whose children changed, as they do when `document.open()` starts it anew. That removes
     * every listener of its window, and sets the document's mode anew, which the doctype written next may change
     * again: a frame's document in another mode than recorded is written anew. The page's own mode stays as the
     * snapshot found it.
     */
    #documentChanged(document: Document, buffer: MutationBuffer): void {
        this.#listenToWindow(document)
        if (
            document !== this.#document &&
            document.compatMode !== this.#modes.get(document) &&
            this.contains(document)
        ) {
            // Removing it from the replay writes it again, with all it holds.
            buffer.removed.add(document)
        }
    }

    /**
     * Notes frames that show another document than the one recorded: the replay gets the new one, or loses the
     * old one when the new one cannot be read, as a cross-origin one cannot.
     */
    #checkFrames(buffer: MutationBuffer): void {
        for (const [frame, recorded] of this.#frames) {
            if (!this.contains(frame)) {
                // The frame's removal reaches the replay as a mutation; inserted again, it is written anew.
                this.#frames.delete(frame)
                continue
            }
            const current = frame.contentDocument
            if (current !== recorded) {
                this.#frames.set(frame, current)
                if (current !== null) {
                    buffer.added.add(current)
                } else if (recorded !== null) {
                    buffer.removed.add(recorded)
                }
            }
        }
    }

    /** Writes the same-document navigations of the page and its frames. */
    #writeNavigations(time: number): void {
        for (const [document, url] of this.#urls) {
            if (!this.contains(document)) {
                this.#urls.delete(document)
                continue
            }
            const current = document.URL
            const id = this.#ids.get(document)
            if (current !== url && id !== undefined) {
                this.#urls.set(document, current)
                this.#sink.event(Track.Navigation, EventType.Navigation, time, encodeNavigation({ id, url: current }))
            }
        }
    }

    /**
     * Where the viewport of the document of an event's target is in the page's viewport: frames' viewports are
     * offset by their place. Null when the target is in no document the recording covers.
     */
    #offsetOf(target: EventTarget | null): readonly [x: number, y: number] | null {
        const document = isNode(target) ? (isDocument(target) ? target : target.ownerDocument) : null
        return document === null || document === this.#document ? ORIGIN : this.#frameOffset(document)
    }

    #frameOffset(document: Document): readonly [x: number, y: number] | null {
        let offset = this.#offsets.get(document)
        if (offset !== undefined) {
            return offset
        }
        offset = null
        const frame = document.defaultView?.frameElement ?? null
        if (frame !== null && isFrame(frame) && frame.contentDocument === document) {
            const outer = frame.ownerDocument
            const base = outer === this.#document ? ORIGIN : this.#frameOffset(outer)
            const view = outer.defaultView
            if (base !== null && view !== null) {
                // The viewport is the frame's content box.
                const box = frame.getBoundingClientRect()
                const style = view.getComputedStyle(frame)
                offset = [
                    base[0] + box.left + frame.clientLeft + Number.parseFloat(style.paddingLeft),
                    base[1] + box.top + frame.clientTop + Number.parseFloat(style.paddingTop)
                ]
            }
        }
        this.#offsets.set(document, offset)
        return offset
    }

    /**
     * Finds shadow roots that the parser attached to hosts already written: declarative ones, which no record
     * or hook reports. Only a parser attaches roots this way, so one look once it is done covers them. Closed
     * ones cannot be found.
     */
    #findDeclarativeRoots(root: Document | ShadowRoot): void {
        const ids = this.#ids
        for (const element of root.querySelectorAll('*')) {
            const shadow = element.shadowRoot
            if (shadow !== null && ids.has(element)) {
                if (ids.has(shadow)) {
                    this.#findDeclarativeRoots(shadow)
                } else {
                    this.#buffer.added.add(shadow)
                }
            }
        }
    }

    /** Listens to the window of `document`, and hooks its realm. Adding a listener again adds nothing. */
    #listenToWindow(document: Document): void {
        const view = document.defaultView
        if (view === null) {
            return
        }
        this.#listen(view, view === this.#window ? WINDOW_EVENTS : FRAME_EVENTS)
        // Same-document navigations by the History API fire no window event; the Navigation API reports them.
        if ('navigation' in view) {
            this.#listen(view.navigation, ['currententrychange'])
        }
        this.#realms?.hook(view)
    }

    #listen(target: EventTarget, types: readonly string[]): void {
        for (const type of types) {
            target.addEventListener(type, this, this.#listenerOptions)
        }
    }

    /** Moves are written once they span long enough, which a flush then has to notice. */
    #awaitMoves(): void {
        if (this.#pointer.pending && this.#movesTimer === undefined && !this.#stopped) {
            this.#movesTimer = setTimeout(this.#movesDue, MAX_MOVES_SPAN)
        }
    }

    /**
     * Marks controls whose state may have changed without an event, here or in the replay, which makes the same
     * changes to their markup. Changes to options can change what a `<select>` has selected. Until the user
     * changes a control, or after its form is reset, its value follows its default: the `value` attribute, the
     * `checked` attribute, the text of a `<textarea>`. The replay sets the state of controls it was recorded
     * for, after which it no longer follows the default, so the recording has to say when the state changes
     * this way. It also notes `<style>` elements whose text changed, which makes them a new sheet.
     */
    #markControls(buffer: MutationBuffer): void {
        const inputs = this.#inputs
        const styles = this.#styles
        for (const parent of buffer.parents) {
            if (isSelect(parent) || isOptGroup(parent) || isTextArea(parent)) {
                inputs.invalidate(parent)
            } else if (isStyle(parent)) {
                styles.add(parent)
            }
        }
        for (const [element, names] of buffer.attributes) {
            if (
                isSelect(element) ||
                isOptGroup(element) ||
                isOption(element) ||
                (isInput(element) && (names.has('value') || names.has('checked') || names.has('type')))
            ) {
                inputs.invalidate(element)
            }
        }
        for (const node of buffer.texts) {
            const parent = node.parentNode
            if (parent === null) {
                continue
            }
            if (isTextArea(parent)) {
                inputs.invalidate(parent)
            } else if (isStyle(parent)) {
                styles.add(parent)
            }
        }
    }

    #writeViewport(time: number): void {
        if (!this.#viewportChanged) {
            return
        }
        this.#viewportChanged = false
        const width = this.#window.innerWidth
        const height = this.#window.innerHeight
        if (width !== this.#width || height !== this.#height) {
            this.#width = width
            this.#height = height
            this.#sink.event(Track.Viewport, EventType.Viewport, time, encodeViewport({ width, height }))
        }
    }

    #hide(): void {
        this.flush(true)
        this.#options.onHidden()
    }

    #requestFlush(): void {
        if (this.#cancelFlush === undefined && !this.#stopped) {
            this.#cancelFlush = this.#options.scheduleFlush(this.#scheduledFlush)
        }
    }

    readonly #scheduledFlush = (): void => {
        this.#cancelFlush = undefined
        this.flush()
    }

    readonly #movesDue = (): void => {
        this.#movesTimer = undefined
        this.#requestFlush()
    }

    // The hooks serve everything of their realm, recorded or not.
    readonly #hooks: RealmHooks = {
        formSet: node => {
            if (!this.#stopped && this.contains(node)) {
                this.#inputs.mark(node)
                this.#requestFlush()
            }
        },
        shadowAttached: (host, root) => {
            if (this.#stopped) {
                return
            }
            if (root.mode === 'closed') {
                // The host may be inserted later, and only this hook sees the root.
                this.#closedRoots.set(host, root)
            }
            if (this.contains(host)) {
                this.#buffer.added.add(root)
                this.#requestFlush()
            }
        },
        sheetChanged: (sheet, index, deleted) => {
            if (!this.#stopped) {
                this.#sheets.sheetChanged(sheet, index, deleted)
                this.#requestFlush()
            }
        },
        ruleChanged: rule => {
            if (!this.#stopped) {
                this.#sheets.ruleChanged(rule)
                this.#requestFlush()
            }
        },
        adoptedSheetsUsed: root => {
            if (!this.#stopped && this.#sheets.adoptedSheetsUsed(root)) {
                this.#requestFlush()
            }
        },
        fontFaceCreated: (face, source, base) => {
            if (!this.#stopped) {
                this.#fonts.created(face, source, base)
            }
        },
        fontFaceAdded: (fonts, face) => {
            if (!this.#stopped && this.#fonts.added(fonts, face)) {
                this.#requestFlush()
            }
        },
        objectUrl: (url, object) => {
            if (!this.#stopped) {
                this.#assets.objectUrl(url, object)
            }
        }
    }
}

/**
 * Flushes in a task of its own once the current one ends, and so after the frame when animation frame callbacks
 * made the changes: each frame's changes are written together, and every frame's are. An animation frame
 * requested from those callbacks would come a frame late, with the next frame's changes. A message task also
 * needs no rendering, and runs in background tabs, where frames stop and timers are throttled.
 */
export function afterTask(flush: () => void): () => void {
    let cancelled = false
    nextTask(() => {
        if (!cancelled) {
            flush()
        }
    })
    return () => {
        cancelled = true
    }
}

/** Yields with `scheduler.yield()`, whose continuation runs before other queued tasks, or a message task. */
export function yieldToPage(): Promise<void> {
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        return scheduler.yield()
    }
    return new Promise(nextTask)
}

function nextTask(run: () => void): void {
    const { port1, port2 } = new MessageChannel()
    port1.addEventListener('message', () => {
        // Open ports with a listener are never collected.
        port1.close()
        run()
    })
    port1.start()
    port2.postMessage(null)
}
