interface LongTask {
    startTime: number
    duration: number
}

/** Per-page measurement state, created before any page script runs. */
export interface BenchState {
    /** performance.now() when recording started. */
    recordStart: number
    events: unknown[]
    stop: (() => void) | undefined
    /** Long tasks that ended after recording started, including the one that started it. */
    longTasksSinceRecordStart: () => LongTask[]
    /**
     * Runs `fn` in its own page task, the way page scripts call an SDK. Work evaluated through CDP is
     * invisible to the Long Tasks API, so recorders must be started through this.
     */
    inPageTask: <T>(fn: () => T) => Promise<T>
}

/** Init script (runs inside the page): sets up `window.timecatBench` and a buffered long task observer. */
export function installHarness(): void {
    const longTasks: LongTask[] = []
    const collect = (entries: PerformanceEntryList): void => {
        for (const entry of entries) {
            longTasks.push({ startTime: entry.startTime, duration: entry.duration })
        }
    }
    const observer = new PerformanceObserver(list => collect(list.getEntries()))
    observer.observe({ type: 'longtask', buffered: true })

    const state: BenchState = {
        recordStart: Number.POSITIVE_INFINITY,
        events: [],
        stop: undefined,
        longTasksSinceRecordStart: () => {
            // Entries are delivered asynchronously; take the queued ones so the latest tasks are not missed.
            collect(observer.takeRecords())
            return longTasks.filter(task => task.startTime + task.duration > state.recordStart)
        },
        inPageTask: fn =>
            new Promise((resolve, reject) => {
                setTimeout(() => {
                    try {
                        resolve(fn())
                    } catch (error) {
                        reject(error)
                    }
                }, 0)
            })
    }
    window.timecatBench = state
}
