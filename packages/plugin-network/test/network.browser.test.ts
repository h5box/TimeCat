import { EventType } from '@timecat-js/protocol'
import type { NetworkEvent } from '@timecat-js/protocol'
import type { PluginContext, PluginEvent } from '@timecat-js/recorder'
import { afterEach, describe, expect, it } from 'vitest'
import { networkPlugin } from '../src/index.ts'
import type { NetworkPluginOptions } from '../src/index.ts'

const stops: (() => void)[] = []

afterEach(() => {
    for (const stop of stops.splice(0)) {
        stop()
    }
})

function start(options: NetworkPluginOptions = {}) {
    const events: (NetworkEvent & { time: number })[] = []
    const errors: unknown[] = []
    const context: PluginContext = {
        window,
        now: () => Math.round(performance.now()),
        time: time => Math.round(time),
        write(event: PluginEvent, time = 0) {
            if (event.type === EventType.Network) {
                events.push({ ...event, time })
            }
        },
        nodeId: () => 0,
        onError: error => void errors.push(error)
    }
    const stopPlugin = networkPlugin(options).start(context)
    let stopped = false
    const stop = (): void => {
        if (!stopped && typeof stopPlugin === 'function') {
            stopPlugin()
        }
        stopped = true
    }
    stops.push(stop)
    return { events, errors, stop }
}

/** The page the tests run in, which the test server serves. */
const page = location.href
/** A port nothing listens on. */
const refused = 'http://127.0.0.1:9/'

function xhr(method: string, url: string, abort = false): Promise<void> {
    return new Promise(resolve => {
        const request = new XMLHttpRequest()
        request.open(method, url)
        request.addEventListener('loadend', () => resolve())
        request.send()
        if (abort) {
            request.abort()
        }
    })
}

describe('networkPlugin', () => {
    it('records requests made with fetch, as they end', async () => {
        const { events, errors, stop } = start({ resources: false })
        const before = performance.now()
        await fetch(page)
        await fetch(new Request(page, { method: 'HEAD' }))
        await fetch(new URL(page), { method: 'head' })
        const after = performance.now()
        stop()
        expect(
            events.map(({ initiator, method, url, status, error }) => ({ initiator, method, url, status, error }))
        ).toEqual([
            { initiator: 'fetch', method: 'GET', url: page, status: 200, error: '' },
            { initiator: 'fetch', method: 'HEAD', url: page, status: 200, error: '' },
            { initiator: 'fetch', method: 'HEAD', url: page, status: 200, error: '' }
        ])
        for (const event of events) {
            expect(event.time).toBeGreaterThanOrEqual(Math.floor(before))
            expect(event.time).toBeLessThanOrEqual(Math.ceil(after))
            expect(event.duration).toBeLessThanOrEqual(Math.ceil(after - before))
        }
        expect(errors).toEqual([])
    })

    it('records how a fetch failed, which the page still sees', async () => {
        const { events, stop } = start({ resources: false })
        await expect(fetch(refused)).rejects.toThrow(TypeError)
        const controller = new AbortController()
        const aborted = fetch(page, { signal: controller.signal })
        controller.abort()
        await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
        stop()
        expect(events).toMatchObject([
            { url: refused, status: 0, size: 0 },
            { url: page, status: 0, error: 'abort' }
        ])
        expect(events[0]!.error).not.toBe('')
    })

    it('records requests made with XMLHttpRequest', async () => {
        const { events, stop } = start({ resources: false })
        await xhr('get', page)
        await xhr('GET', refused)
        await xhr('GET', page, true)
        stop()
        expect(
            events.map(({ initiator, method, url, status, error }) => ({ initiator, method, url, status, error }))
        ).toEqual([
            { initiator: 'xmlhttprequest', method: 'GET', url: page, status: 200, error: '' },
            { initiator: 'xmlhttprequest', method: 'GET', url: refused, status: 0, error: 'error' },
            { initiator: 'xmlhttprequest', method: 'GET', url: page, status: 0, error: 'abort' }
        ])
    })

    it('records beacons', () => {
        const { events, stop } = start({ resources: false })
        expect(navigator.sendBeacon(new URL('/timecat-beacon', page), 'data')).toBe(true)
        stop()
        expect(events).toMatchObject([
            { initiator: 'beacon', method: 'POST', url: new URL('/timecat-beacon', page).href, status: 0, error: '' }
        ])
    })

    it('records the resources the page loads otherwise, once each', async () => {
        const { events, stop } = start()
        const url = new URL(`/package.json?image=${Math.random()}`, page).href
        const image = new Image()
        await new Promise(resolve => {
            image.addEventListener('load', resolve)
            image.addEventListener('error', resolve)
            image.src = url
        })
        await fetch(page)
        stop()
        expect(events.filter(event => event.initiator === 'img')).toMatchObject([{ method: 'GET', url, error: '' }])
        expect(events.filter(event => event.initiator === 'fetch')).toHaveLength(1)
    })

    it('records URLs as the option rewrites them, and no local content', async () => {
        const { events, stop } = start({
            resources: false,
            url: url => (url.includes('secret') ? null : url.replace(/token=[^&]*/u, 'token=hidden'))
        })
        const credentials = new URL(page)
        credentials.username = 'user'
        credentials.password = 'password'
        await xhr('GET', `${page}?token=abc&x=1`)
        await xhr('GET', `${page}?secret=1`)
        await xhr('GET', credentials.href)
        await fetch(URL.createObjectURL(new Blob(['local'])))
        await fetch('data:text/plain,local')
        stop()
        expect(events.map(event => event.url)).toEqual([`${page}?token=hidden&x=1`, page])
    })

    it('puts fetch, XMLHttpRequest and sendBeacon back once stopped', async () => {
        const fetchBefore: unknown = Reflect.get(window, 'fetch')
        const openBefore: unknown = Reflect.get(XMLHttpRequest.prototype, 'open')
        const sendBefore: unknown = Reflect.get(XMLHttpRequest.prototype, 'send')
        const { events, stop } = start({ resources: false })
        expect(Reflect.get(window, 'fetch')).not.toBe(fetchBefore)
        expect(Object.hasOwn(navigator, 'sendBeacon')).toBe(true)
        stop()
        expect(Reflect.get(window, 'fetch')).toBe(fetchBefore)
        expect(Reflect.get(XMLHttpRequest.prototype, 'open')).toBe(openBefore)
        expect(Reflect.get(XMLHttpRequest.prototype, 'send')).toBe(sendBefore)
        expect(Object.hasOwn(navigator, 'sendBeacon')).toBe(false)
        await fetch(page)
        expect(events).toEqual([])
    })
})
