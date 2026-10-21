import { EventType, NodeKind, PointerAction } from '@timecat-js/protocol'
import type { SerializedNode } from '@timecat-js/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { eventsOf } from './decode.ts'
import { isInput } from './fidelity/describe.ts'
import { closeSessions, Session } from './fidelity/session.ts'
import type { SessionOptions } from './fidelity/session.ts'
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

/** A decoded tree as indented lines; shadow roots and frame documents show as the first children of their hosts. */
function outline(node: SerializedNode, depth = 0): string[] {
    const indent = '  '.repeat(depth)
    const below = (children: SerializedNode[]): string[] => children.flatMap(child => outline(child, depth + 1))
    switch (node.kind) {
        case NodeKind.Document:
            return [`${indent}#document`, ...below(node.children)]
        case NodeKind.ShadowRoot:
            return [`${indent}#shadow-root (${node.closed ? 'closed' : 'open'})`, ...below(node.children)]
        case NodeKind.Element: {
            const attributes: string[] = []
            for (let i = 0; i < node.attributes.length; i += 2) {
                attributes.push(` ${node.attributes[i]}="${node.attributes[i + 1]}"`)
            }
            return [`${indent}<${node.tag}${attributes.join('')}>`, ...below(node.children)]
        }
        case NodeKind.Text:
            return [`${indent}${JSON.stringify(node.data)}`]
        case NodeKind.Comment:
            return [`${indent}<!--${node.data}-->`]
        default:
            return [`${indent}<!DOCTYPE ${node.name}>`]
    }
}

function frames(count: number): Promise<void> {
    return new Promise(resolve => {
        const next = (left: number): void => {
            if (left === 0) {
                resolve()
            } else {
                requestAnimationFrame(() => next(left - 1))
            }
        }
        next(count)
    })
}

const PAGE: SessionOptions = {
    html:
        '<!DOCTYPE html><body style="margin: 0"><div id="host"><span>light</span></div>' +
        '<iframe id="frame" style="position: absolute; left: 50px; top: 30px; border: 2px solid; padding: 3px"></iframe>' +
        '</body>',
    prepare: page => {
        byId(page, 'host').attachShadow({ mode: 'open' }).innerHTML = '<p id="inside">shadow <slot></slot></p>'
        contentOf(frameById(page, 'frame')).body.innerHTML = '<p id="framed">framed</p>'
    }
}

describe('recording shadow trees and frames', () => {
    it('writes shadow trees and the documents of frames into the snapshot', async () => {
        const session = await Session.open(PAGE)
        const root = snapshotRoot(await finish(session))
        expect(outline(root)).toEqual([
            '#document',
            '  <!DOCTYPE html>',
            '  <html>',
            '    <head>',
            '    <body style="margin: 0">',
            '      <div id="host">',
            '        #shadow-root (open)',
            '          <p id="inside">',
            '            "shadow "',
            '            <slot>',
            '        <span>',
            '          "light"',
            '      <iframe id="frame" style="position: absolute; left: 50px; top: 30px; border: 2px solid; padding: 3px">',
            '        #document',
            '          <html>',
            '            <head>',
            '            <body>',
            '              <p id="framed">',
            '                "framed"'
        ])
    })

    it('records changes inside shadow trees and frames', async () => {
        const session = await Session.open(PAGE)
        const page = session.document
        const shadow = byId(page, 'host').shadowRoot!
        const content = contentOf(frameById(page, 'frame'))
        byId(shadow, 'inside').append('more')
        byId(shadow, 'inside').setAttribute('title', 't')
        shadow.append(page.createElement('hr'))
        content.body.append(content.createElement('em'))
        byId(content, 'framed').firstChild!.textContent = 'changed'
        session.flush()
        const events = await finish(session)
        const root = snapshotRoot(events)
        const [mutations] = eventsOf(events, EventType.Mutations)
        const shadowId = idOf(root, node => node.kind === NodeKind.ShadowRoot)
        const bodyId = idOf(root, node => node.kind === NodeKind.Element && node.tag === 'body' && node.id > shadowId)
        expect(mutations?.adds.map(run => [run.parentId, run.nodes.flatMap(node => outline(node))])).toEqual([
            [idOf(root, withId('inside')), ['"more"']],
            [shadowId, ['<hr>']],
            [bodyId, ['<em>']]
        ])
        expect(mutations?.attributes).toEqual([{ id: idOf(root, withId('inside')), name: 'title', value: 't' }])
        expect(mutations?.texts).toEqual([{ id: idOf(root, withId('framed')) + 1, data: 'changed' }])
    })

    it('records shadow roots attached while recording, closed ones too', async () => {
        const session = await Session.open({ html: '<!DOCTYPE html><body><div id="a"></div><div id="b"></div></body>' })
        const page = session.document
        byId(page, 'a').attachShadow({ mode: 'open' }).innerHTML = '<i>open</i>'
        // The page's own script, through the built-ins of its realm.
        runScript(
            page,
            "window.closedRoot = document.getElementById('b').attachShadow({ mode: 'closed' }); closedRoot.innerHTML = '<b>closed</b>'"
        )
        session.flush()
        runScript(page, "closedRoot.firstChild.firstChild.data = 'still recorded'")
        session.flush()
        const events = await finish(session)
        const root = snapshotRoot(events)
        const shadowRuns = runs(events).filter(run => run.nodes[0]?.kind === NodeKind.ShadowRoot)
        expect(shadowRuns.map(run => [run.parentId, run.beforeId, run.nodes.flatMap(node => outline(node))])).toEqual([
            [idOf(root, withId('a')), 0, ['#shadow-root (open)', '  <i>', '    "open"']],
            [idOf(root, withId('b')), 0, ['#shadow-root (closed)', '  <b>', '    "closed"']]
        ])
        const texts = eventsOf(events, EventType.Mutations).flatMap(event => event.texts)
        expect(texts.map(change => change.data)).toEqual(['still recorded'])
    })

    it('writes a host inserted with its shadow root, and a root attached before its host is inserted', async () => {
        const session = await Session.open({ html: '<!DOCTYPE html><body></body>' })
        const page = session.document
        runScript(
            page,
            "const host = document.createElement('section'); host.attachShadow({ mode: 'closed' }).append('early');" +
                'window.later = host'
        )
        session.flush()
        runScript(page, 'document.body.append(later)')
        session.flush()
        const events = await finish(session)
        const inserted = runs(events).flatMap(run => run.nodes.flatMap(node => outline(node)))
        expect(inserted).toEqual(['<section>', '  #shadow-root (closed)', '    "early"'])
    })

    it('records documents that frames load, and drops those it cannot read', async () => {
        const session = await Session.open({ html: '<!DOCTYPE html><body></body>' })
        const page = session.document
        const frame = page.createElement('iframe')
        frame.srcdoc = '<p>loaded</p>'
        const load = loaded(frame)
        page.body.append(frame)
        // The frame shows its initial empty document until the new one loads.
        session.flush()
        await load
        session.flush()
        // A data: URL has an origin of its own, which the recorder cannot read.
        const opaque = loaded(frame)
        frame.src = 'data:text/html,<p>opaque</p>'
        frame.removeAttribute('srcdoc')
        await opaque
        session.flush()
        const events = await finish(session)
        const mutations = eventsOf(events, EventType.Mutations)
        const [insert, load1, ...rest] = mutations
        expect(insert?.adds.flatMap(run => run.nodes.flatMap(node => outline(node)))).toEqual([
            '<iframe srcdoc="<p>loaded</p>">',
            '  #document',
            '    <html>',
            '      <head>',
            '      <body>'
        ])
        const frameId = insert!.adds[0]!.nodes[0]!.id
        const blankId = frameId + 1
        expect(load1?.adds.map(run => [run.parentId, run.beforeId, run.nodes.flatMap(node => outline(node))])).toEqual([
            [frameId, 0, ['#document', '  <html>', '    <head>', '    <body>', '      <p>', '        "loaded"']]
        ])
        const loadedId = load1!.adds[0]!.nodes[0]!.id
        expect(loadedId).toBeGreaterThan(blankId)
        expect(rest.flatMap(event => event.removes)).toEqual([loadedId])
    })

    it('writes a shadow root attached while the snapshot is taken once, after the snapshot', async () => {
        let attached = false
        const session = await Session.open({
            html: '<!DOCTYPE html><body><p>a</p><p>b</p><div id="late"></div></body>',
            checkEvery: 1,
            betweenSlices: page => {
                if (!attached) {
                    attached = true
                    byId(page, 'late').attachShadow({ mode: 'open' }).append('inside')
                }
            }
        })
        const events = await finish(session)
        const root = snapshotRoot(events)
        expect(find(root, node => node.kind === NodeKind.ShadowRoot)).toBeUndefined()
        expect(runs(events).map(run => [run.parentId, run.nodes.flatMap(node => outline(node))])).toEqual([
            [idOf(root, withId('late')), ['#shadow-root (open)', '  "inside"']]
        ])
    })

    it('writes the new document of a frame that moved, and nothing of a frame that is gone', async () => {
        const session = await Session.open({ html: '<!DOCTYPE html><body><div id="a"></div></body>' })
        const page = session.document
        const frame = page.createElement('iframe')
        frame.srcdoc = 'first'
        const first = loaded(frame)
        page.body.append(frame)
        await first
        session.flush()
        // Moving a frame loads its document anew.
        const again = loaded(frame)
        byId(page, 'a').append(frame)
        session.flush()
        await again
        session.flush()
        frame.remove()
        session.flush()
        const events = await finish(session)
        const mutations = eventsOf(events, EventType.Mutations)
        expect(mutations.map(event => event.adds.flatMap(run => run.nodes.flatMap(node => outline(node))))).toEqual([
            ['<iframe srcdoc="first">', '  #document', '    <html>', '      <head>', '      <body>', '        "first"'],
            ['<iframe srcdoc="first">', '  #document', '    <html>', '      <head>', '      <body>'],
            ['#document', '  <html>', '    <head>', '    <body>', '      "first"'],
            []
        ])
        const frameId = (snapshot: number): number => mutations[snapshot]!.adds[0]!.nodes[0]!.id
        expect(mutations.map(event => event.removes)).toEqual([[], [frameId(0)], [], [frameId(1)]])
    })

    it('records input, scrolling and navigations in shadow trees and frames', async () => {
        const session = await Session.open({
            html:
                '<!DOCTYPE html><body><div id="host"></div>' +
                '<iframe id="frame" style="width: 200px; height: 100px"></iframe></body>',
            prepare: page => {
                byId(page, 'host').attachShadow({ mode: 'open' }).innerHTML =
                    '<input id="typed"><input id="set"><input type="radio" name="r" id="r1" checked>'
                contentOf(frameById(page, 'frame')).body.innerHTML =
                    '<input id="framed"><div style="height: 1000px">tall</div>'
            }
        })
        const page = session.document
        const shadow = byId(page, 'host').shadowRoot!
        const content = contentOf(frameById(page, 'frame'))
        const typed = byId(shadow, 'typed')
        const framed = byId(content, 'framed')
        if (!isInput(typed) || !isInput(framed)) {
            throw new Error('no inputs')
        }
        typed.value = 'in shadow'
        typed.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        framed.value = 'in frame'
        framed.dispatchEvent(new Event('input', { bubbles: true }))
        // Scripts of the page set state without events.
        runScript(page, "document.getElementById('host').shadowRoot.getElementById('set').value = 'by script'")
        session.flush()
        // Inserting a checked radio button unchecks the others of its group, which is the shadow tree's.
        shadow.append(page.createElement('div'))
        shadow.lastElementChild!.innerHTML = '<input type="radio" name="r" checked>'
        content.defaultView!.scrollTo(0, 120)
        content.defaultView!.location.hash = 'there'
        await frames(2)
        session.flush()
        const events = await finish(session)
        const root = snapshotRoot(events)
        const changes = eventsOf(events, EventType.Input).flatMap(event => event.changes)
        expect(changes).toEqual(
            expect.arrayContaining([
                { kind: 0, id: idOf(root, withId('typed')), value: 'in shadow' },
                { kind: 0, id: idOf(root, withId('framed')), value: 'in frame' },
                { kind: 0, id: idOf(root, withId('set')), value: 'by script' },
                { kind: 1, id: idOf(root, withId('r1')), checked: false }
            ])
        )
        const frameDocument = idOf(root, node => node.kind === NodeKind.Document && node !== root)
        const positions = eventsOf(events, EventType.Scroll).flatMap(event => event.positions)
        expect(positions).toContainEqual({ id: frameDocument, x: 0, y: 120 })
        // The frame's `about:blank` document is recorded with the URL its relative URLs resolve against, the page's,
        // which a fragment does not change.
        expect(find(root, node => node.id === frameDocument)).toMatchObject({ url: page.baseURI })
        expect(eventsOf(events, EventType.Navigation)).toEqual([])
    })

    it('places pointer events in frames in the page viewport, and targets nodes in shadow trees', async () => {
        const session = await Session.open(PAGE)
        const page = session.document
        const content = contentOf(frameById(page, 'frame'))
        const init = { clientX: 5, clientY: 7, isPrimary: true, bubbles: true, composed: true }
        byId(content, 'framed').dispatchEvent(new PointerEvent('pointerdown', init))
        byId(byId(page, 'host').shadowRoot!, 'inside').dispatchEvent(new PointerEvent('pointerup', init))
        session.flush()
        const events = await finish(session)
        const root = snapshotRoot(events)
        const buttons = eventsOf(events, EventType.PointerButton)
        // The frame's content box starts after its left and top, border and padding.
        expect(buttons.map(event => [event.action, event.x, event.y, event.targetId])).toEqual([
            [PointerAction.Down, 60, 42, idOf(root, withId('framed'))],
            [PointerAction.Up, 5, 7, idOf(root, withId('inside'))]
        ])
    })

    it('follows a frame whose document was opened anew', async () => {
        const session = await Session.open({ html: '<!DOCTYPE html><body><iframe id="frame"></iframe></body>' })
        const content = contentOf(frameById(session.document, 'frame'))
        // Opening a document removes every listener of its window, and the doctype ends the quirks mode of the
        // initial empty document.
        content.open()
        content.write('<!DOCTYPE html><body><p id="written">written</p>')
        content.close()
        session.flush()
        byId(content, 'written').dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, bubbles: true }))
        // The opened document has the URL of the document that opened it, which navigates on its own.
        content.defaultView!.history.pushState(null, '', '#moved')
        session.flush()
        const events = await finish(session)
        const root = snapshotRoot(events)
        const blank = find(root, node => node.kind === NodeKind.Document && node !== root)
        expect(blank?.kind === NodeKind.Document && blank.quirks).toBe(true)
        const [opened] = eventsOf(events, EventType.Mutations)
        expect(opened?.removes).toContain(blank?.id)
        const [run] = opened?.adds ?? []
        const document = run?.nodes[0]
        expect([run?.parentId, run?.beforeId, document?.kind === NodeKind.Document && document.quirks]).toEqual([
            idOf(root, withId('frame')),
            0,
            false
        ])
        const written = document === undefined ? undefined : find(document, withId('written'))
        expect(eventsOf(events, EventType.PointerButton).map(event => event.targetId)).toEqual([written?.id])
        expect(eventsOf(events, EventType.Navigation).map(event => [event.id, event.url])).toEqual([
            [document?.id, new URL('#moved', location.href).href]
        ])
    })

    it('finds declarative shadow roots that the parser attaches to hosts already recorded', async () => {
        const session = await Session.open({ html: '<!DOCTYPE html><body><iframe id="frame"></iframe></body>' })
        const content = contentOf(frameById(session.document, 'frame'))
        content.open()
        content.write('<!DOCTYPE html><body><div id="host">')
        session.flush()
        content.write('<template shadowrootmode="open"><p>declarative</p></template></div>')
        const parsed = new Promise(resolve => content.addEventListener('DOMContentLoaded', resolve, { once: true }))
        content.close()
        await parsed
        session.flush()
        const events = await finish(session)
        const host = runs(events)
            .flatMap(run => run.nodes)
            .map(node => find(node, withId('host')))
            .find(node => node !== undefined)
        const shadowRuns = runs(events).filter(run => run.nodes[0]?.kind === NodeKind.ShadowRoot)
        expect(shadowRuns.map(run => [run.parentId, run.beforeId, run.nodes.flatMap(node => outline(node))])).toEqual([
            [host?.id, 0, ['#shadow-root (open)', '  <p>', '    "declarative"']]
        ])
    })

    it('masks and ignores inside shadow trees and frames of masked and ignored regions', async () => {
        const session = await Session.open({
            html: '<!DOCTYPE html><body><div class="secret"><div id="host"></div><iframe id="frame"></iframe></div></body>',
            maskText: '.secret',
            ignore: '.secret',
            prepare: page => {
                byId(page, 'host').attachShadow({ mode: 'open' }).innerHTML = 'zebra<input id="typed">'
                contentOf(frameById(page, 'frame')).body.innerHTML = '<p>okapi</p>'
            }
        })
        const page = session.document
        const shadow = byId(page, 'host').shadowRoot!
        shadow.append('walrus')
        const content = contentOf(frameById(page, 'frame'))
        content.body.firstChild!.textContent = 'quokka'
        const typed = byId(shadow, 'typed')
        if (isInput(typed)) {
            typed.value = 'pelican'
            typed.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        }
        session.flush()
        const text = JSON.stringify(await finish(session))
        for (const secret of ['zebra', 'okapi', 'walrus', 'quokka', 'pelican']) {
            expect(text).not.toContain(secret)
        }
        expect(text).toContain('*****')
    })
})
