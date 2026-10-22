import { EventType } from '@timecat-js/protocol'
import type { TcrEvent } from '@timecat-js/protocol'
import { cssUrls } from './css-urls.ts'
import { HTML_NAMESPACE } from './dom.ts'
import type { PseudoClasses } from './pseudo-classes.ts'

const HTTP = /^https?:/i
/** Most CSS has no URLs, which this finds without looking at the text closely. */
const ANY_URL = /url\(|@import/i

interface Resource {
    readonly data: Uint8Array
    readonly mimeType: string
    /** The replay's URL, once made; null while a style sheet that imports itself is made. */
    url: string | null | undefined
}

/**
 * What a recording keeps of the resources the page loaded from the web, such as images, style sheets, fonts and
 * media, which the replay serves from URLs of its own rather than load again: they may have changed or gone since,
 * or need a network. A recorded style sheet is served with the URLs in it replaced in turn, and its states
 * rewritten (see `PseudoClasses`). Each URL is served once something asks for it.
 */
export class Resources {
    readonly #pseudoClasses: PseudoClasses
    /** Recorded URL, without fragment, to its resource. */
    readonly #resources = new Map<string, Resource>()

    constructor(pseudoClasses: PseudoClasses) {
        this.#pseudoClasses = pseudoClasses
    }

    /** Whether there is any. */
    get size(): number {
        return this.#resources.size
    }

    /**
     * Takes the Asset events of a recording whose URLs are `http:` or `https:`, which may come a part at a time;
     * others are left out. Returns whether any are new.
     */
    add(events: Iterable<TcrEvent>): boolean {
        let added = false
        for (const event of events) {
            if (event.type === EventType.Asset && HTTP.test(event.url) && !this.#resources.has(event.url)) {
                this.#resources.set(event.url, { data: event.data, mimeType: event.mimeType, url: undefined })
                added = true
            }
        }
        return added
    }

    /** The replay's URL for `url`, relative to `base`, with its fragment; undefined when it was not recorded. */
    url(url: string, base: string): string | undefined {
        const value = url.trim()
        if (this.#resources.size === 0 || value === '' || value.startsWith('#')) {
            return undefined
        }
        const href = URL.parse(value, base)?.href
        return href === undefined ? undefined : this.#replayUrl(href)
    }

    /** `text`, CSS whose relative URLs are relative to `base`, with the recorded URLs in it replaced. */
    css(text: string, base: string): string {
        if (this.#resources.size === 0 || !ANY_URL.test(text)) {
            return text
        }
        return cssUrls(text, base, href => this.#replayUrl(href))
    }

    /**
     * The value of attribute `name` of `element`, with the recorded URLs in it replaced. `base` gives what the URLs
     * of the element are relative to; it is called for the attributes that have URLs only.
     */
    attribute(
        element: Pick<Element, 'localName' | 'namespaceURI'>,
        name: string,
        value: string,
        base: () => string
    ): string {
        if (this.#resources.size === 0) {
            return value
        }
        switch (name) {
            case 'style':
                return this.css(value, base())
            case 'srcset':
                return this.#srcset(value, base())
            case 'src':
            case 'poster':
            case 'background':
                return this.url(value, base()) ?? value
            case 'href':
            case 'xlink:href':
                // Links lead elsewhere; `<link>` and SVG elements other than links load what they point to.
                return (
                    element.namespaceURI === HTML_NAMESPACE ? element.localName === 'link' : element.localName !== 'a'
                )
                    ? (this.url(value, base()) ?? value)
                    : value
            default:
                return value
        }
    }

    /** Lets the replay's URLs go, once the replay is gone. */
    revoke(): void {
        for (const resource of this.#resources.values()) {
            if (typeof resource.url === 'string') {
                URL.revokeObjectURL(resource.url)
            }
            resource.url = undefined
        }
    }

    #replayUrl(href: string): string | undefined {
        const hash = href.indexOf('#')
        const resource = this.#resources.get(hash === -1 ? href : href.slice(0, hash))
        if (resource === undefined) {
            return undefined
        }
        if (resource.url === undefined) {
            resource.url = null
            resource.url = URL.createObjectURL(this.#blob(hash === -1 ? href : href.slice(0, hash), resource))
        }
        return resource.url === null ? undefined : resource.url + (hash === -1 ? '' : href.slice(hash))
    }

    #blob(url: string, resource: Resource): Blob {
        const { data, mimeType } = resource
        if (!/^\s*text\/css\s*(?:;|$)/i.test(mimeType)) {
            return new Blob([data.slice()], { type: mimeType })
        }
        // Relative URLs in it are relative to where it loaded from, not to the replay's URL for it.
        const sheet = this.#pseudoClasses.rewrite(this.css(decode(data, mimeType), url))
        return new Blob([sheet], { type: 'text/css' })
    }

    /** A `srcset` with the candidates recorded, or as it is when none was: the page loaded one of them. */
    #srcset(value: string, base: string): string {
        const kept: string[] = []
        for (const { url, descriptors } of candidates(value)) {
            const replay = this.url(url, base)
            if (replay !== undefined) {
                kept.push(descriptors === '' ? replay : `${replay} ${descriptors}`)
            }
        }
        return kept.length === 0 ? value : kept.join(', ')
    }
}

/** The text of a style sheet, in the encoding its type gives, or UTF-8. */
function decode(data: Uint8Array, mimeType: string): string {
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(mimeType)?.[1]
    try {
        return new TextDecoder(charset).decode(data)
    } catch {
        // An encoding this browser does not know.
        return new TextDecoder().decode(data)
    }
}

/** The image candidates of a `srcset`: each URL, and its descriptors. */
function candidates(srcset: string): { url: string; descriptors: string }[] {
    const result: { url: string; descriptors: string }[] = []
    let i = 0
    while (i < srcset.length) {
        while (i < srcset.length && /[\s,]/.test(srcset[i]!)) {
            i++
        }
        const start = i
        while (i < srcset.length && !/\s/.test(srcset[i]!)) {
            i++
        }
        let url = srcset.slice(start, i)
        let descriptors = ''
        if (url.endsWith(',')) {
            // A URL followed by a comma has no descriptors.
            url = url.replace(/,+$/, '')
        } else {
            const from = i
            let depth = 0
            while (i < srcset.length && (srcset[i] !== ',' || depth > 0)) {
                if (srcset[i] === '(') {
                    depth++
                } else if (srcset[i] === ')') {
                    depth--
                }
                i++
            }
            descriptors = srcset.slice(from, i).trim()
        }
        if (url !== '') {
            result.push({ url, descriptors })
        }
    }
    return result
}
