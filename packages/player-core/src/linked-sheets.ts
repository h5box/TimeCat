import { cssUrls } from './css-urls.ts'
import { isLink } from './dom.ts'
import type { PseudoClasses } from './pseudo-classes.ts'

/** The `Accept` header of requests for style sheets, which CORS lets through without asking first. */
const SHEET_ACCEPT = 'text/css,*/*;q=0.1'

interface Waiting {
    readonly link: Element
    /** The `href` it was given, which it keeps unless the replay changes it meanwhile. */
    readonly href: string
}

interface Swapped extends Waiting {
    /** The sheet's URL, and the URL of the rewritten sheet the link loads instead. */
    readonly url: string
    readonly rewritten: string
}

/**
 * The style sheets the replay links to, rewritten for the states it shows (see `PseudoClasses`). Their rules
 * cannot be read where the replay loads them, from another origin, so each is fetched once more by the player, which
 * the browser's cache mostly serves, and a sheet with states in its selectors is served rewritten from a `blob:`
 * URL. One that cannot be fetched, without CORS outside an extension, stays as it is.
 */
export class LinkedSheets implements EventListenerObject {
    readonly #pseudoClasses: PseudoClasses
    readonly #onChange: () => void
    /** Sheet URL to the rewritten sheet's, or null when the sheet stays. */
    readonly #urls = new Map<string, string | null>()
    readonly #waiting = new Map<string, Waiting[]>()
    /** The links that load a rewritten sheet. */
    readonly #swapped = new WeakMap<EventTarget, Swapped>()
    #revoked = false

    /** `onChange` is called once a rewritten sheet replaced one shown. */
    constructor(pseudoClasses: PseudoClasses, onChange: () => void) {
        this.#pseudoClasses = pseudoClasses
        this.#onChange = onChange
    }

    /** The URL `link` loads from, given `href`: the rewritten sheet's, once there is one. */
    href(link: Element, href: string): string {
        if (!isStyleSheetLink(link)) {
            return href
        }
        const url = URL.parse(href, link.baseURI)?.href
        if (url === undefined || !/^https?:/.test(url)) {
            return href
        }
        const known = this.#urls.get(url)
        if (known !== undefined) {
            if (known === null) {
                return href
            }
            this.#swap({ link, href, url, rewritten: known })
            return known
        }
        let waiting = this.#waiting.get(url)
        if (waiting === undefined) {
            waiting = []
            this.#waiting.set(url, waiting)
            void this.#load(url)
        }
        waiting.push({ link, href })
        return href
    }

    /**
     * Gives a link back the sheet it was given when it cannot load the rewritten one, as where a content security
     * policy forbids `blob:` style sheets; no link gets that one from then on.
     */
    handleEvent(event: Event): void {
        const swapped = event.currentTarget === null ? undefined : this.#swapped.get(event.currentTarget)
        if (swapped === undefined) {
            return
        }
        const { link, href, url, rewritten } = swapped
        if (this.#urls.get(url) === rewritten) {
            this.#urls.set(url, null)
            URL.revokeObjectURL(rewritten)
        }
        if (link.getAttribute('href') === rewritten) {
            link.setAttribute('href', href)
        }
    }

    /** Lets the rewritten sheets go, once the replay is gone. */
    revoke(): void {
        this.#revoked = true
        for (const url of this.#urls.values()) {
            if (url !== null) {
                URL.revokeObjectURL(url)
            }
        }
        this.#urls.clear()
    }

    async #load(url: string): Promise<void> {
        let rewritten: string | null = null
        try {
            // As a browser asks for a style sheet, which some servers answer with something else otherwise.
            const response = await fetch(url, { credentials: 'omit', headers: { Accept: SHEET_ACCEPT } })
            if (response.ok && isCss(response.headers.get('content-type'))) {
                const text = cssUrls(await response.text(), response.url || url)
                const sheet = this.#pseudoClasses.rewrite(text)
                if (sheet !== text && !this.#revoked) {
                    rewritten = URL.createObjectURL(new Blob([sheet], { type: 'text/css' }))
                }
            }
        } catch {
            // Not allowed or not there: the sheet stays.
        }
        const waiting = this.#waiting.get(url) ?? []
        this.#waiting.delete(url)
        if (this.#revoked) {
            return
        }
        this.#urls.set(url, rewritten)
        if (rewritten === null) {
            return
        }
        let changed = false
        for (const { link, href } of waiting) {
            // The sheet shown goes once the new one is loaded, so nothing shows unstyled meanwhile.
            if (link.isConnected && link.getAttribute('href') === href) {
                this.#swap({ link, href, url, rewritten })
                link.setAttribute('href', rewritten)
                changed = true
            }
        }
        if (changed) {
            this.#onChange()
        }
    }

    #swap(swapped: Swapped): void {
        this.#swapped.set(swapped.link, swapped)
        // Added once, however often the link is swapped.
        swapped.link.addEventListener('error', this)
    }
}

/** Whether a response of `type` is a style sheet: one without a type may be, as browsers take it in quirks mode. */
function isCss(type: string | null): boolean {
    return type === null || /^\s*text\/css\s*(?:;|$)/i.test(type)
}

/**
 * A `<link>` to a style sheet that the replay can take another for: one with `integrity` would not take it.
 * The element has its other attributes by the time it gets `href` (see `Materializer`).
 */
function isStyleSheetLink(element: Element): boolean {
    return isLink(element) && element.relList.contains('stylesheet') && !element.hasAttribute('integrity')
}
