import type { IndexOptions, SegmentSource } from './build.ts'
import type { TimelineIndex } from './types.ts'

/** What the page asks the indexing worker for. */
export interface IndexRequest extends IndexOptions {
    sources: SegmentSource[]
}

/** The indexing worker's answer. Errors come as their name and message, which survive any page's cloning. */
export type IndexResponse = { type: 'index'; index: TimelineIndex } | { type: 'error'; name: string; message: string }
