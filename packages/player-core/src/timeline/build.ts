import {
    ByteReader,
    ByteWriter,
    ChunkFlag,
    ChunkKind,
    decodeEvent,
    EventType,
    gunzip,
    gzip,
    MAGIC,
    readChunk,
    readEventFrames,
    readFileHeader,
    readMediaPackets,
    SegmentReader,
    Track,
    writeEventFrame
} from '@timecat-js/protocol'
import type {
    Chunk,
    FileHeader,
    FocusEvent,
    IdCounter,
    MediaStateEvent,
    MediaTrackEvent,
    TcrEvent,
    TopLayerEvent
} from '@timecat-js/protocol'
import type { At, Keyframe, MediaIndex, PointerTrail, TimelineIndex } from './types.ts'
import { VirtualDocument } from './virtual.ts'

export interface IndexOptions {
    /** Least work between two keyframes; see `PlayerOptions.keyframeInterval`. */
    keyframeInterval: number
}

/** Recording bytes, as a blob or as bytes: one segment, or several one after the other. */
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

/** Events that hold for the whole recording, whatever their time. */
const STATIC_TYPES: ReadonlySet<number> = new Set([EventType.FontFace, EventType.Asset])
/** Events recorded beside the page, which the replay does not apply. */
const DATA_TYPES: ReadonlySet<number> = new Set([
    EventType.Console,
    EventType.Network,
    EventType.Perf,
    EventType.Custom
])

/**
 * Reads the segments of one session into a timeline index. Damage that a recording can survive, such as a
 * truncated last chunk, becomes a warning; a source that is not a recording at all rejects.
 */
export async function buildIndex(sources: readonly SegmentSource[], options: IndexOptions): Promise<TimelineIndex> {
    const warnings: string[] = []
    const files = await Promise.all(sources.map(readSource))
    const segments = files.flatMap(bytes => readSegments(bytes, warnings))
    segments.sort((a, b) => a.header.segment - b.header.segment || a.header.startedAt - b.header.startedAt)
    if (segments.length === 0) {
        throw new RangeError('no recording to load')
    }
    const indexer = new Indexer(options, warnings)
    for (const segment of segments) {
        indexer.header(segment.header)
        const chunks = segment.chunks.toSorted((a, b) => a.sequence - b.sequence)
        // oxlint-disable-next-line no-await-in-loop -- segments are few, and their chunks decompress together
        const payloads = await Promise.all(chunks.map(decompress))
        for (const [i, chunk] of chunks.entries()) {
            indexer.chunk(chunk, payloads[i])
        }
    }
    indexer.finish()
    return indexer.take()
}

async function readSource(source: SegmentSource): Promise<Uint8Array> {
    // Duck-typed, because a source can come from another realm.
    return 'arrayBuffer' in source ? new Uint8Array(await source.arrayBuffer()) : source
}

/** Reads the segments of a source, and as many whole chunks of each as there are. */
function readSegments(bytes: Uint8Array, warnings: string[]): Segment[] {
    const reader = new ByteReader(bytes)
    let segment: Segment = { header: readFileHeader(reader), chunks: [] }
    const segments = [segment]
    while (reader.remaining > 0) {
        try {
            if (bytes[reader.offset] === MAGIC[0]) {
                segment = { header: readFileHeader(reader), chunks: [] }
                segments.push(segment)
            } else {
                segment.chunks.push(readChunk(reader))
            }
        } catch (error) {
            warnings.push(`segment ${segment.header.segment} is cut short (${describe(error)}); its end is left out`)
            break
        }
    }
    return segments
}

/** A chunk's payload, decompressed; `undefined` when it is not valid gzip data. */
async function decompress(chunk: Chunk): Promise<Uint8Array | undefined> {
    return chunk.flags & ChunkFlag.Gzip ? gunzip(chunk.payload).catch(() => undefined) : chunk.payload
}

/** How often a stream's indexer hands on what it indexed, at most. */
const STREAM_INTERVAL = 100

/**
 * Indexes recording bytes as they come, such as from a live recording: segments one after the other. Hands on
 * what it indexed through `post`, a part at a time, in order; reports with `fail` when the bytes are no recording,
 * after which it takes no more.
 */
export class StreamIndexer {
    readonly #reader = new SegmentReader()
    readonly #indexer: Indexer
    readonly #post: (index: TimelineIndex) => void
    readonly #fail: (error: unknown) => void
    /** Indexing, one header or chunk after the other. */
    #queue: Promise<void> = Promise.resolve()
    /** Handing on, one part after the other. */
    #posting: Promise<void> = Promise.resolve()
    readonly #interval: number
    #timer: ReturnType<typeof setTimeout> | undefined
    #failed = false

    /** `interval` is how long it waits, in milliseconds, before it hands on what it indexed. */
    constructor(
        options: IndexOptions,
        post: (index: TimelineIndex) => void,
        fail: (error: unknown) => void,
        interval: number = STREAM_INTERVAL
    ) {
        this.#indexer = new Indexer(options, [])
        this.#post = post
        this.#fail = fail
        this.#interval = interval
    }

    push(bytes: Uint8Array): void {
        if (this.#failed) {
            return
        }
        let items
        try {
            items = this.#reader.push(bytes)
        } catch (error) {
            this.#stop(error)
            return
        }
        const indexer = this.#indexer
        for (const { header, chunk } of items) {
            if (header !== undefined) {
                this.#enqueue(() => indexer.header(header))
            } else {
                // Decompression starts now, while earlier chunks are indexed.
                const payload = decompress(chunk)
                this.#enqueue(async () => indexer.chunk(chunk, await payload))
            }
        }
        this.#schedule()
    }

    /** The bytes ended: what is held back is all there is. */
    end(): void {
        if (this.#failed) {
            return
        }
        const pending = this.#reader.pending
        this.#enqueue(() => {
            if (!this.#indexer.started) {
                throw new RangeError('no recording to load')
            }
            if (pending > 0) {
                this.#indexer.warn(
                    `the recording is cut short (${pending} bytes are no whole chunk); its end is left out`
                )
            }
            this.#indexer.finish()
        })
        this.#schedule()
    }

    #enqueue(task: () => void | Promise<void>): void {
        this.#queue = this.#queue.then(task).catch((error: unknown) => this.#stop(error))
    }

    #schedule(): void {
        this.#timer ??= setTimeout(() => {
            this.#timer = undefined
            const indexed = this.#queue
            this.#posting = this.#posting.then(() => this.#hand(indexed))
        }, this.#interval)
    }

    /** Hands on what was indexed once `indexed` settles. */
    async #hand(indexed: Promise<void>): Promise<void> {
        await indexed
        const indexer = this.#indexer
        if (!this.#failed && indexer.started && indexer.changed) {
            this.#post(await indexer.take())
        }
    }

    #stop(error: unknown): void {
        if (!this.#failed) {
            this.#failed = true
            clearTimeout(this.#timer)
            this.#fail(error)
        }
    }
}

/** The segment being indexed. */
interface OpenSegment {
    header: FileHeader
    /** Where its time 0 is on the timeline. */
    offset: number
    /** The latest sync point, on the timeline: page events before it are all there. */
    sync: number
    /** Page events not indexed yet, as they came. */
    pending: Frame[]
}

/**
 * Indexes the segments of a session, given one after the other, each header followed by its chunks in order.
 * Page events wait until a sync chunk or the end of their segment says that no earlier one can come, then are
 * indexed in replay order; other events are indexed as they come. `take` hands on what was indexed since it was
 * last called.
 */
class Indexer {
    readonly #options: IndexOptions
    #warnings: string[]
    #first: FileHeader | undefined
    #segment: OpenSegment | undefined
    /** Where the chunks read so far end, on the timeline: the next segment starts no earlier. */
    #chunkEnd = 0
    /** The latest event or pointer sample indexed. */
    #lastTime = 0
    /** How far the timeline is complete while more is to come. */
    #edge = 0
    #done = false
    #changed = false
    #start: number | undefined
    readonly #document = new VirtualDocument()
    readonly #ids: IdCounter = { next: 1 }
    readonly #columns = new EventColumns()
    #keyframes: Keyframe[] = []
    #compressions: Promise<void>[] = []
    #pointer = new PointerColumns()
    #statics = new ByteWriter()
    #data: Frame[] = []
    #mediaTracks: At<MediaTrackEvent>[] = []
    #mediaStates: At<MediaStateEvent>[] = []
    #focus: At<FocusEvent>[] = []
    #topLayer: At<TopLayerEvent>[] = []
    #packets = new PacketColumns()
    /** Media tracks whose packets cannot be decoded until their next key packet, because one is missing. */
    readonly #brokenTracks = new Set<number>()
    #viewport: Keyframe['viewport']
    /** DOM events cannot be applied until the next snapshot, because an earlier one is missing. */
    #broken = false
    #sinceKeyframe = 0

    constructor(options: IndexOptions, warnings: string[]) {
        this.#options = options
        this.#warnings = warnings
    }

    /** Whether a segment started. */
    get started(): boolean {
        return this.#first !== undefined
    }

    /** Whether there is something to `take`. */
    get changed(): boolean {
        return this.#changed || this.#warnings.length > 0
    }

    warn(warning: string): void {
        this.#warnings.push(warning)
    }

    /** Ends the segment so far and starts the next. Segments follow each other, whatever the clocks say. */
    header(header: FileHeader): void {
        const first = (this.#first ??= header)
        if (header.sessionId !== first.sessionId) {
            throw new RangeError(`segments of different sessions: ${first.sessionId} and ${header.sessionId}`)
        }
        this.#endSegment()
        const offset = Math.max(header.startedAt - first.startedAt, this.#chunkEnd)
        this.#segment = { header, offset, sync: offset, pending: [] }
        this.#moveEdge(offset)
    }

    /** Takes a chunk of the current segment, with its payload decompressed, or `undefined` where that failed. */
    chunk(chunk: Chunk, payload: Uint8Array | undefined): void {
        const segment = this.#segment
        if (segment === undefined) {
            return
        }
        const { offset } = segment
        if (chunk.kind === ChunkKind.Sync) {
            segment.sync = Math.max(segment.sync, offset + chunk.startTime)
            this.#release(segment, segment.sync)
            this.#moveEdge(segment.sync)
            return
        }
        if (chunk.kind !== ChunkKind.Events && chunk.kind !== ChunkKind.Media) {
            return
        }
        this.#chunkEnd = Math.max(this.#chunkEnd, offset + chunk.startTime + chunk.duration)
        if (chunk.kind === ChunkKind.Media) {
            this.#media(segment, chunk, payload)
            return
        }
        let frames
        try {
            if (payload === undefined) {
                throw new Error('its payload is not valid gzip data')
            }
            frames = readEventFrames(payload, chunk.startTime)
        } catch (error) {
            this.#warnings.push(
                `chunk ${chunk.sequence} of segment ${segment.header.segment} cannot be read (${describe(error)}); ` +
                    'its events are left out'
            )
            if (chunk.track === Track.Dom) {
                segment.pending.push({ track: Track.Dom, type: GAP, time: offset + chunk.startTime, body: EMPTY })
            }
            return
        }
        const page = chunk.track < Track.Console
        for (const { type, time, body } of frames) {
            const frame = { track: chunk.track, type, time: offset + time, body }
            if (page) {
                // A page event before the sync point broke its promise; it is taken as coming at it.
                frame.time = Math.max(frame.time, segment.sync)
                segment.pending.push(frame)
            } else {
                // Order does not matter for these: they hold for the whole recording, or are kept in time order.
                this.#index(frame, { next: 0 })
            }
        }
    }

    /** Indexes the packets of a media chunk, which need no order but their own. */
    #media(segment: OpenSegment, chunk: Chunk, payload: Uint8Array | undefined): void {
        const { track } = chunk
        this.#changed = true
        let packets
        try {
            if (payload === undefined) {
                throw new Error('its payload is not valid gzip data')
            }
            packets = readMediaPackets(payload, chunk.startTime)
        } catch (error) {
            this.#warnings.push(
                `chunk ${chunk.sequence} of segment ${segment.header.segment} cannot be read (${describe(error)}); ` +
                    'its media is left out'
            )
            this.#brokenTracks.add(track)
            return
        }
        for (const packet of packets) {
            if (packet.key) {
                this.#brokenTracks.delete(track)
            } else if (this.#brokenTracks.has(track)) {
                continue
            }
            this.#packets.push(
                track,
                segment.offset + packet.time / 1000,
                packet.duration / 1000,
                packet.key,
                packet.data
            )
        }
    }

    /** No more is to come: indexes what waits. */
    finish(): void {
        this.#endSegment()
        this.#done = true
        this.#changed = true
    }

    /** What was indexed since the last call. */
    async take(): Promise<TimelineIndex> {
        const first = this.#first
        if (first === undefined) {
            throw new RangeError('no recording to load')
        }
        // Everything is taken now; only the keyframes' compression is awaited.
        const keyframes = this.#keyframes
        const compressions = this.#compressions
        const data = new ByteWriter()
        let dataTime = 0
        // Stable, so events of a track keep their order.
        for (const { type, time, body } of this.#data.toSorted((a, b) => a.time - b.time || a.track - b.track)) {
            writeEventFrame(data, type, time - dataTime, body)
            dataTime = time
        }
        const index: TimelineIndex = {
            sessionId: first.sessionId,
            startedAt: first.startedAt,
            meta: first.meta,
            start: this.#start ?? 0,
            end: this.#done ? Math.max(this.#chunkEnd, this.#lastTime) : this.#edge,
            done: this.#done,
            events: this.#columns.take(),
            keyframes,
            pointer: this.#pointer.finish(),
            statics: this.#statics.finish(),
            data: data.finish(),
            media: { tracks: this.#mediaTracks, states: this.#mediaStates, packets: this.#packets.take() },
            interaction: { focus: this.#focus, topLayer: this.#topLayer },
            warnings: this.#warnings
        }
        this.#mediaTracks = []
        this.#mediaStates = []
        this.#focus = []
        this.#topLayer = []
        this.#keyframes = []
        this.#compressions = []
        this.#pointer = new PointerColumns()
        this.#statics = new ByteWriter()
        this.#data = []
        this.#warnings = []
        this.#changed = false
        await Promise.all(compressions)
        return index
    }

    #moveEdge(time: number): void {
        if (time > this.#edge) {
            this.#edge = time
            this.#changed = true
        }
    }

    #endSegment(): void {
        const segment = this.#segment
        if (segment !== undefined) {
            this.#release(segment, Infinity)
            this.#moveEdge(Math.max(this.#chunkEnd, this.#lastTime))
        }
    }

    /** Indexes the pending events of `segment` before `time`, in replay order: by time, then track. */
    #release(segment: OpenSegment, time: number): void {
        // Stable, so each track keeps its order.
        const pending = segment.pending.toSorted((a, b) => a.time - b.time || a.track - b.track)
        let count = 0
        while (count < pending.length && pending[count]!.time < time) {
            this.#index(pending[count]!, this.#ids)
            count++
        }
        segment.pending = count === 0 ? pending : pending.slice(count)
    }

    #index(frame: Frame, ids: IdCounter): void {
        const { type, time, body } = frame
        this.#lastTime = Math.max(this.#lastTime, time)
        this.#changed = true
        if (type === GAP) {
            this.#broken = true
            return
        }
        const idBase = ids.next
        let event: TcrEvent | undefined
        try {
            event = decodeEvent(type, body, ids)
        } catch (error) {
            this.#warnings.push(`an event at ${time} ms cannot be read (${describe(error)}); it is left out`)
            this.#broken ||= type === EventType.Snapshot || type === EventType.Mutations
            return
        }
        if (event === undefined) {
            return
        }
        if (event.type === EventType.PointerMoves || event.type === EventType.PointerButton) {
            this.#lastTime = Math.max(this.#lastTime, this.#pointer.add(event, time))
            return
        }
        if (STATIC_TYPES.has(type)) {
            writeEventFrame(this.#statics, type, 0, body)
            return
        }
        if (DATA_TYPES.has(type)) {
            this.#data.push(frame)
            return
        }
        if (ids !== this.#ids) {
            // A page event on a track of another kind, which the replay has no place for.
            return
        }
        // The media's own timelines, which the player reads at any time.
        if (event.type === EventType.MediaTrack) {
            this.#mediaTracks.push({ time, event })
            return
        }
        if (event.type === EventType.MediaState) {
            this.#mediaStates.push({ time, event })
            return
        }
        // States the player looks up by time, like the media's.
        if (event.type === EventType.Focus) {
            this.#focus.push({ time, event })
            return
        }
        if (event.type === EventType.TopLayer) {
            this.#topLayer.push({ time, event })
            return
        }
        if (event.type === EventType.Snapshot) {
            this.#broken = false
        } else if (this.#broken && event.type === EventType.Mutations) {
            return
        }
        const document = this.#document
        const cost = document.apply(event)
        const columns = this.#columns
        columns.push(time, type, idBase, body, cost)
        this.#start ??= time
        if (event.type === EventType.Viewport) {
            this.#viewport = { width: event.width, height: event.height }
        }
        if (event.type === EventType.Snapshot) {
            this.#sinceKeyframe = 0
            this.#keyframes.push({
                index: columns.total,
                time,
                cost,
                viewport: this.#viewport,
                recorded: true,
                snapshot: EMPTY,
                input: EMPTY,
                scroll: EMPTY,
                styles: EMPTY
            })
            return
        }
        this.#sinceKeyframe += cost
        // Seeking from a keyframe costs about its size, then the events after it: half the document size in
        // events keeps the two in balance.
        if (this.#sinceKeyframe < Math.max(this.#options.keyframeInterval, document.size / 2)) {
            return
        }
        const state = document.encode(ids.next)
        if (state === undefined) {
            return
        }
        this.#sinceKeyframe = 0
        const keyframe: Keyframe = {
            index: columns.total,
            time,
            cost: document.size + state.rules,
            viewport: this.#viewport,
            recorded: false,
            snapshot: EMPTY,
            input: state.input,
            scroll: state.scroll,
            styles: EMPTY
        }
        this.#keyframes.push(keyframe)
        this.#compressions.push(compress(keyframe, state.snapshot, state.styles))
    }
}

/** Collects the column arrays of the index while events are read, a part at a time. */
class EventColumns {
    /** Events in the parts taken before. */
    #before = 0
    #times: number[] = []
    #types: number[] = []
    #idBases: number[] = []
    #bodies: Uint8Array[] = []
    /** Work of the events before, then summed after each event of this part. */
    #costs: number[] = [0]
    #size = 0

    /** Events so far, those taken before included. */
    get total(): number {
        return this.#before + this.#times.length
    }

    push(time: number, type: number, idBase: number, body: Uint8Array, cost: number): void {
        this.#times.push(time)
        this.#types.push(type)
        this.#idBases.push(idBase)
        this.#bodies.push(body)
        this.#costs.push(this.#costs[this.#costs.length - 1]! + cost)
        this.#size += body.length
    }

    /** The part so far; the next starts empty. */
    take(): TimelineIndex['events'] {
        const count = this.#times.length
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
        const costs = this.#costs
        const table = {
            count,
            times: Float64Array.from(this.#times),
            types: Uint8Array.from(this.#types),
            idBases: Float64Array.from(this.#idBases),
            offsets,
            lengths,
            bodies,
            costs: Float64Array.from(costs)
        }
        this.#before += count
        this.#times = []
        this.#types = []
        this.#idBases = []
        this.#bodies = []
        this.#costs = [costs[costs.length - 1]!]
        this.#size = 0
        return table
    }
}

/** Collects the packets of media tracks, a part at a time. */
class PacketColumns {
    readonly #tracks: number[] = []
    readonly #times: number[] = []
    readonly #durations: number[] = []
    readonly #keys: number[] = []
    readonly #data: Uint8Array[] = []
    #size = 0

    push(track: number, time: number, duration: number, key: boolean, data: Uint8Array): void {
        this.#tracks.push(track)
        this.#times.push(time)
        this.#durations.push(duration)
        this.#keys.push(key ? 1 : 0)
        this.#data.push(data)
        this.#size += data.length
    }

    /** The packets so far; the next part starts empty. */
    take(): MediaIndex['packets'] {
        const count = this.#tracks.length
        const offsets = new Uint32Array(count)
        const lengths = new Uint32Array(count)
        const data = new Uint8Array(this.#size)
        let offset = 0
        for (const [i, packet] of this.#data.entries()) {
            offsets[i] = offset
            lengths[i] = packet.length
            data.set(packet, offset)
            offset += packet.length
        }
        const table = {
            count,
            tracks: Uint32Array.from(this.#tracks),
            times: Float64Array.from(this.#times),
            durations: Float64Array.from(this.#durations),
            keys: Uint8Array.from(this.#keys),
            offsets,
            lengths,
            data
        }
        for (const column of [this.#tracks, this.#times, this.#durations, this.#keys, this.#data]) {
            column.length = 0
        }
        this.#size = 0
        return table
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

async function compress(keyframe: Keyframe, snapshot: Uint8Array, styles: Uint8Array): Promise<void> {
    const [compressed, compressedStyles] = await Promise.all([
        gzip(snapshot),
        styles.length === 0 ? EMPTY : gzip(styles)
    ])
    keyframe.snapshot = compressed
    keyframe.styles = compressedStyles
}

/** Indexes of `times` in ascending, stable order. */
function sortedOrder(times: readonly number[]): number[] {
    return times.map((_, i) => i).toSorted((a, b) => times[a]! - times[b]!)
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
