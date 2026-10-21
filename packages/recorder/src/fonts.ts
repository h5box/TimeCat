import { encodeFontFace, EventType, Track } from '@timecat-js/protocol'
import { findBlobUrls } from './assets.ts'
import type { AssetRecorder } from './assets.ts'
import type { EventSink } from './batch.ts'

/** Descriptors of a font face, with the values that go without saying. */
const DESCRIPTORS: Record<string, string> = {
    style: 'normal',
    weight: 'normal',
    stretch: 'normal',
    unicodeRange: 'U+0-10FFFF',
    featureSettings: 'normal',
    variationSettings: 'normal',
    display: 'auto',
    ascentOverride: 'normal',
    descentOverride: 'normal',
    lineGapOverride: 'normal',
    sizeAdjust: '100%'
}

const URL_FUNCTION = /url\(\s*(["']?)(.*?)\1\s*\)/g

/**
 * Records the font faces script adds to the fonts of recorded documents, which no markup shows. A face does not
 * tell its source, so that is noted when the face is made: faces made before recording started are missed.
 */
export class FontRecorder {
    /** Whose budget font data counts against. */
    readonly #assets: AssetRecorder
    /** Sources of the faces made, with the URL their URLs resolve against. */
    readonly #sources = new WeakMap<FontFace, [source: unknown, base: string]>()
    /** The fonts of recorded documents. */
    readonly #sets = new WeakSet<object>()
    readonly #recorded = new WeakSet<FontFace>()
    readonly #pending: FontFace[] = []
    /** `blob:` URLs in the sources written. The caller empties it. */
    readonly urls: string[] = []

    constructor(assets: AssetRecorder) {
        this.#assets = assets
    }

    /** Faces added to the fonts of `document` are recorded from now on. */
    watch(document: Document): void {
        this.#sets.add(document.fonts)
    }

    created(face: unknown, source: unknown, base: string): void {
        if (isFontFace(face)) {
            this.#sources.set(face, [source, base])
        }
    }

    /** Returns whether the face is to be written. */
    added(fonts: unknown, face: unknown): boolean {
        if (
            typeof fonts !== 'object' ||
            fonts === null ||
            !this.#sets.has(fonts) ||
            !isFontFace(face) ||
            this.#recorded.has(face) ||
            !this.#sources.has(face)
        ) {
            return false
        }
        this.#recorded.add(face)
        this.#pending.push(face)
        return true
    }

    write(sink: EventSink, time: number): void {
        for (const face of this.#pending.splice(0)) {
            const [source, base] = this.#sources.get(face)!
            let written: string | Uint8Array
            if (typeof source === 'string') {
                written = absolute(source, base)
                findBlobUrls(written, this.urls)
            } else {
                const bytes = bytesOf(source)
                if (bytes === undefined || bytes.length === 0 || !this.#assets.reserve(bytes.length)) {
                    continue
                }
                written = bytes
            }
            const descriptors: string[] = []
            for (const [name, initial] of Object.entries(DESCRIPTORS)) {
                const value: unknown = Reflect.get(face, name)
                if (typeof value === 'string' && value !== initial) {
                    descriptors.push(name, value)
                }
            }
            sink.event(
                Track.Assets,
                EventType.FontFace,
                time,
                encodeFontFace({ family: face.family, source: written, descriptors })
            )
        }
    }
}

/** A CSS `src` value with its URLs made absolute. */
function absolute(source: string, base: string): string {
    return source.replace(URL_FUNCTION, (match: string, quote: string, url: string) => {
        try {
            return `url(${quote}${new URL(url, base).href}${quote})`
        } catch {
            return match
        }
    })
}

/** A copy of binary font data, which the page may change after it made the face. */
function bytesOf(source: unknown): Uint8Array | undefined {
    if (ArrayBuffer.isView(source)) {
        return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    }
    return isArrayBuffer(source) ? new Uint8Array(source).slice() : undefined
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
    // Works across realms, unlike `instanceof`.
    return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

function isFontFace(value: unknown): value is FontFace {
    return typeof value === 'object' && value !== null && 'family' in value && 'loaded' in value
}
