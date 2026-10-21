import { EventType, NodeKind, SheetChangeKind, SheetOwner } from '@timecat-js/protocol'
import type { SheetChange } from '@timecat-js/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { eventsOf } from './decode.ts'
import type { DecodedEvent } from './decode.ts'
import { closeSessions, Session } from './fidelity/session.ts'
import {
    byId,
    contentOf,
    find,
    finish,
    frameById,
    idOf,
    loaded,
    runs,
    runScript,
    snapshotRoot,
    withId
} from './helpers.ts'

afterEach(closeSessions)

function sheetOf(element: Element): CSSStyleSheet {
    const sheet = 'sheet' in element ? element.sheet : null
    if (!isSheet(sheet)) {
        throw new Error('no sheet')
    }
    return sheet
}

function isSheet(value: unknown): value is CSSStyleSheet {
    return typeof value === 'object' && value !== null && 'cssRules' in value
}

function ruleOf(sheet: CSSStyleSheet, index: number): CSSRule {
    const rule = sheet.cssRules[index]
    if (rule === undefined) {
        throw new Error(`no rule ${index}`)
    }
    return rule
}

/** Calls the method of the interface `name` of the realm of `global` on `target`. */
function callIn(global: object, name: string, method: string, target: object, args: unknown[]): void {
    const constructor: unknown = Reflect.get(global, name)
    const prototype: unknown = typeof constructor === 'function' ? constructor.prototype : undefined
    const found: unknown =
        typeof prototype === 'object' && prototype !== null ? Reflect.get(prototype, method) : undefined
    if (typeof found !== 'function') {
        throw new Error(`no ${name}.${method}`)
    }
    Reflect.apply(found, target, args)
}

function isGrouping(rule: CSSRule): rule is CSSGroupingRule {
    return 'insertRule' in rule
}

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
    return 'selectorText' in rule
}

/** StyleSheet events as `[owner, id, changes]`. */
function sheetEvents(events: readonly DecodedEvent[]): [SheetOwner, number, SheetChange[]][] {
    return eventsOf(events, EventType.StyleSheet).map(event => [event.owner, event.id, event.changes])
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

describe('recording style sheets', () => {
    it('records the rules script changes in sheets of `<style>` elements', async () => {
        const session = await Session.open({
            html:
                '<!DOCTYPE html><head><style id="empty"></style><style id="text">p { color: red; }</style></head>' +
                '<body></body>',
            // Rules inserted before recording into a `<style>` without text, as CSS-in-JS libraries insert them.
            prepare: page => void sheetOf(byId(page, 'empty')).insertRule('p { margin: 1px; }')
        })
        const page = session.document
        const empty = sheetOf(byId(page, 'empty'))
        const text = sheetOf(byId(page, 'text'))
        empty.insertRule('a { color: blue; }', 1)
        session.flush()
        empty.deleteRule(0)
        text.insertRule('div { color: green; }', 1)
        session.flush()
        text.insertRule('@media print { p { color: black; } }', 0)
        session.flush()
        // Changes inside rules write the top-level rule anew.
        const media = ruleOf(text, 0)
        const paragraph = ruleOf(text, 1)
        if (!isGrouping(media) || !isStyleRule(paragraph)) {
            throw new Error('unexpected rules')
        }
        media.insertRule('a { color: black; }', 1)
        paragraph.style.setProperty('color', 'pink')
        session.flush()
        const mediaText = media.cssText
        const paragraphText = paragraph.cssText
        const events = await finish(session)
        const root = snapshotRoot(events)
        const emptyId = idOf(root, withId('empty'))
        const textId = idOf(root, withId('text'))
        expect(sheetEvents(events)).toEqual([
            // Written whole the first time: with no text, right after the snapshot.
            [SheetOwner.Node, emptyId, [replace('p { margin: 1px; }')]],
            [SheetOwner.Node, emptyId, [insert(1, 'a { color: blue; }')]],
            [SheetOwner.Node, emptyId, [remove(0)]],
            [SheetOwner.Node, textId, [replace('p { color: red; }', 'div { color: green; }')]],
            [SheetOwner.Node, textId, [insert(0, '@media print {\n  p { color: black; }\n}')]],
            [SheetOwner.Node, textId, [remove(0), insert(0, mediaText), remove(1), insert(1, paragraphText)]]
        ])
        expect(paragraphText).toBe('p { color: pink; }')
    })

    it('writes a sheet whole when hooks missed changes or most rules changed', async () => {
        const session = await Session.open({ html: '<!DOCTYPE html><head><style id="s"></style></head><body></body>' })
        const sheet = sheetOf(byId(session.document, 's'))
        sheet.insertRule('a { color: red; }')
        session.flush()
        // Through a realm the recorder does not hook, as one of a frame it does not record.
        const foreign = document.createElement('iframe')
        document.body.append(foreign)
        callIn(foreign.contentWindow!, 'CSSStyleSheet', 'insertRule', sheet, ['b { color: red; }', 1])
        foreign.remove()
        sheet.insertRule('c { color: red; }', 2)
        session.flush()
        // Changes the hooks report without an index are found by comparing the rules.
        callIn(window, 'CSSStyleSheet', 'removeRule', sheet, [1])
        session.flush()
        sheet.deleteRule(1)
        sheet.deleteRule(0)
        sheet.insertRule('d { color: red; }')
        session.flush()
        const events = await finish(session)
        expect(sheetEvents(events).map(([, , changes]) => changes)).toEqual([
            [replace('a { color: red; }')],
            [replace('a { color: red; }', 'b { color: red; }', 'c { color: red; }')],
            [remove(1)],
            [replace('d { color: red; }')]
        ])
    })

    it('writes a sheet whole when its text is parsed anew after script changed it', async () => {
        const session = await Session.open({
            html: '<!DOCTYPE html><head><style id="s">p { color: red; }</style></head><body></body>'
        })
        const page = session.document
        const style = byId(page, 's')
        sheetOf(style).insertRule('a { color: blue; }')
        session.flush()
        // Any change to the children parses the text anew, which drops the rule inserted, even a change undone
        // before it is written, which the replay never sees.
        style.append(page.createComment('gone'))
        style.lastChild?.remove()
        session.flush()
        // The replay has the rules of the text again, and parses a new text as the page does.
        style.append('b { color: green; }')
        session.flush()
        const events = await finish(session)
        expect(sheetEvents(events).map(([, , changes]) => changes)).toEqual([
            [replace('a { color: blue; }', 'p { color: red; }')],
            [replace('p { color: red; }')]
        ])
    })

    it('records constructed sheets, and the documents and shadow roots that adopt them', async () => {
        const session = await Session.open({
            html: '<!DOCTYPE html><body><div id="host"></div></body>',
            prepare: page =>
                runScript(
                    page,
                    "window.first = new CSSStyleSheet(); first.replaceSync('p { color: red; }'); " +
                        'document.adoptedStyleSheets = [first]'
                )
        })
        const page = session.document
        runScript(
            page,
            "window.second = new CSSStyleSheet(); second.replaceSync('a { color: blue; }'); " +
                "document.getElementById('host').attachShadow({ mode: 'open' }).adoptedStyleSheets = [first, second]"
        )
        session.flush()
        // The array of adopted sheets changes in place too.
        runScript(page, 'document.adoptedStyleSheets.push(second)')
        session.flush()
        runScript(page, "first.insertRule('b { color: green; }', 1); second.replaceSync('i { color: gray; }')")
        session.flush()
        // A sheet that is not adopted is not recorded.
        runScript(page, "new CSSStyleSheet().replaceSync('u { color: red; }')")
        session.flush()
        const events = await finish(session)
        const shadowId = runs(events).find(run => run.nodes[0]?.kind === NodeKind.ShadowRoot)?.nodes[0]?.id
        expect(eventsOf(events, EventType.AdoptedStyleSheets).map(event => [event.id, event.sheets])).toEqual([
            [1, [1]],
            [shadowId, [1, 2]],
            [1, [1, 2]]
        ])
        expect(sheetEvents(events)).toEqual([
            [SheetOwner.Constructed, 1, [replace('p { color: red; }')]],
            [SheetOwner.Constructed, 2, [replace('a { color: blue; }')]],
            [SheetOwner.Constructed, 1, [insert(1, 'b { color: green; }')]],
            [SheetOwner.Constructed, 2, [replace('i { color: gray; }')]]
        ])
    })

    it('records rules that the scripts of frames change, in each document a frame loads', async () => {
        const session = await Session.open({
            html: '<!DOCTYPE html><body><iframe id="frame"></iframe></body>',
            prepare: page => {
                contentOf(frameById(page, 'frame')).head.innerHTML = '<style id="framed"></style>'
            }
        })
        const frame = frameById(session.document, 'frame')
        runScript(contentOf(frame), "document.getElementById('framed').sheet.insertRule('p { color: red; }')")
        session.flush()
        // The new document comes with a realm of its own, in the same window.
        const load = loaded(frame)
        frame.srcdoc = '<!DOCTYPE html><style id="loaded"></style>'
        await load
        session.flush()
        runScript(contentOf(frame), "document.getElementById('loaded').sheet.insertRule('a { color: red; }')")
        session.flush()
        const events = await finish(session)
        const loadedId = runs(events)
            .flatMap(run => run.nodes)
            .map(node => find(node, withId('loaded')))
            .find(node => node !== undefined)?.id
        expect(sheetEvents(events)).toEqual([
            [SheetOwner.Node, idOf(snapshotRoot(events), withId('framed')), [replace('p { color: red; }')]],
            [SheetOwner.Node, loadedId, [replace('a { color: red; }')]]
        ])
    })
})

describe('recording fonts and blob: content', () => {
    it('records the font faces script adds to the fonts of the page', async () => {
        const session = await Session.open({ html: '<!DOCTYPE html><body></body>' })
        const page = session.document
        const linked = new URL('fonts/linked.woff2', page.baseURI).href
        runScript(
            page,
            "document.fonts.add(new FontFace('Linked', 'url(fonts/linked.woff2) format(\"woff2\")', " +
                "{ weight: '700', style: 'italic' })); " +
                "document.fonts.add(new FontFace('Inline', new Uint8Array([1, 2, 3]))); " +
                "new FontFace('Unused', 'url(unused.woff2)')"
        )
        session.flush()
        const events = await finish(session)
        const fonts = eventsOf(events, EventType.FontFace)
        expect(fonts.map(font => [font.family, font.source, font.descriptors])).toEqual([
            ['Linked', `url(${linked}) format("woff2")`, ['style', 'italic', 'weight', '700']],
            ['Inline', new Uint8Array([1, 2, 3]), []]
        ])
    })

    it('records what the blob: URLs the page uses point to, once each, while the budget lasts', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
        const session = await Session.open({
            html: '<!DOCTYPE html><body></body>',
            assetBudget: 100,
            prepare: page =>
                runScript(
                    page,
                    "window.early = URL.createObjectURL(new Blob(['early'], { type: 'text/plain' })); " +
                        'document.body.dataset.early = early'
                )
        })
        const page = session.document
        runScript(
            page,
            // Revoked right after use, as pages may revoke once an image is set.
            `window.image = URL.createObjectURL(new Blob(['${svg}'], { type: 'image/svg+xml' })); ` +
                "const img = document.createElement('img'); img.src = image; document.body.append(img); " +
                "document.head.appendChild(document.createElement('style')).sheet" +
                ".insertRule('p { background: url(' + image + ') }'); " +
                'URL.revokeObjectURL(image)'
        )
        session.flush()
        // More than what is left of the budget, which font data shares.
        runScript(
            page,
            "const big = URL.createObjectURL(new Blob(['x'.repeat(40)])); " +
                "document.body.style.backgroundImage = 'url(' + big + ')'; " +
                "document.fonts.add(new FontFace('Heavy', new Uint8Array(40)))"
        )
        session.flush()
        const view = page.defaultView!
        const early: unknown = Reflect.get(view, 'early')
        const image: unknown = Reflect.get(view, 'image')
        const events = await finish(session)
        const assets = eventsOf(events, EventType.Asset).map(asset => [
            asset.url,
            asset.mimeType,
            new TextDecoder().decode(asset.data)
        ])
        expect(assets).toHaveLength(2)
        expect(assets).toEqual(
            expect.arrayContaining([
                [early, 'text/plain', 'early'],
                [image, 'image/svg+xml', svg]
            ])
        )
        expect(eventsOf(events, EventType.FontFace)).toEqual([])
    })
})
