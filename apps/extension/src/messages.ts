/** What a recording records besides the page, and how, as the popup sets it. */
export interface Settings {
    console: boolean
    network: boolean
    perf: boolean
    /** What canvases show, as video. */
    canvas: boolean
    /** What videos show, as video; how they play is recorded anyway. */
    video: boolean
    /** Records what is typed into fields as typed, except passwords. */
    inputs: boolean
    /** Records the text of pages as asterisks. */
    maskText: boolean
    /** Downloads the images, style sheets, fonts and media pages load into the recording. */
    resources: boolean
}

/** What the recorder in a page starts with: the page is a segment of the tab's session. */
export interface StartConfig {
    sessionId: string
    segment: number
    latency: number
    settings: Settings
}

/** From the bridge to the recorder in the page's world, through a `MessagePort`. */
export type ToRecorder = { type: 'start'; config: StartConfig } | { type: 'stop' }

/** From the recorder in the page's world to the bridge. */
export type FromRecorder =
    | { type: 'data'; bytes: Uint8Array }
    | { type: 'resources'; urls: string[] }
    | { type: 'stopped' }
    | { type: 'error'; message: string }

/**
 * From the bridge to the background, through a runtime port, which carries JSON only: bytes go in base64. A page
 * asks whether to record with `hello`, and with `resume` goes on recording after the service worker stopped, as it
 * does when a hidden page sends too little to keep it running.
 */
export type ToBackground =
    | { type: 'hello'; url: string; title: string }
    | { type: 'resume'; session: string; segment: number }
    | { type: 'page'; url: string; title: string }
    | { type: 'data'; seq: number; base64: string }
    | { type: 'resources'; urls: string[] }
    | { type: 'stopped' }
    | { type: 'error'; message: string }

/** From the background to the bridge: start recording, the tab is not recorded, or stop. */
export type ToBridge = { type: 'start'; config: StartConfig } | { type: 'idle' } | { type: 'stop' }

/** What the extension's pages ask the background. */
export type Request =
    | { type: 'status'; tabId: number }
    | { type: 'start'; tabId: number }
    | { type: 'stop'; tabId: number }

export interface Status {
    recording: boolean
    /** When recording started, while it goes on. */
    startedAt?: number
    /** Pages recorded so far. */
    pages?: number
}

export type StartResult = { ok: true } | { ok: false; error: string }

/** Sent to the extension's pages when recordings start, go to another page or stop. */
export interface Changed {
    type: 'changed'
}

/** Name of the runtime ports of the bridges. */
export const PORT_NAME = 'timecat-recording'

/** Tags the message with which the bridge hands the recorder in the page's world its port. */
export const CHANNEL = 'timecat-extension'
