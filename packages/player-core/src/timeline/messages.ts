import type { SegmentSource } from './build.ts'
import type { TimelineIndex } from './types.ts'

/**
 * What the page asks the indexing worker for: to index whole sources (`load`), or bytes as they come (`open`,
 * then `bytes` until `end`).
 */
export type IndexRequest =
    | { type: 'load'; sources: SegmentSource[]; keyframeInterval: number }
    | { type: 'open'; keyframeInterval: number }
    | { type: 'bytes'; bytes: Uint8Array<ArrayBuffer> }
    | { type: 'end' }

/**
 * The indexing worker's answers: `ready` once it runs, then the index, or for bytes that come, its parts. Errors
 * come as their name and message, which survive any page's cloning.
 */
export type IndexResponse =
    | { type: 'ready' }
    | { type: 'index'; index: TimelineIndex }
    | { type: 'error'; name: string; message: string }
