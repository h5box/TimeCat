import type { Settings } from './messages.ts'

const DEFAULTS: Settings = {
    console: true,
    network: true,
    perf: true,
    canvas: false,
    video: false,
    inputs: false,
    maskText: false
}

const KEYS: readonly (keyof Settings)[] = ['console', 'network', 'perf', 'canvas', 'video', 'inputs', 'maskText']

export async function loadSettings(): Promise<Settings> {
    const items = await chrome.storage.local.get('settings')
    const stored: unknown = items['settings']
    const settings = { ...DEFAULTS }
    if (typeof stored === 'object' && stored !== null) {
        for (const key of KEYS) {
            const value: unknown = Reflect.get(stored, key)
            if (typeof value === 'boolean') {
                settings[key] = value
            }
        }
    }
    return settings
}

export async function saveSettings(settings: Settings): Promise<void> {
    await chrome.storage.local.set({ settings })
}
