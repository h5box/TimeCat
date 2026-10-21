/** The toolbar popup: starts and stops recording the tab it opens over, and sets what recordings record. */
import type { Settings, StartResult, Status } from './messages.ts'
import { loadSettings, saveSettings } from './settings.ts'
import { ask, byId, formatDuration, isRecordable, localize, t } from './ui.ts'

const OPTIONS: readonly (keyof Settings)[] = ['console', 'network', 'perf', 'canvas', 'video', 'maskText']

async function main(): Promise<void> {
    localize()
    const button = byId('toggle', HTMLButtonElement)
    const state = byId('state', HTMLElement)
    const error = byId('error', HTMLElement)

    const settings = await loadSettings()
    for (const key of OPTIONS) {
        const input = byId(`option-${key}`, HTMLInputElement)
        input.checked = settings[key]
        input.addEventListener('change', () => {
            settings[key] = input.checked
            saveSettings(settings).catch((reason: unknown) => console.error('[timecat]', reason))
        })
    }
    byId('recordings', HTMLAnchorElement).addEventListener('click', event => {
        event.preventDefault()
        chrome.tabs
            .create({ url: chrome.runtime.getURL('recordings.html') })
            .then(() => window.close())
            .catch((reason: unknown) => console.error('[timecat]', reason))
    })

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = tab?.id
    if (tabId === undefined || !isRecordable(tab?.url)) {
        button.disabled = true
        button.textContent = t('start')
        error.textContent = t('cannotRecord')
        return
    }

    let status = await ask<Status>({ type: 'status', tabId })
    const render = (): void => {
        document.body.classList.toggle('recording', status.recording)
        button.textContent = t(status.recording ? 'stop' : 'start')
        state.textContent =
            status.recording && status.startedAt !== undefined
                ? t('recordingState', formatDuration(Date.now() - status.startedAt), String(status.pages ?? 0))
                : ''
    }
    render()
    setInterval(render, 1000)

    button.addEventListener('click', () => {
        button.disabled = true
        error.textContent = ''
        const done = status.recording ? stop(tabId) : start(tabId)
        done.catch((reason: unknown) => {
            error.textContent = t('startFailed', reason instanceof Error ? reason.message : String(reason))
        })
    })

    async function start(id: number): Promise<void> {
        const result = await ask<StartResult>({ type: 'start', tabId: id })
        if (result.ok) {
            status = await ask<Status>({ type: 'status', tabId: id })
            render()
        } else {
            error.textContent = result.error === 'unsupported' ? t('cannotRecord') : t('startFailed', result.error)
        }
        button.disabled = false
    }
}

async function stop(tabId: number): Promise<void> {
    // The background opens the recording once it is stored.
    await ask<null>({ type: 'stop', tabId })
    window.close()
}

main().catch((reason: unknown) => console.error('[timecat]', reason))
