import { EventType, NodeKind } from '@timecat-js/protocol'
import type { AddedRun, SerializedNode } from '@timecat-js/protocol'
import { expect } from 'vitest'
import { decodeRecording, eventsOf } from './decode.ts'
import type { DecodedEvent } from './decode.ts'
import { isElement } from './fidelity/describe.ts'
import type { Session } from './fidelity/session.ts'

/** The id of the first node, in tree order, that `match` accepts. */
export function idOf(root: SerializedNode, match: (node: SerializedNode) => boolean): number {
    const found = find(root, match)
    if (found === undefined) {
        throw new Error('no such node')
    }
    return found.id
}

export function find(node: SerializedNode, match: (node: SerializedNode) => boolean): SerializedNode | undefined {
    if (match(node)) {
        return node
    }
    if (node.kind === NodeKind.Element || node.kind === NodeKind.Document || node.kind === NodeKind.ShadowRoot) {
        for (const child of node.children) {
            const found = find(child, match)
            if (found !== undefined) {
                return found
            }
        }
    }
    return undefined
}

/** Matches the element with the id attribute `id`. */
export function withId(id: string): (node: SerializedNode) => boolean {
    return node =>
        node.kind === NodeKind.Element &&
        node.attributes.some((value, i) => i % 2 === 1 && value === id && node.attributes[i - 1] === 'id')
}

export function byId(document: Document | ShadowRoot, id: string): Element {
    const element = document.getElementById(id)
    if (element === null) {
        throw new Error(`no #${id}`)
    }
    return element
}

function isFrame(node: Node): node is HTMLIFrameElement {
    return isElement(node) && node.localName === 'iframe'
}

export function frameById(document: Document, id: string): HTMLIFrameElement {
    const element = byId(document, id)
    if (!isFrame(element)) {
        throw new Error(`#${id} is no frame`)
    }
    return element
}

export function contentOf(frame: HTMLIFrameElement): Document {
    const content = frame.contentDocument
    if (content === null) {
        throw new Error('the frame shows no document')
    }
    return content
}

/** Settles once the frame loads a document. */
export function loaded(frame: HTMLIFrameElement): Promise<void> {
    return new Promise(resolve => frame.addEventListener('load', () => resolve(), { once: true }))
}

/** Runs script in the page's own realm, as the page's scripts run. */
export function runScript(document: Document, source: string): void {
    const script = document.createElement('script')
    script.textContent = source
    document.body.append(script)
    script.remove()
}

export async function finish(session: Session): Promise<DecodedEvent[]> {
    const recording = await session.finish()
    expect(session.errors).toEqual([])
    return (await decodeRecording(recording)).events
}

export function snapshotRoot(events: readonly DecodedEvent[]): SerializedNode {
    const [snapshot] = eventsOf(events, EventType.Snapshot)
    if (snapshot === undefined) {
        throw new Error('no snapshot')
    }
    return snapshot.root
}

export function runs(events: readonly DecodedEvent[]): AddedRun[] {
    return eventsOf(events, EventType.Mutations).flatMap(event => event.adds)
}
