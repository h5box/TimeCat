/**
 * Event types. Every event belongs to one track (noted per type); the ids are global so a reader can decode an
 * event without knowing which track it came from.
 */
export const EventType = {
    /** Full DOM state; starts a new id space. Track `Dom`. */
    Snapshot: 1,
    /** One frame of DOM changes. Track `Dom`. */
    Mutations: 2,
    /** Form control state: value, checked or selected options. Track `Input`. */
    Input: 3,
    /** A run of pointer positions, stored column by column. Track `Pointer`. */
    PointerMoves: 4,
    /** Pointer button press or release. Track `Pointer`. */
    PointerButton: 5,
    /** Scroll positions of the viewport or of elements. Track `Scroll`. */
    Scroll: 6,
    /** Viewport size. Track `Viewport`. */
    Viewport: 7,
    /** Same-document URL change. Track `Navigation`. */
    Navigation: 8,
    /** Rules of a style sheet changed through the CSSOM. Track `Dom`. */
    StyleSheet: 9,
    /** The style sheets a document or shadow root adopts. Track `Dom`. */
    AdoptedStyleSheets: 10,
    /** A font face added by script. Track `Assets`. */
    FontFace: 11,
    /** Content of a URL that does not outlive the page, such as a `blob:` URL. Track `Assets`. */
    Asset: 12,
    /** A console message, an uncaught error or an unhandled rejection. Track `Console`. */
    Console: 13,
    /** A finished network request. Track `Network`. */
    Network: 14,
    /** A performance measurement. Track `Perf`. */
    Perf: 15,
    /** An event the application recorded. Track `Custom`. */
    Custom: 16,
    /** Declares a media track, or changes its format from here on. Track `Media`. */
    MediaTrack: 17,
    /** Playback state of an audio or video element. Track `Media`. */
    MediaState: 18
} as const

export type EventType = (typeof EventType)[keyof typeof EventType]

/** Node kinds of the token stream that encodes DOM trees (the low three bits of a node header). */
export const NodeKind = {
    /** Closes the children of the innermost open node. */
    End: 0,
    Element: 1,
    Text: 2,
    Comment: 3,
    Document: 4,
    Doctype: 5,
    ShadowRoot: 6
} as const

export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind]

export const Namespace = {
    HTML: 'http://www.w3.org/1999/xhtml',
    SVG: 'http://www.w3.org/2000/svg',
    MathML: 'http://www.w3.org/1998/Math/MathML'
} as const

/** The root of a snapshot, or the content of a frame as the first child of its `<iframe>` or `<frame>`. */
export interface DocumentNode {
    kind: typeof NodeKind.Document
    id: number
    /** Document URL, which relative URLs in the document resolve against. */
    url: string
    /** The document renders in quirks mode (it had no or a legacy doctype). */
    quirks: boolean
    children: SerializedNode[]
}

export interface DoctypeNode {
    kind: typeof NodeKind.Doctype
    id: number
    name: string
    publicId: string
    systemId: string
}

export interface ElementNode {
    kind: typeof NodeKind.Element
    id: number
    /** Local name: lowercase for HTML elements, case preserved for SVG and MathML. */
    tag: string
    /** Namespace URI; the empty string stands for no namespace. */
    namespace: string
    /** Qualified attribute names and values, flattened: `[name0, value0, name1, value1, ...]`. */
    attributes: string[]
    /**
     * The first child can be a shadow root, the element's shadow tree, or for frames a document, the frame's
     * content. The element's own children follow.
     */
    children: SerializedNode[]
}

export interface TextNode {
    kind: typeof NodeKind.Text
    id: number
    data: string
}

export interface CommentNode {
    kind: typeof NodeKind.Comment
    id: number
    data: string
}

/** A shadow tree, as the first child of its host. */
export interface ShadowRootNode {
    kind: typeof NodeKind.ShadowRoot
    id: number
    /** Closed shadow roots are hidden from the page's scripts; the replay shows them like open ones. */
    closed: boolean
    children: SerializedNode[]
}

export type SerializedNode = DocumentNode | DoctypeNode | ElementNode | TextNode | CommentNode | ShadowRootNode

/** Flags at the start of a snapshot body. */
export const SnapshotFlag = {
    /** Every node header is followed by the node's id, and the body declares the next free id. */
    ExplicitIds: 1
} as const

export interface SnapshotEvent {
    type: typeof EventType.Snapshot
    /**
     * Recorded snapshots number their nodes 1, 2, 3, ... in document order. Snapshots built by a player from
     * a later state keep the ids the recording uses, so they store each id explicitly.
     */
    explicitIds: boolean
    /** First id that later additions get. */
    nextId: number
    root: DocumentNode
}

/**
 * Consecutive siblings inserted under one parent. A shadow root attached to an existing element, or a document
 * loaded into an existing frame, is a run of its own: its only node, with `beforeId` 0.
 */
export interface AddedRun {
    parentId: number
    /** Sibling the nodes go before; 0 appends them. */
    beforeId: number
    nodes: SerializedNode[]
}

export interface AttributeChange {
    id: number
    name: string
    /** New value, or `null` when the attribute was removed. */
    value: string | null
}

export interface TextChange {
    id: number
    data: string
}

/**
 * Changes are applied in field order: removals, additions, attribute changes, text changes. Added nodes take
 * ids in document order, continuing after the last id in use.
 */
export interface MutationsEvent {
    type: typeof EventType.Mutations
    removes: number[]
    adds: AddedRun[]
    attributes: AttributeChange[]
    texts: TextChange[]
}

export const InputKind = {
    Value: 0,
    Checked: 1,
    Selection: 2
} as const

export type InputChange =
    | { kind: typeof InputKind.Value; id: number; value: string }
    | { kind: typeof InputKind.Checked; id: number; checked: boolean }
    /** Indexes of the selected options of a `<select>`. */
    | { kind: typeof InputKind.Selection; id: number; selected: number[] }

export interface InputEvent {
    type: typeof EventType.Input
    changes: InputChange[]
}

export const PointerType = {
    Mouse: 0,
    Pen: 1,
    Touch: 2
} as const

export type PointerType = (typeof PointerType)[keyof typeof PointerType]

/** Positions are integer CSS pixels relative to the viewport. */
export interface PointerMovesEvent {
    type: typeof EventType.PointerMoves
    pointer: PointerType
    /** Milliseconds from the event time; the first sample is at 0. */
    times: number[]
    xs: number[]
    ys: number[]
}

export const PointerAction = {
    Down: 0,
    Up: 1
} as const

export type PointerAction = (typeof PointerAction)[keyof typeof PointerAction]

export interface PointerButtonEvent {
    type: typeof EventType.PointerButton
    action: PointerAction
    pointer: PointerType
    /** `PointerEvent.button`: 0 main, 1 auxiliary, 2 secondary, ... */
    button: number
    x: number
    y: number
    /** Recorded node under the pointer, 0 when unknown. */
    targetId: number
}

export interface ScrollPosition {
    /** A document's id scrolls its viewport: the page's, or a frame's. */
    id: number
    x: number
    y: number
}

export interface ScrollEvent {
    type: typeof EventType.Scroll
    positions: ScrollPosition[]
}

export interface ViewportEvent {
    type: typeof EventType.Viewport
    width: number
    height: number
}

export interface NavigationEvent {
    type: typeof EventType.Navigation
    /** The document whose URL changed: the page's, or a frame's. */
    id: number
    url: string
}

/** Whose rules a StyleSheet event changes. */
export const SheetOwner = {
    /** The sheet of a `<style>` element; the id is the element's. */
    Node: 0,
    /** A sheet made with `new CSSStyleSheet()`; the id is the sheet's own, see `StyleSheetEvent`. */
    Constructed: 1
} as const

export type SheetOwner = (typeof SheetOwner)[keyof typeof SheetOwner]

export const SheetChangeKind = {
    /** Replaces every rule. */
    Replace: 0,
    Insert: 1,
    Delete: 2
} as const

/** A change to the top-level rules of a sheet, given as `cssText`. */
export type SheetChange =
    | { kind: typeof SheetChangeKind.Replace; rules: string[] }
    | { kind: typeof SheetChangeKind.Insert; index: number; rule: string }
    | { kind: typeof SheetChangeKind.Delete; index: number }

/**
 * Rules of a style sheet that changed through the CSSOM rather than through the markup, applied in order.
 * Constructed sheets are numbered from 1 per snapshot: the first event for a number creates the sheet.
 */
export interface StyleSheetEvent {
    type: typeof EventType.StyleSheet
    owner: SheetOwner
    id: number
    changes: SheetChange[]
}

/** Replaces the constructed sheets a document or shadow root adopts. */
export interface AdoptedStyleSheetsEvent {
    type: typeof EventType.AdoptedStyleSheets
    /** The document or shadow root. */
    id: number
    /** Constructed sheets, in order. */
    sheets: number[]
}

/** A font face that script added to a document's fonts. */
export interface FontFaceEvent {
    type: typeof EventType.FontFace
    family: string
    /** A CSS `src` value, its URLs absolute, or the font file itself. */
    source: string | Uint8Array
    /** `FontFace` descriptors, such as `weight` or `unicodeRange`, flattened: `[name0, value0, ...]`. */
    descriptors: string[]
}

/** Content the replay cannot load from the URL the recorded page used, such as a `blob:` URL. */
export interface AssetEvent {
    type: typeof EventType.Asset
    url: string
    mimeType: string
    data: Uint8Array
}

export const ConsoleLevel = {
    Debug: 0,
    Log: 1,
    Info: 2,
    Warn: 3,
    Error: 4
} as const

export type ConsoleLevel = (typeof ConsoleLevel)[keyof typeof ConsoleLevel]

export const ConsoleSource = {
    /** A call of a `console` method. */
    Call: 0,
    /** An error no script caught. */
    Exception: 1,
    /** A promise rejection no script handled. */
    Rejection: 2
} as const

export type ConsoleSource = (typeof ConsoleSource)[keyof typeof ConsoleSource]

export interface ConsoleEvent {
    type: typeof EventType.Console
    level: ConsoleLevel
    source: ConsoleSource
    /** The arguments, each as text. */
    args: string[]
    /** Stack trace, or empty. */
    stack: string
}

/** A request, written when it ended: the event time is its end. */
export interface NetworkEvent {
    type: typeof EventType.Network
    /** What made the request: `fetch`, `xmlhttprequest`, `beacon`, or a resource timing `initiatorType`. */
    initiator: string
    method: string
    url: string
    /** HTTP status, 0 when there was no response the page could read. */
    status: number
    /** Milliseconds from start to end. */
    duration: number
    /** Bytes received, 0 when unknown. */
    size: number
    /** Why the request failed, or empty. */
    error: string
}

export interface PerfEvent {
    type: typeof EventType.Perf
    /** Such as `LCP`, `CLS`, `INP` or `long-task`. */
    metric: string
    value: number
    /** The node the measurement is about, 0 for none. */
    targetId: number
}

export interface CustomDataEvent {
    type: typeof EventType.Custom
    name: string
    /** JSON text. */
    data: string
}

export const MediaKind = {
    Video: 1,
    Audio: 2
} as const

export type MediaKind = (typeof MediaKind)[keyof typeof MediaKind]

/**
 * The format of a media track's packets from this event's time on. A track holds either encoded chunks of
 * WebCodecs, one per packet, named by `codec`; or a byte stream in a container, such as MediaRecorder writes,
 * named by `container`. Exactly one of the two is set. After a change of format, the track's next packet is a key
 * packet.
 */
export interface MediaTrackEvent {
    type: typeof EventType.MediaTrack
    /** The track whose media chunks hold the packets: `FIRST_DYNAMIC_TRACK` or above. */
    track: number
    kind: MediaKind
    /** The element the track shows in, such as a canvas; 0 for none, such as a narration. */
    targetId: number
    /** WebCodecs codec string, such as `vp09.00.10.08` or `opus`; empty for a container. */
    codec: string
    /** WebCodecs decoder `description`, such as an `avcC` box; empty when the codec needs none. */
    description: Uint8Array
    /** MIME type of the byte stream, such as `audio/webm;codecs=opus`; empty for WebCodecs chunks. */
    container: string
    /** Coded size of video, in pixels; 0 for audio. */
    width: number
    height: number
    /** Audio sample rate and channel count; 0 for video, or when the container gives them. */
    sampleRate: number
    channels: number
}

/** The playback state of an audio or video element, as the page left it at the event's time. */
export interface MediaStateEvent {
    type: typeof EventType.MediaState
    /** The `<audio>` or `<video>` element. */
    id: number
    paused: boolean
    muted: boolean
    /** Position in the media, in seconds. While playing, it moves on from there at `playbackRate`. */
    currentTime: number
    playbackRate: number
    /** From 0 to 1. */
    volume: number
}

export type TcrEvent =
    | SnapshotEvent
    | MutationsEvent
    | InputEvent
    | PointerMovesEvent
    | PointerButtonEvent
    | ScrollEvent
    | ViewportEvent
    | NavigationEvent
    | StyleSheetEvent
    | AdoptedStyleSheetsEvent
    | FontFaceEvent
    | AssetEvent
    | ConsoleEvent
    | NetworkEvent
    | PerfEvent
    | CustomDataEvent
    | MediaTrackEvent
    | MediaStateEvent
