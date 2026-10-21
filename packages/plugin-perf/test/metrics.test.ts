import { describe, expect, it } from 'vitest'
import { Interactions, LayoutShifts } from '../src/metrics.ts'

describe('LayoutShifts', () => {
    it('sums the shifts of a session window and keeps the largest sum', () => {
        const shifts = new LayoutShifts()
        expect(shifts.add(0.1, 0)).toBe(0.1)
        expect(shifts.add(0.05, 900)).toBeCloseTo(0.15)
        // A second without a shift ends the window.
        expect(shifts.add(0.1, 1900)).toBeUndefined()
        expect(shifts.add(0.04, 2800)).toBeUndefined()
        expect(shifts.add(0.02, 3700)).toBeCloseTo(0.16)
    })

    it('ends a window after five seconds', () => {
        const shifts = new LayoutShifts()
        for (let time = 0; time < 5000; time += 500) {
            shifts.add(0.01, time)
        }
        expect(shifts.add(0.01, 5000)).toBeUndefined()
        expect(shifts.add(0.2, 5400)).toBeCloseTo(0.21)
    })
})

describe('Interactions', () => {
    it('is the longest interaction, each as long as its longest event', () => {
        const interactions = new Interactions<string>()
        expect(interactions.add(1, 40, 'a')).toEqual({ duration: 40, target: 'a' })
        expect(interactions.add(2, 24, 'b')).toBeUndefined()
        expect(interactions.add(1, 32, 'a up')).toBeUndefined()
        expect(interactions.add(2, 80, 'b up')).toEqual({ duration: 80, target: 'b up' })
    })

    it('leaves out one of every 50 interactions, the longest first', () => {
        const interactions = new Interactions<number>()
        interactions.add(1, 500, 1)
        interactions.add(2, 300, 2)
        for (let id = 3; id < 50; id++) {
            interactions.add(id, 16, id)
        }
        expect(interactions.add(50, 16, 50)).toEqual({ duration: 300, target: 2 })
        for (let id = 51; id < 100; id++) {
            interactions.add(id, 16, id)
        }
        expect(interactions.add(100, 20, 100)).toEqual({ duration: 20, target: 100 })
    })
})
