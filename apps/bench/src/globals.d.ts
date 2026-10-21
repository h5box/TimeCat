import type { BenchState } from './harness.ts'

/** What the bench uses of `@timecat-js/recorder`; its sources are checked as browser code, with src/page. */
interface TimeCatRecorder {
    readonly ready: Promise<void>
    flush(): void
    stop(): Promise<Blob>
}

declare global {
    interface Window {
        timecatBench?: BenchState
        /** UMD global of @rrweb/record. */
        rrwebRecord?: {
            record: (options: { emit: (event: unknown) => void; maskAllInputs?: boolean }) => (() => void) | undefined
        }
        /** Set by the init script of the `timecat` adapter (src/page/timecat.ts). */
        timecat?: {
            record: () => TimeCatRecorder
            recorder: TimeCatRecorder | undefined
            /** Events in a recording, and its size with every chunk uncompressed. */
            summarize: (blob: Blob) => Promise<{ events: number; rawBytes: number }>
        }
        /** Set by the init script of the seek benchmark (src/page/seek.ts). */
        timecatSeek?: {
            /** Records `minutes` of the page's `step`, called `fps` times a second, on a simulated clock. */
            record: (minutes: number, fps: number) => Promise<{ frames: number; bytes: number; recordMs: number }>
            /** Loads the recording and seeks to each target, a fraction of its duration, in turn. */
            replay: (
                targets: number[],
                keyframeInterval: number | undefined
            ) => Promise<{ durationMs: number; loadMs: number; seeks: number[] }>
        }
        /** Exposed by fixtures that drive their own mutations. */
        benchScenario?: { run: (frames: number) => Promise<number>; step?: (frame: number) => void }
    }
}
