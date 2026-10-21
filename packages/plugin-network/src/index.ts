import { EventType } from '@timecat-js/protocol'
import type { NetworkEvent } from '@timecat-js/protocol'
import type { PluginContext, RecorderPlugin } from '@timecat-js/recorder'

export interface NetworkPluginOptions {
    /**
     * Records the resources the page loads otherwise, such as images, scripts and style sheets, from resource
     * timing. `true` by default.
     */
    resources?: boolean | undefined
    /**
     * Rewrites the URL of each request before it is recorded, such as to leave out a token, or returns null to
     * leave the request out. URLs are absolute, without user name and password.
     */
    url?: ((url: string) => string | null) | undefined
}

/** Requests made in ways this plugin records itself, which resource timing reports too. */
const OWN_INITIATORS: ReadonlySet<string> = new Set(['fetch', 'xmlhttprequest', 'beacon'])
const HTTP = /^https?:$/u

/**
 * Records the requests the page makes with `fetch`, `XMLHttpRequest` and `navigator.sendBeacon`, and the
 * resources it loads otherwise: method, URL, status, duration, size and how it failed. Neither headers nor bodies
 * are recorded. A request is recorded when it ends, which for `fetch` is when the response headers arrive.
 */
export function networkPlugin(options: NetworkPluginOptions = {}): RecorderPlugin {
    const resources = options.resources ?? true
    const mapUrl = options.url
    return {
        name: 'network',
        start: context => startNetwork(context, resources, mapUrl)
    }
}

type Request = Pick<NetworkEvent, 'initiator' | 'method' | 'url'>
type Outcome = Pick<NetworkEvent, 'status' | 'size' | 'error'>

function startNetwork(
    context: PluginContext,
    resources: boolean,
    mapUrl: ((url: string) => string | null) | undefined
): () => void {
    const target = context.window
    let active = true

    /** The URL as recorded, or null for a request left out. */
    const recordedUrl = (url: string): string | null => {
        let parsed: URL
        try {
            parsed = new URL(url, target.document.baseURI)
        } catch {
            return null
        }
        // Local content, such as `blob:` URLs, is not a request.
        if (!HTTP.test(parsed.protocol)) {
            return null
        }
        parsed.username = ''
        parsed.password = ''
        return mapUrl === undefined ? parsed.href : mapUrl(parsed.href)
    }

    /** Starts recording a request; returns what records its end, or undefined when it is left out. */
    const begin = (initiator: string, method: string, url: string): ((outcome: Outcome) => void) | undefined => {
        if (!active) {
            return undefined
        }
        const start = target.performance.now()
        let request: Request
        try {
            const recorded = recordedUrl(url)
            if (recorded === null) {
                return undefined
            }
            request = { initiator, method: method.toUpperCase(), url: recorded }
        } catch (error) {
            context.onError(error)
            return undefined
        }
        return outcome => {
            const end = target.performance.now()
            const duration = Math.max(0, Math.round(end - start))
            context.write({ type: EventType.Network, ...request, ...outcome, duration }, context.time(end))
        }
    }

    const restores = [
        patchFetch(target, begin),
        patchXhr(target, begin),
        patchBeacon(target, begin),
        resources ? observeResources(context, recordedUrl) : undefined
    ]
    return () => {
        active = false
        for (const restore of restores) {
            restore?.()
        }
    }
}

type Begin = (initiator: string, method: string, url: string) => ((outcome: Outcome) => void) | undefined

function patchFetch(target: Window & typeof globalThis, begin: Begin): (() => void) | undefined {
    const original: unknown = Reflect.get(target, 'fetch')
    if (typeof original !== 'function') {
        return undefined
    }
    const wrapper = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
        let end: ReturnType<Begin>
        try {
            const [input, init] = args
            if (typeof input === 'string') {
                end = begin('fetch', init?.method ?? 'GET', input)
            } else if ('url' in input) {
                end = begin('fetch', init?.method ?? input.method, input.url)
            } else {
                end = begin('fetch', init?.method ?? 'GET', input.href)
            }
        } catch {
            // Arguments `fetch` rejects, which it reports as it does.
        }
        const promise: Promise<Response> = Reflect.apply(original, this, args)
        if (end !== undefined) {
            const recordEnd = end
            promise.then(
                response =>
                    recordEnd({
                        status: response.status,
                        size: sizeOf(response.headers.get('content-length')),
                        error: ''
                    }),
                (error: unknown) => recordEnd({ status: 0, size: 0, error: failureOf(error) })
            )
        }
        return promise
    }
    return patch(target, 'fetch', wrapper)
}

function patchXhr(target: Window & typeof globalThis, begin: Begin): (() => void) | undefined {
    const prototype: unknown = target.XMLHttpRequest?.prototype
    if (!isXhrPrototype(prototype)) {
        return undefined
    }
    const open: unknown = Reflect.get(prototype, 'open')
    const send: unknown = Reflect.get(prototype, 'send')
    if (typeof open !== 'function' || typeof send !== 'function') {
        return undefined
    }
    const opened = new WeakMap<XMLHttpRequest, [method: string, url: string]>()
    const restoreOpen = patch(prototype, 'open', function (this: XMLHttpRequest, ...args: unknown[]): void {
        try {
            opened.set(this, [String(args[0]), String(args[1])])
        } catch {
            opened.delete(this)
        }
        Reflect.apply(open, this, args)
    })
    const restoreSend = patch(prototype, 'send', function (this: XMLHttpRequest, ...args: unknown[]): void {
        const request = opened.get(this)
        const end = request === undefined ? undefined : begin('xmlhttprequest', ...request)
        if (end === undefined) {
            Reflect.apply(send, this, args)
            return
        }
        // Listened to before sending: a synchronous request ends within `send`.
        const types = ['load', 'error', 'abort', 'timeout'] as const
        const forget = (): void => {
            for (const type of types) {
                this.removeEventListener(type, done)
            }
        }
        const done = (event: Event): void => {
            forget()
            const failed = event.type !== 'load'
            end({
                status: this.status,
                size: failed ? 0 : sizeOf(this.getResponseHeader('content-length')),
                error: failed ? event.type : ''
            })
        }
        for (const type of types) {
            this.addEventListener(type, done)
        }
        try {
            Reflect.apply(send, this, args)
        } catch (error) {
            forget()
            throw error
        }
    })
    return () => {
        restoreOpen()
        restoreSend()
    }
}

function patchBeacon(target: Window & typeof globalThis, begin: Begin): (() => void) | undefined {
    const navigator = target.navigator
    const original: unknown = Reflect.get(navigator, 'sendBeacon')
    if (typeof original !== 'function') {
        return undefined
    }
    return patch(navigator, 'sendBeacon', function (this: Navigator, ...args: Parameters<Navigator['sendBeacon']>) {
        let end: ReturnType<Begin>
        try {
            const [url] = args
            end = begin('beacon', 'POST', typeof url === 'string' ? url : url.href)
        } catch {
            // As for `fetch`.
        }
        const queued: boolean = Reflect.apply(original, this, args)
        end?.({ status: 0, size: 0, error: queued ? '' : 'not queued' })
        return queued
    })
}

/** Records the resources resource timing reports, other than requests the patches record. */
function observeResources(
    context: PluginContext,
    recordedUrl: (url: string) => string | null
): (() => void) | undefined {
    const Observer = context.window.PerformanceObserver
    if (typeof Observer !== 'function' || !Observer.supportedEntryTypes.includes('resource')) {
        return undefined
    }
    const take = (entries: readonly PerformanceEntry[]): void => {
        for (const entry of entries) {
            try {
                if (!isResource(entry) || OWN_INITIATORS.has(entry.initiatorType)) {
                    continue
                }
                const url = recordedUrl(entry.name)
                if (url === null) {
                    continue
                }
                context.write(
                    {
                        type: EventType.Network,
                        initiator: entry.initiatorType,
                        method: 'GET',
                        url,
                        status:
                            'responseStatus' in entry && typeof entry.responseStatus === 'number'
                                ? entry.responseStatus
                                : 0,
                        duration: Math.max(0, Math.round(entry.duration)),
                        size: Math.round(entry.transferSize || entry.encodedBodySize || 0),
                        error: ''
                    },
                    context.time(entry.responseEnd || entry.startTime + entry.duration)
                )
            } catch (error) {
                context.onError(error)
            }
        }
    }
    const observer = new Observer(list => take(list.getEntries()))
    observer.observe({ type: 'resource' })
    return () => {
        take(observer.takeRecords())
        observer.disconnect()
    }
}

function isXhrPrototype(value: unknown): value is XMLHttpRequest {
    return typeof value === 'object' && value !== null
}

function isResource(entry: PerformanceEntry): entry is PerformanceResourceTiming {
    return entry.entryType === 'resource'
}

/**
 * Sets `object[key]`. Returns what puts the original back, unless script replaced the value meanwhile: its
 * wrapper may call the one set here, which then only passes calls on.
 */
function patch<T extends object, K extends keyof T>(object: T, key: K, value: T[K]): () => void {
    const own = Object.getOwnPropertyDescriptor(object, key)
    object[key] = value
    return () => {
        if (object[key] !== value) {
            return
        }
        if (own === undefined) {
            delete object[key]
        } else {
            Object.defineProperty(object, key, own)
        }
    }
}

function sizeOf(contentLength: string | null): number {
    const size = Number(contentLength ?? 0)
    return Number.isSafeInteger(size) && size > 0 ? size : 0
}

function failureOf(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
        return 'abort'
    }
    return (error instanceof Error ? error.message : String(error)) || 'error'
}
