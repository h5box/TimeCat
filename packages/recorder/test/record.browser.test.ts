import { EventType, NodeKind, Track } from '@timecat-js/protocol'
import type { SerializedNode } from '@timecat-js/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { record } from '../src/index.ts'
import type { RecordOptions } from '../src/index.ts'
import { OPFS_DIRECTORY } from '../src/pipeline/storage.ts'
import { decodeRecording, eventsOf } from './decode.ts'

const added: Element[] = []

afterEach(() => {
    for (const element of added.splice(0)) {
        element.remove()
    }
})

function nextFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
}

function texts(node: SerializedNode): string[] {
    if (node.kind === NodeKind.Text) {
        return [node.data]
    }
    return node.kind === NodeKind.Element || node.kind === NodeKind.Document ? node.children.flatMap(texts) : []
}

/** Records adding a paragraph to the page and returns the decoded recording. */
async function recordParagraph(options: RecordOptions) {
    const errors: unknown[] = []
    const recorder = record({ onError: error => void errors.push(error), ...options })
    await recorder.ready
    const paragraph = document.createElement('p')
    paragraph.textContent = 'added while recording'
    document.body.append(paragraph)
    added.push(paragraph)
    await nextFrame()
    const blob = await recorder.stop()
    return { recorder, errors, recording: await decodeRecording(blob) }
}

function expectParagraph(recording: Awaited<ReturnType<typeof decodeRecording>>): void {
    const [first] = recording.events
    expect(first?.event.type).toBe(EventType.Snapshot)
    expect(first?.track).toBe(Track.Dom)
    const runs = eventsOf(recording.events, EventType.Mutations).flatMap(event => event.adds)
    expect(runs.flatMap(run => run.nodes.flatMap(texts))).toContain('added while recording')
    const [viewport] = eventsOf(recording.events, EventType.Viewport)
    expect(viewport).toMatchObject({ width: innerWidth, height: innerHeight })
}

describe('record', () => {
    it('records the page through a worker', async () => {
        const { recorder, errors, recording } = await recordParagraph({ meta: { app: 'test' }, segment: 3 })
        expect(errors).toEqual([])
        expect(recording.header).toMatchObject({ sessionId: recorder.sessionId, segment: 3, meta: { app: 'test' } })
        expect(recorder.sessionId).toMatch(/^[0-9a-f]{32}$/u)
        expectParagraph(recording)
    })

    it('records on the main thread without a worker', async () => {
        const { errors, recording } = await recordParagraph({ worker: false, sessionId: 'main-thread' })
        expect(errors).toEqual([])
        expect(recording.header.sessionId).toBe('main-thread')
        expectParagraph(recording)
    })

    it('falls back to the main thread when the worker script does not load', async () => {
        const worker = new URL('/timecat-missing-worker.js', location.href)
        const { errors, recording } = await recordParagraph({ worker })
        expect(errors).toEqual([])
        expectParagraph(recording)
    })

    it('streams the recording as it is written', async () => {
        const parts: Uint8Array[] = []
        const recorder = record({ onData: bytes => void parts.push(bytes) })
        await recorder.ready
        recorder.flush()
        const blob = await recorder.stop()
        const streamed = new Blob(parts.map(part => new Uint8Array(part)))
        expect(new Uint8Array(await streamed.arrayBuffer())).toEqual(new Uint8Array(await blob.arrayBuffer()))
    })

    it('records pointer moves in batches, without a frame per move', async () => {
        const recorder = record()
        await recorder.ready
        await nextFrame()
        const frames = vi.spyOn(window, 'requestAnimationFrame')
        for (let i = 0; i < 10; i++) {
            window.dispatchEvent(new PointerEvent('pointermove', { clientX: i, clientY: 2 * i, isPrimary: true }))
        }
        expect(frames).not.toHaveBeenCalled()
        frames.mockRestore()
        const moves = eventsOf((await decodeRecording(await recorder.stop())).events, EventType.PointerMoves)
        expect(moves.flatMap(batch => batch.xs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        expect(moves.flatMap(batch => batch.ys)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
    })

    it('exports the recording so far and keeps recording', async () => {
        const recorder = record()
        await recorder.ready
        const early = await decodeRecording(await recorder.export())
        expect(early.events[0]?.event.type).toBe(EventType.Snapshot)
        const div = document.createElement('div')
        document.body.append(div)
        added.push(div)
        await nextFrame()
        const late = await decodeRecording(await recorder.stop())
        expect(late.events.length).toBeGreaterThan(early.events.length)
    })

    it('keeps the recording in the origin private file system until it stops', async () => {
        const recorder = record({ storage: 'opfs', sessionId: 'opfs/test' })
        await recorder.ready
        const exported = await recorder.export()
        const root = await navigator.storage.getDirectory()
        const directory = await root.getDirectoryHandle(OPFS_DIRECTORY)
        const file = await (await directory.getFileHandle('opfs%2Ftest-0.tcr')).getFile()
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(await exported.arrayBuffer()))
        await recorder.stop()
        await expect(directory.getFileHandle('opfs%2Ftest-0.tcr')).rejects.toMatchObject({ name: 'NotFoundError' })
    })

    it('reports that files need a worker and keeps the recording in memory', async () => {
        const errors: unknown[] = []
        const recorder = record({ storage: 'opfs', worker: false, onError: error => void errors.push(error) })
        await recorder.ready
        const recording = await decodeRecording(await recorder.stop())
        expect(recording.events[0]?.event.type).toBe(EventType.Snapshot)
        expect(errors).toHaveLength(1)
        expect(String(errors[0])).toContain('OPFS')
    })

    it('rejects invalid options before it starts', () => {
        let error: unknown
        try {
            record({ maskText: '[' })
        } catch (thrown) {
            error = thrown
        }
        expect(error).toMatchObject({ name: 'SyntaxError' })
        expect(() => record({ segment: -1 })).toThrow(RangeError)
        expect(() => record({ meta: { big: 1n } })).toThrow(TypeError)
    })
})
