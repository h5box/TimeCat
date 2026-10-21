/** What the extension's pages share: their text in the browser's language, and formatting. */
import type { Request } from './messages.ts'
import type { Session } from './store.ts'

export function t(key: string, ...substitutions: string[]): string {
    return chrome.i18n.getMessage(key, substitutions) || key
}

/** Fills the elements marked `data-i18n` with their text, and `data-i18n-title` with their title. */
export function localize(root: ParentNode = document): void {
    document.documentElement.lang = chrome.i18n.getUILanguage()
    for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
        element.textContent = t(element.dataset['i18n'] ?? '')
    }
    for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
        element.title = t(element.dataset['i18nTitle'] ?? '')
    }
}

export function ask<T>(request: Request): Promise<T> {
    return chrome.runtime.sendMessage<Request, T>(request)
}

export function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000))
    const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    const [hours = 0, ...rest] = parts
    return (hours > 0 ? parts : rest).map((part, index) => (index === 0 ? String(part) : pad(part))).join(':')
}

export function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

export function formatDate(time: number): string {
    return new Date(time).toLocaleString(chrome.i18n.getUILanguage(), { dateStyle: 'medium', timeStyle: 'short' })
}

/** The title of a recording: its first page's, or its address. */
export function titleOf(session: Session): string {
    const [first] = session.segments
    return first === undefined ? t('untitled') : first.title || first.url
}

export function urlOf(session: Session): string {
    return session.segments[0]?.url ?? ''
}

/** How long a recording went on, until now while it does. */
export function durationOf(session: Session): number {
    const last = Math.max(session.startedAt, ...session.segments.map(segment => segment.updatedAt))
    return (session.endedAt ?? last) - session.startedAt
}

export function bytesOf(session: Session): number {
    return session.segments.reduce((sum, segment) => sum + segment.bytes, 0)
}

export function pad(value: number): string {
    return String(value).padStart(2, '0')
}

/** The element with this id, of this type. */
export function byId<T extends Element>(id: string, type: new () => T): T {
    const element = document.getElementById(id)
    if (!(element instanceof type)) {
        throw new TypeError(`#${id} is missing`)
    }
    return element
}

/** Pages the extension can record: those the web serves, and files. */
export function isRecordable(url: string | undefined): boolean {
    return url !== undefined && /^(?:https?|file):/u.test(url)
}
