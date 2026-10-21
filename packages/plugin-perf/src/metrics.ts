/** Most time between two shifts of one session window, and the longest window, as Core Web Vitals define CLS. */
const SHIFT_GAP = 1000
const SHIFT_WINDOW = 5000
/** Interactions INP leaves out: one of every 50, the longest first, as an approximation of the 98th percentile. */
const INTERACTIONS_PER_OUTLIER = 50
/** Longest interactions kept, enough for 500 interactions. */
const KEPT_INTERACTIONS = 10

/**
 * Cumulative Layout Shift: the largest sum of the shifts of a session window, a burst of shifts less than a second
 * apart and at most five seconds long.
 */
export class LayoutShifts {
    #value = 0
    #window = 0
    #first = 0
    #last = 0

    /** Adds a shift that no recent input caused. Returns the CLS when it grew. */
    add(value: number, time: number): number | undefined {
        if (this.#window > 0 && time - this.#last < SHIFT_GAP && time - this.#first < SHIFT_WINDOW) {
            this.#window += value
        } else {
            this.#window = value
            this.#first = time
        }
        this.#last = time
        if (this.#window <= this.#value) {
            return undefined
        }
        this.#value = this.#window
        return this.#value
    }
}

interface Interaction<T> {
    id: number
    duration: number
    target: T
}

/**
 * Interaction to Next Paint: the longest interaction, leaving out one of every 50 interactions, as an
 * approximation of the 98th percentile. An interaction lasts as long as the longest of its events.
 */
export class Interactions<T> {
    /** Ids of the interactions seen. */
    readonly #ids = new Set<number>()
    /** The longest interactions, the longest first. */
    readonly #longest: Interaction<T>[] = []
    /** The INP last returned. */
    #value = 0

    /** Adds an event of interaction `id`. Returns the interaction that INP now is, when its duration changed. */
    add(id: number, duration: number, target: T): { duration: number; target: T } | undefined {
        this.#ids.add(id)
        const longest = this.#longest
        const known = longest.find(interaction => interaction.id === id)
        if (known !== undefined) {
            if (duration <= known.duration) {
                return undefined
            }
            known.duration = duration
            known.target = target
        } else {
            longest.push({ id, duration, target })
        }
        longest.sort((a, b) => b.duration - a.duration)
        longest.length = Math.min(longest.length, KEPT_INTERACTIONS)
        const index = Math.min(Math.floor(this.#ids.size / INTERACTIONS_PER_OUTLIER), longest.length - 1)
        const value = longest[index]
        if (value === undefined || value.duration === this.#value) {
            return undefined
        }
        this.#value = value.duration
        return { duration: value.duration, target: value.target }
    }
}
