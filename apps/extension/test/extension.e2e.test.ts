import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { TimecatPlayer } from '@timecat-js/player'
import { EventType, SegmentReader } from '@timecat-js/protocol'
import { chromium } from 'playwright'
import type { BrowserContext, Page, Worker } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from '../build.ts'
import type { Request, StartResult, Status } from '../src/messages.ts'

/** A checkout page that logs an error and fails a request when paying, and the page it links to. */
const PAGES: Record<string, string> = {
    '/': `<!doctype html>
<title>Checkout</title>
<h1>Checkout</h1>
<input id="name">
<button id="pay">Pay</button>
<a id="next" href="/done">Next</a>
<script>
    addEventListener('pageshow', event => {
        window.restored = event.persisted
    })
    document.getElementById('pay').addEventListener('click', async () => {
        console.error('payment failed')
        await fetch('/api/pay', { method: 'POST' })
        document.querySelector('h1').textContent = 'Paid'
    })
</script>`,
    '/done': `<!doctype html>
<title>Done</title>
<p id="thanks">Thank you</p>
<a id="home" href="/">Home</a>`
}

let server: http.Server
let origin: string
let extensionDir: string
let profileDir: string
let downloadDir: string
let context: BrowserContext
let background: Worker
let extensionId: string

beforeAll(async () => {
    server = http.createServer((request, response) => {
        const page = PAGES[request.url ?? '']
        if (page === undefined) {
            response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"declined"}')
        } else {
            response.writeHead(200, { 'content-type': 'text/html' }).end(page)
        }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
        throw new Error('the server listens on no port')
    }
    origin = `http://127.0.0.1:${address.port}`

    extensionDir = await mkdtemp(path.join(os.tmpdir(), 'timecat-extension-'))
    profileDir = await mkdtemp(path.join(os.tmpdir(), 'timecat-profile-'))
    downloadDir = await mkdtemp(path.join(os.tmpdir(), 'timecat-downloads-'))
    await build(extensionDir)
    const executablePath = process.env['CHROMIUM_EXECUTABLE_PATH']
    context = await chromium.launchPersistentContext(profileDir, {
        // Extensions need Chromium itself in its new headless mode, not the headless shell Playwright defaults to.
        ...(executablePath === undefined ? { channel: 'chromium' } : { executablePath }),
        headless: true,
        // Playwright turns the back/forward cache off, which pages of the extension's recording come back from.
        ignoreDefaultArgs: ['--disable-back-forward-cache'],
        acceptDownloads: true,
        args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    })
    background = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    extensionId = new URL(background.url()).host
})

afterAll(async () => {
    await context?.close()
    await new Promise(resolve => server?.close(resolve))
    await rm(extensionDir, { recursive: true, force: true })
    await rm(profileDir, { recursive: true, force: true })
    await rm(downloadDir, { recursive: true, force: true })
})

function extensionUrl(file: string): string {
    return `chrome-extension://${extensionId}/${file}`
}

/** Asks the background as the extension's pages do, from a page of the extension's. */
async function ask<T>(request: Request): Promise<T> {
    const page = await context.newPage()
    try {
        await page.goto(extensionUrl('recordings.html'))
        return await page.evaluate(message => chrome.runtime.sendMessage<Request, T>(message), request)
    } finally {
        await page.close()
    }
}

function tabIdOf(url: string): Promise<number> {
    return background.evaluate(async address => {
        const [tab] = await chrome.tabs.query({ url: address })
        if (tab?.id === undefined) {
            throw new Error(`no tab shows ${address}`)
        }
        return tab.id
    }, url)
}

async function waitForPages(tabId: number, pages: number): Promise<void> {
    await expect.poll(async () => (await ask<Status>({ type: 'status', tabId })).pages, { timeout: 10_000 }).toBe(pages)
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/** Stops the extension's service worker, as Chrome does after 30 seconds without events. */
async function stopServiceWorker(): Promise<void> {
    const page = await context.newPage()
    try {
        await page.goto(extensionUrl('recordings.html'))
        const cdp = await context.newCDPSession(page)
        const running = new Set<string>()
        const stopped = new Promise<void>(resolve => {
            cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
                for (const version of versions) {
                    if (version.scriptURL !== extensionUrl('background.js')) {
                        continue
                    }
                    if (version.runningStatus === 'stopped') {
                        resolve()
                    } else {
                        running.add(version.versionId)
                    }
                }
            })
        })
        await cdp.send('ServiceWorker.enable')
        await expect.poll(() => running.size).toBeGreaterThan(0)
        await Promise.all([...running].map(versionId => cdp.send('ServiceWorker.stopWorker', { versionId })))
        await stopped
    } finally {
        await page.close()
    }
}

/** Stops recording the tab and gives the page of the player that opens then. */
async function stopRecording(tabId: number): Promise<Page> {
    const opened = context.waitForEvent('page', page => page.url().startsWith(extensionUrl('player.html')))
    await ask<null>({ type: 'stop', tabId })
    return opened
}

/** Seeks the player of the page to its end and gives the text of what `selector` selects in the replay then. */
async function textAtEnd(page: Page, selector: string): Promise<string | null | undefined> {
    const duration = await loaded(page)
    return page.evaluate(
        async ([total, query]) => {
            const element = document.querySelector<TimecatPlayer>('timecat-player')
            await element?.seek(total)
            return element?.player?.document.querySelector(query)?.textContent
        },
        [duration, selector] as const
    )
}

/** Waits for the player of the page to show its recording, and gives its duration. */
async function loaded(page: Page): Promise<number> {
    await page.waitForFunction(
        () => (document.querySelector<TimecatPlayer>('timecat-player')?.duration ?? 0) > 0,
        undefined,
        { timeout: 15_000 }
    )
    return page.evaluate(() => document.querySelector<TimecatPlayer>('timecat-player')?.duration ?? 0)
}

describe('the extension', () => {
    let player: Page

    it('records a tab across its pages, then shows the recording', async () => {
        const tab = await context.newPage()
        await tab.goto(`${origin}/`)
        const tabId = await tabIdOf(`${origin}/`)
        expect(await ask<Status>({ type: 'status', tabId })).toEqual({ recording: false })

        expect(await ask<StartResult>({ type: 'start', tabId })).toEqual({ ok: true })
        await waitForPages(tabId, 1)
        await delay(300)
        await tab.fill('#name', 'Ada Lovelace')
        await tab.click('#pay')
        await tab.waitForFunction(() => document.querySelector('h1')?.textContent === 'Paid')
        await delay(1200)
        await tab.click('#next')
        await tab.waitForURL(`${origin}/done`)
        await waitForPages(tabId, 2)
        await delay(1200)

        const opened = context.waitForEvent('page', page => page.url().startsWith(extensionUrl('player.html')))
        await ask<null>({ type: 'stop', tabId })
        player = await opened
        expect(await ask<Status>({ type: 'status', tabId })).toEqual({ recording: false })

        const duration = await loaded(player)
        expect(duration).toBeGreaterThan(1000)
        expect(await player.locator('#title').textContent()).toBe('Checkout')
        expect(await player.locator('#meta').textContent()).toContain('2 pages')
        const types = await player.evaluate(
            () =>
                document
                    .querySelector<TimecatPlayer>('timecat-player')
                    ?.player?.events.map(({ event }) => event.type) ?? []
        )
        expect(types).toContain(EventType.Console)
        expect(types).toContain(EventType.Network)

        // The first page, after paying: the input is masked, as the recorder masks form values.
        const firstPage = await player.evaluate(async () => {
            const element = document.querySelector<TimecatPlayer>('timecat-player')
            await element?.seek(1100)
            const replayed = element?.player?.document
            return {
                heading: replayed?.querySelector('h1')?.textContent,
                input: replayed?.querySelector('input')?.value
            }
        })
        expect(firstPage.heading).toBe('Paid')
        expect(firstPage.input).toMatch(/^\*+$/u)

        // The second page, at the end.
        const thanks = await player.evaluate(async total => {
            const element = document.querySelector<TimecatPlayer>('timecat-player')
            await element?.seek(total)
            return element?.player?.document.querySelector('#thanks')?.textContent
        }, duration)
        expect(thanks).toBe('Thank you')
        await tab.close()
    })

    it('lists the recording', async () => {
        const page = await context.newPage()
        await page.goto(extensionUrl('recordings.html'))
        const item = page.locator('.recording')
        await expect.poll(() => item.count()).toBe(1)
        expect(await item.locator('h2').textContent()).toBe('Checkout')
        expect(await item.locator('.url').textContent()).toBe(`${origin}/`)
        await page.close()
    })

    it('exports the recording as an HTML page that plays it', async () => {
        const download = player.waitForEvent('download')
        await player.click('#export')
        const file = path.join(downloadDir, (await download).suggestedFilename())
        await (await download).saveAs(file)
        const html = await readFile(file, 'utf8')
        expect(html).toContain('<timecat-player')
        const page = await context.newPage()
        await page.goto(`file://${file}`)
        expect(await loaded(page)).toBeGreaterThan(1000)
        await page.close()
    })

    it('downloads the recording as a TCR file', async () => {
        const download = player.waitForEvent('download')
        await player.click('#download')
        const file = await (await download).path()
        expect((await download).suggestedFilename()).toMatch(/^timecat-127\.0\.0\.1-\d{8}-\d{4}\.tcr$/u)
        // Both pages, each a header and its chunks, whole.
        const reader = new SegmentReader()
        const items = reader.push(await readFile(file))
        expect(reader.pending).toBe(0)
        const sessionId = await player.evaluate(
            () => document.querySelector<TimecatPlayer>('timecat-player')?.player?.sessionId
        )
        const headers = items.flatMap(item => (item.header === undefined ? [] : [item.header]))
        expect(headers.map(header => [header.sessionId, header.segment])).toEqual([
            [sessionId, 0],
            [sessionId, 1]
        ])
        expect(items.length).toBeGreaterThan(4)
    })

    it('deletes the recording', async () => {
        player.once('dialog', dialog => {
            dialog.accept().catch(() => undefined)
        })
        await player.click('#delete')
        await player.waitForURL(extensionUrl('recordings.html'))
        await expect.poll(() => player.locator('#empty').isVisible()).toBe(true)
        await player.close()
    })

    it('ends the recording of a tab that closes', async () => {
        const tab = await context.newPage()
        await tab.goto(`${origin}/done`)
        const tabId = await tabIdOf(`${origin}/done`)
        expect(await ask<StartResult>({ type: 'start', tabId })).toEqual({ ok: true })
        await waitForPages(tabId, 1)
        await delay(1200)
        await tab.close()
        const page = await context.newPage()
        await page.goto(extensionUrl('recordings.html'))
        await expect.poll(() => page.locator('.recording').count()).toBe(1)
        await expect.poll(() => page.locator('.recording .live').count()).toBe(0)
        await page.close()
    })

    it('goes on recording a page after the service worker stopped', async () => {
        const tab = await context.newPage()
        await tab.goto(`${origin}/`)
        const tabId = await tabIdOf(`${origin}/`)
        expect(await ask<StartResult>({ type: 'start', tabId })).toEqual({ ok: true })
        await waitForPages(tabId, 1)
        await delay(1200)
        await stopServiceWorker()
        await tab.click('#pay')
        await tab.waitForFunction(() => document.querySelector('h1')?.textContent === 'Paid')
        await delay(1200)
        const replay = await stopRecording(tabId)
        expect(await textAtEnd(replay, 'h1')).toBe('Paid')
        expect(await replay.locator('#meta').textContent()).toContain('1 page')
        await replay.close()
        await tab.close()
    })

    it('records a page that comes back from the back/forward cache as a page of its own', async () => {
        const tab = await context.newPage()
        await tab.goto(`${origin}/`)
        const tabId = await tabIdOf(`${origin}/`)
        expect(await ask<StartResult>({ type: 'start', tabId })).toEqual({ ok: true })
        await waitForPages(tabId, 1)
        await tab.click('#next')
        await tab.waitForURL(`${origin}/done`)
        await waitForPages(tabId, 2)
        // A page from the cache does not load again.
        await tab.goBack({ waitUntil: 'commit' })
        await tab.waitForFunction(() => Reflect.get(window, 'restored') === true)
        await waitForPages(tabId, 3)
        await delay(300)
        await tab.click('#pay')
        await tab.waitForFunction(() => document.querySelector('h1')?.textContent === 'Paid')
        await delay(1200)
        const replay = await stopRecording(tabId)
        expect(await textAtEnd(replay, 'h1')).toBe('Paid')
        expect(await replay.locator('#meta').textContent()).toContain('3 pages')
        await replay.close()
        await tab.close()
    })

    it('does not record pages the browser shows of its own', async () => {
        const tabId = await background.evaluate(async () => (await chrome.tabs.create({ url: 'chrome://version' })).id)
        expect(tabId).toBeDefined()
        expect(await ask<StartResult>({ type: 'start', tabId: tabId ?? -1 })).toEqual({
            ok: false,
            error: 'unsupported'
        })
    })
})
