/** Saving recordings as files, from the recordings and player pages. */
import { exportHtml } from '@timecat-js/player/export'
import { readSegments } from './store.ts'
import type { Session } from './store.ts'
import { pad, titleOf, urlOf } from './ui.ts'

/** Saves the recording as an HTML page that plays it. */
export async function saveHtml(session: Session): Promise<void> {
    const segments = await readSegments(session.id)
    const page = await exportHtml(segments, { title: titleOf(session) })
    save(page, `${fileName(session)}.html`)
}

/** Saves the recording as a TCR file: its pages one after the other, which players read as one recording. */
export async function saveTcr(session: Session): Promise<void> {
    const segments = await readSegments(session.id)
    save(new Blob(segments, { type: 'application/octet-stream' }), `${fileName(session)}.tcr`)
}

function save(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function fileName(session: Session): string {
    let host = 'page'
    try {
        host = new URL(urlOf(session)).hostname || host
    } catch {
        // No address, or not one URL parses.
    }
    const date = new Date(session.startedAt)
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
    return `timecat-${host.replaceAll(/[^\w.-]+/gu, '-')}-${stamp}`
}
