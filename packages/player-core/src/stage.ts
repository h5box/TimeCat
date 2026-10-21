import { PointerType } from '@timecat-js/protocol'
import type { PointerState } from './pointer.ts'

const STYLE = `
.stage { position: absolute; left: 0; top: 0; overflow: hidden; transform-origin: 0 0; }
iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
.shield { position: absolute; inset: 0; overflow: hidden; }
.cursor, .touch, .click { position: absolute; left: 0; top: 0; display: none; pointer-events: none; }
.cursor { transform-origin: 0 0; }
.cursor svg { display: block; width: 14px; height: 18px; overflow: visible; }
.touch, .click { border-radius: 50%; box-sizing: border-box; }
.touch { width: 32px; height: 32px; margin: -16px 0 0 -16px; background: rgb(0 0 0 / 0.2);
    border: 2px solid rgb(255 255 255 / 0.9); }
.click { width: 40px; height: 40px; margin: -20px 0 0 -20px; border: 3px solid rgb(255 72 72); }
`

/** An arrow with its tip at the origin. */
const CURSOR =
    '<div class="cursor"><svg viewBox="0 0 14 18" aria-hidden="true"><path d="M0 0v14l3.8-3.5 2.5 5.7 2.3-1 ' +
    '-2.4-5.6h5z" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg></div>'

const CLICKS = 3

/**
 * Shows the replay: a sandboxed iframe at the recorded viewport size, scaled to fit the container, under a shield
 * that keeps the viewer's input away from it, with the recorded pointer on top. Lives in a shadow root, out of
 * reach of the page's styles.
 */
export class Stage {
    readonly #host: HTMLElement
    readonly #stage: HTMLElement
    readonly #iframe: HTMLIFrameElement
    readonly #cursor: HTMLElement
    readonly #touch: HTMLElement
    readonly #clicks: HTMLElement[]
    readonly #observer: ResizeObserver
    #width = 1024
    #height = 768
    #scale = 1

    private constructor(container: Element) {
        const document = container.ownerDocument
        const host = document.createElement('div')
        host.style.cssText = 'display: block; position: relative; width: 100%; height: 100%; overflow: hidden'
        const shadow = host.attachShadow({ mode: 'open' })
        // A constructed style sheet, which a page's CSP allows when it allows no inline styles. It has to come from
        // the window of the container's document.
        const sheet = new (document.defaultView ?? window).CSSStyleSheet()
        sheet.replaceSync(STYLE)
        shadow.adoptedStyleSheets = [sheet]
        shadow.innerHTML =
            '<div class="stage"><div class="shield">' +
            `${'<div class="click"></div>'.repeat(CLICKS)}<div class="touch"></div>${CURSOR}</div></div>`
        this.#host = host
        this.#stage = query(shadow, '.stage')
        this.#cursor = query(shadow, '.cursor')
        this.#touch = query(shadow, '.touch')
        this.#clicks = [...shadow.querySelectorAll<HTMLElement>('.click')]
        const iframe = document.createElement('iframe')
        // Scripts never run in the replay: without `allow-scripts`, same origin only lets the player build it.
        iframe.setAttribute('sandbox', 'allow-same-origin')
        iframe.setAttribute('referrerpolicy', 'no-referrer')
        iframe.setAttribute('title', 'Session replay')
        iframe.tabIndex = -1
        // Nothing in the replay takes focus or input.
        iframe.inert = true
        this.#iframe = iframe
        this.#stage.prepend(iframe)
        this.#observer = new ResizeObserver(() => this.#layout())
    }

    /** The document of the container, outside the replay. */
    get ownerDocument(): Document {
        return this.#host.ownerDocument
    }

    /** Adds a stage to `container`, once its document is ready to build in. */
    static async create(container: Element): Promise<Stage> {
        const stage = new Stage(container)
        // Some browsers replace the first document of a new frame once it loads, so the replay waits for that.
        const loaded = new Promise(resolve => stage.#iframe.addEventListener('load', resolve, { once: true }))
        container.append(stage.#host)
        stage.#observer.observe(stage.#host)
        stage.setViewport(stage.#width, stage.#height)
        await loaded
        return stage
    }

    /** The document the replay is built in. */
    get document(): Document {
        const document = this.#iframe.contentDocument
        if (document === null) {
            throw new Error('the replay frame has no document')
        }
        return document
    }

    /** Resizes the replay to a recorded viewport. */
    setViewport(width: number, height: number): void {
        this.#width = Math.max(width, 1)
        this.#height = Math.max(height, 1)
        const style = this.#stage.style
        style.width = `${this.#width}px`
        style.height = `${this.#height}px`
        // A container without a height of its own gets the proportions of the recording.
        this.#host.style.aspectRatio = `${this.#width} / ${this.#height}`
        this.#layout()
    }

    showPointer(state: PointerState | undefined): void {
        // The pointer keeps its size on screen however far the replay is scaled.
        const scale = `scale(${1 / this.#scale})`
        const touch = state?.type === PointerType.Touch
        show(this.#cursor, state !== undefined && !touch, state)
        this.#cursor.style.transform = state === undefined ? '' : `translate(${state.x}px, ${state.y}px) ${scale}`
        show(this.#touch, touch && state.pressed, state)
        for (const [i, element] of this.#clicks.entries()) {
            const click = state?.clicks[i]
            show(element, click !== undefined, click)
            if (click !== undefined) {
                element.style.opacity = String(1 - click.progress)
                element.style.transform = `${translate(click)} ${scale} scale(${0.4 + 0.6 * click.progress})`
            }
        }
        if (touch) {
            this.#touch.style.transform = `${translate(state)} ${scale}`
        }
    }

    /** Removes the stage from the page. */
    destroy(): void {
        this.#observer.disconnect()
        this.#host.remove()
    }

    #layout(): void {
        const width = this.#host.clientWidth
        const height = this.#host.clientHeight
        const scale = Math.min(width / this.#width, height / this.#height)
        this.#scale = scale > 0 && Number.isFinite(scale) ? scale : 1
        const x = (width - this.#width * this.#scale) / 2
        const y = (height - this.#height * this.#scale) / 2
        this.#stage.style.transform = `translate(${x}px, ${y}px) scale(${this.#scale})`
    }
}

function query(root: ParentNode, selector: string): HTMLElement {
    const element = root.querySelector<HTMLElement>(selector)
    if (element === null) {
        throw new Error(`missing ${selector}`)
    }
    return element
}

function show(element: HTMLElement, visible: boolean, at: { x: number; y: number } | undefined): void {
    element.style.display = visible && at !== undefined ? 'block' : 'none'
}

function translate({ x, y }: { x: number; y: number }): string {
    return `translate(${x}px, ${y}px)`
}
