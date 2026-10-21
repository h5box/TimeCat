/**
 * What the indexer hands the player: every event in replay order with its body still encoded, the keyframes to
 * seek from and the pointer trail. Made of typed arrays, so it moves from the worker without a copy.
 */
export interface TimelineIndex {
    sessionId: string
    /** Wall-clock start of the first segment, in epoch milliseconds. Event times are relative to it. */
    startedAt: number
    /** Metadata of the first segment's header. */
    meta: Record<string, unknown>
    /** Time of the first event, where playback starts. */
    start: number
    /** Time of the last thing recorded. */
    end: number
    events: EventTable
    keyframes: Keyframe[]
    pointer: PointerTrail
    /**
     * FontFace and Asset events, as an events chunk payload. They hold for the whole recording, whatever their
     * time, so `events` leaves them out.
     */
    statics: Uint8Array<ArrayBuffer>
    /** Problems the recording was read despite, such as a truncated last chunk. */
    warnings: string[]
}

/**
 * Events in replay order: by segment, then time, then track. Pointer events are left out; the pointer trail
 * holds them.
 */
interface EventTable {
    count: number
    times: Float64Array<ArrayBuffer>
    types: Uint8Array<ArrayBuffer>
    /** Next free node id before each event, which decoding a DOM event needs (RFC 0002, section 6.3). */
    idBases: Float64Array<ArrayBuffer>
    offsets: Uint32Array<ArrayBuffer>
    lengths: Uint32Array<ArrayBuffer>
    /** Every body, back to back. */
    bodies: Uint8Array<ArrayBuffer>
    /** Work of applying the events before each one, summed: `costs[j] - costs[i]` is the work of events i..j-1. */
    costs: Float64Array<ArrayBuffer>
}

/** A state seeking can start from: what applying the first `index` events produces. */
export interface Keyframe {
    index: number
    time: number
    /** Work of materializing it, comparable to event costs. */
    cost: number
    viewport: { width: number; height: number } | undefined
    /** A recorded snapshot: the event before `index`. Otherwise the snapshot below, built by the indexer. */
    recorded: boolean
    /** Snapshot body with explicit ids, gzip-compressed. Empty for recorded snapshots. */
    snapshot: Uint8Array<ArrayBuffer>
    /** Input event body with the state of every control, or empty. */
    input: Uint8Array<ArrayBuffer>
    /** Scroll event body with the offset of every scrolled node, or empty. */
    scroll: Uint8Array<ArrayBuffer>
    /**
     * StyleSheet and AdoptedStyleSheets events that bring the sheets of the snapshot to their state, as an events
     * chunk payload, gzip-compressed; or empty. Always empty for recorded snapshots: the events after them do that.
     */
    styles: Uint8Array<ArrayBuffer>
}

/** Pointer positions and button presses, in time order. */
export interface PointerTrail {
    times: Float64Array<ArrayBuffer>
    xs: Int32Array<ArrayBuffer>
    ys: Int32Array<ArrayBuffer>
    /** `PointerType` of each sample. */
    pointers: Uint8Array<ArrayBuffer>
    buttons: ButtonTrail
}

interface ButtonTrail {
    times: Float64Array<ArrayBuffer>
    /** `PointerAction` of each press or release. */
    actions: Uint8Array<ArrayBuffer>
    xs: Int32Array<ArrayBuffer>
    ys: Int32Array<ArrayBuffer>
}

/** Buffers of an index, for transferring it. */
export function transferables(index: TimelineIndex): ArrayBuffer[] {
    const { events, pointer } = index
    const buffers = [
        events.times,
        events.types,
        events.idBases,
        events.offsets,
        events.lengths,
        events.bodies,
        events.costs,
        pointer.times,
        pointer.xs,
        pointer.ys,
        pointer.pointers,
        pointer.buttons.times,
        pointer.buttons.actions,
        pointer.buttons.xs,
        pointer.buttons.ys
    ].map(array => array.buffer)
    buffers.push(index.statics.buffer)
    for (const keyframe of index.keyframes) {
        buffers.push(keyframe.snapshot.buffer, keyframe.input.buffer, keyframe.scroll.buffer, keyframe.styles.buffer)
    }
    // A buffer can be listed only once.
    return [...new Set(buffers)]
}
