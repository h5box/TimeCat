import type { BenchState } from './harness.ts'

declare global {
    interface Window {
        timecatBench?: BenchState
        /** UMD global of @rrweb/record. */
        rrwebRecord?: {
            record: (options: { emit: (event: unknown) => void; maskAllInputs?: boolean }) => (() => void) | undefined
        }
        /** Exposed by fixtures that drive their own mutations. */
        benchScenario?: { run: (frames: number) => Promise<number> }
    }
}
