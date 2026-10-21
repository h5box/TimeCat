import {
    ByteReader,
    ChunkFlag,
    ChunkKind,
    decodeEvent,
    EventType,
    gunzip,
    gzip,
    readChunk,
    readEventFrames,
    readFileHeader,
    Track
} from '@timecat-js/protocol'
import type { Chunk, FileHeader, IdCounter, TcrEvent } from '@timecat-js/protocol'
import type { Keyframe, PointerTrail, TimelineIndex } from './types.ts'
import { VirtualDocument } from './virtual.ts'

export interface IndexOptions {
    /** Least work between two keyframes; see `PlayerOptions.keyframeInterval`. */
    keyframeInterval: number
}

/** A recording segment: a TCR file, as a blob or as bytes. */
export type SegmentSource = Blob | Uint8Array

interface Segment {
    header: FileHeader
    chunks: Chunk[]
}

interface Frame {
    track: number
    /** An event type, or `GAP`. */
    type: number
    time: number
    body: Uint8Array
}

/** Marks DOM events that could not be read: later ones depend on them, until the next snapshot. */
const GAP = 0
const EMPTY = new Uint8Array(0)

/**
 * Reads the segments of one session into a timeline index. Damage that a recording can survive, such as a
 * truncated last chunk, becomes a warning; a segment that is not a recording at all rejects.
 */
export async function buildIndex(sources: readonly SegmentSource[], options: IndexOptions): Promise<TimelineIndex> {
    const warnings: string[] = []
    const files = await Promise.all(sources.map(readSource))
    const segments = files.map(bytes => readSegment(bytes, warnings))
    segments.sort((a, b) => a.header.segment - b.header.segment || a.header.startedAt - b.header.startedAt)
    const first = segments[0]?.header
    if (first === undefined) {
        throw new RangeError('no recording to load')
    }
    for (const { header } of segments) {
        if (header.sessionId !== first.sessionId) {
            throw new RangeError(`segments of different sessions: ${first.sessionId} and ${header.sessionId}`)
        }
    }
    const perSegment = await Promise.all(segments.map(segment => readFrames(segment, warnings)))

    // Segments follow each other: one starts no earlier than the previous one ends, whatever the clocks say.
    const frames: Frame[] = []
    let end = 0
    for (const [i, segment] of segments.entries()) {
        const { frames: segmentFrames, end: segmentEnd } = perSegment[i]!
        const offset = Math.max(segment.header.startedAt - first.startedAt, end)
        for (const frame of segmentFrames) {
            frame.time += offset
            frames.push(frame)
        }
        end = Math.max(end, offset + segmentEnd)
    }
    const index = indexFrames(frames, options, warnings)
    return {
        sessionId: first.sessionId,
        startedAt: first.startedAt,
        meta: first.meta,
        start: index.events.count > 0 ? index.events.times[0]! : 0,
        end: Math.max(end, index.end),
        events: index.events,
        keyframes: await index.keyframes,
        pointer: index.pointer,
        warnings
    }
}

async function readSource(source: SegmentSource): Promise<Uint8Array> {
    // Duck-typed, because a source can come from another realm.
    return 'arrayBuffer' in source ? new Uint8Array(await source.arrayBuffer()) : source
}

/** Reads a segment's header and as many whole chunks as there are. */
function readSegment(bytes: Uint8Array, warnings: string[]): Segment {
    const reader = new ByteReader(bytes)
    const header = readFileHeader(reader)
    const chunks: Chunk[] = []
    while (reader.remaining > 0) {
        try {
            chunks.push(readChunk(reader))
        } catch (error) {
            warnings.push(`segment ${header.segment} is cut short (${describe(error)}); its end is left out`)
            break
        }
    }
    return { header, chunks }
}

/** A segment's events in replay order: by time, then track, each track in recording order. */
async function readFrames(segment: Segment, warnings: string[]): Promise<{ frames: Frame[]; end: number }> {
    const chunks = segment.chunks.filter(chunk => chunk.kind === ChunkKind.Events)
    chunks.sort((a, b) => a.sequence - b.sequence)
    const payloads = await Promise.all(
        chunks.map(async chunk =>
            chunk.flags & ChunkFlag.Gzip ? gunzip(chunk.payload).catch(() => undefined) : chunk.payload
        )
    )
    const frames: Frame[] = []
    let end = 0
    for (const [i, chunk] of chunks.entries()) {
        end = Math.max(end, chunk.startTime + chunk.duration)
        const payload = payloads[i]
        try {
            if (payload === undefined) {
                throw new Error('its payload is not valid gzip data')
            }
            for (const frame of readEventFrames(payload, chunk.startTime)) {
                frames.push({ track: chunk.track, ...frame })
            }
        } catch (error) {
            warnings.push(
                `chunk ${chunk.sequence} of segment ${segment.header.segment} cannot be read (${describe(error)}); ` +
                    'its events are left out'
            )
            if (chunk.track === Track.Dom) {
                frames.push({ track: Track.Dom, type: GAP, time: chunk.startTime, body: EMPTY })
            }
        }
    }
    // Stable, so each track keeps its order.
    frames.sort((a, b) => a.time - b.time || a.track - b.track)
    return { frames, end }
}

/** Collects the column arrays of the index while events are read. */
class EventColumns {
    count = 0
    #times: number[] = []
    #types: number[] = []
    #idBases: number[] = []
    #bodies: Uint8Array[] = []
    #costs: number[] = [0]
    #size = 0

    push(time: number, type: number, idBase: number, body: Uint8Array, cost: number): void {
        this.#times.push(time)
        this.#types.push(type)
        this.#idBases.push(idBase)
        this.#bodies.push(body)
        this.#costs.push(this.#costs[this.count]! + cost)
        this.#size += body.length
        this.count++
    }

    finish(): TimelineIndex['events'] {
        const count = this.count
        const offsets = new Uint32Array(count)
        const lengths = new Uint32Array(count)
        const bodies = new Uint8Array(this.#size)
        let offset = 0
        for (const [i, body] of this.#bodies.entries()) {
            offsets[i] = offset
            lengths[i] = body.length
            bodies.set(body, offset)
            offset += body.length
        }
        return {
            count,
            times: Float64Array.from(this.#times),
            types: Uint8Array.from(this.#types),
            idBases: Float64Array.from(this.#idBases),
            offsets,
            lengths,
            bodies,
            costs: Float64Array.from(this.#costs)
        }
    }
}

function indexFrames(frames: readonly Frame[], options: IndexOptions, warnings: string[]) {
    const columns = new EventColumns()
    const document = new VirtualDocument()
    const keyframes: Keyframe[] = []
    const compressions: Promise<void>[] = []
    const ids: IdCounter = { next: 1 }
    const pointer = new PointerColumns()
    let viewport: Keyframe['viewport']
    /** DOM events cannot be applied until the next snapshot, because an earlier one is missing. */
    let broken = false
    let sinceKeyframe = 0
    let end = 0
    for (const frame of frames) {
        const { type, time, body } = frame
        end = Math.max(end, time)
        if (type === GAP) {
            broken = true
            continue
        }
        const idBase = ids.next
        let event: TcrEvent | undefined
        try {
            event = decodeEvent(type, body, ids)
        } catch (error) {
            warnings.push(`an event at ${time} ms cannot be read (${describe(error)}); it is left out`)
            broken ||= type === EventType.Snapshot || type === EventType.Mutations
            continue
        }
        if (event === undefined) {
            continue
        }
        if (event.type === EventType.PointerMoves || event.type === EventType.PointerButton) {
            end = Math.max(end, pointer.add(event, time))
            continue
        }
        if (event.type === EventType.Snapshot) {
            broken = false
        } else if (broken && event.type === EventType.Mutations) {
            continue
        }
        const cost = document.apply(event)
        columns.push(time, type, idBase, body, cost)
        if (event.type === EventType.Viewport) {
            viewport = { width: event.width, height: event.height }
        }
        if (event.type === EventType.Snapshot) {
            sinceKeyframe = 0
            keyframes.push({
                index: columns.count,
                time,
                cost,
                viewport,
                recorded: true,
                snapshot: EMPTY,
                input: EMPTY,
                scroll: EMPTY
            })
            continue
        }
        sinceKeyframe += cost
        // Seeking from a keyframe costs about its size, then the events after it: half the document size in
        // events keeps the two in balance.
        if (sinceKeyframe < Math.max(options.keyframeInterval, document.size / 2)) {
            continue
        }
        const state = document.encode(ids.next)
        if (state === undefined) {
            continue
        }
        sinceKeyframe = 0
        const keyframe: Keyframe = {
            index: columns.count,
            time,
            cost: document.size,
            viewport,
            recorded: false,
            snapshot: EMPTY,
            input: state.input,
            scroll: state.scroll
        }
        keyframes.push(keyframe)
        compressions.push(compress(keyframe, state.snapshot))
    }
    return {
        events: columns.finish(),
        keyframes: Promise.all(compressions).then(() => keyframes),
        pointer: pointer.finish(),
        end
    }
}

/** Collects the pointer trail. */
class PointerColumns {
    readonly #times: number[] = []
    readonly #xs: number[] = []
    readonly #ys: number[] = []
    readonly #pointers: number[] = []
    readonly #buttonTimes: number[] = []
    readonly #actions: number[] = []
    readonly #buttonXs: number[] = []
    readonly #buttonYs: number[] = []

    /** Adds a pointer event; returns the time of its last sample. */
    add(event: Extract<TcrEvent, { type: 4 | 5 }>, time: number): number {
        if (event.type === EventType.PointerButton) {
            this.#buttonTimes.push(time)
            this.#actions.push(event.action)
            this.#buttonXs.push(event.x)
            this.#buttonYs.push(event.y)
            this.#sample(time, event.x, event.y, event.pointer)
            return time
        }
        let sampleTime = time
        for (let i = 0; i < event.times.length; i++) {
            sampleTime = time + event.times[i]!
            this.#sample(sampleTime, event.xs[i]!, event.ys[i]!, event.pointer)
        }
        return sampleTime
    }

    #sample(time: number, x: number, y: number, pointer: number): void {
        this.#times.push(time)
        this.#xs.push(x)
        this.#ys.push(y)
        this.#pointers.push(pointer)
    }

    finish(): PointerTrail {
        // Recordings keep the trail in order; one that does not is put in order, the earliest sample first.
        const order = sortedOrder(this.#times)
        const buttons = sortedOrder(this.#buttonTimes)
        return {
            times: Float64Array.from(order, i => this.#times[i]!),
            xs: Int32Array.from(order, i => this.#xs[i]!),
            ys: Int32Array.from(order, i => this.#ys[i]!),
            pointers: Uint8Array.from(order, i => this.#pointers[i]!),
            buttons: {
                times: Float64Array.from(buttons, i => this.#buttonTimes[i]!),
                actions: Uint8Array.from(buttons, i => this.#actions[i]!),
                xs: Int32Array.from(buttons, i => this.#buttonXs[i]!),
                ys: Int32Array.from(buttons, i => this.#buttonYs[i]!)
            }
        }
    }
}

async function compress(keyframe: Keyframe, snapshot: Uint8Array): Promise<void> {
    keyframe.snapshot = await gzip(snapshot)
}

/** Indexes of `times` in ascending, stable order. */
function sortedOrder(times: readonly number[]): number[] {
    return times.map((_, i) => i).toSorted((a, b) => times[a]! - times[b]!)
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
