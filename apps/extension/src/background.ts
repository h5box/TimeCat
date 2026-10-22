/**
 * The service worker: starts and stops the recording of tabs, and stores what their pages record. A recorded tab
 * is a session; each page it shows is a segment of it, recorded by a recorder of its own, which the bridge of the
 * page asks for. What tabs are recorded is kept in session storage, which outlives the worker; what they record
 * goes to IndexedDB as it comes.
 */
import { fromBase64 } from './base64.ts'
import { Downloads } from './downloads.ts'
import { PORT_NAME } from './messages.ts'
import type { Changed, Request, Settings, StartResult, Status, ToBackground, ToBridge } from './messages.ts'
import { loadSettings } from './settings.ts'
import * as store from './store.ts'
import { isRecordable } from './ui.ts'

/** How often, at most, pages hand over what they recorded, in milliseconds: what a page that crashes loses. */
const LATENCY = 1000
/** How long a page may take to hand over the end of its recording once asked to stop. */
const STOP_TIMEOUT = 5000
/** How long the resources of a recording may take to download once it stopped; those left are left out. */
const DOWNLOAD_TIMEOUT = 10_000
const BRIDGE_ID = 'timecat-bridge'
const RECORDING_COLOR = '#d93025'

/** A recorded tab. */
interface TabState {
    session: string
    startedAt: number
    /** Index of the next page's segment. */
    nextSegment: number
    settings: Settings
}

/** The page of a recorded tab whose recorder runs. */
interface Connection {
    port: chrome.runtime.Port
    session: string
    segment: number
    settings: Settings
    /** Settles once what came so far is stored. */
    writes: Promise<void>
    /** Settles once the page stopped recording, or went away. */
    ended: Promise<void>
    end: () => void
}

const connections = new Map<number, Connection>()
/** What pages sent while the background attached them, which it takes once it did. */
const attaching = new Map<chrome.runtime.Port, ToBackground[]>()
const downloads = new Downloads()

/** Changes to the recorded tabs happen one after the other. */
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(task: () => Promise<T>): Promise<T> {
    const done = queue.then(task)
    queue = done.catch(() => undefined)
    return done
}

async function recordedTabs(): Promise<Record<string, TabState>> {
    const items = await chrome.storage.session.get('tabs')
    const tabs: unknown = items['tabs']
    return isTabs(tabs) ? tabs : {}
}

function isTabs(value: unknown): value is Record<string, TabState> {
    return (
        typeof value === 'object' &&
        value !== null &&
        Object.values(value).every(
            (state: unknown) =>
                typeof state === 'object' &&
                state !== null &&
                typeof Reflect.get(state, 'session') === 'string' &&
                typeof Reflect.get(state, 'startedAt') === 'number' &&
                typeof Reflect.get(state, 'nextSegment') === 'number' &&
                typeof Reflect.get(state, 'settings') === 'object'
        )
    )
}

async function saveTabs(tabs: Record<string, TabState>): Promise<void> {
    await chrome.storage.session.set({ tabs })
    // The bridge asks every page whether its tab is recorded, while one is.
    const recording = Object.keys(tabs).length > 0
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [BRIDGE_ID] })
    if (recording && registered.length === 0) {
        await chrome.scripting.registerContentScripts([
            {
                id: BRIDGE_ID,
                js: ['bridge.js'],
                matches: ['<all_urls>'],
                runAt: 'document_start',
                persistAcrossSessions: false
            }
        ])
    } else if (!recording && registered.length > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_ID] })
    }
}

async function status(tabId: number): Promise<Status> {
    const state = (await recordedTabs())[tabId]
    return state === undefined
        ? { recording: false }
        : { recording: true, startedAt: state.startedAt, pages: state.nextSegment }
}

async function start(tabId: number): Promise<StartResult> {
    const tab = await chrome.tabs.get(tabId)
    if (!isRecordable(tab.url)) {
        return { ok: false, error: 'unsupported' }
    }
    return serial(async () => {
        const tabs = await recordedTabs()
        if (tabs[tabId] !== undefined) {
            return { ok: true }
        }
        const session = randomId()
        const startedAt = Date.now()
        const settings = await loadSettings()
        await store.createSession({ id: session, startedAt, settings })
        tabs[tabId] = { session, startedAt, nextSegment: 0, settings }
        await saveTabs(tabs)
        try {
            // The bridge asks for the recorder at once.
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['bridge.js'] })
        } catch (error) {
            delete tabs[tabId]
            await saveTabs(tabs)
            await store.deleteSession(session)
            return { ok: false, error: describe(error) }
        }
        await showRecording(tabId, true)
        notify()
        return { ok: true }
    })
}

/** Stops recording a tab; settles once what it recorded is stored. */
async function stop(tabId: number): Promise<string | undefined> {
    const state = await serial(async () => {
        const tabs = await recordedTabs()
        const recorded = tabs[tabId]
        if (recorded !== undefined) {
            delete tabs[tabId]
            await saveTabs(tabs)
        }
        return recorded
    })
    if (state === undefined) {
        return undefined
    }
    const connection = connections.get(tabId)
    if (connection?.session === state.session) {
        try {
            const { port } = connection
            port.postMessage({ type: 'stop' } satisfies ToBridge)
            await Promise.race([connection.ended, delay(STOP_TIMEOUT)])
        } catch {
            // The page went away.
        }
        await connection.writes
        disconnect(tabId, connection)
    }
    await downloads.finish(state.session, DOWNLOAD_TIMEOUT)
    await store.endSession(state.session, Date.now())
    await showRecording(tabId, false)
    notify()
    return state.session
}

/** A page of a recorded tab asks for its recorder. */
async function hello(port: chrome.runtime.Port, url: string, title: string): Promise<void> {
    const tabId = port.sender?.tab?.id
    const documentId = port.sender?.documentId
    const recorded =
        tabId === undefined || documentId === undefined || port.sender?.frameId !== 0
            ? undefined
            : await serial(async () => {
                  const tabs = await recordedTabs()
                  const state = tabs[tabId]
                  if (state === undefined) {
                      return undefined
                  }
                  tabs[tabId] = { ...state, nextSegment: state.nextSegment + 1 }
                  await saveTabs(tabs)
                  return { ...state, segment: state.nextSegment }
              })
    if (tabId === undefined || documentId === undefined || recorded === undefined) {
        port.postMessage({ type: 'idle' } satisfies ToBridge)
        return
    }
    try {
        await chrome.scripting.executeScript({
            target: { tabId, documentIds: [documentId] },
            world: 'MAIN',
            files: ['main.js'],
            injectImmediately: true
        })
    } catch (error) {
        // A page that cannot be scripted, such as one the browser shows of its own.
        console.warn('[timecat] cannot record', url, error)
        port.postMessage({ type: 'idle' } satisfies ToBridge)
        return
    }
    const now = Date.now()
    await store.createSegment({
        session: recorded.session,
        index: recorded.segment,
        url,
        title,
        startedAt: now,
        updatedAt: now,
        bytes: 0
    })
    if (!(await attach(tabId, port, recorded.session, recorded.segment))) {
        port.postMessage({ type: 'idle' } satisfies ToBridge)
        return
    }
    port.postMessage({
        type: 'start',
        config: {
            sessionId: recorded.session,
            segment: recorded.segment,
            latency: LATENCY,
            settings: recorded.settings
        }
    } satisfies ToBridge)
    // The badge of a tab goes back to the action's when it shows another page.
    await showRecording(tabId, true)
    notify()
}

/** A page goes on recording after the service worker stopped. */
async function resume(port: chrome.runtime.Port, session: string, segment: number): Promise<void> {
    const tabId = port.sender?.tab?.id
    if (tabId === undefined || !(await attach(tabId, port, session, segment))) {
        port.postMessage({ type: 'idle' } satisfies ToBridge)
    }
}

/**
 * Takes what comes through `port` as the recording of a page of the tab, unless the tab no longer records the
 * session: changes to the recorded tabs are serial, so a tab that stops later finds the connection.
 */
function attach(tabId: number, port: chrome.runtime.Port, session: string, segment: number): Promise<boolean> {
    return serial(async () => {
        const state = (await recordedTabs())[tabId]
        if (state?.session !== session) {
            return false
        }
        let end = noop
        const ended = new Promise<void>(resolve => {
            end = resolve
        })
        const connection: Connection = {
            port,
            session,
            segment,
            settings: state.settings,
            writes: Promise.resolve(),
            ended,
            end
        }
        const previous = connections.get(tabId)
        if (previous !== undefined) {
            disconnect(tabId, previous)
        }
        connections.set(tabId, connection)
        port.onDisconnect.addListener(() => disconnect(tabId, connection))
        return true
    })
}

function receive(port: chrome.runtime.Port, message: ToBackground): void {
    if (message.type === 'hello' || message.type === 'resume') {
        attaching.set(port, [])
        const attached =
            message.type === 'hello'
                ? hello(port, message.url, message.title)
                : resume(port, message.session, message.segment)
        attached
            .catch(error => console.error('[timecat]', error))
            .finally(() => {
                const queued = attaching.get(port) ?? []
                attaching.delete(port)
                for (const later of queued) {
                    receive(port, later)
                }
            })
        return
    }
    const queued = attaching.get(port)
    if (queued !== undefined) {
        queued.push(message)
        return
    }
    const tabId = port.sender?.tab?.id
    const connection = tabId === undefined ? undefined : connections.get(tabId)
    if (connection?.port !== port) {
        return
    }
    switch (message.type) {
        case 'data': {
            const bytes = fromBase64(message.base64)
            connection.writes = connection.writes
                .then(() => store.appendChunk(connection.session, connection.segment, message.seq, bytes))
                .catch(error => console.error('[timecat] cannot store a recording', error))
            break
        }
        case 'page':
            connection.writes = connection.writes
                .then(() => store.updatePage(connection.session, connection.segment, message.url, message.title))
                .catch(error => console.error('[timecat]', error))
            break
        case 'resources':
            if (connection.settings.resources && isStrings(message.urls)) {
                downloads.add(connection.session, connection.segment, port.sender?.url, message.urls)
            }
            break
        case 'stopped':
            connection.end()
            break
        case 'error':
            console.warn('[timecat] recording', message.message)
            break
    }
}

function disconnect(tabId: number, connection: Connection): void {
    connection.end()
    if (connections.get(tabId) === connection) {
        connections.delete(tabId)
    }
    try {
        connection.port.disconnect()
    } catch {
        // It already was.
    }
}

async function showRecording(tabId: number, recording: boolean): Promise<void> {
    try {
        await chrome.action.setBadgeText({ tabId, text: recording ? 'REC' : '' })
        if (recording) {
            await chrome.action.setBadgeBackgroundColor({ tabId, color: RECORDING_COLOR })
            await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' })
        }
    } catch {
        // The tab is gone.
    }
}

async function openRecording(session: string, next: chrome.tabs.Tab | undefined): Promise<void> {
    await chrome.tabs.create({
        url: chrome.runtime.getURL(`player.html#${session}`),
        ...(next === undefined ? {} : { index: next.index + 1, windowId: next.windowId })
    })
}

/** Stops recording a tab and shows what it recorded, or starts recording it. */
async function toggle(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.id === undefined) {
        return
    }
    if ((await status(tab.id)).recording) {
        const session = await stop(tab.id)
        if (session !== undefined) {
            await openRecording(session, tab)
        }
    } else {
        await start(tab.id)
    }
}

async function handle(request: Request): Promise<Status | StartResult | null> {
    if (request.type === 'status') {
        return status(request.tabId)
    }
    if (request.type === 'start') {
        return start(request.tabId)
    }
    const tab = await chrome.tabs.get(request.tabId)
    const session = await stop(request.tabId)
    if (session !== undefined) {
        await openRecording(session, tab)
    }
    return null
}

function notify(): void {
    chrome.runtime.sendMessage({ type: 'changed' } satisfies Changed).catch(() => {
        // No page of the extension is open.
    })
}

chrome.runtime.onConnect.addListener(port => {
    if (port.name === PORT_NAME) {
        port.onMessage.addListener((message: ToBackground) => receive(port, message))
    }
})

chrome.runtime.onMessage.addListener((request: Request, sender, respond) => {
    // Only the extension's own pages ask; content scripts talk through ports.
    if (sender.id !== chrome.runtime.id || sender.url?.startsWith(chrome.runtime.getURL('')) !== true) {
        return false
    }
    handle(request).then(respond, (error: unknown) => respond({ ok: false, error: describe(error) }))
    return true
})

chrome.commands.onCommand.addListener((command, tab) => {
    if (command === 'toggle-recording' && tab !== undefined) {
        toggle(tab).catch(error => console.error('[timecat]', error))
    }
})

chrome.tabs.onRemoved.addListener(tabId => {
    stop(tabId).catch(error => console.error('[timecat]', error))
})

// The worker starts afresh: tabs closed while it was not running, and recordings the browser or an update of the
// extension cut off, end now.
serial(async () => {
    const tabs = await recordedTabs()
    const open = new Set((await chrome.tabs.query({})).map(tab => String(tab.id)))
    for (const tabId of Object.keys(tabs)) {
        if (!open.has(tabId)) {
            delete tabs[tabId]
        }
    }
    await saveTabs(tabs)
    await store.endInterrupted(new Set(Object.values(tabs).map(state => state.session)))
}).catch(error => console.error('[timecat]', error))

function isStrings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function noop(): void {
    // Replaced once the promise it settles exists.
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function randomId(): string {
    let id = ''
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
        id += byte.toString(16).padStart(2, '0')
    }
    return id
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
