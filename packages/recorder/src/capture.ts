import {
    ByteWriter,
    encodeNavigation,
    encodeViewport,
    EventType,
    EventWriter,
    PointerAction,
    Track
} from '@timecat-js/protocol'
import type { EventSink } from './batch.ts'
import {
    HTML_NAMESPACE,
    isForm,
    isInput,
    isNode,
    isOptGroup,
    isOption,
    isPointerEvent,
    isSelect,
    isTextArea
} from './dom.ts'
import { NodeIds } from './ids.ts'
import { hookFormSetters, InputRecorder } from './inputs.ts'
import { MutationBuffer, MutationWriter } from './mutations.ts'
import { MAX_MOVES_SPAN, PointerRecorder, pointerTypeOf } from './pointer.ts'
import { Privacy, TextMask } from './privacy.ts'
import type { PrivacyOptions } from './privacy.ts'
import { ScrollRecorder } from './scroll.ts'
import { TreeWriter } from './tree.ts'

export interface CaptureOptions extends PrivacyOptions {
    window: Window
    sink: EventSink
    /** Recording time: whole milliseconds since recording started. */
    now: () => number
    /** Longest time slice of the snapshot, in milliseconds. */
    sliceMs: number
    /** Nodes the snapshot writes between looks at the clock. */
    checkEvery: number
    /** Lets the page run between snapshot slices. */
    yieldToPage: () => Promise<void>
    /** Runs `flush` soon. Returns a function that cancels it. */
    scheduleFlush: (flush: () => void) => () => void
    /** The page is being hidden and may not come back: what was recorded should be stored now. */
    onHidden: () => void
    onError: (error: unknown) => void
}

const WINDOW_EVENTS = [
    'input',
    'change',
    'reset',
    'pointermove',
    'pointerdown',
    'pointerup',
    'pointercancel',
    'scroll',
    'resize',
    'popstate',
    'hashchange',
    'pagehide',
    'visibilitychange'
]

/** Initial capacity of the snapshot buffer, which every time slice reuses. */
const SNAPSHOT_BUFFER = 64 * 1024

/**
 * Captures one document: a time-sliced snapshot first, then everything that changes, written as events once the
 * task or the animation frame that changed it ends. The mutation observer is attached before the snapshot, which
 * uses the records as its guard (see `SnapshotGuard`); the changes the snapshot misses follow it as a Mutations
 * event of the same time.
 */
export class Capture implements EventListenerObject {
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
    readonly #observer: MutationObserver
    readonly #listeners = new AbortController()
    #unhook: () => void = noop
    /** Flushes wait while the snapshot runs: the ids they would refer to are still being assigned. */
    #snapshotting = true
    #stopped = false
    #cancelFlush: (() => void) | undefined
    #movesTimer: number | undefined
    #url = ''
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
        this.#mutations = new MutationWriter(this.#ids, this.#privacy)
        this.#inputs = new InputRecorder(this.#ids, this.#privacy)
        this.#pointer = new PointerRecorder(options.sink)
        this.#scroll = new ScrollRecorder(this.#ids, options.window)
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
        const window = this.#window
        this.#observer.observe(this.#document, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
        })
        const options: AddEventListenerOptions = { capture: true, passive: true, signal: this.#listeners.signal }
        for (const type of WINDOW_EVENTS) {
            window.addEventListener(type, this, options)
        }
        // Same-document navigations by the History API fire no window event; the Navigation API reports them.
        if ('navigation' in window) {
            window.navigation.addEventListener('currententrychange', this, options)
        }
        this.#unhook = hookFormSetters(this.#document, this.#onFormSet)
        return this.#snapshot().catch((error: unknown) => {
            this.#options.onError(error)
            this.stop()
        })
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

    /** Writes the last changes and detaches from the page. */
    stop(): void {
        if (this.#stopped) {
            return
        }
        this.flush(true)
        this.#stopped = true
        this.#observer.disconnect()
        this.#listeners.abort()
        this.#unhook()
        this.#cancelFlush?.()
        this.#cancelFlush = undefined
        clearTimeout(this.#movesTimer)
    }

    handleEvent(event: Event): void {
        if (this.#stopped) {
            return
        }
        const target = event.target
        // popstate, hashchange and currententrychange only request a flush, which compares the URL.
        switch (event.type) {
            case 'pointermove':
                if (isPointerEvent(event) && event.isPrimary) {
                    this.#pointer.move(
                        this.#options.now(),
                        pointerTypeOf(event),
                        Math.round(event.clientX),
                        Math.round(event.clientY)
                    )
                    this.#awaitMoves()
                }
                // Moves need no flush until they span long enough to be written: a timer covers them, so a moving
                // pointer costs no task per move.
                return
            case 'pointerdown':
            case 'pointerup':
            case 'pointercancel':
                if (isPointerEvent(event) && event.isPrimary) {
                    this.#pointer.button(
                        this.#options.now(),
                        event.type === 'pointerdown' ? PointerAction.Down : PointerAction.Up,
                        pointerTypeOf(event),
                        Math.min(Math.max(event.button, 0), 255),
                        Math.round(event.clientX),
                        Math.round(event.clientY),
                        isNode(target) ? (this.#ids.get(target) ?? 0) : 0
                    )
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
                if (isNode(target)) {
                    this.#scroll.mark(target)
                }
                break
            case 'resize':
                this.#viewportChanged = true
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

    async #snapshot(): Promise<void> {
        const document = this.#document
        const { sink, sliceMs, checkEvery } = this.#options
        const writer = new EventWriter(new ByteWriter(SNAPSHOT_BUFFER))
        const tree = new TreeWriter(writer, this.#ids, this.#privacy, this.#buffer, true)
        this.#url = document.URL
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
        this.#scroll.mark(document)
        for (const element of tree.scrolled) {
            this.#scroll.mark(element)
        }
        this.#snapshotting = false
        this.#write(time, false)
    }

    #write(time: number, force: boolean): void {
        const sink = this.#sink
        try {
            const buffer = this.#buffer
            buffer.push(this.#observer.takeRecords())
            if (!buffer.isEmpty) {
                try {
                    this.#markControls(buffer)
                    const body = this.#mutations.write(buffer)
                    if (body !== undefined) {
                        sink.event(Track.Dom, EventType.Mutations, time, body)
                    }
                    this.#inputs.added(this.#mutations.controls)
                } finally {
                    buffer.clear()
                }
            }
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
            const document = this.#document
            const url = document.URL
            const id = this.#ids.get(document)
            if (url !== this.#url && id !== undefined) {
                this.#url = url
                sink.event(Track.Navigation, EventType.Navigation, time, encodeNavigation({ id, url }))
            }
            sink.commit()
        } catch (error) {
            this.#options.onError(error)
        }
        this.#awaitMoves()
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
     * this way.
     */
    #markControls(buffer: MutationBuffer): void {
        const inputs = this.#inputs
        for (const parent of buffer.parents) {
            if (isSelect(parent) || isOptGroup(parent) || isTextArea(parent)) {
                inputs.invalidate(parent)
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
            if (parent !== null && isTextArea(parent)) {
                inputs.invalidate(parent)
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

    readonly #onFormSet = (node: Node): void => {
        // The hooked setters serve every document of their realm.
        if (!this.#stopped && node.ownerDocument === this.#document) {
            this.#inputs.mark(node)
            this.#requestFlush()
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

function noop(): void {}
