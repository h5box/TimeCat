/** The page of all recordings: each opens in the player, and can be saved or deleted. */
import { saveHtml, saveTcr } from './files.ts'
import type { Changed } from './messages.ts'
import { deleteSession, listSessions } from './store.ts'
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

/** How often the page shows how far recordings that go on got. */
const REFRESH = 2000

const list = byId('list', HTMLElement)
const empty = byId('empty', HTMLElement)
let refresh: ReturnType<typeof setTimeout> | undefined

async function render(): Promise<void> {
    clearTimeout(refresh)
    const sessions = await listSessions()
    list.replaceChildren(...sessions.map(item))
    empty.hidden = sessions.length > 0
    if (sessions.some(session => session.endedAt === undefined)) {
        refresh = setTimeout(update, REFRESH)
    }
}

function update(): void {
    render().catch((reason: unknown) => console.error('[timecat]', reason))
}

function item(session: Session): HTMLElement {
    const recording = session.endedAt === undefined
    const article = element('article', 'recording')
    const heading = element('h2')
    const link = element('a')
    link.href = `player.html#${encodeURIComponent(session.id)}`
    link.textContent = titleOf(session)
    heading.append(link)
    if (recording) {
        heading.append(' ', element('span', 'live', t('live')))
    }
    const pages = session.segments.length
    article.append(
        heading,
        element('p', 'url', urlOf(session)),
        element(
            'p',
            'meta',
            [
                formatDate(session.startedAt),
                formatDuration(durationOf(session)),
                t(pages === 1 ? 'onePage' : 'pages', String(pages)),
                formatBytes(bytesOf(session))
            ].join(' · ')
        )
    )
    const actions = element('div', 'actions')
    actions.append(
        button(t('exportHtml'), () => saveHtml(session)),
        button(t('download'), () => saveTcr(session)),
        button(
            t('delete'),
            async () => {
                if (confirm(t('confirmDelete'))) {
                    await deleteSession(session.id)
                    await render()
                }
            },
            recording ? t('stopFirst') : undefined
        )
    )
    article.append(actions)
    return article
}

/** A button that runs `action`; disabled, with `disabled` as its title, when that is given. */
function button(label: string, action: () => Promise<void>, disabled?: string): HTMLButtonElement {
    const result = element('button', undefined, label)
    result.type = 'button'
    if (disabled !== undefined) {
        result.disabled = true
        result.title = disabled
    }
    result.addEventListener('click', () => {
        result.disabled = true
        action()
            .catch((reason: unknown) => alert(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => {
                result.disabled = false
            })
    })
    return result
}

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag)
    if (className !== undefined) {
        result.className = className
    }
    if (text !== undefined) {
        result.textContent = text
    }
    return result
}

localize()
chrome.runtime.onMessage.addListener((message: Changed) => {
    if (message.type === 'changed') {
        update()
    }
})
update()
