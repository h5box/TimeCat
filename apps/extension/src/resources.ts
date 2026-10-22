/**
 * The resources a recorded page loads, such as images, style sheets, fonts and media, found in the page's world as
 * the page loads them, then downloaded by the background, so the replay shows them without the network and as
 * they were.
 */
import type { RecorderPlugin } from '@timecat-js/recorder'

/** How resources are loaded that the replay has no use for: what scripts fetch, scripts, and documents. */
const SKIPPED: ReadonlySet<string> = new Set([
    'beacon',
    'fetch',
    'xmlhttprequest',
    'script',
    'iframe',
    'frame',
    'navigation',
    'ping'
])

/** How long the URLs found gather before they go, in milliseconds. */
const BATCH = 500

/**
 * Finds the URLs of the resources the page and its same-origin frames load, those loaded before recording started
 * included, from resource timing; each URL goes to `onUrls` once, without its fragment.
 */
export function resourcesPlugin(onUrls: (urls: string[]) => void): RecorderPlugin {
    return {
        name: 'resources',
        start(context) {
            const seen = new Set<string>()
            let found: string[] = []
            let timer: ReturnType<typeof setTimeout> | undefined
            const flush = (): void => {
                clearTimeout(timer)
                timer = undefined
                if (found.length > 0) {
                    onUrls(found)
                    found = []
                }
            }
            const take = (entries: readonly PerformanceEntry[]): void => {
                for (const entry of entries) {
                    const url = isResource(entry) && !SKIPPED.has(entry.initiatorType) ? httpUrl(entry.name) : undefined
                    if (url !== undefined && !seen.has(url)) {
                        seen.add(url)
                        found.push(url)
                    }
                }
                if (found.length > 0) {
                    timer ??= setTimeout(flush, BATCH)
                }
            }
            const documents = new WeakSet<Node>()
            const observers: PerformanceObserver[] = []
            context.observeRoots(root => {
                const view = 'defaultView' in root ? root.defaultView : null
                const Observer = view?.PerformanceObserver
                if (documents.has(root) || typeof Observer !== 'function') {
                    return
                }
                documents.add(root)
                try {
                    const observer = new Observer(list => take(list.getEntries()))
                    // With what loaded before.
                    observer.observe({ type: 'resource', buffered: true })
                    observers.push(observer)
                } catch (error) {
                    context.onError(error)
                }
            })
            return () => {
                for (const observer of observers) {
                    take(observer.takeRecords())
                    observer.disconnect()
                }
                flush()
            }
        }
    }
}

function isResource(entry: PerformanceEntry): entry is PerformanceResourceTiming {
    return entry.entryType === 'resource'
}

/** The URL without its fragment, if it is `http:` or `https:`. */
function httpUrl(name: string): string | undefined {
    try {
        const url = new URL(name)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return undefined
        }
        url.hash = ''
        return url.href
    } catch {
        return undefined
    }
}
