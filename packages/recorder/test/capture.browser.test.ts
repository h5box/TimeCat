import { describe, expect, it } from 'vitest'
import { BatchWriter } from '../src/batch.ts'
import { Capture } from '../src/capture.ts'

function noop(): void {}

describe('Capture', () => {
    it('schedules no flush for pointer moves', async () => {
        let scheduled = 0
        const errors: unknown[] = []
        const capture = new Capture({
            window,
            sink: new BatchWriter(noop),
            now: () => 0,
            sliceMs: 60_000,
            checkEvery: 64,
            assetBudget: 0,
            yieldToPage: () => Promise.resolve(),
            scheduleFlush: () => {
                scheduled++
                return noop
            },
            onHidden: noop,
            onError: error => void errors.push(error)
        })
        await capture.start()
        scheduled = 0
        for (let i = 0; i < 10; i++) {
            window.dispatchEvent(new PointerEvent('pointermove', { clientX: i, clientY: i, isPrimary: true }))
        }
        capture.stop()
        // Moves are written in batches, once they span long enough; a flush per move would be wasted.
        expect(scheduled).toBe(0)
        expect(errors).toEqual([])
    })
})
