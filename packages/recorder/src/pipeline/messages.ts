import type { SegmentInfo } from '@timecat-js/protocol'

/**
 * How long a chunk spans at most by default, in recording time and in wall-clock time. Here rather than in the
 * pipeline, so the page does not load the pipeline to know it.
 */
export const LATENCY = 5000

/** Where finished chunks are kept until the recording is exported. */
export type StorageKind = 'memory' | 'opfs'

/** Messages from the page to the pipeline. */
export type Request =
    /** `latency` is how long a chunk spans at most, in milliseconds. */
    | { type: 'init'; info: SegmentInfo; storage: StorageKind; stream: boolean; latency: number }
    /** Records written by `BatchWriter`. */
    | { type: 'batch'; batch: Uint8Array<ArrayBuffer> }
    /** Ends the open chunks, so storage has everything so far. */
    | { type: 'flush' }
    | { type: 'export'; id: number }
    | { type: 'stop'; id: number }

/** Messages from the pipeline to the page. */
export type Response =
    | { type: 'ready' }
    /** The header or a chunk, in recording order; only when the init request asked to `stream`. */
    | { type: 'data'; bytes: Uint8Array<ArrayBuffer> }
    | { type: 'result'; id: number; blob: Blob }
    | { type: 'failed'; id: number; error: unknown }
    | { type: 'error'; error: unknown }
