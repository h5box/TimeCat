import { consolePlugin } from '@timecat-js/plugin-console'
import { mediaPlugin } from '@timecat-js/plugin-media'
import { record } from '@timecat-js/recorder'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { toBase64 } from '../src/embed.ts'
import { TimecatPlayer } from '../src/index.ts'

let recording: Blob
/** A recording of a page with a video, whose playback state is recorded. */
let withMedia: Blob

const added: Element[] = []

afterEach(() => {
    for (const element of added.splice(0)) {
        element.remove()
    }
})

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/** Records the test page: a paragraph whose text changes, a console error and an event of the application. */
beforeAll(async () => {
    const paragraph = document.createElement('p')
    paragraph.textContent = 'before'
    document.body.append(paragraph)
    // The console plugin calls the method it wraps, which would print.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
        const recorder = record({ worker: false, plugins: [consolePlugin()] })
        await recorder.ready
        await delay(50)
        paragraph.textContent = 'after'
        console.error('payment failed')
        recorder.addEvent('checkout', { total: 3 })
        await delay(50)
        recording = await recorder.stop()
    } finally {
        error.mockRestore()
        paragraph.remove()
    }
    const video = document.createElement('video')
    document.body.append(video)
    try {
        const recorder = record({ worker: false, plugins: [mediaPlugin()] })
        await recorder.ready
        withMedia = await recorder.stop()
    } finally {
        video.remove()
    }
})

function withRecording(target: TimecatPlayer): void {
    target.recording = recording
}

function create(setup: (target: TimecatPlayer) => void = () => undefined): TimecatPlayer {
    const element = document.createElement('timecat-player')
    element.style.cssText = 'width: 800px; height: 400px'
    setup(element)
    added.push(element)
    return element
}

/** Adds the element to the page and waits for it to show its recording. */
async function show(element: TimecatPlayer): Promise<TimecatPlayer> {
    const loaded = next(element, 'load')
    document.body.append(element)
    await loaded
    await element.updateComplete
    return element
}

function next(target: EventTarget, type: string): Promise<Event> {
    return new Promise((resolve, reject) => {
        target.addEventListener(type, resolve, { once: true })
        if (type !== 'error') {
            target.addEventListener('error', event => reject(event instanceof ErrorEvent ? event.error : event), {
                once: true
            })
        }
    })
}

function part(element: TimecatPlayer, selector: string): HTMLElement {
    return partOf(element, selector, HTMLElement)
}

function partOf<T extends Element>(element: TimecatPlayer, selector: string, type: abstract new () => T): T {
    const found = element.shadowRoot!.querySelector(selector)
    if (!(found instanceof type)) {
        throw new Error(`no ${selector}`)
    }
    return found
}

function parts<T extends Element = HTMLElement>(element: TimecatPlayer, selector: string): T[] {
    return [...element.shadowRoot!.querySelectorAll<T>(selector)]
}

function replayed(element: TimecatPlayer): string[] {
    return [...element.player!.document.querySelectorAll('p')].map(paragraph => paragraph.textContent ?? '')
}

function press(element: TimecatPlayer, key: string, target: Element = part(element, '.overlay')): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true }))
}

describe('<timecat-player>', () => {
    it('is defined', () => {
        expect(customElements.get('timecat-player')).toBe(TimecatPlayer)
        expect(document.createElement('timecat-player')).toBeInstanceOf(TimecatPlayer)
    })

    it('plays a recording given as a property, and dispatches what the player does', async () => {
        const element = await show(create(withRecording))
        expect(element.duration).toBeGreaterThan(0)
        expect(element.currentTime).toBe(0)
        expect(element.paused).toBe(true)
        expect(replayed(element)).toContain('before')
        expect(part(element, '.time').textContent).toBe('0:00 / 0:00')
        expect(parts(element, '.big-play')).toHaveLength(1)
        const ended = next(element, 'ended')
        const played = next(element, 'play')
        element.play()
        await played
        expect(element.paused).toBe(false)
        await ended
        expect(element.paused).toBe(true)
        expect(element.currentTime).toBe(element.duration)
        expect(replayed(element)).toContain('after')
    })

    it('loads the recording from src', async () => {
        const url = URL.createObjectURL(recording)
        try {
            const element = await show(create(target => target.setAttribute('src', url)))
            expect(replayed(element)).toContain('before')
        } finally {
            URL.revokeObjectURL(url)
        }
    })

    it('reads the segments of a recording from its children', async () => {
        const bytes = new Uint8Array(await recording.arrayBuffer())
        const element = create(target => {
            const script = document.createElement('script')
            script.type = 'application/x-timecat-recording'
            script.textContent = toBase64(bytes).join('\n')
            target.append(script)
        })
        await show(element)
        expect(replayed(element)).toContain('before')
    })

    it('says when there is no recording, or one it cannot play', async () => {
        const element = create()
        document.body.append(element)
        await element.updateComplete
        expect(part(element, '.message').textContent).toBe('No recording')
        expect(partOf(element, '.play', HTMLButtonElement).disabled).toBe(true)
        const failed = next(element, 'error')
        element.recording = new Uint8Array([1, 2, 3])
        const event = await failed
        await element.updateComplete
        expect(event).toBeInstanceOf(ErrorEvent)
        expect(part(element, '.message.error').textContent).toMatch(/^The recording cannot be played: /u)
        expect(element.player).toBeUndefined()
    })

    it('plays, pauses and seeks from its controls and the keyboard', async () => {
        const element = await show(create(withRecording))
        const button = partOf(element, '.play', HTMLButtonElement)
        expect(button.getAttribute('aria-label')).toBe('Play')
        button.click()
        await element.updateComplete
        expect(element.paused).toBe(false)
        expect(button.getAttribute('aria-label')).toBe('Pause')
        press(element, 'k')
        expect(element.paused).toBe(true)
        press(element, 'End')
        expect(element.currentTime).toBe(element.duration)
        press(element, 'ArrowLeft')
        expect(element.currentTime).toBe(0)
        press(element, 'ArrowRight', part(element, '.timeline'))
        expect(element.currentTime).toBe(element.duration)
        press(element, 'Home')
        expect(element.currentTime).toBe(0)
        // Keys typed into the search go there.
        element.panel = true
        await element.updateComplete
        press(element, 'End', part(element, '.search'))
        expect(element.currentTime).toBe(0)
        part(element, '.overlay').click()
        expect(element.paused).toBe(false)
        element.pause()
    })

    it('seeks where the timeline is pressed', async () => {
        const element = await show(create(withRecording))
        const timeline = part(element, '.timeline')
        // Synthetic pointers are not active ones, which only can be captured.
        timeline.setPointerCapture = () => undefined
        const { left, width, top } = timeline.getBoundingClientRect()
        const at = (share: number): PointerEventInit => ({
            clientX: left + width * share,
            clientY: top + 5,
            button: 0,
            pointerId: 1,
            bubbles: true
        })
        timeline.dispatchEvent(new PointerEvent('pointerdown', at(0.5)))
        expect(element.currentTime).toBeCloseTo(element.duration / 2, 0)
        timeline.dispatchEvent(new PointerEvent('pointermove', at(0.25)))
        expect(element.currentTime).toBeCloseTo(element.duration / 4, 0)
        await element.updateComplete
        expect(part(element, '.hover').textContent?.trim()).toBe('0:00')
        expect(timeline.getAttribute('aria-valuenow')).toBe(String(Math.round(element.currentTime)))
        timeline.dispatchEvent(new PointerEvent('pointerup', at(0.25)))
        timeline.dispatchEvent(new PointerEvent('pointermove', at(0.75)))
        expect(element.currentTime).toBeCloseTo(element.duration / 4, 0)
        timeline.dispatchEvent(new PointerEvent('pointerleave', at(1)))
        await element.updateComplete
        expect(parts(element, '.hover')).toEqual([])
    })

    it('plays at the speed asked for', async () => {
        const element = await show(create(withRecording))
        const select = partOf(element, '.speed', HTMLSelectElement)
        expect(select.value).toBe('1')
        select.value = '4'
        select.dispatchEvent(new Event('change'))
        await element.updateComplete
        expect(element.speed).toBe(4)
        expect(element.player!.speed).toBe(4)
        element.speed = 1.5
        await element.updateComplete
        expect(element.player!.speed).toBe(1.5)
        expect(select.value).toBe('1.5')
    })

    it('marks errors and events of the application on the timeline', async () => {
        const element = await show(create(withRecording))
        expect(parts(element, '.marker.error')).toHaveLength(1)
        expect(parts(element, '.marker.custom')).toHaveLength(1)
    })

    it('lists the events recorded beside the page, to filter, search and seek to', async () => {
        const element = await show(create(withRecording))
        expect(parts(element, '.panel')).toEqual([])
        part(element, '.events').click()
        await element.updateComplete
        expect(element.panel).toBe(true)
        expect(element.hasAttribute('panel')).toBe(true)
        const summaries = (): string[] => parts(element, '.summary').map(summary => summary.textContent ?? '')
        expect(summaries()).toEqual(['payment failed', 'checkout {"total":3}'])
        expect(parts(element, '.entry.error')).toHaveLength(1)
        expect(parts(element, '.filter').map(filter => filter.textContent?.replaceAll(/\s+/gu, ' ').trim())).toEqual([
            'All 2',
            'Console 1',
            'Network 0',
            'Perf 0',
            'Custom 1'
        ])
        const [, , network, , custom] = parts(element, '.filter')
        custom!.click()
        await element.updateComplete
        expect(summaries()).toEqual(['checkout {"total":3}'])
        network!.click()
        await element.updateComplete
        expect(part(element, '.none').textContent?.trim()).toBe('No events match.')
        partOf(element, '.filter', HTMLButtonElement).click()
        const search = partOf(element, '.search', HTMLInputElement)
        search.value = 'PAYMENT'
        search.dispatchEvent(new Event('input'))
        await element.updateComplete
        expect(summaries()).toEqual(['payment failed'])
        search.value = ''
        search.dispatchEvent(new Event('input'))
        await element.updateComplete

        const [, checkout] = element.player!.events
        partOf(element, '.entry:last-child .entry-head', HTMLButtonElement).click()
        await element.updateComplete
        expect(element.currentTime).toBe(checkout!.time)
        expect(part(element, '.detail').textContent).toBe('checkout\n{\n  "total": 3\n}')
        expect(parts(element, '.entry.past')).toHaveLength(2)
        await element.seek(0)
        await element.updateComplete
        expect(parts(element, '.entry.past').length).toBeLessThan(2)
    })

    it('replays again once moved, and lets go of the replay once removed', async () => {
        const element = await show(create(withRecording))
        const first = element.player
        const reloaded = next(element, 'load')
        document.body.prepend(element)
        await reloaded
        expect(element.player).not.toBe(first)
        expect(replayed(element)).toContain('before')
        element.remove()
        expect(element.player).toBeUndefined()
        expect(parts(element, '.stage > *')).toEqual([])
    })

    it('sets the volume of recorded media, and offers to unmute them once the player muted itself', async () => {
        const silent = await show(create(withRecording))
        expect(parts(silent, '.volume')).toEqual([])
        const element = await show(
            create(target => {
                target.recording = withMedia
                target.volume = 0.5
            })
        )
        const player = element.player!
        expect({ hasMedia: player.hasMedia, volume: player.volume, muted: player.muted }).toEqual({
            hasMedia: true,
            volume: 0.5,
            muted: false
        })
        const volumechange = vi.fn<() => void>()
        element.addEventListener('volumechange', volumechange)
        const slider = partOf(element, '.volume input', HTMLInputElement)
        expect(slider.value).toBe('0.5')
        slider.value = '0.25'
        slider.dispatchEvent(new Event('input'))
        await element.updateComplete
        expect({ volume: element.volume, player: player.volume }).toEqual({ volume: 0.25, player: 0.25 })
        part(element, '.mute').click()
        await element.updateComplete
        expect({ muted: element.muted, player: player.muted, slider: slider.value }).toEqual({
            muted: true,
            player: true,
            slider: '0'
        })
        expect(part(element, '.mute').getAttribute('aria-label')).toBe('Unmute')
        press(element, 'm')
        await element.updateComplete
        expect({ muted: element.muted, player: player.muted, slider: slider.value }).toEqual({
            muted: false,
            player: false,
            slider: '0.25'
        })
        expect(volumechange).toHaveBeenCalledTimes(3)
        expect(parts(element, '.unmute')).toEqual([])
        // As when the browser does not let media play with sound before the viewer interacted with the page.
        player.muted = true
        await element.updateComplete
        expect(element.muted).toBe(true)
        part(element, '.unmute').click()
        await element.updateComplete
        expect({ muted: element.muted, player: player.muted }).toEqual({ muted: false, player: false })
        expect(parts(element, '.unmute')).toEqual([])
        // Muted from the start, as asked.
        const muted = await show(
            create(target => {
                target.recording = withMedia
                target.setAttribute('muted', '')
            })
        )
        expect(muted.player!.muted).toBe(true)
        expect(parts(muted, '.unmute')).toEqual([])
    })

    it('plays a stream live, and goes back to its edge', async () => {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>({
            start(streamController) {
                controller = streamController
            }
        })
        const paragraph = document.createElement('p')
        paragraph.textContent = 'live'
        document.body.append(paragraph)
        const recorder = record({ worker: false, latency: 100, onData: bytes => controller!.enqueue(bytes) })
        try {
            await recorder.ready
            const element = await show(
                create(target => {
                    target.recording = stream
                })
            )
            const live = (): HTMLElement => part(element, '.live')
            expect({ live: element.live, paused: element.paused, edge: live().classList.contains('edge') }).toEqual({
                live: true,
                paused: true,
                edge: false
            })
            expect(replayed(element)).toEqual(['live'])
            live().click()
            await element.updateComplete
            expect({ paused: element.paused, edge: live().classList.contains('edge') }).toEqual({
                paused: false,
                edge: true
            })
            expect(live().getAttribute('aria-label')).toBe('Live')
            // More comes as it is recorded: the timeline and the events grow.
            const duration = element.duration
            paragraph.textContent = 'later'
            recorder.addEvent('checkout', { total: 3 })
            await vi.waitFor(() => expect(replayed(element)).toEqual(['later']))
            expect(element.duration).toBeGreaterThan(duration)
            expect(part(element, '.events .count').textContent).toBe('1')
            press(element, 'Home')
            await element.updateComplete
            expect({ paused: element.paused, edge: live().classList.contains('edge') }).toEqual({
                paused: false,
                edge: false
            })
            expect(live().getAttribute('aria-label')).toBe('Go live')
            live().click()
            await element.updateComplete
            expect(live().classList.contains('edge')).toBe(true)
            // Paused, it falls behind.
            element.pause()
            await element.updateComplete
            expect(live().classList.contains('edge')).toBe(false)
            const ended = next(element, 'durationchange')
            await recorder.stop()
            controller!.close()
            await ended
            await vi.waitFor(() => expect(element.live).toBe(false))
            await element.updateComplete
            expect(parts(element, '.live')).toEqual([])
        } finally {
            paragraph.remove()
        }
    })

    it('plays once loaded when asked to before, or when autoplay is set', async () => {
        const asked = create(withRecording)
        asked.play()
        expect(asked.paused).toBe(false)
        const played = next(asked, 'play')
        document.body.append(asked)
        await played
        const autoplay = create(target => {
            target.recording = recording
            target.setAttribute('autoplay', '')
        })
        const autoplayed = next(autoplay, 'play')
        document.body.append(autoplay)
        await autoplayed
        expect(autoplay.paused).toBe(false)
    })
})
