import { EventType } from '@timecat-js/protocol'
import type { PerfEvent } from '@timecat-js/protocol'
import type { PluginContext, PluginEvent } from '@timecat-js/recorder'
import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { perfPlugin } from '../src/index.ts'
import type { PerfPluginOptions } from '../src/index.ts'

const added: Element[] = []

afterEach(() => {
    for (const element of added.splice(0)) {
        element.remove()
    }
})

function start(options: PerfPluginOptions = {}) {
    const origin = performance.now()
    const events: (PerfEvent & { time: number })[] = []
    const errors: unknown[] = []
    const ids = new Map<Node, number>()
    const time = (at: number): number => Math.max(0, Math.round(at - origin))
    const context: PluginContext = {
        window,
        now: () => time(performance.now()),
        time,
        microseconds: at => Math.max(0, Math.round((at - origin) * 1000)),
        write(event: PluginEvent, at = 0) {
            if (event.type === EventType.Perf) {
                events.push({ ...event, time: at })
            }
        },
        openMedia() {
            throw new Error('plugins of this kind write no media')
        },
        nodeId: node => ids.get(node) ?? 0,
        onError: error => void errors.push(error)
    }
    const stopPlugin = perfPlugin(options).start(context)
    const stop = (): void => {
        if (typeof stopPlugin === 'function') {
            void stopPlugin()
        }
    }
    return { events, errors, ids, stop }
}

/** Waits for `count` frames to be rendered. */
function frames(count: number): Promise<void> {
    return new Promise(resolve => {
        const next = (left: number): void => {
            if (left === 0) {
                setTimeout(resolve, 0)
            } else {
                requestAnimationFrame(() => next(left - 1))
            }
        }
        next(count)
    })
}

/** Waits until `done` holds, which the browser may take a while to make so: it reports entries when it can. */
function until(done: () => boolean, timeout = 2000): Promise<void> {
    const end = performance.now() + timeout
    return new Promise(resolve => {
        const check = (): void => {
            if (done() || performance.now() > end) {
                resolve()
            } else {
                setTimeout(check, 20)
            }
        }
        check()
    })
}

function supports(type: string): boolean {
    return PerformanceObserver.supportedEntryTypes.includes(type)
}

function isLong(event: PerfEvent): boolean {
    return event.metric === 'long-animation-frame' && event.value >= 120
}

function busy(ms: number): void {
    const end = performance.now() + ms
    while (performance.now() < end) {
        // Blocks the main thread.
    }
}

function box(height: number): HTMLDivElement {
    const element = document.createElement('div')
    element.style.cssText = `width: 200px; height: ${height}px; background: teal`
    added.push(element)
    return element
}

describe('perfPlugin', () => {
    it('records the time to first byte of the page, at the start of the recording', () => {
        const { events, errors, stop } = start()
        stop()
        const ttfb = events.find(event => event.metric === 'TTFB')
        expect(ttfb).toMatchObject({ time: 0, targetId: 0 })
        expect(ttfb!.value).toBeGreaterThan(0)
        expect(errors).toEqual([])
    })

    // Only Chromium-based browsers report layout shifts and long animation frames.
    it.skipIf(!supports('layout-shift'))('records layout shifts and the cumulative layout shift', async () => {
        const { events, ids, stop } = start()
        const moved = box(100)
        ids.set(moved, 7)
        document.body.prepend(moved)
        await frames(3)
        moved.before(box(60))
        await frames(3)
        stop()
        const shifts = events.filter(event => event.metric === 'layout-shift' && event.targetId === 7)
        expect(shifts).toHaveLength(1)
        expect(shifts[0]!.value).toBeGreaterThan(0)
        expect(shifts[0]!.time).toBeGreaterThan(0)
        const cls = events.filter(event => event.metric === 'CLS')
        expect(cls.at(-1)!.value).toBeGreaterThanOrEqual(shifts[0]!.value)
    })

    it.skipIf(!supports('long-animation-frame'))('records long animation frames, unless asked not to', async () => {
        const { events, stop } = start()
        const quiet = start({ longTasks: false })
        await frames(1)
        busy(120)
        await until(() => events.some(isLong))
        stop()
        quiet.stop()
        expect(events.some(isLong)).toBe(true)
        expect(quiet.events.filter(event => event.metric === 'long-animation-frame')).toEqual([])
    })

    it.skipIf(!supports('event') || !('interactionId' in PerformanceEventTiming.prototype))(
        'records interaction to next paint, with the target of the interaction',
        async () => {
            const { events, ids, stop } = start()
            const button = document.createElement('button')
            button.textContent = 'slow'
            button.addEventListener('click', () => busy(80))
            document.body.append(button)
            added.push(button)
            ids.set(button, 9)
            await userEvent.click(button)
            await until(() => events.some(event => event.metric === 'INP' && event.value >= 80))
            stop()
            const inp = events.filter(event => event.metric === 'INP')
            expect(inp.length).toBeGreaterThan(0)
            expect(inp.at(-1)!.value).toBeGreaterThanOrEqual(80)
            expect(inp.at(-1)!.targetId).toBe(9)
        }
    )
})
