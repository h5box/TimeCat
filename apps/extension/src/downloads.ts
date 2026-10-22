/**
 * Downloads the resources recorded pages load, in the background, into their recordings: the replay then shows
 * them as they were, without the network. Each recording keeps a resource once, and keeps no more than its limits.
 */
import { ByteWriter, ChunkFlag, encodeAsset, EventType, gzip, writeEventFrame } from '@timecat-js/protocol'
import * as store from './store.ts'

const MB = 1024 * 1024
/** Bytes of one audio or video file, at most. */
const MEDIA_LIMIT = 20 * MB
/** Bytes of any other file, at most. */
const FILE_LIMIT = 10 * MB
/** Bytes of all the resources of a recording, at most. */
const RECORDING_LIMIT = 100 * MB
/** Resources of a recording, at most. */
const URL_LIMIT = 5000
/** Downloads at once, of all recordings. */
const CONCURRENCY = 4
/** How long a download may take, in milliseconds. */
const TIMEOUT = 60_000

/** Types of what the replay does not load: documents, scripts and data. */
const UNWANTED =
    /^\s*(?:text\/(?:html|javascript|ecmascript|xml|event-stream)|application\/(?:xhtml\+xml|(?:x-)?javascript|ecmascript|json|[\w.-]+\+json|xml|wasm)|multipart\/)/i
const MEDIA = /^\s*(?:audio|video)\//i
/** Types that compress: text, SVG and fonts that are not compressed already. */
const COMPRESSIBLE =
    /^\s*(?:text\/|image\/svg\+xml|font\/(?:ttf|otf|sfnt)|application\/(?:x-font-ttf|x-font-otf|font-sfnt|vnd\.ms-fontobject))/i

interface Job {
    session: string
    segment: number
    url: string
    credentials: RequestCredentials
}

interface Recording {
    /** URLs downloaded, being downloaded, or that could not be. */
    readonly urls: Set<string>
    /** Bytes downloaded. */
    bytes: number
    /** Settles once the resources downloaded before are known, as after the service worker started again. */
    ready: Promise<void>
    /** Downloads waiting or going on. */
    pending: number
    /** Called once there are none. */
    readonly idle: (() => void)[]
    readonly controller: AbortController
}

export class Downloads {
    readonly #recordings = new Map<string, Recording>()
    readonly #queue: Job[] = []
    #running = 0

    /**
     * Downloads the resources at `urls` that a page of a recording loaded, but those the recording has. Cookies go
     * with the requests to the site of the page, at `page`, as they did when the page loaded them.
     */
    add(session: string, segment: number, page: string | undefined, urls: readonly string[]): void {
        const recording = this.#recording(session)
        recording.pending++
        this.#enqueue(recording, session, segment, page, urls)
            .catch((error: unknown) => console.error('[timecat] cannot download resources', error))
            .finally(() => {
                this.#done(recording)
                this.#next()
            })
    }

    /**
     * Settles once the downloads of a recording are done, or after `timeout` milliseconds, when those left are
     * cancelled; the recording downloads nothing more.
     */
    async finish(session: string, timeout: number): Promise<void> {
        const recording = this.#recordings.get(session)
        if (recording === undefined) {
            return
        }
        if (recording.pending > 0) {
            let timer: ReturnType<typeof setTimeout> | undefined
            await new Promise<void>(resolve => {
                recording.idle.push(resolve)
                timer = setTimeout(resolve, timeout)
            })
            clearTimeout(timer)
        }
        recording.controller.abort()
        if (this.#recordings.get(session) === recording) {
            this.#recordings.delete(session)
        }
    }

    async #enqueue(
        recording: Recording,
        session: string,
        segment: number,
        page: string | undefined,
        urls: readonly string[]
    ): Promise<void> {
        await recording.ready
        for (const url of urls) {
            if (recording.urls.size >= URL_LIMIT) {
                break
            }
            if (!recording.urls.has(url) && /^https?:/.test(url)) {
                recording.urls.add(url)
                recording.pending++
                const credentials = page !== undefined && sameSite(page, url) ? 'include' : 'omit'
                this.#queue.push({ session, segment, url, credentials })
            }
        }
    }

    #recording(session: string): Recording {
        let recording = this.#recordings.get(session)
        if (recording === undefined) {
            recording = {
                urls: new Set(),
                bytes: 0,
                ready: Promise.resolve(),
                pending: 0,
                idle: [],
                controller: new AbortController()
            }
            recording.ready = known(recording, session)
            this.#recordings.set(session, recording)
        }
        return recording
    }

    #next(): void {
        while (this.#running < CONCURRENCY) {
            const job = this.#queue.shift()
            if (job === undefined) {
                return
            }
            const recording = this.#recordings.get(job.session)
            // None once the recording finished.
            if (recording === undefined) {
                continue
            }
            this.#running++
            this.#download(job, recording)
                .catch(() => {
                    // Not there, not allowed, too slow, or cancelled: the replay loads it, if it can.
                })
                .finally(() => {
                    this.#running--
                    this.#done(recording)
                    this.#next()
                })
        }
    }

    #done(recording: Recording): void {
        recording.pending--
        if (recording.pending === 0) {
            for (const resolve of recording.idle.splice(0)) {
                resolve()
            }
        }
    }

    async #download(job: Job, recording: Recording): Promise<void> {
        const { signal } = recording.controller
        const left = RECORDING_LIMIT - recording.bytes
        if (left <= 0 || signal.aborted) {
            return
        }
        const response = await fetch(job.url, {
            credentials: job.credentials,
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]),
            // After what pages ask for.
            priority: 'low'
        })
        const type = response.headers.get('content-type') ?? ''
        if (!response.ok || UNWANTED.test(type)) {
            await response.body?.cancel()
            return
        }
        const data = await readUpTo(response, Math.min(MEDIA.test(type) ? MEDIA_LIMIT : FILE_LIMIT, left))
        if (data === undefined || signal.aborted || recording.bytes + data.length > RECORDING_LIMIT) {
            return
        }
        recording.bytes += data.length
        const writer = new ByteWriter(data.length + 256)
        writeEventFrame(writer, EventType.Asset, 0, encodeAsset({ url: job.url, mimeType: type, data }))
        let payload = writer.finish()
        // It needs no other chunk to be read.
        let flags: number = ChunkFlag.Keyframe
        if (COMPRESSIBLE.test(type)) {
            const compressed = await gzip(payload)
            if (compressed.length < payload.length) {
                payload = compressed
                flags |= ChunkFlag.Gzip
            }
        }
        const record = { session: job.session, segment: job.segment, url: job.url, size: data.length }
        if (!(await store.appendResource(record, flags, payload))) {
            recording.bytes -= data.length
        }
    }
}

/** Takes the resources downloaded for a recording before, as before the service worker stopped. */
async function known(recording: Recording, session: string): Promise<void> {
    for (const { url, size } of await store.listResources(session)) {
        recording.urls.add(url)
        recording.bytes += size
    }
}

/** The body of a response, unless it is longer than `limit` bytes. */
async function readUpTo(response: Response, limit: number): Promise<Uint8Array | undefined> {
    const body = response.body
    if (body === null) {
        return new Uint8Array(0)
    }
    // The length of the content as sent, maybe compressed: what it decodes to is counted as it comes.
    if (Number(response.headers.get('content-length')) > limit) {
        await body.cancel()
        return undefined
    }
    const reader = body.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- the body comes a part at a time
        const { done, value } = await reader.read()
        if (done) {
            break
        }
        size += value.length
        if (size > limit) {
            break
        }
        parts.push(value)
    }
    if (size > limit) {
        await reader.cancel()
        return undefined
    }
    const data = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
        data.set(part, offset)
        offset += part.length
    }
    return data
}

/**
 * Whether two URLs are of the same site, as cookies take it: the same scheme and registrable domain. Without the
 * list of public suffixes, the registrable domain is taken as the last two labels of the host name, or three under
 * second-level ones such as `co.uk`; IP addresses and hosts of one label are their own.
 */
export function sameSite(a: string, b: string): boolean {
    try {
        return siteOf(new URL(a)) === siteOf(new URL(b))
    } catch {
        return false
    }
}

function siteOf(url: URL): string {
    const host = url.hostname
    if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) {
        return `${url.protocol}//${host}`
    }
    const labels = host.split('.')
    const count = labels.length > 2 && labels.at(-2)!.length <= 3 && labels.at(-1)!.length === 2 ? 3 : 2
    return `${url.protocol}//${labels.slice(-count).join('.')}`
}
