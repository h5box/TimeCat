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

export interface Session extends SessionRecord {
    /** In order. */
    segments: SegmentRecord[]
}

const NAME = 'timecat'
const VERSION = 1

let database: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
    database ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(NAME, VERSION)
        request.addEventListener('upgradeneeded', () => {
            const db = request.result
            db.createObjectStore('sessions', { keyPath: 'id' })
            db.createObjectStore('segments', { keyPath: ['session', 'index'] })
            db.createObjectStore('chunks', { keyPath: ['session', 'segment', 'seq'] })
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

/** The keys of a session's segments, or chunks, all of them: arrays sort after their prefixes. */
function ofSession(id: string): IDBKeyRange {
    return IDBKeyRange.bound([id], [id, Infinity])
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

/** The recording of each page, in order: what its recorder gave, one after the other. */
export async function readSegments(id: string): Promise<Blob[]> {
    const transaction = (await open()).transaction('chunks', 'readonly')
    const chunks: ChunkRecord[] = await result(transaction.objectStore('chunks').getAll(ofSession(id)))
    const bySegment = groupBy(chunks, chunk => chunk.segment)
    return [...bySegment.keys()]
        .toSorted((a, b) => a - b)
        .map(segment => new Blob((bySegment.get(segment) ?? []).map(chunk => chunk.bytes)))
}

export async function deleteSession(id: string): Promise<void> {
    const transaction = (await open()).transaction(['sessions', 'segments', 'chunks'], 'readwrite')
    transaction.objectStore('sessions').delete(id)
    transaction.objectStore('segments').delete(ofSession(id))
    transaction.objectStore('chunks').delete(ofSession(id))
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
