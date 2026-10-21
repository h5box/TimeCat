import { decodeEvent, EventType, InputKind, Namespace } from '@timecat-js/protocol'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { isHtml, isInput, isSelect, isTextArea } from '../src/dom.ts'
import { Materializer, PLAYER_ATTRIBUTE } from '../src/materializer.ts'
import { Stage } from '../src/stage.ts'
import { VirtualDocument } from '../src/timeline/virtual.ts'
import { operation, recordingOf } from './operations.ts'
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
async function setUp(): Promise<{ document: Document; materializer: Materializer }> {
    const container = document.createElement('div')
    container.style.cssText = 'width: 400px; height: 300px'
    document.body.append(container)
    containers.push(container)
    const stage = await Stage.create(container)
    stages.push(stage)
    return { document: stage.document, materializer: new Materializer(stage.document) }
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
                { tag: 'iframe', attributes: ['src', 'https://example.com/', 'srcdoc', '<p>', 'title', 'kept'] },
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
            fc.property(fc.array(operation, { minLength: 1, maxLength: 60 }), operations => {
                const reference = new VirtualDocument()
                for (const { event } of recordingOf(operations)) {
                    // The materializer first: the virtual document changes the nodes it is given.
                    if (event.type === EventType.Snapshot) {
                        materializer.build(event)
                    } else {
                        materializer.apply(event)
                    }
                    reference.apply(event)
                }
                const model = modelOf(reference)
                expect(describeDom(document)).toBe(model.tree)
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
})
