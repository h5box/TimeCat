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
    Navigation: 8
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
    Doctype: 5
} as const

export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind]

export const Namespace = {
    HTML: 'http://www.w3.org/1999/xhtml',
    SVG: 'http://www.w3.org/2000/svg',
    MathML: 'http://www.w3.org/1998/Math/MathML'
} as const

export interface DocumentNode {
    kind: typeof NodeKind.Document
    id: number
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

export type SerializedNode = DocumentNode | DoctypeNode | ElementNode | TextNode | CommentNode

/** Flags at the start of a snapshot body. */
export const SnapshotFlag = {
    /** Every node header is followed by the node's id, and the body declares the next free id. */
    ExplicitIds: 1,
    /** The document renders in quirks mode. */
    Quirks: 2
} as const

export interface SnapshotEvent {
    type: typeof EventType.Snapshot
    /** Document URL, which relative URLs in the snapshot resolve against. */
    url: string
    /** The document renders in quirks mode (it had no or a legacy doctype). */
    quirks: boolean
    /**
     * Recorded snapshots number their nodes 1, 2, 3, ... in document order. Snapshots built by a player from
     * a later state keep the ids the recording uses, so they store each id explicitly.
     */
    explicitIds: boolean
    /** First id that later additions get. */
    nextId: number
    root: DocumentNode
}

/** Consecutive siblings inserted under one parent. */
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
    /** The document's id scrolls the viewport. */
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
    url: string
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
