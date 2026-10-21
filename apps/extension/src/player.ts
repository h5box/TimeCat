/** The page that plays a recording, given by its id after the `#`. */
import { TimecatPlayer } from '@timecat-js/player'
import { saveHtml, saveTcr } from './files.ts'
import { deleteSession, getSession, readSegments } from './store.ts'
import type { Session } from './store.ts'
import {
    byId,
    bytesOf,
    durationOf,
    formatBytes,
    formatDate,
    formatDuration,
    localize,
    t,
    titleOf,
    urlOf
} from './ui.ts'

async function main(): Promise<void> {
    localize()
    const notice = byId('notice', HTMLElement)
    const id = decodeURIComponent(location.hash.slice(1))
    const session = id === '' ? undefined : await getSession(id)
    if (session === undefined) {
        notice.textContent = t('notFound')
        notice.hidden = false
        return
    }
    describe(session)
    const segments = await readSegments(session.id)
    if (segments.length === 0) {
        notice.textContent = t('nothingRecorded')
        notice.hidden = false
        return
    }
    if (session.endedAt === undefined) {
        notice.textContent = t('stillRecording')
        notice.hidden = false
    }
    const player = byId('player', TimecatPlayer)
    // Pages of the extension may start workers from its own scripts only, not from `blob:` URLs.
    player.worker = chrome.runtime.getURL('player-worker.js')
    player.recording = segments
    player.addEventListener('error', event => {
        notice.textContent = t('cannotPlay', event instanceof ErrorEvent ? event.message : '')
        notice.hidden = false
    })
}

function describe(session: Session): void {
    const title = titleOf(session)
    document.title = `${title} – TimeCat`
    byId('title', HTMLElement).textContent = title
    const url = urlOf(session)
    const link = byId('url', HTMLAnchorElement)
    link.textContent = url
    if (/^https?:/u.test(url)) {
        link.href = url
    }
    const pages = session.segments.length
    byId('meta', HTMLElement).textContent = [
        formatDate(session.startedAt),
        formatDuration(durationOf(session)),
        t(pages === 1 ? 'onePage' : 'pages', String(pages)),
        formatBytes(bytesOf(session))
    ].join(' · ')
    act('export', () => saveHtml(session))
    act('download', () => saveTcr(session))
    const remove = byId('delete', HTMLButtonElement)
    if (session.endedAt === undefined) {
        remove.disabled = true
        remove.title = t('stopFirst')
    }
    act('delete', async () => {
        if (confirm(t('confirmDelete'))) {
            await deleteSession(session.id)
            location.href = 'recordings.html'
        }
    })
}

function act(id: string, action: () => Promise<void>): void {
    const button = byId(id, HTMLButtonElement)
    button.addEventListener('click', () => {
        button.disabled = true
        action()
            .catch((reason: unknown) => alert(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => {
                button.disabled = false
            })
    })
}

window.addEventListener('hashchange', () => location.reload())
main().catch((reason: unknown) => {
    const notice = byId('notice', HTMLElement)
    notice.textContent = t('cannotPlay', reason instanceof Error ? reason.message : String(reason))
    notice.hidden = false
})
