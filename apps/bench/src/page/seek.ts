// Init script of the seek benchmark. It records a long session of the dashboard fixture in seconds, on a
// clock it moves itself, through the recorder's capture and pipeline: the public API runs on the real clock.
// Then it replays the recording and times seeks.
import { createPlayer } from '@timecat-js/player-core'
import { BatchWriter } from '../../../../packages/recorder/src/batch.ts'
import { Capture } from '../../../../packages/recorder/src/capture.ts'
import { Pipeline } from '../../../../packages/recorder/src/pipeline/pipeline.ts'

let recording: Uint8Array<ArrayBuffer> | undefined

window.timecatSeek = {
    async record(minutes, fps) {
        const step = window.benchScenario?.step
        if (step === undefined) {
            throw new Error('the page has no step function')
        }
        const parts: Uint8Array[] = []
        const errors: unknown[] = []
        const onError = (error: unknown): void => void errors.push(error)
        let time = 0
        const pipeline = new Pipeline(
            { sessionId: 'seek-bench', segment: 0, startedAt: Date.now(), meta: {} },
            bytes => void parts.push(bytes),
            onError
        )
        const capture = new Capture({
            window,
            sink: new BatchWriter(batch => pipeline.push(batch)),
            now: () => time,
            sliceMs: 60_000,
            checkEvery: 64,
            assetBudget: 0,
            yieldToPage: () => Promise.resolve(),
            scheduleFlush: () => noop,
            onHidden: noop,
            onError
        })
        const startedAt = performance.now()
        await capture.start()
        const frames = Math.round(minutes * 60 * fps)
        for (let frame = 1; frame <= frames; frame++) {
            time = Math.round((frame * 1000) / fps)
            step(frame)
            capture.flush(true)
            if (frame % 600 === 0) {
                // Lets the pipeline compress what it has.
                await new Promise(resolve => setTimeout(resolve, 0))
            }
        }
        capture.stop()
        await pipeline.close()
        if (errors.length > 0) {
            throw new Error(`recording failed: ${String(errors[0])}`)
        }
        recording = concat(parts)
        return { frames, bytes: recording.length, recordMs: performance.now() - startedAt }
    },

    async replay(targets, keyframeInterval) {
        if (recording === undefined) {
            throw new Error('nothing recorded yet')
        }
        const container = document.createElement('div')
        container.style.cssText = 'position: fixed; inset: 0; z-index: 1; background: white'
        document.body.append(container)
        const errors: unknown[] = []
        const loadStart = performance.now()
        const player = await createPlayer(recording, {
            container,
            keyframeInterval,
            onError: error => void errors.push(error)
        })
        const loadMs = performance.now() - loadStart
        const seeks: number[] = []
        try {
            for (const target of targets) {
                const seekStart = performance.now()
                await player.seek(target * player.duration)
                // Style and layout of what the seek built count too.
                void player.document.body?.offsetHeight
                seeks.push(performance.now() - seekStart)
            }
        } finally {
            player.destroy()
            container.remove()
        }
        if (errors.length > 0) {
            throw new Error(`replay failed: ${String(errors[0])}`)
        }
        return { durationMs: player.duration, loadMs, seeks }
    }
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
    let offset = 0
    for (const part of parts) {
        result.set(part, offset)
        offset += part.length
    }
    return result
}

function noop(): void {}
