import { EventType } from '@timecat-js/protocol'
import type { FontFaceEvent, TcrEvent } from '@timecat-js/protocol'

/**
 * What a recording keeps of content that the replay cannot load where the page did: `blob:` URLs, whose content
 * the replay serves from URLs of its own, and the font faces scripts added, which every replayed document gets.
 * Recorded `http:` and `https:` URLs are left to `Resources`, which resolves the relative URLs that point to them.
 */
export class Assets {
    /** Recorded URL to the replay's. */
    readonly #urls = new Map<string, string>()
    readonly #fonts: FontFaceEvent[] = []
    /** The faces made for each document, and of how many fonts. */
    readonly #faces = new WeakMap<Document, { fonts: number; faces: FontFace[] }>()
    /** Matches the recorded URLs, longest first. */
    #pattern: RegExp | undefined
    /** What every recorded URL starts with, which most texts lack. */
    #prefix = ''

    /** Takes the FontFace and Asset events of a recording, which may come a part at a time; others are left out. */
    add(events: Iterable<TcrEvent>): void {
        let added = false
        for (const event of events) {
            if (event.type === EventType.Asset) {
                if (!this.#urls.has(event.url) && !/^https?:/i.test(event.url)) {
                    const blob = new Blob([event.data.slice()], { type: event.mimeType })
                    this.#urls.set(event.url, URL.createObjectURL(blob))
                    added = true
                }
            } else if (event.type === EventType.FontFace) {
                this.#fonts.push(event)
            }
        }
        if (added) {
            const urls = [...this.#urls.keys()].toSorted((a, b) => b.length - a.length)
            this.#pattern = new RegExp(urls.map(escape).join('|'), 'g')
            this.#prefix = urls.reduce(commonPrefix, urls[0] ?? '')
        }
    }

    /** `text` with the recorded URLs in it replaced by the replay's. */
    rewrite(text: string): string {
        const pattern = this.#pattern
        if (pattern === undefined || !text.includes(this.#prefix)) {
            return text
        }
        return text.replace(pattern, url => this.#urls.get(url) ?? url)
    }

    /** Adds the recorded font faces to a document, unless it has them, with the URLs of their sources `rewrite`n. */
    addFonts(document: Document, rewrite: (text: string) => string): void {
        const view = document.defaultView
        if (this.#fonts.length === 0 || view === null) {
            return
        }
        let made = this.#faces.get(document)
        if (made === undefined) {
            made = { fonts: 0, faces: [] }
            this.#faces.set(document, made)
        }
        for (const font of this.#fonts.slice(made.fonts)) {
            const face = this.#face(view, font, rewrite)
            if (face !== undefined) {
                made.faces.push(face)
            }
        }
        made.fonts = this.#fonts.length
        for (const face of made.faces) {
            if (!document.fonts.has(face)) {
                document.fonts.add(face)
            }
        }
    }

    /** Lets the replay's URLs go. */
    revoke(): void {
        for (const url of this.#urls.values()) {
            URL.revokeObjectURL(url)
        }
    }

    /** A face made in `view`, the window of the document it is for. */
    #face(
        view: Window & typeof globalThis,
        font: FontFaceEvent,
        rewrite: (text: string) => string
    ): FontFace | undefined {
        const { source, descriptors } = font
        const options: Record<string, string> = {}
        for (let i = 0; i < descriptors.length; i += 2) {
            options[descriptors[i]!] = descriptors[i + 1]!
        }
        try {
            const face = new view.FontFace(
                font.family,
                typeof source === 'string' ? rewrite(source) : source.slice(),
                options
            )
            // A face that fails to load just does not show; its rejection is not an error of the replay.
            face.loaded.catch(ignore)
            return face
        } catch {
            // Descriptors this browser does not take.
            return undefined
        }
    }
}

function escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function commonPrefix(a: string, b: string): string {
    let i = 0
    while (i < a.length && a[i] === b[i]) {
        i++
    }
    return a.slice(0, i)
}

function ignore(): void {
    // Nothing to do.
}
