import { EventType, PointerAction, PointerType } from '@timecat-js/protocol'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { isInput, isTextArea } from '../src/dom.ts'
import { createPlayer, TcrDecodeError } from '../src/index.ts'
import type { Player, PlayerOptions, RecordingSource } from '../src/index.ts'
import { operation, recordingOf } from './operations.ts'
import { build, describeDom, mutations, pageOf, SESSION, writeRecording } from './recording.ts'
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
    source: RecordingSource | RecordingSource[],
    options: Partial<PlayerOptions> = {}
): Promise<Player> {
    const player = await createPlayer(source, { ...options, container: options.container ?? containerOf() })
    players.push(player)
    return player
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/** Text of the replayed paragraphs. */
function paragraphs(player: Player): (string | null)[] {
    return [...player.document.querySelectorAll('p')].map(paragraph => paragraph.textContent)
}

/** What the replay shows: the tree, and the values of its form controls. */
function stateOf(player: Player): string {
    const values = [...player.document.querySelectorAll('input, textarea')].map(control =>
        isInput(control) || isTextArea(control) ? control.value : ''
    )
    return `${describeDom(player.document)}\n${JSON.stringify(values)}`
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
                fc.array(operation, { minLength: 1, maxLength: 80 }),
                fc.integer({ min: 1, max: 30 }),
                fc.array(fc.nat(), { minLength: 1, maxLength: 10 }),
                async (operations, keyframeInterval, picks) => {
                    const events = recordingOf(operations)
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
