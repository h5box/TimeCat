import { EventType, MediaKind } from '@timecat-js/protocol'
import type { MediaPacket, MediaStateEvent, TcrEvent } from '@timecat-js/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlayer } from '../src/index.ts'
import type { Player } from '../src/index.ts'
import { concat, pageOf, writeMedia, writeRecording } from './recording.ts'
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
    vi.restoreAllMocks()
})

async function open(recording: Uint8Array): Promise<Player> {
    const container = document.createElement('div')
    container.style.cssText = 'width: 400px; height: 300px'
    document.body.append(container)
    containers.push(container)
    const player = await createPlayer(recording, { container })
    players.push(player)
    return player
}

const RED = '#ff0000'
const GREEN = '#00ff00'
const BLUE = '#0000ff'

/** Frames of one color each, every 100 ms, drawn on a canvas of `width` × `height`. */
function canvasOf(width: number, height: number, colors: readonly string[]) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    return {
        canvas,
        draw: (i: number): void => {
            context.fillStyle = colors[i]!
            context.fillRect(0, 0, width, height)
        }
    }
}

/** Encodes `colors` as VP8 frames 100 ms apart, the first one a key frame. */
async function encode(colors: readonly string[]): Promise<MediaPacket[]> {
    const packets: MediaPacket[] = []
    const encoder = new VideoEncoder({
        output: chunk => {
            const data = new Uint8Array(chunk.byteLength)
            chunk.copyTo(data)
            packets.push({ time: chunk.timestamp, duration: chunk.duration ?? 0, key: chunk.type === 'key', data })
        },
        error: error => {
            throw error
        }
    })
    encoder.configure({ codec: 'vp8', width: 64, height: 48, bitrate: 500_000 })
    const { canvas, draw } = canvasOf(64, 48, colors)
    for (const i of colors.keys()) {
        draw(i)
        const frame = new VideoFrame(canvas, { timestamp: i * 100_000, duration: 100_000 })
        encoder.encode(frame, { keyFrame: i === 0 })
        frame.close()
    }
    await encoder.flush()
    encoder.close()
    return packets
}

/** How long each color of a recorded video shows. */
const SPAN = 300

/**
 * Records a WebM video of a canvas in `colors`, each for at least `SPAN` milliseconds, with MediaRecorder, which
 * hands it on in pieces as it goes. Says when each color started, in milliseconds since recording started.
 */
async function recordWebm(colors: readonly string[]) {
    const { canvas, draw } = canvasOf(64, 48, colors)
    draw(0)
    const stream = canvas.captureStream()
    const type = 'video/webm;codecs=vp8'
    const recorder = new MediaRecorder(stream, { mimeType: type })
    const parts: { time: number; data: Blob }[] = []
    const starts: number[] = []
    let start = 0
    recorder.addEventListener('dataavailable', event =>
        parts.push({ time: performance.now() - start, data: event.data })
    )
    recorder.start(100)
    start = performance.now()
    for (const i of colors.keys()) {
        starts.push(performance.now() - start)
        // A canvas stream has a frame for each time the canvas is drawn on.
        for (let drawn = 0; drawn < SPAN; drawn += 50) {
            draw(i)
            // oxlint-disable-next-line no-await-in-loop -- frames come one after the other
            await new Promise(resolve => setTimeout(resolve, 50))
        }
    }
    const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve))
    recorder.stop()
    await stopped
    for (const track of stream.getTracks()) {
        track.stop()
    }
    const packets = await Promise.all(
        parts.map(async ({ time, data }, i) => ({
            time: Math.round(time * 1000),
            duration: 0,
            key: i === 0,
            data: new Uint8Array(await data.arrayBuffer())
        }))
    )
    return { type, packets, starts }
}

/**
 * The color in the middle of what the replayed canvas shows, the picture of its bitmap, as the channel that
 * dominates it.
 */
async function colorOf(player: Player): Promise<string> {
    const canvas = player.document.querySelector('canvas')!
    const image = new Image()
    image.src = /url\("(.*)"\)/.exec(canvas.style.getPropertyValue('content'))?.[1] ?? ''
    await image.decode()
    const copy = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d')!
    copy.drawImage(image, 0, 0)
    const [r, g, b] = copy.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
    if (r! > 150 && g! < 100 && b! < 100) {
        return RED
    }
    if (g! > 150 && r! < 100 && b! < 100) {
        return GREEN
    }
    if (b! > 150 && r! < 100 && g! < 100) {
        return BLUE
    }
    return `rgb(${r}, ${g}, ${b})`
}

// body 5: canvas 6
const canvasPage = pageOf([{ tag: 'canvas', attributes: ['width', '64', 'height', '48'] }])

function declaration(changes: Partial<Extract<TcrEvent, { type: 17 }>>): TcrEvent {
    return {
        type: EventType.MediaTrack,
        track: 256,
        kind: MediaKind.Video,
        targetId: 6,
        codec: '',
        description: new Uint8Array(0),
        container: '',
        width: 64,
        height: 48,
        sampleRate: 0,
        channels: 0,
        ...changes
    }
}

function state(changes: Partial<MediaStateEvent>): TcrEvent {
    return {
        type: EventType.MediaState,
        id: 6,
        paused: true,
        muted: false,
        currentTime: 5,
        playbackRate: 1,
        volume: 0.5,
        ...changes
    }
}

describe('media', () => {
    it('shows video tracks of encoded frames in their canvas, decoding from the last key frame', async () => {
        const colors = [RED, GREEN, BLUE, RED]
        const packets = await encode(colors)
        expect(packets.map(packet => packet.key)).toEqual([true, false, false, false])
        const player = await open(
            concat(
                writeRecording([
                    { time: 0, event: canvasPage },
                    { time: 0, event: declaration({ codec: 'vp8' }) }
                ]),
                writeMedia(256, packets, 2)
            )
        )
        expect(player.duration).toBe(400)
        for (const [time, color] of [
            [150, GREEN],
            [250, BLUE],
            [50, RED],
            [399, RED],
            [120, GREEN]
        ] as const) {
            // oxlint-disable-next-line no-await-in-loop -- one time after the other
            await player.seek(time)
            // oxlint-disable-next-line no-await-in-loop -- decoding takes a moment
            await vi.waitFor(async () => expect(await colorOf(player)).toBe(color))
        }
    })

    it('plays container tracks, such as MediaRecorder writes, in their canvas', async () => {
        const { type, packets, starts } = await recordWebm([RED, GREEN, BLUE])
        const player = await open(
            concat(
                writeRecording([
                    { time: 0, event: canvasPage },
                    { time: 0, event: declaration({ container: type }) }
                ]),
                ...packets.map((packet, i) => writeMedia(256, [packet], 2 + i))
            )
        )
        // In the middle of each color.
        for (const [i, color] of [
            [0, RED],
            [2, BLUE],
            [1, GREEN]
        ] as const) {
            // oxlint-disable-next-line no-await-in-loop -- one time after the other
            await player.seek(starts[i]! + SPAN / 2)
            // oxlint-disable-next-line no-await-in-loop -- the frame comes once the video seeked
            await vi.waitFor(async () => expect(await colorOf(player)).toBe(color))
        }
    })

    it('plays and shows replayed media elements as they were recorded', async () => {
        const events: Timed[] = [
            // body 5: video 6
            { time: 0, event: pageOf([{ tag: 'video' }]) },
            { time: 10, event: state({}) },
            { time: 100, event: state({ paused: false, playbackRate: 2 }) },
            { time: 300, event: state({ currentTime: 5.4, muted: true }) },
            // A new page, whose node 6 is another element.
            { time: 500, event: pageOf([{ tag: 'video' }]) }
        ]
        const player = await open(writeRecording(events))
        expect(player.hasMedia).toBe(true)
        const video = (): HTMLVideoElement => player.document.querySelector('video')!
        const volumechange = vi.fn<() => void>()
        player.addEventListener('volumechange', volumechange)
        await player.seek(50)
        await vi.waitFor(() => expect(video().currentTime).toBe(5))
        expect({ paused: video().paused, volume: video().volume, muted: video().muted }).toEqual({
            paused: true,
            volume: 0.5,
            muted: false
        })
        await player.seek(200)
        expect(video().currentTime).toBeCloseTo(5.2)
        expect(video().paused).toBe(true)
        player.volume = 0.5
        player.muted = true
        expect({ volume: video().volume, muted: video().muted }).toEqual({ volume: 0.25, muted: true })
        expect(volumechange).toHaveBeenCalledTimes(2)
        player.speed = 0.5
        player.play()
        await vi.waitFor(() => expect(video().paused).toBe(false))
        expect(video().playbackRate).toBe(1)
        player.pause()
        expect(video().paused).toBe(true)
        await player.seek(400)
        expect({ currentTime: video().currentTime, muted: video().muted }).toEqual({ currentTime: 5.4, muted: true })
        // The state of the element before is not this one's.
        await player.seek(550)
        player.volume = 1
        expect(video().volume).toBe(0.25)
        expect(() => {
            player.volume = 2
        }).toThrow(RangeError)
    })

    it('mutes itself when the browser does not let media play with sound', async () => {
        const player = await open(
            writeRecording([
                { time: 0, event: pageOf([{ tag: 'audio' }]) },
                {
                    time: 0,
                    event: {
                        type: EventType.MediaState,
                        id: 6,
                        paused: false,
                        muted: false,
                        currentTime: 0,
                        playbackRate: 1,
                        volume: 1
                    }
                },
                { time: 5000, event: pageOf([{ tag: 'audio' }]) }
            ])
        )
        const view = player.document.defaultView!
        const tries: boolean[] = []
        vi.spyOn(view.HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
            tries.push(this.muted)
            return this.muted
                ? Promise.resolve()
                : Promise.reject(new view.DOMException('no sound without a gesture', 'NotAllowedError'))
        })
        const muted = new Promise(resolve => player.addEventListener('volumechange', resolve, { once: true }))
        player.play()
        await muted
        expect(player.muted).toBe(true)
        // Tried with sound, then muted from then on.
        await vi.waitFor(() => expect(tries.at(-1)).toBe(true))
        expect(tries[0]).toBe(false)
        expect(tries.slice(tries.indexOf(true))).not.toContain(false)
    })
})
