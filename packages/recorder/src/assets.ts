import { encodeAsset, EventType, Track } from '@timecat-js/protocol'
import type { EventSink } from './batch.ts'

/** A `blob:` URL: the origin of the page that made it, then a UUID. */
const BLOB_URL = /blob:[^\s"'()<>\\,]*?\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gi

/** Adds the `blob:` URLs in `text`, which a replay cannot load, to `urls`. */
export function findBlobUrls(text: string, urls: string[]): void {
    if (text.includes('blob:')) {
        for (const [url] of text.matchAll(BLOB_URL)) {
            urls.push(url)
        }
    }
}

export interface AssetOptions {
    sink: EventSink
    now: () => number
    /** Bytes of content recorded, all together. */
    budget: number
}

/**
 * Records what the `blob:` URLs the page uses point to, which lives no longer than the page: images, style sheets,
 * fonts. Each URL is read once, after the changes that use it were written, and becomes an Asset event, which
 * holds for the whole recording. Content is recorded while it fits in the budget, which font data shares.
 */
export class AssetRecorder {
    readonly #sink: EventSink
    readonly #now: () => number
    /** Bytes left of the budget. */
    #left: number
    /** URLs read, being read, or that could not be. */
    readonly #seen = new Set<string>()
    /**
     * Blobs of the URLs the page made, so a URL revoked right after use can still be read. A URL keeps its blob
     * alive until it is revoked anyway; this keeps it until the next flush has looked for it.
     */
    readonly #blobs = new Map<string, Blob>()
    readonly #revoked: string[] = []
    readonly #reads = new Set<Promise<void>>()
    #stopped = false

    constructor(options: AssetOptions) {
        this.#sink = options.sink
        this.#now = options.now
        this.#left = options.budget
    }

    /** Takes `size` bytes from the budget. Returns false, taking nothing, when they do not fit. */
    reserve(size: number): boolean {
        if (size > this.#left) {
            return false
        }
        this.#left -= size
        return true
    }

    /** The page made `url` for `object`, or revoked it, with no `object`. */
    objectUrl(url: string, object?: unknown): void {
        if (object === undefined) {
            if (this.#blobs.has(url)) {
                this.#revoked.push(url)
            }
        } else if (isBlob(object)) {
            this.#blobs.set(url, object)
        }
    }

    /** Reads what `urls` point to, each URL once. */
    request(urls: readonly string[]): void {
        if (this.#left <= 0) {
            return
        }
        for (const url of urls) {
            if (!this.#seen.has(url)) {
                this.#seen.add(url)
                const read = this.#read(url)
                this.#reads.add(read)
                void read.then(() => this.#reads.delete(read))
            }
        }
    }

    /** Forgets the blobs of revoked URLs, once the changes written have requested theirs. */
    forget(): void {
        for (const url of this.#revoked.splice(0)) {
            this.#blobs.delete(url)
        }
    }

    /** Settles once what was requested so far is read. */
    async settled(): Promise<void> {
        await Promise.all(this.#reads)
    }

    stop(): void {
        this.#stopped = true
        this.#blobs.clear()
        this.#revoked.length = 0
    }

    async #read(url: string): Promise<void> {
        try {
            // Taken before anything is awaited: `forget` may drop it once this returns.
            const blob = this.#blobs.get(url) ?? (await (await fetch(url)).blob())
            // Reads run side by side: the bytes are taken before the content is read.
            if (this.#stopped || !this.reserve(blob.size)) {
                return
            }
            const data = new Uint8Array(await blob.arrayBuffer())
            if (!this.#stopped) {
                const body = encodeAsset({ url, mimeType: blob.type, data })
                this.#sink.event(Track.Assets, EventType.Asset, this.#now(), body)
                this.#sink.commit()
            }
        } catch {
            // Revoked already, or not a blob: a media source, or a URL of another origin. The replay goes without.
        }
    }
}

function isBlob(value: unknown): value is Blob {
    return typeof value === 'object' && value !== null && 'arrayBuffer' in value && 'size' in value && 'slice' in value
}
