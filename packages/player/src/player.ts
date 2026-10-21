import { createPlayer } from '@timecat-js/player-core'
import type { Player, RecordingSource } from '@timecat-js/player-core'
import { html, LitElement, nothing, svg } from 'lit'
import type { CSSResultGroup, PropertyDeclarations, PropertyValues, SVGTemplateResult, TemplateResult } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { guard } from 'lit/directives/guard.js'
import { styleMap } from 'lit/directives/style-map.js'
import { fromBase64, RECORDING_TYPE } from './embed.ts'
import { countUntil, formatTime, markersOf, toEntry } from './format.ts'
import type { Entry, Kind } from './format.ts'
import { styles } from './styles.ts'

type Status = 'empty' | 'loading' | 'ready' | 'error'
type Filter = 'all' | Kind

const SPEEDS = [0.5, 1, 2, 4, 8]
const FILTERS: readonly { readonly filter: Filter; readonly label: string }[] = [
    { filter: 'all', label: 'All' },
    { filter: 'console', label: 'Console' },
    { filter: 'network', label: 'Network' },
    { filter: 'perf', label: 'Perf' },
    { filter: 'custom', label: 'Custom' }
]
/** How far the arrow keys move. */
const STEP = 5000
const PLAYER_EVENTS = ['play', 'pause', 'ended', 'timeupdate']

const ICONS = {
    play: svg`<path d="M8 5v14l11-7z"/>`,
    pause: svg`<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>`,
    list: svg`<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z"/>`,
    expand: svg`<path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/>`,
    shrink: svg`<path d="M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z"/>`
}

/**
 * `<timecat-player>`: plays a recording, with controls, a timeline that marks errors and the events of the
 * application, and a panel listing what was recorded beside the page. The recording comes from the `recording`
 * property, the `src` attribute or `<script type="application/x-timecat-recording">` children holding its
 * segments in base64, in that order. Dispatches `load` once a recording is shown, `error` when one cannot be,
 * and `play`, `pause`, `ended` and `timeupdate` as the player does.
 */
export class TimecatPlayer extends LitElement {
    static override properties: PropertyDeclarations = {
        src: { type: String },
        recording: { attribute: false },
        autoplay: { type: Boolean },
        speed: { type: Number },
        worker: { attribute: false },
        panel: { type: Boolean, reflect: true }
    }

    static override styles: CSSResultGroup = styles

    /** URL of the recording, or URLs of its segments, separated by spaces. */
    declare src: string | null
    /** The recording, which takes the place of `src`: one segment or all of a session, as `createPlayer` takes. */
    declare recording: RecordingSource | readonly RecordingSource[] | undefined
    /** Starts playing once loaded. */
    declare autoplay: boolean
    /** Playback rate; 1 is real time. */
    declare speed: number
    /** Where the recording is indexed, as `createPlayer`'s `worker` option. */
    declare worker: boolean | string | URL
    /** Shows the panel of events recorded beside the page. */
    declare panel: boolean

    #player: Player | undefined
    #status: Status = 'empty'
    #error = ''
    /** Counts loads, so a load that another replaced leaves no trace. */
    #generation = 0
    #playOnLoad = false
    #entries: readonly Entry[] = []
    #counts = new Map<Filter, number>()
    #filter: Filter = 'all'
    #search = ''
    #view: { entries: readonly Entry[]; filter: Filter; search: string; shown: readonly Entry[] } | undefined
    #selected: Entry | undefined
    /** The time under the pointer on the timeline. */
    #hover: number | undefined
    #dragging = false

    constructor() {
        super()
        this.src = null
        this.recording = undefined
        this.autoplay = false
        this.speed = 1
        this.worker = true
        this.panel = false
        this.addEventListener('keydown', this.#onKeydown)
        this.addEventListener('fullscreenchange', () => this.requestUpdate())
    }

    /** The player of the recording shown, once loaded. */
    get player(): Player | undefined {
        return this.#player
    }

    /** In milliseconds from the first recorded event. */
    get currentTime(): number {
        return this.#player?.currentTime ?? 0
    }

    get duration(): number {
        return this.#player?.duration ?? 0
    }

    get paused(): boolean {
        return this.#player?.paused ?? !this.#playOnLoad
    }

    /** Plays, as soon as the recording is loaded if it is not yet. */
    play(): void {
        if (this.#player === undefined) {
            this.#playOnLoad = true
        } else {
            this.#player.play()
        }
    }

    pause(): void {
        this.#playOnLoad = false
        this.#player?.pause()
    }

    /** Moves to `time`, in milliseconds. Resolves once the replay shows it. */
    async seek(time: number): Promise<void> {
        await this.#player?.seek(time)
    }

    override connectedCallback(): void {
        super.connectedCallback()
        // Moving the element reloads its frame, so the replay is built again.
        if (this.hasUpdated) {
            void this.#load()
        }
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback()
        this.#generation++
        this.#unload()
    }

    protected override willUpdate(changed: PropertyValues<this>): void {
        if (changed.has('src') || changed.has('recording') || changed.has('worker')) {
            void this.#load()
        } else if (changed.has('speed') && this.#player !== undefined && isSpeed(this.speed)) {
            this.#player.speed = this.speed
        }
    }

    protected override render(): TemplateResult {
        const player = this.#player
        const ready = player !== undefined
        const duration = player?.duration ?? 0
        const time = player?.currentTime ?? 0
        const paused = player?.paused ?? true
        const progress = duration > 0 ? (time / duration) * 100 : 0
        const fullscreen = this.ownerDocument.fullscreenElement === this
        return html`
            <div class="main">
                <div class="screen">
                    <div class="stage" part="stage"></div>
                    <div class="overlay" tabindex="-1" @click=${this.#toggle}>${this.#renderOverlay(paused)}</div>
                </div>
                ${this.panel ? this.#renderPanel(time) : nothing}
            </div>
            <div class="controls" part="controls">
                <button
                    class="play"
                    ?disabled=${!ready}
                    aria-label=${paused ? 'Play' : 'Pause'}
                    title=${paused ? 'Play (k)' : 'Pause (k)'}
                    @click=${this.#toggle}
                >
                    ${icon(paused ? ICONS.play : ICONS.pause)}
                </button>
                <span class="time">${formatTime(time)} / ${formatTime(duration)}</span>
                <div
                    class="timeline"
                    part="timeline"
                    role="slider"
                    tabindex=${ready ? 0 : -1}
                    aria-label="Seek"
                    aria-disabled=${!ready}
                    aria-valuemin="0"
                    aria-valuemax=${Math.round(duration)}
                    aria-valuenow=${Math.round(time)}
                    aria-valuetext=${`${formatTime(time)} of ${formatTime(duration)}`}
                    @pointerdown=${this.#onPointerDown}
                    @pointermove=${this.#onPointerMove}
                    @pointerup=${this.#onPointerUp}
                    @pointercancel=${this.#onPointerUp}
                    @pointerleave=${this.#onPointerLeave}
                >
                    <div class="track">
                        <div class="progress" style=${styleMap({ width: `${progress}%` })}></div>
                        ${guard([this.#entries, duration], () =>
                            markersOf(this.#entries, duration).map(
                                marker =>
                                    html`<div
                                        class="marker ${marker.kind}"
                                        style=${styleMap({ left: `${marker.at * 100}%` })}
                                    ></div>`
                            )
                        )}
                    </div>
                    <div class="thumb" style=${styleMap({ left: `${progress}%` })}></div>
                    ${
                        this.#hover === undefined || duration <= 0
                            ? nothing
                            : html`<div class="hover" style=${styleMap({ left: `${(this.#hover / duration) * 100}%` })}>
                                  ${formatTime(this.#hover)}
                              </div>`
                    }
                </div>
                <select class="speed" aria-label="Playback speed" title="Playback speed" @change=${this.#onSpeed}>
                    ${speeds(this.speed).map(
                        speed => html`<option value=${speed} ?selected=${speed === this.speed}>${speed}×</option>`
                    )}
                </select>
                <button
                    class="events"
                    aria-pressed=${this.panel}
                    aria-label="Events"
                    title="Events recorded beside the page"
                    @click=${this.#togglePanel}
                >
                    ${icon(ICONS.list)}<span class="count">${this.#entries.length}</span>
                </button>
                ${
                    this.ownerDocument.fullscreenEnabled
                        ? html`<button
                              class="fullscreen"
                              aria-label=${fullscreen ? 'Exit full screen' : 'Full screen'}
                              title=${fullscreen ? 'Exit full screen' : 'Full screen'}
                              @click=${this.#toggleFullscreen}
                          >
                              ${icon(fullscreen ? ICONS.shrink : ICONS.expand)}
                          </button>`
                        : nothing
                }
            </div>
        `
    }

    #renderOverlay(paused: boolean): TemplateResult | typeof nothing {
        switch (this.#status) {
            case 'loading':
                return html`<div class="message" role="status"><span class="spinner"></span>Loading…</div>`
            case 'error':
                return html`<div class="message error" role="alert">${this.#error}</div>`
            case 'empty':
                return html`<div class="message">No recording</div>`
            default:
                return paused ? html`<div class="big-play" aria-hidden="true">${icon(ICONS.play)}</div>` : nothing
        }
    }

    #renderPanel(time: number): TemplateResult {
        const shown = this.#shown()
        const past = countUntil(shown, time)
        return html`
            <aside class="panel" part="panel" aria-label="Events recorded beside the page">
                <div class="panel-content">
                    <div class="filters">
                        ${FILTERS.map(
                            ({ filter, label }) =>
                                html`<button
                                    class="filter"
                                    aria-pressed=${this.#filter === filter}
                                    @click=${() => this.#setFilter(filter)}
                                >
                                    ${label} <span class="count">${this.#counts.get(filter) ?? 0}</span>
                                </button>`
                        )}
                    </div>
                    <input
                        class="search"
                        type="search"
                        placeholder="Search"
                        aria-label="Search the events"
                        .value=${this.#search}
                        @input=${this.#onSearch}
                    />
                    ${guard([shown, past, this.#selected], () => this.#renderList(shown, past))}
                </div>
            </aside>
        `
    }

    #renderList(shown: readonly Entry[], past: number): TemplateResult {
        if (shown.length === 0) {
            return html`<p class="none">
                ${this.#entries.length === 0 ? 'Nothing was recorded beside the page.' : 'No events match.'}
            </p>`
        }
        return html`<ol class="entries">
            ${shown.map((entry, i) => {
                const selected = entry === this.#selected
                return html`<li class=${classMap({ entry: true, past: i < past, [entry.tone]: true, selected })}>
                    <button class="entry-head" aria-expanded=${selected} @click=${() => this.#select(entry)}>
                        <span class="at">${formatTime(entry.time)}</span>
                        <span class="badge ${entry.kind}">${entry.badge}</span>
                        <span class="summary">${entry.summary}</span>
                    </button>
                    ${selected ? html`<pre class="detail">${entry.detail}</pre>` : nothing}
                </li>`
            })}
        </ol>`
    }

    /** The entries the filter and search let through, kept while they do not change. */
    #shown(): readonly Entry[] {
        const entries = this.#entries
        const filter = this.#filter
        const search = this.#search.trim().toLowerCase()
        const view = this.#view
        if (view?.entries === entries && view.filter === filter && view.search === search) {
            return view.shown
        }
        const shown = entries.filter(
            entry => (filter === 'all' || entry.kind === filter) && (search === '' || entry.text.includes(search))
        )
        this.#view = { entries, filter, search, shown }
        return shown
    }

    async #load(): Promise<void> {
        const generation = ++this.#generation
        this.#unload()
        const loading = this.#sources()
        if (loading === undefined) {
            return
        }
        this.#status = 'loading'
        try {
            const sources = await loading
            const container = this.renderRoot.querySelector('.stage')
            if (generation !== this.#generation) {
                return
            }
            if (sources === undefined || container === null) {
                this.#status = 'empty'
                this.requestUpdate()
                return
            }
            const speed = isSpeed(this.speed) ? this.speed : 1
            const player = await createPlayer(sources, { container, worker: this.worker, speed })
            if (generation !== this.#generation) {
                player.destroy()
                return
            }
            this.#show(player)
        } catch (error) {
            if (generation !== this.#generation) {
                return
            }
            this.#status = 'error'
            this.#error = `The recording cannot be played: ${error instanceof Error ? error.message : String(error)}`
            this.requestUpdate()
            this.dispatchEvent(new ErrorEvent('error', { error, message: this.#error }))
        }
    }

    /**
     * Loads the recording, from the property, `src` or the element's children, in that order. `undefined` when
     * there is none, and may be none once the page is parsed.
     */
    #sources(): Promise<RecordingSource | readonly RecordingSource[] | undefined> | undefined {
        if (this.recording !== undefined) {
            return Promise.resolve(this.recording)
        }
        const urls =
            this.src
                ?.trim()
                .split(/\s+/u)
                .filter(url => url !== '') ?? []
        if (urls.length > 0) {
            return Promise.all(urls.map(fetchSegment))
        }
        const embedded = this.#embedded()
        if (embedded !== undefined) {
            return Promise.resolve(embedded)
        }
        // The parser may not have added the children yet.
        const document = this.ownerDocument
        if (document.readyState !== 'loading') {
            return undefined
        }
        return new Promise(resolve => {
            document.addEventListener('DOMContentLoaded', () => resolve(this.#embedded()), { once: true })
        })
    }

    /** The segments held by the element's children, if any. */
    #embedded(): Uint8Array<ArrayBuffer>[] | undefined {
        const scripts = this.querySelectorAll<HTMLScriptElement>(`:scope > script[type="${RECORDING_TYPE}"]`)
        return scripts.length === 0 ? undefined : [...scripts].map(script => fromBase64(script.textContent ?? ''))
    }

    #show(player: Player): void {
        this.#player = player
        for (const type of PLAYER_EVENTS) {
            player.addEventListener(type, this.#onPlayerEvent)
        }
        this.#entries = player.events.map(toEntry)
        this.#counts = new Map<Filter, number>([['all', this.#entries.length]])
        for (const entry of this.#entries) {
            this.#counts.set(entry.kind, (this.#counts.get(entry.kind) ?? 0) + 1)
        }
        this.#selected = undefined
        this.#status = 'ready'
        this.requestUpdate()
        this.dispatchEvent(new Event('load'))
        if (this.autoplay || this.#playOnLoad) {
            this.#playOnLoad = false
            player.play()
        }
    }

    #unload(): void {
        const player = this.#player
        if (player !== undefined) {
            for (const type of PLAYER_EVENTS) {
                player.removeEventListener(type, this.#onPlayerEvent)
            }
            player.destroy()
        }
        this.#player = undefined
        this.#entries = []
        this.#counts = new Map()
        this.#status = 'empty'
        this.#error = ''
        this.#hover = undefined
        this.#dragging = false
        this.requestUpdate()
    }

    readonly #onPlayerEvent = (event: Event): void => {
        this.requestUpdate()
        this.dispatchEvent(new Event(event.type))
    }

    readonly #toggle = (): void => {
        const player = this.#player
        if (player?.paused === true) {
            player.play()
        } else {
            player?.pause()
        }
    }

    #seekTo(time: number): void {
        this.#player?.seek(time).catch(logError)
    }

    readonly #onKeydown = (event: KeyboardEvent): void => {
        const player = this.#player
        const target = event.composedPath()[0]
        if (
            player === undefined ||
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            target instanceof HTMLInputElement ||
            target instanceof HTMLSelectElement ||
            target instanceof HTMLTextAreaElement
        ) {
            return
        }
        switch (event.key) {
            case ' ':
                // A button does what Space asks of it.
                if (target instanceof HTMLButtonElement) {
                    return
                }
                this.#toggle()
                break
            case 'k':
                this.#toggle()
                break
            case 'ArrowLeft':
                this.#seekTo(player.currentTime - STEP)
                break
            case 'ArrowRight':
                this.#seekTo(player.currentTime + STEP)
                break
            case 'Home':
                this.#seekTo(0)
                break
            case 'End':
                this.#seekTo(player.duration)
                break
            default:
                return
        }
        event.preventDefault()
    }

    /** The time at the pointer's place on the timeline. */
    #timeAt(event: PointerEvent): number | undefined {
        const timeline = event.currentTarget
        const player = this.#player
        if (!(timeline instanceof Element) || player === undefined) {
            return undefined
        }
        const { left, width } = timeline.getBoundingClientRect()
        return width > 0 ? Math.min(Math.max((event.clientX - left) / width, 0), 1) * player.duration : 0
    }

    readonly #onPointerDown = (event: PointerEvent): void => {
        const time = this.#timeAt(event)
        if (event.button !== 0 || time === undefined || !(event.currentTarget instanceof Element)) {
            return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        this.#dragging = true
        this.#seekTo(time)
    }

    readonly #onPointerMove = (event: PointerEvent): void => {
        const time = this.#timeAt(event)
        this.#hover = time
        this.requestUpdate()
        if (this.#dragging && time !== undefined) {
            this.#seekTo(time)
        }
    }

    readonly #onPointerUp = (): void => {
        this.#dragging = false
    }

    readonly #onPointerLeave = (): void => {
        this.#hover = undefined
        this.requestUpdate()
    }

    readonly #onSpeed = (event: Event): void => {
        if (event.target instanceof HTMLSelectElement) {
            this.speed = Number(event.target.value)
        }
    }

    readonly #togglePanel = (): void => {
        this.panel = !this.panel
    }

    readonly #toggleFullscreen = (): void => {
        const document = this.ownerDocument
        const request = document.fullscreenElement === this ? document.exitFullscreen() : this.requestFullscreen()
        request.catch(logError)
    }

    readonly #onSearch = (event: Event): void => {
        if (event.target instanceof HTMLInputElement) {
            this.#search = event.target.value
            this.requestUpdate()
        }
    }

    #setFilter(filter: Filter): void {
        this.#filter = filter
        this.requestUpdate()
    }

    #select(entry: Entry): void {
        this.#selected = entry === this.#selected ? undefined : entry
        this.requestUpdate()
        this.#seekTo(entry.time)
    }
}

async function fetchSegment(url: string): Promise<Blob> {
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`fetching ${url} failed with status ${response.status}`)
    }
    return response.blob()
}

function isSpeed(speed: number): boolean {
    return speed > 0 && Number.isFinite(speed)
}

/** The speeds offered, with the current one. */
function speeds(current: number): number[] {
    return isSpeed(current) && !SPEEDS.includes(current) ? [...SPEEDS, current].toSorted((a, b) => a - b) : SPEEDS
}

function icon(path: SVGTemplateResult): TemplateResult {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`
}

function logError(error: unknown): void {
    console.error('[timecat]', error)
}
