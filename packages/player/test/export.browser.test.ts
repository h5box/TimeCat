import { TcrDecodeError } from '@timecat-js/player-core'
import { record } from '@timecat-js/recorder'
import { afterEach, describe, expect, it } from 'vitest'
import { exportHtml } from '../src/export.ts'
import type { TimecatPlayer } from '../src/index.ts'

const frames: HTMLIFrameElement[] = []

afterEach(() => {
    for (const frame of frames.splice(0)) {
        frame.remove()
    }
})

async function recordPage(text: string): Promise<Blob> {
    const paragraph = document.createElement('p')
    paragraph.textContent = text
    document.body.append(paragraph)
    try {
        const recorder = record({ worker: false })
        await recorder.ready
        return await recorder.stop()
    } finally {
        paragraph.remove()
    }
}

/** Opens a page in a frame and waits until its player shows the recording. */
async function open(page: Blob): Promise<TimecatPlayer> {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'width: 800px; height: 600px'
    frames.push(frame)
    const url = URL.createObjectURL(page)
    try {
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
        frame.src = url
        document.body.append(frame)
        await loaded
    } finally {
        URL.revokeObjectURL(url)
    }
    const element = frame.contentDocument!.querySelector('timecat-player')!
    const end = performance.now() + 5000
    while (element.player === undefined && performance.now() < end) {
        // oxlint-disable-next-line no-await-in-loop -- the page loads the recording on its own
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(element.player).toBeDefined()
    return element
}

describe('exportHtml', () => {
    it('writes a page that plays the recording with nothing to fetch', async () => {
        const recording = await recordPage('exported </script><!-- text')
        const page = await exportHtml(recording, { title: 'Checkout <failed> & retried' })
        expect(page.type).toBe('text/html')
        const html = await page.text()
        expect(html).toMatch(/^<!doctype html>/u)
        expect(html).toContain('<title>Checkout &lt;failed&gt; &amp; retried</title>')
        // One element, whose script ends where it should.
        expect(html.match(/<\/script>/gu)).toHaveLength(2)
        expect(html).not.toContain('<!--')
        const element = await open(page)
        expect(element.ownerDocument.title).toBe('Checkout <failed> & retried')
        const texts = [...element.player!.document.querySelectorAll('p')].map(p => p.textContent)
        expect(texts).toContain('exported </script><!-- text')
        expect(element.paused).toBe(true)
    })

    it('writes all segments of a session, titled by when it started, and plays at once if asked', async () => {
        const recording = await recordPage('segment')
        const page = await exportHtml([recording], { autoplay: true })
        const html = await page.text()
        expect(html).toMatch(/<title>TimeCat recording, \d{4}-\d\d-\d\dT\d\d:\d\dZ<\/title>/u)
        expect(html).toContain('<timecat-player autoplay>')
        const element = await open(page)
        expect(element.autoplay).toBe(true)
    })

    it('rejects what is not a recording, and segments of different sessions', async () => {
        await expect(exportHtml(new Uint8Array([1, 2, 3]))).rejects.toThrow(TcrDecodeError)
        await expect(exportHtml([])).rejects.toThrow(TypeError)
        const sessions = await Promise.all([recordPage('one'), recordPage('two')])
        await expect(exportHtml(sessions)).rejects.toThrow(RangeError)
    })
})
