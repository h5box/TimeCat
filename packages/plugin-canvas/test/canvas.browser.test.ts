import { createPlayer, EventType } from '@timecat-js/player-core'
import type { Player } from '@timecat-js/player-core'
import {
    ChunkFlag,
    ChunkKind,
    decodeEvent,
    gunzip,
    readEventFrames,
    readFile,
    readMediaPackets,
    Track
} from '@timecat-js/protocol'
import type { MediaPacket, MediaTrackEvent } from '@timecat-js/protocol'
import { record } from '@timecat-js/recorder'
import type { RecordOptions } from '@timecat-js/recorder'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canvasPlugin } from '../src/index.ts'
import type { CanvasPluginOptions } from '../src/index.ts'

const added: Element[] = []
const players: Player[] = []

afterEach(() => {
    for (const player of players.splice(0)) {
        player.destroy()
    }
    for (const element of added.splice(0)) {
        element.remove()
    }
    vi.unstubAllGlobals()
})

const RED = [255, 0, 0] as const
const GREEN = [0, 255, 0] as const
const BLUE = [0, 0, 255] as const
type Color = readonly [number, number, number]

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function add<T extends Element>(element: T, parent: ParentNode = document.body): T {
    parent.append(element)
    added.push(element)
    return element
}

function canvas2d(width = 160, height = 120) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    return {
        canvas,
        paint: ([r, g, b]: Color) => {
            context.fillStyle = `rgb(${r}, ${g}, ${b})`
            context.fillRect(0, 0, canvas.width, canvas.height)
        }
    }
}

/** A WebGL canvas whose drawing buffer is cleared once shown, as is the default. */
function canvasGl() {
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 120
    const gl = canvas.getContext('webgl')!
    return {
        canvas,
        paint: ([r, g, b]: Color) => {
            gl.clearColor(r / 255, g / 255, b / 255, 1)
            gl.clear(gl.COLOR_BUFFER_BIT)
        }
    }
}

/**
 * Records while `act` runs, with the plugin, and marks times with application events. The plugin starts recording
 * canvases a little after the recording starts.
 */
async function recordCanvas(
    act: (mark: (name: string) => void) => Promise<void>,
    options: CanvasPluginOptions = {},
    recordOptions: RecordOptions = {}
) {
    const errors: unknown[] = []
    const recorder = record({
        worker: false,
        onError: error => void errors.push(error),
        plugins: [canvasPlugin(options)],
        ...recordOptions
    })
    await recorder.ready
    await wait(200)
    await act(name => recorder.addEvent(name))
    const blob = await recorder.stop()
    return { blob, errors }
}

/** The media track declarations and packets of a recording. */
async function mediaOf(blob: Blob) {
    const { chunks } = readFile(new Uint8Array(await blob.arrayBuffer()))
    const declarations: MediaTrackEvent[] = []
    const packets = new Map<number, MediaPacket[]>()
    for (const chunk of chunks) {
        if (chunk.kind === ChunkKind.Events && chunk.track === Track.Media) {
            // oxlint-disable-next-line no-await-in-loop -- chunks are few in tests
            const payload = chunk.flags & ChunkFlag.Gzip ? await gunzip(chunk.payload) : chunk.payload
            for (const frame of readEventFrames(payload, chunk.startTime)) {
                const event = decodeEvent(frame.type, frame.body, { next: 1 })
                if (event?.type === EventType.MediaTrack) {
                    declarations.push(event)
                }
            }
        } else if (chunk.kind === ChunkKind.Media) {
            const list = packets.get(chunk.track) ?? []
            list.push(...readMediaPackets(chunk.payload, chunk.startTime))
            packets.set(chunk.track, list)
        }
    }
    return { declarations, packets }
}

async function replay(blob: Blob): Promise<Player> {
    const container = add(document.createElement('div'))
    const player = await createPlayer(blob, { container, worker: false })
    players.push(player)
    return player
}

function timeOf(player: Player, name: string): number {
    const found = player.events.find(({ event }) => event.type === EventType.Custom && event.name === name)
    if (found === undefined) {
        throw new Error(`no mark ${name}`)
    }
    return found.time
}

function colorAt(canvas: HTMLCanvasElement): Color {
    const [r, g, b] = canvas.getContext('2d')!.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data
    return [r!, g!, b!]
}

/** Whether `color` is the primary `expected` is, as codecs leave it: high where it is, low elsewhere. */
function near(color: Color, expected: Color): boolean {
    return color.every((value, i) => (expected[i] === 255 ? value > 150 : value < 100))
}

/** Seeks and waits for the replayed canvas to show `expected`. */
async function expectShown(player: Player, time: number, expected: Color, selector = 'canvas'): Promise<void> {
    await player.seek(time)
    const canvas = player.document.querySelector<HTMLCanvasElement>(selector)!
    await expect.poll(() => colorAt(canvas), { timeout: 3000 }).toSatisfy(color => near(color, expected))
}

describe('canvasPlugin', () => {
    it('records a 2D canvas as video that the player draws again', async () => {
        const { canvas, paint } = canvas2d()
        add(canvas)
        paint(RED)
        const { blob, errors } = await recordCanvas(async mark => {
            mark('red')
            await wait(300)
            paint(GREEN)
            mark('green')
            await wait(300)
            paint(BLUE)
            mark('blue')
            await wait(300)
        })
        expect(errors).toEqual([])
        const { declarations, packets } = await mediaOf(blob)
        expect(declarations).toHaveLength(1)
        const [declaration] = declarations
        expect(declaration).toMatchObject({ width: 160, height: 120, container: '' })
        expect(declaration!.codec).toMatch(/^vp09/)
        expect(declaration!.targetId).toBeGreaterThan(0)
        const list = packets.get(declaration!.track)!
        expect(list[0]!.key).toBe(true)
        // A frame for each change, not for each tick.
        expect(list.length).toBeLessThan(10)
        const player = await replay(blob)
        await expectShown(player, timeOf(player, 'green') + 150, GREEN)
        await expectShown(player, timeOf(player, 'red') + 150, RED)
        await expectShown(player, timeOf(player, 'blue') + 150, BLUE)
        await expectShown(player, timeOf(player, 'green') + 150, GREEN)
    })

    it('records what a WebGL canvas shows, drawn in frames', async () => {
        const { canvas, paint } = canvasGl()
        add(canvas)
        let color: Color = RED
        let drawing = true
        const draw = (): void => {
            if (drawing) {
                paint(color)
                requestAnimationFrame(draw)
            }
        }
        draw()
        try {
            const { blob } = await recordCanvas(async mark => {
                mark('red')
                await wait(300)
                color = GREEN
                mark('green')
                await wait(300)
            })
            const player = await replay(blob)
            await expectShown(player, timeOf(player, 'red') + 150, RED)
            await expectShown(player, timeOf(player, 'green') + 150, GREEN)
        } finally {
            drawing = false
        }
    })

    it('waits for a WebGL canvas to draw, since what it showed before is gone from its drawing buffer', async () => {
        const { canvas, paint } = canvasGl()
        add(canvas)
        paint(RED)
        const { blob } = await recordCanvas(async mark => {
            await wait(300)
            paint(GREEN)
            mark('green')
            await wait(300)
        })
        const { packets } = await mediaOf(blob)
        expect(packets.size).toBe(1)
        const player = await replay(blob)
        await expectShown(player, timeOf(player, 'green') + 150, GREEN)
    })

    it('records a resized canvas at its new size', async () => {
        const { canvas, paint } = canvas2d()
        add(canvas)
        paint(RED)
        const { blob } = await recordCanvas(async mark => {
            await wait(300)
            canvas.width = 301
            canvas.height = 99
            paint(GREEN)
            mark('resized')
            await wait(300)
        })
        const { declarations } = await mediaOf(blob)
        expect(declarations.map(({ width, height }) => [width, height])).toEqual([
            [160, 120],
            [302, 100]
        ])
        expect(new Set(declarations.map(({ track }) => track)).size).toBe(1)
        const player = await replay(blob)
        await expectShown(player, timeOf(player, 'resized') + 150, GREEN)
        await expectShown(player, timeOf(player, 'resized') - 100, RED)
    })

    it('scales down canvases larger than maxSize', async () => {
        const { canvas, paint } = canvas2d(400, 100)
        add(canvas)
        paint(RED)
        const { blob } = await recordCanvas(() => wait(200), { maxSize: 200 })
        const { declarations } = await mediaOf(blob)
        expect(declarations.map(({ width, height }) => [width, height])).toEqual([[200, 50]])
    })

    it('finds canvases in shadow trees and canvases added later, and leaves out blocked ones', async () => {
        const host = add(document.createElement('div'))
        const shadow = host.attachShadow({ mode: 'open' })
        const inShadow = canvas2d()
        shadow.append(inShadow.canvas)
        inShadow.paint(RED)
        const blocked = canvas2d()
        blocked.canvas.className = 'secret'
        add(blocked.canvas)
        blocked.paint(GREEN)
        const later = canvas2d()
        later.canvas.id = 'later'
        const { blob, errors } = await recordCanvas(
            async mark => {
                add(later.canvas)
                later.paint(BLUE)
                await wait(700)
                mark('end')
            },
            {},
            { block: '.secret' }
        )
        expect(errors).toEqual([])
        const { declarations } = await mediaOf(blob)
        expect(declarations).toHaveLength(2)
        const player = await replay(blob)
        const end = timeOf(player, 'end')
        await expectShown(player, end, BLUE, '#later')
        const replayedHost = player.document.body.querySelector('div')!
        const replayedCanvas = replayedHost.shadowRoot!.querySelector('canvas')!
        await expect.poll(() => near(colorAt(replayedCanvas), RED), { timeout: 3000 }).toBe(true)
    })

    it('stops recording a canvas that is removed, and goes on with its track once it is back', async () => {
        const { canvas, paint } = canvas2d()
        add(canvas)
        paint(RED)
        const { blob } = await recordCanvas(async mark => {
            await wait(200)
            canvas.remove()
            mark('removed')
            await wait(700)
            paint(GREEN)
            await wait(700)
            add(canvas)
            mark('back')
            await wait(700)
        })
        const { declarations, packets } = await mediaOf(blob)
        expect(new Set(declarations.map(({ track }) => track)).size).toBe(1)
        expect(declarations.length).toBeGreaterThanOrEqual(2)
        const player = await replay(blob)
        await expectShown(player, timeOf(player, 'back') + 600, GREEN)
        const [list] = packets.values()
        expect(list!.length).toBeGreaterThanOrEqual(2)
    })

    it('records with MediaRecorder where WebCodecs cannot take the frames of a canvas', async () => {
        vi.stubGlobal('MediaStreamTrackProcessor', undefined)
        const { canvas, paint } = canvas2d()
        add(canvas)
        let color: Color = RED
        // Frames keep coming, as a container file has the last one end where the next starts.
        const timer = setInterval(() => paint(color), 50)
        try {
            const { blob, errors } = await recordCanvas(async mark => {
                mark('red')
                await wait(500)
                color = GREEN
                mark('green')
                await wait(500)
                canvas.width = 80
                mark('resized')
                await wait(500)
            })
            expect(errors).toEqual([])
            const { declarations } = await mediaOf(blob)
            expect(declarations.map(({ codec, container, width }) => [codec, container, width])).toEqual([
                ['', 'video/webm;codecs=vp9', 160],
                ['', 'video/webm;codecs=vp9', 80]
            ])
            const player = await replay(blob)
            await expectShown(player, timeOf(player, 'red') + 200, RED)
            await expectShown(player, timeOf(player, 'green') + 200, GREEN)
            await expectShown(player, timeOf(player, 'resized') + 300, GREEN)
        } finally {
            clearInterval(timer)
        }
    })

    it('writes key frames at keyframeInterval while a canvas changes', async () => {
        const { canvas, paint } = canvas2d()
        add(canvas)
        paint(RED)
        let frame = 0
        const timer = setInterval(() => paint([frame++ % 2 === 0 ? 255 : 0, 0, 0]), 40)
        try {
            const { blob } = await recordCanvas(() => wait(1000), { keyframeInterval: 300, fps: 30 })
            const [packets] = (await mediaOf(blob)).packets.values()
            const keys = packets!.filter(packet => packet.key).map(packet => packet.time)
            expect(keys.length).toBeGreaterThanOrEqual(3)
            expect(keys.length).toBeLessThan(packets!.length / 2)
            // The first packet goes no earlier than its declaration, which was written once it was encoded.
            for (let i = 2; i < keys.length; i++) {
                expect(keys[i]! - keys[i - 1]!).toBeGreaterThanOrEqual(300_000)
            }
            const times = packets!.map(packet => packet.time)
            expect(times).toEqual(times.toSorted((a, b) => a - b))
        } finally {
            clearInterval(timer)
        }
    })

    it('reports a canvas it cannot capture once, and records the others', async () => {
        const broken = canvas2d()
        broken.canvas.captureStream = () => {
            throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError')
        }
        add(broken.canvas)
        broken.paint(RED)
        const fine = canvas2d()
        add(fine.canvas)
        fine.paint(GREEN)
        const { blob, errors } = await recordCanvas(() => wait(1200))
        expect(errors).toHaveLength(1)
        expect(errors[0]).toMatchObject({
            message: expect.stringMatching(/^canvas \d+ is not recorded$/),
            cause: expect.objectContaining({ name: 'SecurityError' })
        })
        expect((await mediaOf(blob)).declarations).toHaveLength(1)
    })

    it('rejects options out of range', () => {
        expect(() => canvasPlugin({ fps: 0 })).toThrow(RangeError)
        expect(() => canvasPlugin({ keyframeInterval: -1 })).toThrow(RangeError)
        expect(() => canvasPlugin({ maxSize: Number.NaN })).toThrow(RangeError)
        expect(() => canvasPlugin({ bitrate: Infinity })).toThrow(RangeError)
        expect(() => canvasPlugin({ codecs: [] })).toThrow(RangeError)
    })
})
