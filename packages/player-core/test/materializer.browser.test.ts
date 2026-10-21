import {
    decodeEvent,
    EventType,
    InputKind,
    Namespace,
    readEventFrames,
    SheetChangeKind,
    SheetOwner
} from '@timecat-js/protocol'
import type { SheetChange, SnapshotEvent, TcrEvent } from '@timecat-js/protocol'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { Assets } from '../src/assets.ts'
import { isDocument, isFrame, isHtml, isInput, isSelect, isShadowRoot, isStyle, isTextArea } from '../src/dom.ts'
import { Materializer, PLAYER_ATTRIBUTE } from '../src/materializer.ts'
import { Stage } from '../src/stage.ts'
import { VirtualDocument } from '../src/timeline/virtual.ts'
import type { EncodedState } from '../src/timeline/virtual.ts'
import { operations, recordingOf } from './operations.ts'
import { build, describeDom, describeTree, isElement, mutations, pageOf, snapshotOf } from './recording.ts'
import type { Spec } from './recording.ts'

const XLINK = 'http://www.w3.org/1999/xlink'
const XMLNS = 'http://www.w3.org/2000/xmlns/'

const containers: Element[] = []
const stages: Stage[] = []

afterEach(() => {
    for (const stage of stages.splice(0)) {
        stage.destroy()
    }
    for (const container of containers.splice(0)) {
        container.remove()
    }
})

/** A materializer for the document of a new stage. */
async function setUp(assets?: Assets): Promise<{ document: Document; materializer: Materializer }> {
    const container = document.createElement('div')
    container.style.cssText = 'width: 400px; height: 300px'
    document.body.append(container)
    containers.push(container)
    const stage = await Stage.create(container)
    stages.push(stage)
    return { document: stage.document, materializer: new Materializer(stage.document, assets) }
}

/** Applies an event the way the player does. */
function play(materializer: Materializer, event: TcrEvent): void {
    if (event.type === EventType.Snapshot) {
        materializer.build(event)
    } else {
        materializer.apply(event)
    }
}

/** Builds a keyframe's state the way the player restores it. */
function restore(materializer: Materializer, state: EncodedState): void {
    const ids = { next: 0 }
    const snapshot = decodeEvent(EventType.Snapshot, state.snapshot, ids)
    if (snapshot?.type !== EventType.Snapshot) {
        throw new Error('a keyframe without a snapshot')
    }
    materializer.build(snapshot)
    for (const { type, body } of readEventFrames(state.styles, 0)) {
        materializer.apply(decodeEvent(type, body, ids)!)
    }
    if (state.input.length > 0) {
        materializer.apply(decodeEvent(EventType.Input, state.input, ids)!)
    }
}

/** Shows the documents the materializer built in frames, and not the blank ones of frames without one. */
function builtIn(materializer: Materializer): (element: Element) => Document | undefined {
    return element => {
        const document = isFrame(element) ? element.contentDocument : null
        return document !== null && materializer.id(document) !== undefined ? document : undefined
    }
}

/** Everything a replay shows, sheets and form values included. */
function describeReplay({ document, materializer }: { document: Document; materializer: Materializer }): string {
    return describeDom(document, { frameDocument: builtIn(materializer), state: true })
}

/** An iframe with a document that has `body` in its body. */
function framed(body: Spec[]): Spec {
    return {
        tag: 'iframe',
        children: [{ document: [{ tag: 'html', children: [{ tag: 'body', children: body }] }] }]
    }
}

/**
 * A page with a node of each kind: body 5: div 6 (div 7), p 8 ("one" 9), input 10, style 11 ("p { color: red; }"
 * 12), div 13 (#shadow-root 14 (span 15 ("shadow" 16))), iframe 17 (#document 18 (html 19 (body 20 ("framed" 21)))).
 * Div 6 scrolls.
 */
function varied(): SnapshotEvent {
    return pageOf([
        {
            tag: 'div',
            attributes: ['class', 'box', 'style', 'height: 50px; overflow: auto'],
            children: [{ tag: 'div', attributes: ['style', 'height: 500px'] }]
        },
        { tag: 'p', attributes: ['title', 'first'], children: [{ text: 'one' }] },
        { tag: 'input' },
        { tag: 'style', children: [{ text: 'p { color: red; }' }] },
        { tag: 'div', children: [{ shadow: [{ tag: 'span', children: [{ text: 'shadow' }] }] }] },
        framed([{ text: 'framed' }])
    ])
}

function sheetEvent(owner: SheetOwner, id: number, ...changes: SheetChange[]): TcrEvent {
    return { type: EventType.StyleSheet, owner, id, changes }
}

function rulesOf(sheet: CSSStyleSheet | null | undefined): string[] {
    return sheet === null || sheet === undefined ? [] : [...sheet.cssRules].map(rule => rule.cssText)
}

/** The node a recorded id stands for, checked to be of the kind expected. */
function nodeOf<T extends Node>(materializer: Materializer, id: number, is: (node: Node) => node is T): T {
    const node = materializer.node(id)
    if (node === undefined || !is(node)) {
        throw new Error(`node ${id} is missing or of another kind`)
    }
    return node
}

function isAnchor(node: Node): node is HTMLAnchorElement {
    return isElement(node) && isHtml(node, 'a')
}

function isControl(node: Node): node is HTMLInputElement | HTMLTextAreaElement {
    return isElement(node) && (isInput(node) || isTextArea(node))
}

function isInputNode(node: Node): node is HTMLInputElement {
    return isElement(node) && isInput(node)
}

function isSelectNode(node: Node): node is HTMLSelectElement {
    return isElement(node) && isSelect(node)
}

function isScrollable(node: Node): node is HTMLElement {
    return isElement(node) && isHtml(node, 'div')
}

function isFrameNode(node: Node): node is HTMLIFrameElement | HTMLFrameElement {
    return isElement(node) && isFrame(node)
}

function isStyleNode(node: Node): node is HTMLStyleElement | SVGStyleElement {
    return isElement(node) && isStyle(node)
}

function isImage(node: Node): node is HTMLImageElement {
    return isElement(node) && isHtml(node, 'img')
}

function colorOf(element: Element): string {
    return element.ownerDocument.defaultView!.getComputedStyle(element).color
}

function option(text: string): Spec {
    return { tag: 'option', children: [{ text }] }
}

function frame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

/** The tree and form values a virtual document holds. */
function modelOf(document: VirtualDocument): { tree: string; values: Map<number, string> } {
    const state = document.encode(0)
    if (state === undefined) {
        return { tree: '', values: new Map() }
    }
    const ids = { next: 0 }
    const snapshot = decodeEvent(EventType.Snapshot, state.snapshot, ids)
    const input = state.input.length === 0 ? undefined : decodeEvent(EventType.Input, state.input, ids)
    const values = new Map<number, string>()
    for (const change of input?.type === EventType.Input ? input.changes : []) {
        if (change.kind === InputKind.Value) {
            values.set(change.id, change.value)
        }
    }
    return { tree: snapshot?.type === EventType.Snapshot ? describeTree(snapshot.root) : '', values }
}

describe('Materializer', () => {
    it('builds a snapshot, with the player base element first in the head', async () => {
        const { document, materializer } = await setUp()
        // doctype 2, html 3, head 4, title 5 ("Page" 6), body 7, a 8 ("next" 9)
        const snapshot = pageOf(
            [{ tag: 'a', attributes: ['href', 'next.html', 'class', 'link'], children: [{ text: 'next' }] }],
            { head: [{ tag: 'title', children: [{ text: 'Page' }] }] }
        )
        materializer.build(snapshot)
        expect(describeDom(document)).toBe(describeTree(snapshot.root))
        expect(document.compatMode).toBe('CSS1Compat')
        const base = document.head?.firstElementChild
        expect(base?.hasAttribute(PLAYER_ATTRIBUTE)).toBe(true)
        expect(base?.getAttribute('href')).toBe('https://example.com/app/page.html')
        expect(nodeOf(materializer, 8, isAnchor).href).toBe('https://example.com/app/next.html')
        expect(materializer.node(1)).toBe(document)
        // A second build replaces the first, whose ids are forgotten.
        materializer.build(pageOf([]))
        expect(materializer.node(8)).toBeUndefined()
        expect(document.head?.firstElementChild?.hasAttribute(PLAYER_ATTRIBUTE)).toBe(true)
        materializer.clear()
        expect(document.childNodes.length).toBe(0)
        expect(materializer.node(1)).toBeUndefined()
    })

    it('renders in quirks mode when the recorded page did, whatever its doctype', async () => {
        const { document, materializer } = await setUp()
        materializer.build(snapshotOf([{ tag: 'html', children: [{ tag: 'body' }] }], { quirks: true }))
        expect(document.compatMode).toBe('BackCompat')
        expect(document.doctype?.name).toBe('html')
        materializer.build(pageOf([]))
        expect(document.compatMode).toBe('CSS1Compat')
        materializer.build(snapshotOf([{ tag: 'html' }], { doctype: false, quirks: true }))
        expect(document.compatMode).toBe('BackCompat')
        expect(document.doctype).toBeNull()
    })

    it('resolves URLs against the recorded base element and URL as they change', async () => {
        const { document, materializer } = await setUp()
        // doctype 2, html 3, head 4, base 5, body 6, a 7
        materializer.build(
            pageOf([{ tag: 'a', attributes: ['href', 'next.html'] }], {
                head: [{ tag: 'base', attributes: ['href', '/root/'] }]
            })
        )
        const link = nodeOf(materializer, 7, isAnchor)
        expect(link.href).toBe('https://example.com/root/next.html')
        // The player's base element comes before the recorded one.
        expect(document.head?.firstElementChild?.hasAttribute(PLAYER_ATTRIBUTE)).toBe(true)
        materializer.apply(mutations({ attributes: [{ id: 5, name: 'href', value: 'https://cdn.example.org/x/' }] }))
        expect(link.href).toBe('https://cdn.example.org/x/next.html')
        // A base element without a URL it may have does not count.
        materializer.apply(mutations({ attributes: [{ id: 5, name: 'href', value: 'javascript:alert(1)' }] }))
        expect(link.href).toBe('https://example.com/app/next.html')
        materializer.apply(mutations({ attributes: [{ id: 5, name: 'href', value: 'sub/' }] }))
        expect(link.href).toBe('https://example.com/app/sub/next.html')
        materializer.apply({ type: EventType.Navigation, id: 1, url: 'https://example.com/other/page' })
        expect(link.href).toBe('https://example.com/other/sub/next.html')
        materializer.apply(mutations({ removes: [5] }))
        expect(link.href).toBe('https://example.com/other/next.html')
        // The player's base element moves to a new head.
        materializer.apply(
            mutations({
                removes: [4],
                adds: [{ parentId: 3, beforeId: 6, nodes: [build({ tag: 'head' }, { next: 8 })] }]
            })
        )
        expect(document.head?.firstElementChild?.hasAttribute(PLAYER_ATTRIBUTE)).toBe(true)
        expect(link.href).toBe('https://example.com/other/next.html')
    })

    it('leaves out what could run scripts, load documents, navigate or take focus', async () => {
        const { document, materializer } = await setUp()
        const snapshot = pageOf(
            [
                { tag: 'a', attributes: ['href', ' JAVA\tSCRIPT:alert(1)', 'onclick', 'alert(1)'] },
                { tag: 'a', attributes: ['href', 'https://example.com/ok', 'ONMOUSEOVER', 'alert(1)'] },
                {
                    tag: 'iframe',
                    attributes: [
                        'src',
                        'https://example.com/',
                        'srcdoc',
                        '<p>',
                        'sandbox',
                        'allow-scripts',
                        'csp',
                        'script-src *',
                        'title',
                        'kept'
                    ]
                },
                { tag: 'object', attributes: ['data', 'movie.swf', 'type', 'application/x-shockwave-flash'] },
                { tag: 'embed', attributes: ['src', 'movie.swf'] },
                {
                    tag: 'form',
                    attributes: ['action', 'javascript:alert(1)'],
                    children: [{ tag: 'button', attributes: ['formaction', 'javascript:alert(1)'] }]
                },
                { tag: 'input', attributes: ['autofocus', ''] },
                { tag: 'video', attributes: ['autoplay', '', 'muted', ''] },
                { tag: 'script', attributes: ['type', 'module'], children: [{ text: 'parent.timecatRan = 1' }] },
                { tag: 'script', children: [{ text: 'parent.timecatRan = 2' }] },
                {
                    tag: 'svg',
                    namespace: Namespace.SVG,
                    children: [
                        {
                            tag: 'a',
                            attributes: ['href', 'javascript:alert(1)'],
                            children: [{ tag: 'set', attributes: ['attributeName', 'href', 'to', 'java script:x'] }]
                        }
                    ]
                }
            ],
            {
                head: [
                    { tag: 'meta', attributes: ['http-equiv', 'refresh', 'content', '0; url=https://example.com/'] },
                    { tag: 'meta', attributes: ['name', ' Referrer', 'content', 'unsafe-url'] }
                ]
            }
        )
        // head 4: meta 5, meta 6; body 7: a 8, a 9, iframe 10, object 11, embed 12, form 13 (button 14), input 15,
        // video 16, script 17 (text 18), script 19 (text 20), svg 21 (a 22 (set 23))
        materializer.build(snapshot)
        expect(describeDom(document)).toBe(
            [
                '#document',
                '  <!DOCTYPE html>',
                '  <html>',
                '    <head>',
                '      <meta content="0; url=https://example.com/">',
                '      <meta content="unsafe-url">',
                '    <body>',
                '      <a>',
                '      <a href="https://example.com/ok">',
                '      <iframe title="kept">',
                '      <object type="application/x-shockwave-flash">',
                '      <embed>',
                '      <form>',
                '        <button>',
                '      <input>',
                '      <video muted="">',
                '      <script type="text/plain">',
                '        "parent.timecatRan = 1"',
                '      <script type="text/plain">',
                '        "parent.timecatRan = 2"',
                '      <svg:svg>',
                '        <svg:a>',
                '          <svg:set attributeName="href">'
            ].join('\n')
        )
        // Changes go through the same checks.
        materializer.apply(
            mutations({
                attributes: [
                    { id: 8, name: 'href', value: 'javascript:alert(1)' },
                    { id: 8, name: 'onfocus', value: 'alert(1)' },
                    { id: 10, name: 'srcdoc', value: '<p>' },
                    { id: 17, name: 'type', value: 'module' }
                ]
            })
        )
        expect(nodeOf(materializer, 8, isElement).getAttributeNames()).toEqual([])
        expect(nodeOf(materializer, 10, isElement).getAttributeNames()).toEqual(['title'])
        expect(nodeOf(materializer, 17, isElement).getAttribute('type')).toBe('text/plain')
    })

    it('runs no script, even one the sanitizer would let through', async () => {
        const { document, materializer } = await setUp()
        materializer.build(pageOf([]))
        // Straight into the replayed document, past the materializer: the sandbox stops these.
        const script = document.createElement('script')
        script.textContent = 'parent.timecatRan = true'
        const image = document.createElement('img')
        const failed = new Promise(resolve => image.addEventListener('error', resolve, { once: true }))
        image.setAttribute('onerror', 'parent.timecatRan = true')
        image.src = 'data:image/png;base64,AAAA'
        document.body?.append(script, image)
        await failed
        expect(Reflect.get(window, 'timecatRan')).toBeUndefined()
    })

    it('creates SVG and MathML elements, namespaced attributes, and stands in for names it cannot create', async () => {
        const { materializer } = await setUp()
        // body 5: svg 6 (use 7), math 8 (mi 9 ("x" 10)), 1bad 11 (p 12)
        materializer.build(
            pageOf([
                {
                    tag: 'svg',
                    namespace: Namespace.SVG,
                    attributes: ['xmlns:xlink', XLINK, 'viewBox', '0 0 10 10'],
                    children: [{ tag: 'use', attributes: ['xlink:href', '#shape', 'x', '1'] }]
                },
                { tag: 'math', namespace: Namespace.MathML, children: [{ tag: 'mi', children: [{ text: 'x' }] }] },
                { tag: '1bad', attributes: ['=x', 'dropped', 'title', 'kept'], children: [{ tag: 'p' }] }
            ])
        )
        const svg = nodeOf(materializer, 6, isElement)
        expect(svg.namespaceURI).toBe(Namespace.SVG)
        expect(svg.getAttributeNS(XMLNS, 'xlink')).toBe(XLINK)
        expect(svg.getAttribute('viewBox')).toBe('0 0 10 10')
        const use = nodeOf(materializer, 7, isElement)
        expect(use.getAttributeNS(XLINK, 'href')).toBe('#shape')
        expect(nodeOf(materializer, 9, isElement).namespaceURI).toBe(Namespace.MathML)
        expect(describeDom(nodeOf(materializer, 11, isElement))).toBe(
            ['<timecat-invalid title="kept">', '  <p>'].join('\n')
        )
    })

    it('restores the state of form controls', async () => {
        const { materializer } = await setUp()
        // body 5: radio 6, radio 7, select 8 (options 9-14), select 15 (options 16-21), textarea 22 (text 23),
        // file 24, text 25
        materializer.build(
            pageOf([
                { tag: 'input', attributes: ['type', 'radio', 'name', 'r'] },
                { tag: 'input', attributes: ['type', 'radio', 'name', 'r'] },
                { tag: 'select', children: [option('a'), option('b'), option('c')] },
                { tag: 'select', attributes: ['multiple', ''], children: [option('a'), option('b'), option('c')] },
                { tag: 'textarea', children: [{ text: 'default' }] },
                { tag: 'input', attributes: ['type', 'file'] },
                { tag: 'input' }
            ])
        )
        materializer.apply({
            type: EventType.Input,
            changes: [
                { kind: InputKind.Checked, id: 7, checked: true },
                { kind: InputKind.Checked, id: 6, checked: true },
                { kind: InputKind.Selection, id: 8, selected: [2] },
                { kind: InputKind.Selection, id: 15, selected: [0, 2] },
                { kind: InputKind.Value, id: 22, value: 'typed\nlines' },
                { kind: InputKind.Value, id: 24, value: 'C:\\fakepath\\secret.txt' },
                { kind: InputKind.Value, id: 25, value: 'text' },
                // Not form controls, or unknown.
                { kind: InputKind.Value, id: 5, value: 'body' },
                { kind: InputKind.Checked, id: 99, checked: true }
            ]
        })
        expect(nodeOf(materializer, 6, isInputNode).checked).toBe(true)
        expect(nodeOf(materializer, 7, isInputNode).checked).toBe(false)
        expect(nodeOf(materializer, 8, isSelectNode).selectedIndex).toBe(2)
        const multiple = nodeOf(materializer, 15, isSelectNode)
        expect([...multiple.selectedOptions].map(selected => selected.index)).toEqual([0, 2])
        expect(nodeOf(materializer, 22, isControl).value).toBe('typed\nlines')
        expect(nodeOf(materializer, 24, isControl).value).toBe('')
        expect(nodeOf(materializer, 25, isControl).value).toBe('text')
        materializer.apply({
            type: EventType.Input,
            changes: [
                { kind: InputKind.Selection, id: 8, selected: [] },
                { kind: InputKind.Selection, id: 15, selected: [1] }
            ]
        })
        expect(nodeOf(materializer, 8, isSelectNode).selectedIndex).toBe(-1)
        expect([...multiple.selectedOptions].map(selected => selected.index)).toEqual([1])
    })

    it('scrolls once the content is there, and gives up on positions that never stick', async () => {
        const { document, materializer } = await setUp()
        // body 5: tall 6, box 7 (content 8)
        materializer.build(
            pageOf([
                { tag: 'div', attributes: ['style', 'height: 3000px'] },
                {
                    tag: 'div',
                    attributes: ['style', 'height: 100px; overflow: auto'],
                    children: [{ tag: 'div', attributes: ['style', 'height: 1000px'] }]
                }
            ])
        )
        materializer.apply({
            type: EventType.Scroll,
            positions: [
                { id: 1, x: 0, y: 500 },
                { id: 7, x: 0, y: 300 }
            ]
        })
        expect(materializer.flushScrolls()).toBe(false)
        expect(document.defaultView?.scrollY).toBe(500)
        const box = nodeOf(materializer, 7, isScrollable)
        expect(box.scrollTop).toBe(300)
        // Further than the content goes, until it grows.
        materializer.apply({ type: EventType.Scroll, positions: [{ id: 7, x: 0, y: 2000 }] })
        expect(materializer.flushScrolls()).toBe(true)
        materializer.apply(mutations({ attributes: [{ id: 8, name: 'style', value: 'height: 5000px' }] }))
        await frame()
        expect(materializer.flushScrolls()).toBe(false)
        expect(box.scrollTop).toBe(2000)
        // A position that never sticks is given up on after a while.
        materializer.apply({ type: EventType.Scroll, positions: [{ id: 7, x: 0, y: 99_999 }] })
        let tries = 1
        while (materializer.flushScrolls()) {
            tries++
        }
        expect(tries).toBe(60)
        // Removed nodes are not scrolled.
        materializer.apply({ type: EventType.Scroll, positions: [{ id: 7, x: 0, y: 99_999 }] })
        materializer.apply(mutations({ removes: [7] }))
        expect(materializer.flushScrolls()).toBe(false)
    })

    it('changes the DOM the way the virtual document models it', async () => {
        const { document, materializer } = await setUp()
        fc.assert(
            fc.property(operations(60), steps => {
                const reference = new VirtualDocument()
                for (const { event } of recordingOf(steps)) {
                    // The materializer first: the virtual document changes the nodes it is given.
                    play(materializer, event)
                    reference.apply(event)
                }
                const model = modelOf(reference)
                expect(describeDom(document, { frameDocument: builtIn(materializer) })).toBe(model.tree)
                // Values recorded for nodes that are not form controls do not show.
                const expected: [number, string][] = []
                const actual: [number, string][] = []
                for (const [id, value] of model.values) {
                    const node = materializer.node(id)
                    if (node !== undefined && isControl(node)) {
                        expected.push([id, value])
                        actual.push([id, node.value])
                    }
                }
                expect(actual).toEqual(expected)
            }),
            { numRuns: 60 }
        )
    })

    it('builds from a keyframe what applying the events before it builds, style sheets included', async () => {
        const live = await setUp()
        const restored = await setUp()
        fc.assert(
            fc.property(operations(60), steps => {
                const reference = new VirtualDocument()
                for (const { event } of recordingOf(steps)) {
                    play(live.materializer, event)
                    reference.apply(event)
                }
                restore(restored.materializer, reference.encode(0)!)
                expect(describeReplay(restored)).toBe(describeReplay(live))
            }),
            { numRuns: 60 }
        )
    })

    it('builds a keyframe over any state it shows, and goes on from there as from the events before it', async () => {
        const live = await setUp()
        const seeking = await setUp()
        fc.assert(
            fc.property(operations(60), fc.nat(), (steps, split) => {
                const events = recordingOf(steps).map(({ event }) => event)
                const at = 1 + (split % events.length)
                const reference = new VirtualDocument()
                let keyframe: EncodedState | undefined
                for (const [i, event] of events.entries()) {
                    play(live.materializer, event)
                    play(seeking.materializer, event)
                    if (i < at) {
                        reference.apply(event)
                        keyframe = reference.encode(0)
                    }
                }
                // Back to the keyframe from the end, and on to the end again.
                restore(seeking.materializer, keyframe!)
                for (const event of events.slice(at)) {
                    play(seeking.materializer, event)
                }
                expect(describeReplay(seeking)).toBe(describeReplay(live))
            }),
            { numRuns: 60 }
        )
    })

    it('takes back the nodes a snapshot shows again, as they would be built anew', async () => {
        const replay = await setUp()
        const { document, materializer } = replay
        materializer.build(varied())
        const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
        const before = new Map(ids.map(id => [id, materializer.node(id)]))
        const base = document.head?.firstElementChild
        const input = nodeOf(materializer, 10, isInputNode)
        const style = nodeOf(materializer, 11, isStyleNode)
        const box = nodeOf(materializer, 6, isScrollable)
        materializer.apply({ type: EventType.Scroll, positions: [{ id: 6, x: 0, y: 100 }] })
        materializer.flushScrolls()
        expect(box.scrollTop).toBe(100)
        const added = build({ tag: 'b', children: [{ text: 'new' }] }, { next: 22 })
        materializer.apply(
            mutations({
                adds: [{ parentId: 5, beforeId: 8, nodes: [added] }],
                attributes: [
                    { id: 8, name: 'title', value: 'second' },
                    { id: 8, name: 'class', value: 'added' }
                ],
                texts: [{ id: 9, data: 'two' }]
            })
        )
        materializer.apply({ type: EventType.Input, changes: [{ kind: InputKind.Value, id: 10, value: 'typed' }] })
        materializer.apply(
            sheetEvent(SheetOwner.Node, 11, { kind: SheetChangeKind.Insert, index: 1, rule: 'b { color: blue; }' })
        )

        materializer.build(varied())
        const fresh = await setUp()
        fresh.materializer.build(varied())
        expect(describeReplay(replay)).toBe(describeReplay(fresh))
        expect(ids.filter(id => materializer.node(id) !== before.get(id))).toEqual([])
        expect(document.head?.firstElementChild).toBe(base)
        expect(document.querySelector('b')).toBeNull()
        expect(materializer.node(22)).toBeUndefined()
        // Form controls and sheets the CSSOM changed are made anew, and elements scroll back to the top.
        expect(materializer.node(10)).not.toBe(input)
        expect(materializer.node(11)).not.toBe(style)
        expect(materializer.flushScrolls()).toBe(false)
        expect(box.scrollTop).toBe(0)
    })

    it('builds shadow trees and the documents of frames, and changes them', async () => {
        const { document, materializer } = await setUp()
        // body 5: div 6 (#shadow-root 7 (span 8 ("shadow" 9))), iframe 10 (#document 11 (html 12 (head 13,
        // body 14 (a 15 ("framed" 16)))))
        const snapshot = pageOf([
            { tag: 'div', children: [{ shadow: [{ tag: 'span', children: [{ text: 'shadow' }] }] }] },
            {
                tag: 'iframe',
                children: [
                    {
                        document: [
                            {
                                tag: 'html',
                                children: [
                                    { tag: 'head' },
                                    {
                                        tag: 'body',
                                        children: [
                                            {
                                                tag: 'a',
                                                attributes: ['href', 'next.html'],
                                                children: [{ text: 'framed' }]
                                            }
                                        ]
                                    }
                                ]
                            }
                        ],
                        quirks: true
                    }
                ]
            }
        ])
        materializer.build(snapshot)
        const frameDocument = builtIn(materializer)
        expect(describeDom(document, { frameDocument })).toBe(describeTree(snapshot.root))
        const host = nodeOf(materializer, 6, isElement)
        expect(materializer.node(7)).toBe(host.shadowRoot)
        const iframe = nodeOf(materializer, 10, isFrameNode)
        const inner = nodeOf(materializer, 11, isDocument)
        expect(iframe.contentDocument).toBe(inner)
        expect(inner.compatMode).toBe('BackCompat')
        // URLs in the frame resolve against the frame's recorded URL, and follow it.
        expect(nodeOf(materializer, 15, isAnchor).href).toBe('https://example.com/frame/next.html')
        materializer.apply({ type: EventType.Navigation, id: 11, url: 'https://example.com/moved/page.html' })
        expect(nodeOf(materializer, 15, isAnchor).href).toBe('https://example.com/moved/next.html')
        // Into the shadow tree and the frame's document. A second shadow root, and one on an element that takes
        // none, are left out.
        materializer.apply(
            mutations({
                adds: [
                    { parentId: 7, beforeId: 8, nodes: [build({ text: 'before ' }, { next: 17 })] },
                    { parentId: 14, beforeId: 0, nodes: [build({ tag: 'p' }, { next: 18 })] },
                    { parentId: 6, beforeId: 0, nodes: [build({ shadow: [{ text: 'second' }] }, { next: 19 })] },
                    { parentId: 15, beforeId: 0, nodes: [build({ shadow: [{ text: 'none' }] }, { next: 21 })] }
                ]
            })
        )
        expect(host.shadowRoot?.textContent).toBe('before shadow')
        expect(inner.body.lastElementChild?.localName).toBe('p')
        expect([19, 20, 21, 22].map(id => materializer.node(id))).toEqual([undefined, undefined, undefined, undefined])
        expect(nodeOf(materializer, 15, isElement).shadowRoot).toBeNull()
        // A new document replaces the frame's, in the same frame.
        const next = build(
            { document: [{ tag: 'html', children: [{ tag: 'body', children: [{ text: 'next' }] }] }] },
            { next: 23 }
        )
        materializer.apply(mutations({ adds: [{ parentId: 10, beforeId: 0, nodes: [next] }] }))
        expect(materializer.node(11)).toBeUndefined()
        expect(materializer.node(15)).toBeUndefined()
        expect(materializer.node(23)).toBe(inner)
        expect(inner.compatMode).toBe('CSS1Compat')
        expect(describeDom(nodeOf(materializer, 10, isElement), { frameDocument })).toBe(
            ['<iframe>', '  #document', '    <html>', '      <body>', '        "next"'].join('\n')
        )
        // Without its document, the frame shows the blank page of a frame that never had one.
        materializer.apply(mutations({ removes: [23] }))
        expect(materializer.node(23)).toBeUndefined()
        expect(frameDocument(iframe)).toBeUndefined()
        expect(inner.body.childNodes.length).toBe(0)
        // Removing the host forgets its shadow tree.
        materializer.apply(mutations({ removes: [6] }))
        expect([6, 7, 8, 9, 17].map(id => materializer.node(id))).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined
        ])
    })

    it('builds the documents of frames in frames and in shadow trees, and forgets them with their frame', async () => {
        const { document, materializer } = await setUp()
        // body 5: div 6 (#shadow-root 7 (iframe 8 (#document 9 (html 10 (body 11 (iframe 12 (#document 13 (html 14
        // (body 15 ("deep" 16)))))))))
        const snapshot = pageOf([{ tag: 'div', children: [{ shadow: [framed([framed([{ text: 'deep' }])])] }] }])
        materializer.build(snapshot)
        expect(describeDom(document, { frameDocument: builtIn(materializer) })).toBe(describeTree(snapshot.root))
        const deep = nodeOf(materializer, 13, isDocument)
        expect(deep.body.textContent).toBe('deep')
        expect(deep.querySelector('base')?.getAttribute('href')).toBe('https://example.com/frame/page.html')
        materializer.apply(mutations({ removes: [8] }))
        expect([8, 9, 12, 13, 16].map(id => materializer.node(id))).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined
        ])
        // A document for an element that shows none is left out.
        const stray = build({ document: [{ tag: 'html' }] }, { next: 17 })
        materializer.apply(mutations({ adds: [{ parentId: 6, beforeId: 0, nodes: [stray] }] }))
        expect(materializer.node(17)).toBeUndefined()
    })

    it('changes the rules of style sheets, with stand-ins for those this browser does not take', async () => {
        const { materializer } = await setUp()
        // head 4: style 5 ("p { color: red; }" 6), style 7 ('@import url("data:text/css,");' 8); body 9
        materializer.build(
            pageOf([], {
                head: [
                    { tag: 'style', children: [{ text: 'p { color: red; }' }] },
                    { tag: 'style', children: [{ text: '@import url("data:text/css,");' }] }
                ]
            })
        )
        const style = nodeOf(materializer, 5, isStyleNode)
        materializer.apply(
            sheetEvent(
                SheetOwner.Node,
                5,
                { kind: SheetChangeKind.Insert, index: 9, rule: 'div { margin: 1px; }' },
                { kind: SheetChangeKind.Insert, index: 0, rule: 'not a rule' },
                { kind: SheetChangeKind.Delete, index: 7 }
            )
        )
        expect(rulesOf(style.sheet)).toEqual(['@media not all {\n}', 'p { color: red; }', 'div { margin: 1px; }'])
        // An `@import` rule goes first, or not at all.
        materializer.apply(
            sheetEvent(SheetOwner.Node, 5, {
                kind: SheetChangeKind.Replace,
                rules: ['a { color: blue; }', '@import url("data:text/css,");']
            })
        )
        expect(rulesOf(style.sheet)).toEqual(['a { color: blue; }', '@media not all {\n}'])
        // Nothing but a layer statement goes before one.
        const imports = nodeOf(materializer, 7, isStyleNode)
        materializer.apply(
            sheetEvent(SheetOwner.Node, 7, { kind: SheetChangeKind.Insert, index: 0, rule: 'p { color: red; }' })
        )
        expect(rulesOf(imports.sheet)).toEqual(['@layer timecat-inert;', '@import url("data:text/css,");'])
        // New text undoes what the CSSOM changed; elements that are no `<style>` have no sheet to change.
        materializer.apply(mutations({ texts: [{ id: 6, data: 'b { color: green; }' }] }))
        expect(rulesOf(style.sheet)).toEqual(['b { color: green; }'])
        materializer.apply(sheetEvent(SheetOwner.Node, 9, { kind: SheetChangeKind.Delete, index: 0 }))
        materializer.apply(sheetEvent(SheetOwner.Node, 99, { kind: SheetChangeKind.Delete, index: 0 }))
    })

    it('adopts constructed sheets in documents, shadow roots and frames, a copy for each document', async () => {
        const { document, materializer } = await setUp()
        // body 5: p 6, div 7 (#shadow-root 8 (p 9)), iframe 10 (#document 11 (html 12 (body 13 (p 14))))
        materializer.build(
            pageOf([
                { tag: 'p' },
                { tag: 'div', children: [{ shadow: [{ tag: 'p' }] }] },
                {
                    tag: 'iframe',
                    children: [{ document: [{ tag: 'html', children: [{ tag: 'body', children: [{ tag: 'p' }] }] }] }]
                }
            ])
        )
        const paragraphs = [6, 9, 14].map(id => nodeOf(materializer, id, isElement))
        const red = 'rgb(255, 0, 0)'
        const blue = 'rgb(0, 0, 255)'
        materializer.apply(
            sheetEvent(SheetOwner.Constructed, 1, { kind: SheetChangeKind.Replace, rules: [`p { color: ${red}; }`] })
        )
        for (const id of [1, 8, 11]) {
            materializer.apply({ type: EventType.AdoptedStyleSheets, id, sheets: [1, 2] })
        }
        expect(paragraphs.map(colorOf)).toEqual([red, red, red])
        const shadow = nodeOf(materializer, 8, isShadowRoot)
        const inner = nodeOf(materializer, 11, isDocument)
        // Sheet 2 did not exist yet, so it stays out.
        expect(document.adoptedStyleSheets.length).toBe(1)
        expect(shadow.adoptedStyleSheets[0]).toBe(document.adoptedStyleSheets[0])
        expect(inner.adoptedStyleSheets[0]).not.toBe(document.adoptedStyleSheets[0])
        // Changes reach every copy.
        materializer.apply(
            sheetEvent(SheetOwner.Constructed, 1, {
                kind: SheetChangeKind.Insert,
                index: 1,
                rule: `p { color: ${blue}; }`
            })
        )
        materializer.apply(
            sheetEvent(SheetOwner.Constructed, 2, { kind: SheetChangeKind.Replace, rules: ['p { color: green; }'] })
        )
        expect(paragraphs.map(colorOf)).toEqual([blue, blue, blue])
        materializer.apply({ type: EventType.AdoptedStyleSheets, id: 8, sheets: [2, 1] })
        expect(rulesOf(shadow.adoptedStyleSheets[0])).toEqual(['p { color: green; }'])
        expect(shadow.adoptedStyleSheets[1]).toBe(document.adoptedStyleSheets[0])
        // A snapshot drops every sheet.
        materializer.build(pageOf([{ tag: 'p' }]))
        expect(document.adoptedStyleSheets.length).toBe(0)
        materializer.apply({ type: EventType.AdoptedStyleSheets, id: 1, sheets: [1] })
        expect(document.adoptedStyleSheets.length).toBe(0)
    })

    it('shows blob content from the recording at URLs of its own, and adds the recorded fonts', async () => {
        const image = 'blob:https://example.com/0b6f-image'
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"></svg>'
        const assets = new Assets()
        assets.add([
            { type: EventType.Asset, url: image, mimeType: 'image/svg+xml', data: new TextEncoder().encode(svg) },
            { type: EventType.Asset, url: image, mimeType: 'text/plain', data: new Uint8Array([1]) },
            { type: EventType.FontFace, family: 'Recorded', source: `url("${image}")`, descriptors: ['weight', '700'] },
            { type: EventType.FontFace, family: 'Bytes', source: new Uint8Array([0, 1, 2]), descriptors: [] }
        ])
        const { document, materializer } = await setUp(assets)
        // head 4: style 5 (text 6); body 7: img 8, iframe 9 (#document 10 (html 11 (body 12 (img 13))))
        materializer.build(
            pageOf(
                [
                    { tag: 'img', attributes: ['src', image, 'srcset', `${image} 2x, other.png 3x`] },
                    {
                        tag: 'iframe',
                        children: [
                            {
                                document: [
                                    {
                                        tag: 'html',
                                        children: [
                                            { tag: 'body', children: [{ tag: 'img', attributes: ['src', image] }] }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ],
                { head: [{ tag: 'style', children: [{ text: `body { background: url(${image}) }` }] }] }
            )
        )
        const local = nodeOf(materializer, 8, isImage).getAttribute('src')!
        expect(local).toMatch(new RegExp(`^blob:${location.origin}/`))
        expect(nodeOf(materializer, 8, isImage).getAttribute('srcset')).toBe(`${local} 2x, other.png 3x`)
        expect(nodeOf(materializer, 13, isImage).getAttribute('src')).toBe(local)
        expect(document.querySelector('style')?.textContent).toBe(`body { background: url(${local}) }`)
        // The first copy of a URL counts.
        const framedImage = nodeOf(materializer, 13, isImage)
        await framedImage.decode()
        expect(framedImage.naturalWidth).toBe(20)
        // In attributes, text and rules that change later too.
        materializer.apply(mutations({ attributes: [{ id: 8, name: 'src', value: `${image}#again` }] }))
        expect(nodeOf(materializer, 8, isImage).getAttribute('src')).toBe(`${local}#again`)
        materializer.apply(
            sheetEvent(SheetOwner.Node, 5, {
                kind: SheetChangeKind.Insert,
                index: 0,
                rule: `p { background: url("${image}"); }`
            })
        )
        expect(rulesOf(nodeOf(materializer, 5, isStyleNode).sheet)[0]).toBe(`p { background: url("${local}"); }`)
        // Every document gets the fonts, once.
        const inner = nodeOf(materializer, 10, isDocument)
        for (const fonts of [document.fonts, inner.fonts]) {
            const faces = [...fonts].filter(face => face.family === 'Recorded' || face.family === 'Bytes')
            expect(faces.map(face => [face.family, face.weight])).toEqual([
                ['Recorded', '700'],
                ['Bytes', 'normal']
            ])
        }
        const size = document.fonts.size
        materializer.build(pageOf([]))
        expect(document.fonts.size).toBe(size)
        assets.revoke()
        await expect(fetch(local).catch((error: unknown) => error)).resolves.toBeInstanceOf(TypeError)
    })
})
