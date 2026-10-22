import { ByteWriter, ChunkKind, Track, writeChunk } from '@timecat-js/protocol'
import type { Settings } from './messages.ts'

/** A recording of a tab: the pages it went to are its segments. */
export interface SessionRecord {
    id: string
    startedAt: number
    /** When recording stopped; missing while it goes on. */
    endedAt?: number
    settings: Settings
}

/** A page of a recording. */
export interface SegmentRecord {
    session: string
    index: number
    url: string
    title: string
    startedAt: number
    /** When its last bytes came. */
    updatedAt: number
    bytes: number
}

/** What `onData` gave in a page, in the order it gave them. */
interface ChunkRecord {
    session: string
    segment: number
    seq: number
    bytes: Uint8Array<ArrayBuffer>
}

/** A resource a page loaded, downloaded for the replay: its content is a chunk of the page's segment. */
export interface ResourceRecord {
    session: string
    url: string
    segment: number
    /** The `seq` of its chunk. */
    seq: number
    /** Bytes of its content. */
    size: number
}

/**
 * The `seq` of the first resource of a session: resources come after what the pages recorded, whose chunks count
 * from 0, and so do the `sequence` numbers of their chunks within a segment (RFC 0002, 4.2).
 */
const FIRST_RESOURCE = 2 ** 30

export interface Session extends SessionRecord {
    /** In order. */
    segments: SegmentRecord[]
}

const NAME = 'timecat'
const VERSION = 2

let database: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
    database ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(NAME, VERSION)
        request.addEventListener('upgradeneeded', event => {
            const db = request.result
            if (event.oldVersion < 1) {
                db.createObjectStore('sessions', { keyPath: 'id' })
                db.createObjectStore('segments', { keyPath: ['session', 'index'] })
                db.createObjectStore('chunks', { keyPath: ['session', 'segment', 'seq'] })
            }
            if (event.oldVersion < 2) {
                db.createObjectStore('resources', { keyPath: ['session', 'url'] })
            }
        })
        request.addEventListener('success', () => resolve(request.result))
        request.addEventListener('error', () => reject(request.error))
    })
    return database
}

function completion(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.addEventListener('complete', () => resolve())
        transaction.addEventListener('error', () => reject(transaction.error))
        transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('transaction aborted')))
    })
}

function result<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result))
        request.addEventListener('error', () => reject(request.error))
    })
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
    const groups = new Map<K, T[]>()
    for (const item of items) {
        const group = groups.get(key(item))
        if (group === undefined) {
            groups.set(key(item), [item])
        } else {
            group.push(item)
        }
    }
    return groups
}

/**
 * The keys of a session's segments, chunks or resources, all of them: arrays sort after their prefixes, and before
 * the same prefix followed by an array, as arrays sort after numbers and strings.
 */
function ofSession(id: string): IDBKeyRange {
    return IDBKeyRange.bound([id], [id, []])
}

export async function createSession(session: SessionRecord): Promise<void> {
    const transaction = (await open()).transaction('sessions', 'readwrite')
    transaction.objectStore('sessions').put(session)
    await completion(transaction)
}

export async function endSession(id: string, endedAt: number): Promise<void> {
    const transaction = (await open()).transaction('sessions', 'readwrite')
    const sessions = transaction.objectStore('sessions')
    const session: SessionRecord | undefined = await result(sessions.get(id))
    if (session !== undefined && session.endedAt === undefined) {
        sessions.put({ ...session, endedAt })
    }
    await completion(transaction)
}

export async function createSegment(segment: SegmentRecord): Promise<void> {
    const transaction = (await open()).transaction('segments', 'readwrite')
    transaction.objectStore('segments').put(segment)
    await completion(transaction)
}

/** The URL and title of a page, once it has them. */
export async function updatePage(session: string, index: number, url: string, title: string): Promise<void> {
    const transaction = (await open()).transaction('segments', 'readwrite')
    const segments = transaction.objectStore('segments')
    const segment: SegmentRecord | undefined = await result(segments.get([session, index]))
    if (segment !== undefined) {
        segments.put({ ...segment, url, title })
    }
    await completion(transaction)
}

export async function appendChunk(
    session: string,
    segment: number,
    seq: number,
    bytes: Uint8Array<ArrayBuffer>
): Promise<void> {
    const transaction = (await open()).transaction(['chunks', 'segments'], 'readwrite')
    transaction.objectStore('chunks').put({ session, segment, seq, bytes } satisfies ChunkRecord)
    const segments = transaction.objectStore('segments')
    const record: SegmentRecord | undefined = await result(segments.get([session, segment]))
    if (record !== undefined) {
        segments.put({ ...record, updatedAt: Date.now(), bytes: record.bytes + bytes.byteLength })
    }
    await completion(transaction)
}

/**
 * Adds a resource to a page of a recording, as the events chunk `payload` of its Asset event on the `Assets` track,
 * with `flags`. Returns false, adding nothing, when the session has the URL already.
 */
export async function appendResource(
    record: Omit<ResourceRecord, 'seq'>,
    flags: number,
    payload: Uint8Array
): Promise<boolean> {
    const transaction = (await open()).transaction(['resources', 'chunks', 'segments'], 'readwrite')
    const resources = transaction.objectStore('resources')
    const [known, count] = await Promise.all([
        result(resources.getKey([record.session, record.url])),
        result(resources.count(ofSession(record.session)))
    ])
    if (known !== undefined) {
        await completion(transaction)
        return false
    }
    const { session, segment } = record
    const seq = FIRST_RESOURCE + count
    resources.put({ ...record, seq } satisfies ResourceRecord)
    const writer = new ByteWriter(payload.length + 32)
    writeChunk(writer, {
        kind: ChunkKind.Events,
        track: Track.Assets,
        flags,
        sequence: seq,
        startTime: 0,
        duration: 0,
        payload
    })
    const bytes = writer.finish()
    transaction.objectStore('chunks').put({ session, segment, seq, bytes } satisfies ChunkRecord)
    const segments = transaction.objectStore('segments')
    const page: SegmentRecord | undefined = await result(segments.get([session, segment]))
    if (page !== undefined) {
        segments.put({ ...page, bytes: page.bytes + bytes.byteLength })
    }
    await completion(transaction)
    return true
}

/** The resources downloaded for a recording so far. */
export async function listResources(session: string): Promise<ResourceRecord[]> {
    const transaction = (await open()).transaction('resources', 'readonly')
    return result(transaction.objectStore('resources').getAll(ofSession(session)))
}

/** Every recording, the latest first. */
export async function listSessions(): Promise<Session[]> {
    const transaction = (await open()).transaction(['sessions', 'segments'], 'readonly')
    const [sessions, segments]: [SessionRecord[], SegmentRecord[]] = await Promise.all([
        result(transaction.objectStore('sessions').getAll()),
        result(transaction.objectStore('segments').getAll())
    ])
    const bySession = groupBy(segments, segment => segment.session)
    return sessions
        .map(session => Object.assign(session, { segments: bySession.get(session.id) ?? [] }))
        .toSorted((a, b) => b.startedAt - a.startedAt)
}

export async function getSession(id: string): Promise<Session | undefined> {
    const transaction = (await open()).transaction(['sessions', 'segments'], 'readonly')
    const [session, segments]: [SessionRecord | undefined, SegmentRecord[]] = await Promise.all([
        result(transaction.objectStore('sessions').get(id)),
        result(transaction.objectStore('segments').getAll(ofSession(id)))
    ])
    return session === undefined ? undefined : { ...session, segments }
}

/**
 * The recording of each page, in order: what its recorder gave, one after the other, then its resources. A page
 * whose recorder gave nothing, not even the header of its segment, is left out.
 */
export async function readSegments(id: string): Promise<Blob[]> {
    const transaction = (await open()).transaction('chunks', 'readonly')
    // In the order of their keys: by segment, then `seq`.
    const chunks: ChunkRecord[] = await result(transaction.objectStore('chunks').getAll(ofSession(id)))
    const bySegment = groupBy(chunks, chunk => chunk.segment)
    return [...bySegment.keys()]
        .toSorted((a, b) => a - b)
        .map(segment => bySegment.get(segment) ?? [])
        .filter(segment => segment[0] !== undefined && segment[0].seq < FIRST_RESOURCE)
        .map(segment => new Blob(segment.map(chunk => chunk.bytes)))
}

export async function deleteSession(id: string): Promise<void> {
    const transaction = (await open()).transaction(['sessions', 'segments', 'chunks', 'resources'], 'readwrite')
    transaction.objectStore('sessions').delete(id)
    transaction.objectStore('segments').delete(ofSession(id))
    transaction.objectStore('chunks').delete(ofSession(id))
    transaction.objectStore('resources').delete(ofSession(id))
    await completion(transaction)
}

/**
 * Ends the recordings that were going on when the browser or the extension stopped, but those of `recording`:
 * they end when their last bytes came.
 */
export async function endInterrupted(recording: ReadonlySet<string>): Promise<void> {
    const sessions = await listSessions()
    const transaction = (await open()).transaction('sessions', 'readwrite')
    for (const { segments, ...session } of sessions) {
        if (session.endedAt === undefined && !recording.has(session.id)) {
            const endedAt = Math.max(session.startedAt, ...segments.map(segment => segment.updatedAt))
            transaction.objectStore('sessions').put({ ...session, endedAt } satisfies SessionRecord)
        }
    }
    await completion(transaction)
}
