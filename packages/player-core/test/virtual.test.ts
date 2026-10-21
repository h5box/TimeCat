import {
    decodeEvent,
    EventType,
    InputKind,
    NodeKind,
    readEventFrames,
    SheetChangeKind,
    SheetOwner
} from '@timecat-js/protocol'
import type { SerializedNode, SheetChange, TcrEvent } from '@timecat-js/protocol'
import { describe, expect, it } from 'vitest'
import { VirtualDocument } from '../src/timeline/virtual.ts'
import { build, describeTree, mutations, pageOf, snapshotOf } from './recording.ts'
import type { Spec } from './recording.ts'

/** Decodes the state a virtual document encodes. */
function stateOf(document: VirtualDocument, nextId: number) {
    const state = document.encode(nextId)
    if (state === undefined) {
        throw new Error('no document')
    }
    const ids = { next: 0 }
    const snapshot = decodeEvent(EventType.Snapshot, state.snapshot, ids)
    if (snapshot?.type !== EventType.Snapshot) {
        throw new Error('not a snapshot')
    }
    const input = state.input.length === 0 ? undefined : decodeEvent(EventType.Input, state.input, ids)
    const scroll = state.scroll.length === 0 ? undefined : decodeEvent(EventType.Scroll, state.scroll, ids)
    return { snapshot, input, scroll, nextId: ids.next }
}

function doctype(id: number): SerializedNode {
    return { kind: NodeKind.Doctype, id, name: 'html', publicId: '', systemId: '' }
}

function html(id: number): SerializedNode {
    return build({ tag: 'html' }, { next: id })
}

function treeOf(document: VirtualDocument): string {
    return describeTree(stateOf(document, 1000).snapshot.root)
}

/** The events that restore the sheets of a virtual document's state. */
function stylesOf(document: VirtualDocument): TcrEvent[] {
    const styles = document.encode(1000)?.styles ?? new Uint8Array(0)
    return readEventFrames(styles, 0).map(({ type, body }) => decodeEvent(type, body, { next: 0 })!)
}

/** A run that adds the node `spec` describes, numbered from `id`, to `parentId`. */
function add(parentId: number, spec: Spec, id: number, beforeId = 0) {
    return { parentId, beforeId, nodes: [build(spec, { next: id })] }
}

function replace(...rules: string[]): SheetChange {
    return { kind: SheetChangeKind.Replace, rules }
}

function insert(index: number, rule: string): SheetChange {
    return { kind: SheetChangeKind.Insert, index, rule }
}

function remove(index: number): SheetChange {
    return { kind: SheetChangeKind.Delete, index }
}

function sheet(owner: SheetOwner, id: number, ...changes: SheetChange[]): TcrEvent {
    return { type: EventType.StyleSheet, owner, id, changes }
}

function adopt(id: number, sheets: number[]): TcrEvent {
    return { type: EventType.AdoptedStyleSheets, id, sheets }
}

describe('VirtualDocument', () => {
    it('keeps the document a snapshot describes, by the DOM rules for document children', () => {
        const document = new VirtualDocument()
        expect(document.loaded).toBe(false)
        const snapshot = snapshotOf([{ text: 'refused' }, { tag: 'html' }, { comment: 'kept' }, { tag: 'second' }])
        expect(document.apply(snapshot)).toBe(4)
        expect(document.loaded).toBe(true)
        expect(document.size).toBe(4)
        expect(treeOf(document)).toBe(['#document', '  <!DOCTYPE html>', '  <html>', '  <!--kept-->'].join('\n'))
    })

    it('encodes its state with the ids the recording uses', () => {
        const document = new VirtualDocument()
        document.apply(pageOf([{ tag: 'p', attributes: ['class', 'a'], children: [{ text: 'hi' }] }]))
        const { snapshot, nextId } = stateOf(document, 42)
        expect(snapshot).toMatchObject({
            explicitIds: true,
            nextId: 42,
            root: { url: 'https://example.com/app/page.html' }
        })
        expect(nextId).toBe(42)
        const ids: number[] = []
        const collect = (node: SerializedNode): void => {
            ids.push(node.id)
            if (node.kind === NodeKind.Element || node.kind === NodeKind.Document) {
                node.children.forEach(collect)
            }
        }
        collect(snapshot.root)
        expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7])
    })

    it('applies removals, insertions, attribute and text changes in that order', () => {
        const document = new VirtualDocument()
        // body 5: p 6 ("a" 7), p 8 ("b" 9)
        document.apply(
            pageOf([
                { tag: 'p', children: [{ text: 'a' }] },
                { tag: 'p', children: [{ text: 'b' }] }
            ])
        )
        const ids = { next: 10 }
        const added = build({ tag: 'span', children: [{ text: 'new' }] }, ids)
        const cost = document.apply(
            mutations({
                removes: [6],
                adds: [{ parentId: 5, beforeId: 8, nodes: [added] }],
                attributes: [
                    { id: 10, name: 'class', value: 'x' },
                    { id: 8, name: 'hidden', value: '' },
                    { id: 8, name: 'hidden', value: null }
                ],
                texts: [{ id: 11, data: 'changed' }]
            })
        )
        // Two removed nodes, two added, three attribute and one text change.
        expect(cost).toBe(8)
        expect(document.size).toBe(9)
        expect(treeOf(document)).toContain(
            ['    <body>', '      <span class="x">', '        "changed"', '      <p>', '        "b"'].join('\n')
        )
    })

    it('appends nodes whose sibling is unknown or has moved, and refuses what the DOM refuses', () => {
        const document = new VirtualDocument()
        document.apply(pageOf([{ tag: 'p' }, { tag: 'div' }]))
        document.apply(
            mutations({
                adds: [
                    // The sibling, the paragraph 6, is not a child of the div 7.
                    { parentId: 7, beforeId: 6, nodes: [{ kind: NodeKind.Text, id: 8, data: 'appended' }] },
                    { parentId: 7, beforeId: 99, nodes: [{ kind: NodeKind.Comment, id: 9, data: 'too' }] },
                    {
                        parentId: 7,
                        beforeId: 0,
                        nodes: [{ kind: NodeKind.Doctype, id: 10, name: 'html', publicId: '', systemId: '' }]
                    },
                    // A second root element and text in the document.
                    {
                        parentId: 1,
                        beforeId: 0,
                        nodes: [
                            { kind: NodeKind.Element, id: 11, tag: 'x', namespace: '', attributes: [], children: [] }
                        ]
                    },
                    { parentId: 1, beforeId: 0, nodes: [{ kind: NodeKind.Text, id: 12, data: 'no' }] },
                    // Text has no children.
                    { parentId: 8, beforeId: 0, nodes: [{ kind: NodeKind.Text, id: 13, data: 'no' }] }
                ]
            })
        )
        expect(treeOf(document)).toBe(
            [
                '#document',
                '  <!DOCTYPE html>',
                '  <html>',
                '    <head>',
                '    <body>',
                '      <p>',
                '      <div>',
                '        "appended"',
                '        <!--too-->'
            ].join('\n')
        )
        expect(document.size).toBe(9)
    })

    it('places doctypes and root elements by their order rules', () => {
        const document = new VirtualDocument()
        document.apply(snapshotOf([{ comment: 'c' }], { doctype: false }))
        document.apply(mutations({ adds: [{ parentId: 1, beforeId: 0, nodes: [html(10), doctype(11)] }] }))
        // A doctype cannot follow the root element, but can go before it.
        expect(treeOf(document)).toBe(['#document', '  <!--c-->', '  <html>'].join('\n'))
        document.apply(mutations({ adds: [{ parentId: 1, beforeId: 10, nodes: [doctype(12), doctype(13)] }] }))
        expect(treeOf(document)).toBe(['#document', '  <!--c-->', '  <!DOCTYPE html>', '  <html>'].join('\n'))
        // An element cannot go before the doctype even once the root is gone.
        document.apply(mutations({ removes: [10], adds: [{ parentId: 1, beforeId: 12, nodes: [html(14)] }] }))
        expect(treeOf(document)).toBe(['#document', '  <!--c-->', '  <!DOCTYPE html>'].join('\n'))
    })

    it('keeps the last form state and scroll offset of each node, in the order they were recorded', () => {
        const document = new VirtualDocument()
        // body 5: radio 6, radio 7, div 8
        document.apply(pageOf([{ tag: 'input' }, { tag: 'input' }, { tag: 'div' }]))
        document.apply({
            type: EventType.Input,
            changes: [
                { kind: InputKind.Checked, id: 6, checked: true },
                { kind: InputKind.Checked, id: 7, checked: true },
                { kind: InputKind.Value, id: 99, value: 'unknown node' }
            ]
        })
        document.apply({ type: EventType.Input, changes: [{ kind: InputKind.Checked, id: 6, checked: true }] })
        document.apply({
            type: EventType.Scroll,
            positions: [
                { id: 8, x: 0, y: 10 },
                { id: 1, x: 0, y: 300 },
                { id: 8, x: 5, y: 20 }
            ]
        })
        const { input, scroll } = stateOf(document, 9)
        // Checking 6 again unchecks 7, so 6 has to come last.
        expect(input).toEqual({
            type: EventType.Input,
            changes: [
                { kind: InputKind.Checked, id: 7, checked: true },
                { kind: InputKind.Checked, id: 6, checked: true }
            ]
        })
        expect(scroll).toEqual({
            type: EventType.Scroll,
            positions: [
                { id: 1, x: 0, y: 300 },
                { id: 8, x: 5, y: 20 }
            ]
        })
        // Removing a node forgets its state.
        document.apply(mutations({ removes: [6, 8] }))
        expect(stateOf(document, 9).input).toEqual({
            type: EventType.Input,
            changes: [{ kind: InputKind.Checked, id: 7, checked: true }]
        })
        expect(stateOf(document, 9).scroll).toEqual({ type: EventType.Scroll, positions: [{ id: 1, x: 0, y: 300 }] })
    })

    it('attaches shadow roots and the documents of frames where the DOM takes them', () => {
        const document = new VirtualDocument()
        // body 5: div 6, input 7, iframe 8, p 9
        document.apply(pageOf([{ tag: 'div' }, { tag: 'input' }, { tag: 'iframe' }, { tag: 'p' }]))
        const cost = document.apply(
            mutations({
                adds: [
                    add(6, { shadow: [{ tag: 'span', children: [{ text: 'shadow' }] }] }, 10),
                    // An input cannot host a shadow root, and a host keeps its first one.
                    add(7, { shadow: [] }, 13),
                    add(6, { shadow: [] }, 14),
                    add(8, { document: [{ tag: 'html', children: [{ tag: 'body' }] }] }, 15),
                    // Only frames show documents.
                    add(9, { document: [] }, 18),
                    // Shadow roots and documents are no siblings: inserting before them appends.
                    add(6, { text: 'light' }, 19, 10),
                    add(8, { comment: 'fallback' }, 20, 15)
                ]
            })
        )
        expect(cost).toBe(3 + 3 + 2)
        expect(treeOf(document)).toContain(
            [
                '    <body>',
                '      <div>',
                '        #shadow-root',
                '          <span>',
                '            "shadow"',
                '        "light"',
                '      <input>',
                '      <iframe>',
                '        #document',
                '          <html>',
                '            <body>',
                '        <!--fallback-->',
                '      <p>'
            ].join('\n')
        )
        expect(document.size).toBe(9 + 8)
        // A new document replaces the frame's; removing it leaves the frame empty. Shadow roots stay.
        document.apply(mutations({ adds: [add(8, { document: [{ comment: 'second' }] }, 21)] }))
        expect(document.size).toBe(9 + 8 - 3 + 2)
        expect(treeOf(document)).toContain(
            ['      <iframe>', '        #document', '          <!--second-->'].join('\n')
        )
        document.apply(mutations({ removes: [21, 10] }))
        expect(treeOf(document)).toContain(
            ['        "light"', '      <input>', '      <iframe>', '        <!--fallback-->'].join('\n')
        )
        expect(document.size).toBe(9 + 8 - 3)
    })

    it('leaves out the shadow roots and documents of a snapshot that the DOM does not take', () => {
        const document = new VirtualDocument()
        // body 5: input 6 (#shadow-root 7), div 8 (#document 9), iframe 10 (#document 11: "text" 12, html 13
        // (#shadow-root 14), comment 15), x-card 16 (#shadow-root 17 (b 18))
        document.apply(
            pageOf([
                { tag: 'input', children: [{ shadow: [] }] },
                { tag: 'div', children: [{ document: [] }] },
                {
                    tag: 'iframe',
                    children: [
                        { document: [{ text: 'text' }, { tag: 'html', children: [{ shadow: [] }] }, { comment: 'c' }] }
                    ]
                },
                { tag: 'x-card', children: [{ shadow: [{ tag: 'b' }] }] }
            ])
        )
        expect(document.size).toBe(5 + 13 - 4)
        expect(treeOf(document)).toContain(
            [
                '      <input>',
                '      <div>',
                '      <iframe>',
                '        #document',
                '          <html>',
                '          <!--c-->',
                '      <x-card>',
                '        #shadow-root',
                '          <b>'
            ].join('\n')
        )
    })

    it('keeps what the CSSOM changed, for keyframes to restore', () => {
        const document = new VirtualDocument()
        // head 4: style 5 ("p {}" 6); body 7: div 8 (#shadow-root 9)
        document.apply(
            pageOf([{ tag: 'div', children: [{ shadow: [] }] }], {
                head: [{ tag: 'style', children: [{ text: 'p {}' }] }]
            })
        )
        // Changes before the first replace stay as they are, the replace takes in those after it.
        expect(document.apply(sheet(SheetOwner.Node, 5, insert(0, 'a {}')))).toBe(1)
        document.apply(sheet(SheetOwner.Node, 5, insert(1, 'b {}')))
        expect(stylesOf(document)).toEqual([sheet(SheetOwner.Node, 5, insert(0, 'a {}'), insert(1, 'b {}'))])
        expect(document.apply(sheet(SheetOwner.Node, 5, replace('x {}', 'y {}'), insert(9, 'z {}'), remove(0)))).toBe(4)
        // Elements without a sheet keep no changes.
        document.apply(sheet(SheetOwner.Node, 8, replace('div {}')))
        document.apply(sheet(SheetOwner.Constructed, 2, insert(3, 'c {}')))
        document.apply(sheet(SheetOwner.Constructed, 1, replace('d {}', 'e {}')))
        // Sheets without an event yet are left out.
        document.apply(adopt(1, [1, 3, 2]))
        document.apply(adopt(9, [2]))
        document.apply(adopt(8, [1]))
        document.apply(sheet(SheetOwner.Constructed, 3, replace()))
        expect(stylesOf(document)).toEqual([
            sheet(SheetOwner.Constructed, 2, replace('c {}')),
            sheet(SheetOwner.Constructed, 1, replace('d {}', 'e {}')),
            sheet(SheetOwner.Constructed, 3, replace()),
            sheet(SheetOwner.Node, 5, replace('y {}', 'z {}')),
            adopt(1, [1, 2]),
            adopt(9, [2])
        ])
        expect(document.encode(1000)?.rules).toBe(2 + 1 + 2)
        // A `<style>` parses its text anew when its children change; a root that goes forgets what it adopts.
        document.apply(mutations({ removes: [8], texts: [{ id: 6, data: 'q {}' }] }))
        document.apply(adopt(1, []))
        expect(stylesOf(document)).toEqual([
            sheet(SheetOwner.Constructed, 2, replace('c {}')),
            sheet(SheetOwner.Constructed, 1, replace('d {}', 'e {}')),
            sheet(SheetOwner.Constructed, 3, replace())
        ])
        document.apply(sheet(SheetOwner.Node, 5, insert(0, 'a {}')))
        document.apply(mutations({ adds: [add(5, { comment: 'c' }, 10)] }))
        expect(stylesOf(document)).toHaveLength(3)
        // So does one whose type is set; not one whose title is.
        document.apply(sheet(SheetOwner.Node, 5, insert(0, 'a {}')))
        document.apply(mutations({ attributes: [{ id: 5, name: 'title', value: 't' }] }))
        expect(stylesOf(document)).toHaveLength(4)
        document.apply(mutations({ attributes: [{ id: 5, name: 'type', value: 'text/css' }] }))
        expect(stylesOf(document)).toHaveLength(3)
        // A snapshot starts over.
        document.apply(pageOf([]))
        expect(document.encode(1000)?.styles).toHaveLength(0)
    })

    it('starts over at a snapshot and follows navigations', () => {
        const document = new VirtualDocument()
        document.apply(pageOf([{ tag: 'p' }]))
        document.apply({ type: EventType.Scroll, positions: [{ id: 1, x: 0, y: 50 }] })
        document.apply({ type: EventType.Navigation, id: 1, url: 'https://example.com/next' })
        expect(stateOf(document, 9).snapshot.root.url).toBe('https://example.com/next')
        document.apply(snapshotOf([{ tag: 'html' }], { url: 'https://example.com/other', quirks: true }))
        const { snapshot, scroll } = stateOf(document, 9)
        expect(snapshot.root).toMatchObject({ url: 'https://example.com/other', quirks: true })
        expect(scroll).toBeUndefined()
        expect(document.size).toBe(3)
    })
})
