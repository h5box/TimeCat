import { createPlayer, EventType } from '@timecat-js/player-core'
import type { Player } from '@timecat-js/player-core'
import {
    ChunkFlag,
    ChunkKind,
    decodeEvent,
    gunzip,
    MediaKind,
    readEventFrames,
    readFile,
    readMediaPackets,
    Track
} from '@timecat-js/protocol'
import type { MediaPacket, MediaStateEvent, MediaTrackEvent } from '@timecat-js/protocol'
import { record } from '@timecat-js/recorder'
import type { RecordOptions } from '@timecat-js/recorder'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mediaPlugin } from '../src/index.ts'
import type { MediaPluginOptions } from '../src/index.ts'

const added: Element[] = []
const players: Player[] = []
const urls: string[] = []

afterEach(() => {
    for (const player of players.splice(0)) {
        player.destroy()
    }
    for (const element of added.splice(0)) {
        if (element instanceof HTMLMediaElement) {
            element.pause()
        }
        element.remove()
    }
    vi.restoreAllMocks()
})

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function once(target: EventTarget, type: string): Promise<void> {
    return new Promise(resolve => target.addEventListener(type, () => resolve(), { once: true }))
}

function add<T extends Element>(element: T, parent: ParentNode = document.body): T {
    parent.append(element)
    added.push(element)
    return element
}

/** A WAV file of a tone, which browsers seek in exactly. */
function wav(seconds: number): string {
    const rate = 8000
    const samples = seconds * rate
    const view = new DataView(new ArrayBuffer(44 + samples * 2))
    const text = (offset: number, value: string): void => {
        for (let i = 0; i < value.length; i++) {
            view.setUint8(offset + i, value.charCodeAt(i))
        }
    }
    text(0, 'RIFF')
    view.setUint32(4, 36 + samples * 2, true)
    text(8, 'WAVEfmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, rate, true)
    view.setUint32(28, rate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    text(36, 'data')
    view.setUint32(40, samples * 2, true)
    for (let i = 0; i < samples; i++) {
        view.setInt16(44 + i * 2, Math.round(Math.sin(i / 10) * 3000), true)
    }
    const url = URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' }))
    urls.push(url)
    return url
}

/** A muted element that plays a tone: a `<video>`, which browsers let play muted with no user activation. */
async function audioOf(seconds = 3, tag: 'audio' | 'video' = 'video'): Promise<HTMLMediaElement> {
    const audio = document.createElement(tag)
    audio.muted = true
    audio.src = wav(seconds)
    const loaded = once(audio, 'loadedmetadata')
    audio.load()
    await loaded
    return audio
}

/** A WebM video, as MediaRecorder writes it, of a canvas that is red, then green. */
let video: { url: string } | undefined
beforeAll(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 48
    const context = canvas.getContext('2d')!
    let color = 'red'
    const timer = setInterval(() => {
        context.fillStyle = color
        context.fillRect(0, 0, 64, 48)
    }, 30)
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' })
    const parts: Blob[] = []
    recorder.addEventListener('dataavailable', event => parts.push(event.data))
    const stopped = once(recorder, 'stop')
    recorder.start()
    await wait(600)
    color = 'lime'
    await wait(600)
    recorder.stop()
    await stopped
    clearInterval(timer)
    const url = URL.createObjectURL(new Blob(parts, { type: 'video/webm' }))
    urls.push(url)
    video = { url }
})

function captureOf(element: HTMLMediaElement): MediaStream {
    const capture: unknown = Reflect.get(element, 'captureStream')
    if (typeof capture !== 'function') {
        throw new TypeError('no captureStream')
    }
    const stream: unknown = Reflect.apply(capture, element, [])
    if (!(stream instanceof MediaStream)) {
        throw new TypeError('no stream')
    }
    return stream
}

/** Records while `act` runs, marking times with application events. */
async function recordMedia(
    act: (mark: (name: string) => void) => Promise<void>,
    options: MediaPluginOptions = {},
    recordOptions: RecordOptions = {}
) {
    const errors: unknown[] = []
    const recorder = record({
        worker: false,
        onError: error => void errors.push(error),
        plugins: [mediaPlugin(options)],
        ...recordOptions
    })
    await recorder.ready
    await act(name => recorder.addEvent(name))
    const blob = await recorder.stop()
    return { blob, errors }
}

async function decode(blob: Blob) {
    const { chunks } = readFile(new Uint8Array(await blob.arrayBuffer()))
    const states: MediaStateEvent[] = []
    const declarations: MediaTrackEvent[] = []
    const packets = new Map<number, MediaPacket[]>()
    for (const chunk of chunks) {
        if (chunk.kind === ChunkKind.Events && chunk.track === Track.Media) {
            // oxlint-disable-next-line no-await-in-loop -- chunks are few in tests
            const payload = chunk.flags & ChunkFlag.Gzip ? await gunzip(chunk.payload) : chunk.payload
            for (const frame of readEventFrames(payload, chunk.startTime)) {
                const event = decodeEvent(frame.type, frame.body, { next: 1 })
                if (event?.type === EventType.MediaState) {
                    states.push(event)
                } else if (event?.type === EventType.MediaTrack) {
                    declarations.push(event)
                }
            }
        } else if (chunk.kind === ChunkKind.Media) {
            const list = packets.get(chunk.track) ?? []
            list.push(...readMediaPackets(chunk.payload, chunk.startTime))
            packets.set(chunk.track, list)
        }
    }
    return { states, declarations, packets }
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

describe('mediaPlugin', () => {
    it('records the playback state of media elements, which the player follows', async () => {
        const audio = add(await audioOf())
        const { blob, errors } = await recordMedia(async mark => {
            const playing = once(audio, 'playing')
            await audio.play()
            await playing
            await wait(400)
            mark('played')
            audio.pause()
            mark('paused')
            const seeked = once(audio, 'seeked')
            audio.currentTime = 1.5
            await seeked
            audio.playbackRate = 2
            audio.volume = 0.5
            mark('changed')
            await wait(50)
        })
        expect(errors).toEqual([])
        const { states } = await decode(blob)
        expect(states[0]).toMatchObject({ paused: true, currentTime: 0, muted: true, volume: 1, playbackRate: 1 })
        expect(states.some(state => !state.paused)).toBe(true)
        expect(states.at(-1)).toMatchObject({ paused: true, currentTime: 1.5, playbackRate: 2, volume: 0.5 })
        expect(new Set(states.map(state => state.id)).size).toBe(1)

        const player = await replay(blob)
        const replayed = player.document.querySelector('video')!
        await player.seek(timeOf(player, 'played') - 100)
        await expect.poll(() => replayed.currentTime).toBeGreaterThan(0.15)
        expect(replayed.currentTime).toBeLessThan(0.5)
        await player.seek(timeOf(player, 'changed') + 10)
        await expect.poll(() => replayed.currentTime).toBeCloseTo(1.5, 1)
        expect(replayed.volume).toBe(0.5)
        expect(replayed.muted).toBe(true)
        expect(replayed.paused).toBe(true)
    })

    it('records media elements in shadow trees, added later and in roots that come later, but not blocked ones', async () => {
        const host = add(document.createElement('div'))
        const shadow = host.attachShadow({ mode: 'open' })
        const inShadow = await audioOf()
        shadow.append(inShadow)
        // An `<audio>` that does not play, whose state is recorded as it is when recording starts.
        const still = add(await audioOf(3, 'audio'))
        still.volume = 0.25
        const blocked = add(await audioOf())
        blocked.className = 'secret'
        const later = await audioOf()
        const laterHost = document.createElement('div')
        const laterShadow = laterHost.attachShadow({ mode: 'open' })
        const inLaterShadow = await audioOf()
        laterShadow.append(inLaterShadow)
        const { blob, errors } = await recordMedia(
            async () => {
                add(later)
                await wait(50)
                await Promise.all([inShadow.play(), blocked.play(), later.play(), inLaterShadow.play()])
                await wait(100)
                add(laterHost)
                await wait(100)
            },
            {},
            { block: '.secret' }
        )
        expect(errors).toEqual([])
        const { states } = await decode(blob)
        const playing = new Set(states.filter(state => !state.paused).map(state => state.id))
        expect(playing.size).toBe(3)
        // The blocked element's state is not recorded, not even as it is when recording starts.
        expect(new Set(states.map(state => state.id)).size).toBe(4)
        expect(states.filter(state => state.volume === 0.25)).toHaveLength(1)
    })

    it('records what a video shows with pixels, which the player plays in the replayed video', async () => {
        const element = document.createElement('video')
        element.muted = true
        element.src = video!.url
        add(element)
        const { blob, errors } = await recordMedia(
            async mark => {
                const playing = once(element, 'playing')
                await element.play()
                await playing
                mark('playing')
                await once(element, 'ended')
                await wait(100)
            },
            { pixels: true }
        )
        expect(errors).toEqual([])
        const { declarations, packets } = await decode(blob)
        expect(declarations).toHaveLength(1)
        const [declaration] = declarations
        expect(declaration).toMatchObject({ kind: MediaKind.Video, codec: '' })
        expect(declaration!.container).toMatch(/^video\/webm/)
        expect(declaration!.targetId).toBeGreaterThan(0)
        expect(packets.get(declaration!.track)!.length).toBeGreaterThan(0)

        const player = await replay(blob)
        const replayed = player.document.querySelector('video')!
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 48
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        const color = (): string => {
            context.drawImage(replayed, 0, 0, 64, 48)
            const [r, g] = context.getImageData(32, 24, 1, 1).data
            return r! > 150 && g! < 100 ? 'red' : g! > 150 && r! < 100 ? 'green' : `${r},${g}`
        }
        const start = timeOf(player, 'playing')
        await player.seek(start + 300)
        await expect.poll(color, { timeout: 3000 }).toBe('red')
        expect(replayed.getAttribute('src')).not.toBe(video!.url)
        await player.seek(start + 900)
        await expect.poll(color, { timeout: 3000 }).toBe('green')
    })

    it('records narration from a stream of the page, which the player plays', async () => {
        // A tone, played muted: the page's stream gets its sound all the same.
        const tone = add(await audioOf(5))
        await tone.play()
        const stream = captureOf(tone)
        await expect.poll(() => stream.getAudioTracks().length).toBe(1)
        const { blob, errors } = await recordMedia(() => wait(1200), { narration: stream, state: false })
        expect(errors).toEqual([])
        // The page's stream is the page's: it goes on.
        expect(stream.getAudioTracks()[0]!.readyState).toBe('live')
        const { declarations, packets } = await decode(blob)
        expect(declarations).toMatchObject([
            { kind: MediaKind.Audio, targetId: 0, codec: '', container: 'audio/webm;codecs=opus' }
        ])
        expect(packets.get(declarations[0]!.track)!.length).toBeGreaterThan(0)

        const played: HTMLMediaElement[] = []
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
            played.push(this)
            return Promise.resolve()
        })
        const player = await replay(blob)
        player.muted = true
        player.play()
        await expect.poll(() => played.some(element => element.localName === 'audio')).toBe(true)
    })

    it('asks for the microphone for narration and lets it go when it stops', async () => {
        const audioContext = new AudioContext()
        const destination = audioContext.createMediaStreamDestination()
        const getUserMedia = vi
            .spyOn(navigator.mediaDevices, 'getUserMedia')
            .mockImplementation(() => Promise.resolve(destination.stream))
        try {
            const { blob, errors } = await recordMedia(() => wait(300), { narration: true })
            expect(errors).toEqual([])
            expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
            expect(destination.stream.getAudioTracks()[0]!.readyState).toBe('ended')
            expect((await decode(blob)).declarations).toHaveLength(1)

            getUserMedia.mockImplementation(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
            const denied = await recordMedia(() => wait(50), { narration: true })
            expect(denied.errors).toMatchObject([
                { message: 'narration is not recorded', cause: expect.objectContaining({ name: 'NotAllowedError' }) }
            ])
        } finally {
            await audioContext.close()
        }
    })

    it('records no state with state: false', async () => {
        const audio = add(await audioOf())
        const { blob } = await recordMedia(
            async () => {
                await audio.play()
                await wait(100)
            },
            { state: false }
        )
        expect((await decode(blob)).states).toEqual([])
    })

    it('rejects options it cannot take', () => {
        expect(() => mediaPlugin({ pixels: '[' })).toThrow(expect.objectContaining({ name: 'SyntaxError' }))
        expect(() => mediaPlugin({ narrationBitrate: 0 })).toThrow(RangeError)
        expect(() => mediaPlugin({ pixelsBitrate: Number.NaN })).toThrow(RangeError)
    })
})
