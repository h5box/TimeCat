import type { SegmentInfo } from '@timecat-js/protocol'
import type { StorageKind } from './messages.ts'

/** Keeps the encoded recording: the header, then chunks in the order they are finished. */
export interface Storage {
    append(bytes: Uint8Array<ArrayBuffer>): void
    /** Everything appended so far. */
    read(): Blob
    /** Releases the storage and deletes what it kept. */
    destroy(): Promise<void>
}

export class MemoryStorage implements Storage {
    readonly #parts: Uint8Array<ArrayBuffer>[] = []

    append(bytes: Uint8Array<ArrayBuffer>): void {
        this.#parts.push(bytes)
    }

    read(): Blob {
        return new Blob(this.#parts)
    }

    destroy(): Promise<void> {
        this.#parts.length = 0
        return Promise.resolve()
    }
}

/** Directory of the origin private file system that recordings are kept in. */
export const OPFS_DIRECTORY = 'timecat'

// Sync access handles exist only in dedicated workers, and the DOM typings leave them out.
interface SyncAccessHandle {
    write(buffer: Uint8Array, options: { at: number }): number
    read(buffer: Uint8Array, options: { at: number }): number
    truncate(size: number): void
    flush(): void
    close(): void
}

interface SyncAccessFileHandle extends FileSystemFileHandle {
    createSyncAccessHandle(): Promise<SyncAccessHandle>
}

function hasSyncAccess(handle: FileSystemFileHandle): handle is SyncAccessFileHandle {
    return 'createSyncAccessHandle' in handle
}

/**
 * Keeps the recording in the origin private file system, as `timecat/<session>-<segment>.tcr`, so it survives a
 * crash of the page. Only works in a worker.
 */
async function openFileStorage(info: SegmentInfo): Promise<Storage> {
    // Checked first, so no file is created where it could not be written.
    if (!('FileSystemSyncAccessHandle' in globalThis)) {
        throw new Error('synchronous file access is only available in a worker')
    }
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(OPFS_DIRECTORY, { create: true })
    const name = `${encodeURIComponent(info.sessionId)}-${info.segment}.tcr`
    const file = await directory.getFileHandle(name, { create: true })
    if (!hasSyncAccess(file)) {
        throw new Error('this browser has no synchronous file access')
    }
    const handle = await file.createSyncAccessHandle()
    handle.truncate(0)
    let size = 0
    return {
        append(bytes) {
            handle.write(bytes, { at: size })
            size += bytes.length
            handle.flush()
        },
        read() {
            const bytes = new Uint8Array(size)
            handle.read(bytes, { at: 0 })
            return new Blob([bytes])
        },
        async destroy() {
            handle.close()
            await directory.removeEntry(name)
        }
    }
}

/** Opens the requested storage, falling back to memory (and reporting why) when files are not available. */
export async function openStorage(
    kind: StorageKind,
    info: SegmentInfo,
    onError: (error: unknown) => void
): Promise<Storage> {
    if (kind === 'opfs') {
        try {
            return await openFileStorage(info)
        } catch (error) {
            onError(new Error('OPFS storage is not available; keeping the recording in memory', { cause: error }))
        }
    }
    return new MemoryStorage()
}
