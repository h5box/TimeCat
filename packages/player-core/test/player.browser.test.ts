import { EventType, PointerAction, PointerType } from '@timecat-js/protocol'
import type { TcrEvent } from '@timecat-js/protocol'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFrame } from '../src/dom.ts'
import { createPlayer, TcrDecodeError } from '../src/index.ts'
import type { Player, PlayerOptions, RecordingSource } from '../src/index.ts'
import { operations, recordingOf } from './operations.ts'
import {
    build,
    concat,
    describeDom,
    mutations,
    pageOf,
    SESSION,
    writeChunks,
    writeRecording,
    writeSync
} from './recording.ts'
import type { Timed } from './recording.ts'

const containers: Element[] = []
const players: Player[] = []

afterEach(() => {
    for (const player of players.splice(0)) {
        player.destroy()
    }
    for (const container of containers.splice(0)) {
        container.remove()
    }
})

function containerOf(): HTMLElement {
    const container = document.createElement('div')
    container.style.cssText = 'width: 400px; height: 300px'
    document.body.append(container)
    containers.push(container)
    return container
}

async function open(
    source: RecordingSource | RecordingSource[] | ReadableStream<Uint8Array>,
    options: Partial<PlayerOptions> = {}
): Promise<Player> {
    const player = await createPlayer(source, { ...options, container: options.container ?? containerOf() })
    players.push(player)
    return player
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function once(target: EventTarget, type: string): Promise<void> {
    return new Promise(resolve => target.addEventListener(type, () => resolve(), { once: true }))
}

/** A stream that bytes are pushed into, as a live recording sends them. */
function feed() {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
        start(started) {
            controller = started
        },
        cancel() {
            cancelled = true
        }
    })
    return {
        stream,
        push: (bytes: Uint8Array) => controller.enqueue(bytes),
        close: () => controller.close(),
        fail: (error: unknown) => controller.error(error),
        cancelled: () => cancelled
    }
}

/** Text of the replayed paragraphs. */
function paragraphs(player: Player): (string | null)[] {
    return [...player.document.querySelectorAll('p')].map(paragraph => paragraph.textContent)
}

/** What the replay shows: the tree with the documents of frames, form values and style sheets. */
function stateOf(player: Player): string {
    return describeDom(player.document, { frameDocument: contentDocumentOf, state: true })
}

function contentDocumentOf(frame: Element): Document | undefined {
    return (isFrame(frame) ? frame.contentDocument : null) ?? undefined
}

// body 5: p 6 ("one" 7), then p 8 ("two" 9)
const story: Timed[] = [
    { time: 0, event: pageOf([{ tag: 'p', children: [{ text: 'one' }] }]) },
    { time: 0, event: { type: EventType.Viewport, width: 800, height: 600 } },
    {
        time: 100,
        event: mutations({
            adds: [{ parentId: 5, beforeId: 0, nodes: [build({ tag: 'p', children: [{ text: 'two' }] }, { next: 8 })] }]
        })
    },
    { time: 400, event: mutations({ texts: [{ id: 7, data: 'changed' }] }) }
]

describe('createPlayer', () => {
    it('loads a recording and shows its start', async () => {
        const player = await open(writeRecording(story, { meta: { app: 'test' } }))
        expect({
            sessionId: player.sessionId,
            startedAt: player.startedAt,
            meta: player.meta,
            warnings: player.warnings,
            duration: player.duration,
            currentTime: player.currentTime,
            paused: player.paused,
            speed: player.speed
        }).toEqual({
            sessionId: 'player-test',
            startedAt: SESSION.startedAt,
            meta: { app: 'test' },
            warnings: [],
            duration: 400,
            currentTime: 0,
            paused: true,
            speed: 1
        })
        expect(paragraphs(player)).toEqual(['one'])
        // The replay has the recorded viewport size.
        expect(player.document.defaultView?.innerWidth).toBe(800)
        expect(player.document.defaultView?.innerHeight).toBe(600)
    })

    it('seeks to any time, forward and back', async () => {
        const player = await open(writeRecording(story))
        let updates = 0
        player.addEventListener('timeupdate', () => updates++)
        await player.seek(100)
        expect(paragraphs(player)).toEqual(['one', 'two'])
        expect(player.currentTime).toBe(100)
        await player.seek(99)
        expect(paragraphs(player)).toEqual(['one'])
        await player.seek(10_000)
        expect(player.currentTime).toBe(400)
        expect(paragraphs(player)).toEqual(['changed', 'two'])
        await player.seek(-10)
        expect(player.currentTime).toBe(0)
        expect(paragraphs(player)).toEqual(['one'])
        expect(updates).toBe(4)
        await expect(player.seek(Number.NaN)).rejects.toThrow('cannot seek to NaN')
    })

    it('shows the same page at any time, however it got there', async () => {
        await fc.assert(
            fc.asyncProperty(
                operations(80),
                fc.integer({ min: 1, max: 30 }),
                fc.array(fc.nat(), { minLength: 1, maxLength: 10 }),
                async (steps, keyframeInterval, picks) => {
                    const events = recordingOf(steps)
                    const recording = writeRecording(events)
                    const times = picks.map(pick => pick % (events.length + 1))
                    // Without keyframes of its own, the reference only ever applies the events in order.
                    const reference = await open(recording, {
                        keyframeInterval: Number.MAX_SAFE_INTEGER,
                        worker: false
                    })
                    const expected = new Map<number, string>()
                    for (const time of new Set(times.toSorted((a, b) => a - b))) {
                        // oxlint-disable-next-line no-await-in-loop -- each seek starts where the last one ended
                        await reference.seek(time)
                        expected.set(time, stateOf(reference))
                    }
                    const player = await open(recording, { keyframeInterval })
                    for (const time of times) {
                        // oxlint-disable-next-line no-await-in-loop -- each seek starts where the last one ended
                        await player.seek(time)
                        expect(stateOf(player)).toBe(expected.get(time))
                    }
                    // Seeks that overlap end at the last one asked for.
                    const last = times.at(-1)!
                    await Promise.all([player.seek(times[0]!), player.seek(0), player.seek(last)])
                    expect(stateOf(player)).toBe(expected.get(last))
                    reference.destroy()
                    player.destroy()
                }
            ),
            { numRuns: 20 }
        )
    })

    it('plays at its speed, and ends', async () => {
        const player = await open(writeRecording(story), { speed: 4 })
        const seen: string[] = []
        for (const type of ['play', 'pause', 'ended']) {
            player.addEventListener(type, () => seen.push(type))
        }
        let updates = 0
        player.addEventListener('timeupdate', () => updates++)
        const ended = new Promise(resolve => player.addEventListener('ended', resolve, { once: true }))
        const started = performance.now()
        player.play()
        expect(player.paused).toBe(false)
        await ended
        expect(performance.now() - started).toBeGreaterThanOrEqual(99)
        expect(seen).toEqual(['play', 'pause', 'ended'])
        expect(updates).toBeGreaterThan(0)
        expect(player.currentTime).toBe(400)
        expect(player.paused).toBe(true)
        expect(paragraphs(player)).toEqual(['changed', 'two'])
        // Once ended, playing starts over.
        player.play()
        expect(player.currentTime).toBeLessThan(400)
        player.pause()
        expect(seen).toEqual(['play', 'pause', 'ended', 'play', 'pause'])
    })

    it('pauses where it is', async () => {
        const player = await open(writeRecording(story), { speed: 0.25 })
        player.play()
        await delay(100)
        player.pause()
        const time = player.currentTime
        expect(time).toBeGreaterThan(0)
        expect(time).toBeLessThan(400)
        await delay(50)
        expect(player.currentTime).toBe(time)
        expect(() => {
            player.speed = 0
        }).toThrow('speed must be a positive number, got 0')
        player.speed = 2
        expect(player.speed).toBe(2)
    })

    it('indexes on the main thread, and when the worker does not start', async () => {
        const missing = new URL('/timecat-missing-worker.js', location.href)
        const loaded = await Promise.all([false, missing].map(worker => open(writeRecording(story), { worker })))
        for (const player of loaded) {
            expect(player.duration).toBe(400)
            expect(paragraphs(player)).toEqual(['one'])
        }
    })

    it('joins the segments of a session, from blobs, buffers and views', async () => {
        const first = writeRecording(story.slice(0, 3))
        const second = writeRecording(
            [
                { time: 0, event: pageOf([{ tag: 'p', children: [{ text: 'later' }] }]) },
                { time: 50, event: mutations({ texts: [{ id: 7, data: 'last' }] }) }
            ],
            { segment: 1, startedAt: SESSION.startedAt + 1000 }
        )
        const padded = new Uint8Array(second.length + 8)
        padded.set(second, 4)
        for (const source of [
            [new Blob([first]), padded.subarray(4, 4 + second.length)],
            [first.slice().buffer, new DataView(padded.buffer, 4, second.length)]
        ]) {
            // oxlint-disable-next-line no-await-in-loop -- one player at a time
            const player = await open(source)
            expect(player.duration).toBe(1050)
            // oxlint-disable-next-line no-await-in-loop -- one player at a time
            await player.seek(999)
            expect(paragraphs(player)).toEqual(['one', 'two'])
            // oxlint-disable-next-line no-await-in-loop -- one player at a time
            await player.seek(1050)
            expect(paragraphs(player)).toEqual(['last'])
        }
    })

    it('shows the recorded pointer and its clicks', async () => {
        const container = containerOf()
        const events: Timed[] = [
            ...story.slice(0, 2),
            {
                time: 100,
                event: {
                    type: EventType.PointerMoves,
                    pointer: PointerType.Mouse,
                    times: [0, 20],
                    xs: [10, 30],
                    ys: [20, 40]
                }
            },
            {
                time: 200,
                event: {
                    type: EventType.PointerButton,
                    action: PointerAction.Down,
                    pointer: PointerType.Mouse,
                    button: 0,
                    x: 30,
                    y: 40,
                    targetId: 6
                }
            },
            { time: 1000, event: mutations({}) }
        ]
        const player = await open(writeRecording(events), { container })
        const shadow = container.lastElementChild?.shadowRoot
        const cursor = shadow?.querySelector<HTMLElement>('.cursor')
        const click = shadow?.querySelector<HTMLElement>('.click')
        expect(cursor?.style.display).toBe('none')
        // The stage's styles apply.
        expect(cursor === null || cursor === undefined ? '' : getComputedStyle(cursor).position).toBe('absolute')
        await player.seek(110)
        expect(cursor?.style.display).toBe('block')
        expect(cursor?.style.transform).toContain('translate(10px, 20px)')
        expect(click?.style.display).toBe('none')
        await player.seek(300)
        expect(cursor?.style.transform).toContain('translate(30px, 40px)')
        expect(click?.style.display).toBe('block')
        await player.seek(700)
        expect(click?.style.display).toBe('none')
    })

    it('lists the events recorded beside the page on its clock', async () => {
        const early: TcrEvent = { type: EventType.Console, level: 3, source: 0, args: ['early'], stack: '' }
        const ready: TcrEvent = { type: EventType.Custom, name: 'ready', data: '{"ok":true}' }
        const lcp: TcrEvent = { type: EventType.Perf, metric: 'LCP', value: 180.5, targetId: 6 }
        const player = await open(
            writeRecording([
                { time: 5, event: early },
                { time: 10, event: story[0]!.event },
                { time: 60, event: ready },
                { time: 90, event: lcp }
            ])
        )
        expect(player.events).toEqual([
            { time: 0, event: early },
            { time: 50, event: ready },
            { time: 80, event: lcp }
        ])
        expect(player.events).toBe(player.events)
        expect(player.duration).toBe(80)
    })

    it('rejects what it cannot play, and leaves the container as it was', async () => {
        const recording = writeRecording(story)
        await expect(createPlayer(recording, { container: document.createElement('div') })).rejects.toThrow(
            'the player container must be in the document'
        )
        const container = containerOf()
        await expect(createPlayer(recording, { container, keyframeInterval: 0 })).rejects.toThrow(
            'keyframeInterval must be positive, got 0'
        )
        await expect(createPlayer(recording, { container, speed: Number.POSITIVE_INFINITY })).rejects.toThrow(
            'speed must be a positive number, got Infinity'
        )
        // The same error whether a worker or the main thread read the file.
        for (const worker of [true, false]) {
            // oxlint-disable-next-line no-await-in-loop -- one load at a time
            const error: unknown = await createPlayer(new Uint8Array([1, 2, 3, 4]), { container, worker }).catch(
                (reason: unknown) => reason
            )
            expect(error).toBeInstanceOf(TcrDecodeError)
            expect(error).toMatchObject({ message: 'not a TCR stream: bad magic bytes' })
        }
        expect(container.childElementCount).toBe(0)
    })

    it('plays a stream as it comes, from its edge while it is live', async () => {
        const { stream, push, close } = feed()
        push(concat(writeRecording(story.slice(0, 2)), writeSync(50, 2)))
        const player = await open(stream)
        expect({ live: player.live, duration: player.duration, currentTime: player.currentTime }).toEqual({
            live: true,
            duration: 50,
            currentTime: 50
        })
        expect(paragraphs(player)).toEqual(['one'])
        let changed = once(player, 'durationchange')
        push(concat(writeChunks(story.slice(2), 3), writeSync(500, 5)))
        await changed
        expect(player.duration).toBe(500)
        await player.seek(450)
        expect(paragraphs(player)).toEqual(['changed', 'two'])
        // At the edge, playing waits for more.
        const ended = vi.fn<() => void>()
        player.addEventListener('ended', ended)
        await player.seek(500)
        player.play()
        await delay(100)
        expect(player.paused).toBe(false)
        expect(ended).not.toHaveBeenCalled()
        changed = once(player, 'durationchange')
        const end = once(player, 'ended')
        push(writeChunks([{ time: 600, event: mutations({ texts: [{ id: 9, data: 'three' }] }) }], 6))
        close()
        await changed
        expect({ live: player.live, duration: player.duration }).toEqual({ live: false, duration: 600 })
        await end
        expect(paragraphs(player)).toEqual(['changed', 'three'])
    })

    it('plays what a stream gave before it failed, and reports the failure', async () => {
        for (const worker of [true, false]) {
            const errors: unknown[] = []
            const { stream, push, fail } = feed()
            const opening = open(stream, { worker, onError: error => errors.push(error) })
            // Without sync points, the page events wait until the stream ends.
            push(writeRecording(story))
            // An error drops what the stream did not give yet.
            // oxlint-disable-next-line no-await-in-loop -- one load at a time
            await delay(50)
            fail(new Error('connection lost'))
            // oxlint-disable-next-line no-await-in-loop -- one load at a time
            const player = await opening
            expect({ live: player.live, duration: player.duration }).toEqual({ live: false, duration: 400 })
            expect(paragraphs(player)).toEqual(['one'])
            expect(errors).toMatchObject([{ message: 'connection lost' }])
        }
    })

    it('rejects a stream that holds no recording', async () => {
        const container = containerOf()
        await expect(createPlayer(new Blob(['not a recording']).stream(), { container })).rejects.toThrow(
            TcrDecodeError
        )
        const { stream, fail } = feed()
        fail(new Error('offline'))
        await expect(createPlayer(stream, { container })).rejects.toThrow('offline')
        expect(container.childElementCount).toBe(0)
    })

    it('stops reading a stream once destroyed', async () => {
        const { stream, push, cancelled } = feed()
        push(concat(writeRecording(story.slice(0, 2)), writeSync(50, 2)))
        const player = await open(stream)
        player.destroy()
        await vi.waitFor(() => expect(cancelled()).toBe(true))
    })

    it('stops for good once destroyed', async () => {
        const container = containerOf()
        const player = await open(writeRecording(story), { container })
        expect(container.childElementCount).toBe(1)
        player.destroy()
        expect(container.childElementCount).toBe(0)
        player.play()
        expect(player.paused).toBe(true)
        await player.seek(100)
        player.destroy()
    })
})
