import { EventType } from '@timecat-js/protocol'
import type { PluginContext, RecorderPlugin } from '@timecat-js/recorder'
import { Interactions, LayoutShifts } from './metrics.ts'

export interface PerfPluginOptions {
    /**
     * Records long animation frames, or long tasks where the browser does not report those, which show when the
     * page did not respond. `true` by default.
     */
    longTasks?: boolean | undefined
}

/** Not in the DOM types, as only Chromium reports it. */
interface LayoutShift extends PerformanceEntry {
    readonly value: number
    readonly hadRecentInput: boolean
    readonly sources: readonly { readonly node: Node | null }[]
}

/** Event timing reports events at least this long, the least it takes. */
const EVENT_THRESHOLD = 16

/**
 * Records what the browser measures of the page's performance, as `Perf` events whose value is in milliseconds,
 * or a score for layout shifts, and whose target is the node measured, if any:
 *
 * - `TTFB` and `FCP`: time to first byte and first contentful paint, from the start of navigation.
 * - `LCP`: each largest contentful paint candidate, the element as target. The last one is the LCP.
 * - `layout-shift`: each shift of layout no recent input caused, the first node that moved as target; `CLS` each
 *   time the cumulative layout shift grows.
 * - `INP`: each time interaction to next paint changes, the target of that interaction as target.
 * - `long-animation-frame`, or `long-task`: their duration.
 *
 * Measurements from before recording started are recorded at its start. Browsers measure what they support:
 * only Chromium-based ones report all of these.
 */
export function perfPlugin(options: PerfPluginOptions = {}): RecorderPlugin {
    const longTasks = options.longTasks ?? true
    return {
        name: 'perf',
        start: context => startPerf(context, longTasks)
    }
}

function startPerf(context: PluginContext, longTasks: boolean): (() => void) | undefined {
    const Observer = context.window.PerformanceObserver
    if (typeof Observer !== 'function') {
        return undefined
    }
    const write = (metric: string, value: number, time: number, target: Node | null = null): void => {
        const targetId = target === null ? 0 : context.nodeId(target)
        context.write({ type: EventType.Perf, metric, value, targetId }, context.time(time))
    }
    const shifts = new LayoutShifts()
    const interactions = new Interactions<Node | null>()
    const handlers = new Map<string, (entry: PerformanceEntry) => void>([
        [
            'navigation',
            entry => {
                if (isNavigation(entry) && entry.responseStart > 0) {
                    write('TTFB', entry.responseStart, entry.responseStart)
                }
            }
        ],
        [
            'paint',
            entry => {
                if (entry.name === 'first-contentful-paint') {
                    write('FCP', entry.startTime, entry.startTime)
                }
            }
        ],
        [
            'largest-contentful-paint',
            entry => {
                if (isLargestContentfulPaint(entry)) {
                    write('LCP', entry.startTime, entry.startTime, entry.element)
                }
            }
        ],
        [
            'layout-shift',
            entry => {
                if (!isLayoutShift(entry) || entry.hadRecentInput) {
                    return
                }
                write('layout-shift', entry.value, entry.startTime, entry.sources[0]?.node ?? null)
                const cls = shifts.add(entry.value, entry.startTime)
                if (cls !== undefined) {
                    write('CLS', cls, entry.startTime)
                }
            }
        ],
        [
            'event',
            entry => {
                // Events of no interaction, such as mouse moves, have no id.
                if (!isEventTiming(entry) || !(entry.interactionId > 0)) {
                    return
                }
                const inp = interactions.add(entry.interactionId, entry.duration, entry.target)
                if (inp !== undefined) {
                    write('INP', inp.duration, entry.startTime, inp.target)
                }
            }
        ]
    ])
    const supported = Observer.supportedEntryTypes
    if (longTasks) {
        const type = supported.includes('long-animation-frame') ? 'long-animation-frame' : 'longtask'
        const metric = type === 'longtask' ? 'long-task' : type
        handlers.set(type, entry => write(metric, entry.duration, entry.startTime))
    }
    const take = (entries: readonly PerformanceEntry[]): void => {
        for (const entry of entries) {
            try {
                handlers.get(entry.entryType)?.(entry)
            } catch (error) {
                context.onError(error)
            }
        }
    }
    const observer = new Observer(list => take(list.getEntries()))
    for (const type of handlers.keys()) {
        if (supported.includes(type)) {
            // Not in the DOM types yet.
            const init: PerformanceObserverInit & { durationThreshold?: number } = { type, buffered: true }
            if (type === 'event') {
                init.durationThreshold = EVENT_THRESHOLD
            }
            try {
                observer.observe(init)
            } catch (error) {
                context.onError(error)
            }
        }
    }
    return () => {
        take(observer.takeRecords())
        observer.disconnect()
    }
}

function isNavigation(entry: PerformanceEntry): entry is PerformanceNavigationTiming {
    return entry.entryType === 'navigation'
}

function isLargestContentfulPaint(entry: PerformanceEntry): entry is LargestContentfulPaint {
    return entry.entryType === 'largest-contentful-paint'
}

function isLayoutShift(entry: PerformanceEntry): entry is LayoutShift {
    return entry.entryType === 'layout-shift'
}

function isEventTiming(entry: PerformanceEntry): entry is PerformanceEventTiming {
    return entry.entryType === 'event'
}
