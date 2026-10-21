import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeRecording } from '../decode.ts'
import { isElement, isForm, isInput, isSelect, isTextArea } from './describe.ts'
import { applyOperation, pageOperation } from './operations.ts'
import { closeSessions, replay, Session } from './session.ts'

const XLINK = 'http://www.w3.org/1999/xlink'

afterEach(closeSessions)

/**
 * Finishes a recording and expects its replay to show each checkpoint's state at its time, seeking in `order`
 * (by default forward through the checkpoints, then back), with the keyframes of the recording and with
 * keyframes the player adds every few events.
 */
async function expectReplay(session: Session, order?: readonly number[]): Promise<void> {
    const recording = await session.finish()
    expect(session.errors).toEqual([])
    const checkpoints = session.checkpoints
    const indexes = order ?? [...checkpoints.keys(), ...[...checkpoints.keys()].toReversed()]
    const times = indexes.map(i => checkpoints[i]!.time)
    const expected = indexes.map(i => checkpoints[i]!.state)
    const replays = await Promise.all([2000, 3].map(interval => replay(recording, times, interval)))
    for (const states of replays) {
        expect(states).toEqual(expected)
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

function byId(document: Document, id: string): Element {
    const element = document.getElementById(id)
    if (element === null) {
        throw new Error(`no #${id}`)
    }
    return element
}

function byIdAs<T extends Element>(document: Document, id: string, guard: (node: Node) => node is T): T {
    const element = byId(document, id)
    if (!guard(element)) {
        throw new Error(`#${id} is not what the test expects`)
    }
    return element
}

function inputById(document: Document, id: string): HTMLInputElement {
    return byIdAs(document, id, isInput)
}

function typeInto(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    control.value = value
    control.dispatchEvent(new Event('input', { bubbles: true }))
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fidelity</title>
<style>body { margin: 8px; font: 16px/1.4 sans-serif } .box { height: 80px; overflow: auto }</style>
</head>
<body class="page" data-x="1">
<!-- a comment -->
<h1 id="title">Hello <em>world</em></h1>
<p>Text with &amp; entities &lt;ok&gt; and   spaces, and emoji 😀.</p>
<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
<form>
<input name="text" value="initial">
<input type="checkbox" checked>
<input type="radio" name="r" value="a"><input type="radio" name="r" value="b" checked>
<select><option>a</option><option selected>b</option></select>
<select multiple><option selected>a</option><option>b</option><option selected>c</option></select>
<textarea>default text</textarea>
</form>
<svg width="20" height="20" viewBox="0 0 20 20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect id="r" width="10" height="10" fill="url(#g)"/><use xlink:href="#r" x="10"/></svg>
<math><mi>x</mi><mo>=</mo><mn>1</mn></math>
<div class="box"><div style="height: 300px">scrollable</div></div>
</body>
</html>`

describe('replay of a recording', () => {
    it('shows the page as it was when recording started', async () => {
        const session = await Session.open({ html: PAGE })
        session.checkpoint()
        await expectReplay(session)
    })

    it('renders a page without a doctype in quirks mode', async () => {
        const session = await Session.open({ html: '<html><body><p>quirks</p></body></html>' })
        session.checkpoint()
        expect(session.checkpoints[0]?.state).toContain('BackCompat')
        await expectReplay(session)
    })

    it('shows the changes of each frame', async () => {
        const session = await Session.open({
            html:
                '<!DOCTYPE html><body><div id="a"><p id="p1">first</p><p id="p2">second</p></div><div id="b"></div>' +
                '<svg><use id="use" xlink:href="#p1"/></svg></body>'
        })
        const page = session.document
        const a = byId(page, 'a')
        const b = byId(page, 'b')
        const p1 = byId(page, 'p1')
        session.checkpoint()
        // Insertions at the start, in the middle and at the end.
        a.prepend('start')
        byId(page, 'p2').before(page.createElement('hr'))
        a.append(page.createComment('end'))
        session.checkpoint()
        // A move to another parent, and one within the same parent.
        b.append(p1)
        a.prepend(byId(page, 'p2'))
        session.checkpoint()
        // Several changes to one node in a frame, of which the last counts.
        p1.setAttribute('class', 'x')
        p1.setAttribute('class', 'y')
        p1.setAttribute('title', 'kept')
        p1.removeAttribute('class')
        p1.textContent = 'replaced'
        const text = p1.firstChild
        if (text !== null && text.nodeType === 3 && 'data' in text) {
            text.data = 'changed'
        }
        session.checkpoint()
        // Added and removed again, added and then changed, moved and then changed.
        const gone = page.createElement('em')
        b.append(gone)
        gone.remove()
        const fresh = page.createElement('section')
        b.append(fresh)
        fresh.append('inside')
        fresh.setAttribute('data-n', '1')
        a.append(p1)
        p1.setAttribute('data-moved', '')
        session.checkpoint()
        // Namespaced attributes, and markup parsed in place.
        byId(page, 'use').setAttributeNS(XLINK, 'xlink:href', '#p2')
        b.innerHTML = '<ul><li>one</li><li>two</li></ul><svg><circle r="1"/></svg><math><mi>y</mi></math>'
        session.checkpoint()
        byId(page, 'use').removeAttributeNS(XLINK, 'href')
        session.checkpoint()
        // A new head, and a new body.
        page.head.remove()
        page.documentElement.prepend(page.createElement('head'))
        page.body.replaceChildren(page.createElement('main'), 'text')
        session.checkpoint()
        await expectReplay(session)
    })

    it('shows form state set by the user, by scripts and by resets', async () => {
        const session = await Session.open({
            html:
                '<!DOCTYPE html><body><form id="form"><input id="text" value="a"><input id="box" type="checkbox">' +
                '<input id="r1" type="radio" name="r" checked><input id="r2" type="radio" name="r">' +
                '<select id="one"><option>a</option><option>b</option></select>' +
                '<select id="many" multiple><option>a</option><option selected>b</option><option>c</option></select>' +
                '<textarea id="area">default</textarea></form></body>'
        })
        const page = session.document
        const form = byIdAs(page, 'form', isForm)
        const text = inputById(page, 'text')
        const box = inputById(page, 'box')
        const area = byIdAs(page, 'area', isTextArea)
        const one = byIdAs(page, 'one', isSelect)
        const many = byIdAs(page, 'many', isSelect)
        session.checkpoint()
        // Typing, which fires input events.
        typeInto(text, 'ab')
        typeInto(area, 'typed\nlines')
        session.checkpoint()
        // Scripts setting state, which fires no event.
        text.value = 'abc'
        box.checked = true
        inputById(page, 'r2').checked = true
        one.selectedIndex = 1
        many.options[0]!.selected = true
        session.checkpoint()
        // Clicks, which change state and fire events.
        inputById(page, 'r1').click()
        box.click()
        session.checkpoint()
        // A reset, after which the defaults show again.
        form.reset()
        session.checkpoint()
        // Defaults that change after the reset, which the controls follow.
        text.setAttribute('value', 'new default')
        box.setAttribute('checked', '')
        area.textContent = 'new text'
        many.options[2]!.setAttribute('selected', '')
        session.checkpoint()
        // A control added with a value of its own, and one whose type changes.
        const added = page.createElement('input')
        added.value = 'own'
        form.append(added)
        text.type = 'checkbox'
        session.checkpoint()
        await expectReplay(session)
    })

    it('shows scrolling, the viewport size and same-document navigations', async () => {
        const session = await Session.open({
            html:
                '<!DOCTYPE html><body style="margin: 0"><div style="height: 2000px; width: 1500px">tall</div>' +
                '<div id="box" style="height: 100px; overflow: auto"><div style="height: 500px">inner</div></div></body>',
            width: 400,
            height: 300
        })
        const page = session.document
        const view = page.defaultView!
        session.checkpoint()
        view.scrollTo(30, 400)
        byId(page, 'box').scrollTop = 120
        // Scroll events come with the next frame.
        await frames(2)
        session.checkpoint()
        session.frame.style.width = '360px'
        session.frame.style.height = '320px'
        await frames(2)
        session.checkpoint()
        view.history.pushState(null, '', '#second')
        session.checkpoint()
        view.history.pushState(null, '', 'other/page?x=1')
        session.checkpoint()
        expect(session.checkpoints.map(checkpoint => checkpoint.state.split('\n')[1])).toEqual([
            'viewport 400x300, scrolled 0,0',
            'viewport 400x300, scrolled 30,400',
            'viewport 360x320, scrolled 30,400',
            'viewport 360x320, scrolled 30,400',
            'viewport 360x320, scrolled 30,400'
        ])
        await expectReplay(session)
    })

    it('keeps up with a page that changes while its snapshot is taken and after', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(pageOperation, { maxLength: 20 }),
                fc.array(pageOperation, { maxLength: 20 }),
                fc.array(fc.array(pageOperation, { maxLength: 4 }), { maxLength: 6 }),
                fc.integer({ min: 1, max: 6 }),
                fc.array(fc.nat(), { maxLength: 8 }),
                async (setup, during, later, checkEvery, jumps) => {
                    let used = 0
                    const session = await Session.open({
                        html: '<!DOCTYPE html><body><div><p>one</p><p>two</p></div><span>three</span></body>',
                        prepare: page => {
                            for (const operation of setup) {
                                applyOperation(page, operation)
                            }
                        },
                        checkEvery,
                        betweenSlices: page => {
                            const operation = during[used]
                            if (operation !== undefined) {
                                applyOperation(page, operation)
                                used++
                            }
                        }
                    })
                    // What the snapshot was too short for comes right after it.
                    for (const operation of during.slice(used)) {
                        applyOperation(session.document, operation)
                    }
                    session.checkpoint()
                    for (const frame of later) {
                        for (const operation of frame) {
                            applyOperation(session.document, operation)
                        }
                        session.checkpoint()
                    }
                    const count = session.checkpoints.length
                    await expectReplay(session, [...session.checkpoints.keys(), ...jumps.map(jump => jump % count)])
                }
            ),
            { numRuns: 40 }
        )
    })

    it('masks what privacy options say, and passwords always', async () => {
        const session = await Session.open({
            html:
                '<!DOCTYPE html><body><p class="secret">Classified dossier <b>zebra</b></p>' +
                '<input id="password" class="free" type="password" value="hunter2"><input id="name" value="Alice">' +
                '<input id="free" class="free" value="shown"><textarea id="memo">pelican</textarea>' +
                '<div class="blocked" style="width: 120px; height: 30px">giraffe <i>okapi</i></div>' +
                '<div class="ignored"><input id="ignored" class="free" value="v"></div></body>',
            maskText: '.secret',
            block: '.blocked',
            ignore: '.ignored',
            unmaskInputs: '.free'
        })
        const page = session.document
        typeInto(inputById(page, 'password'), 'longer2!')
        typeInto(inputById(page, 'name'), 'Bobby')
        typeInto(inputById(page, 'free'), 'typed')
        typeInto(inputById(page, 'ignored'), 'walrus')
        typeInto(byIdAs(page, 'memo', isTextArea), 'flamingo')
        const bold = page.querySelector('.secret b')
        if (bold !== null && isElement(bold)) {
            bold.textContent = 'quokka'
        }
        session.checkpoint()
        const time = session.checkpoints[0]!.time
        const recording = await session.finish()
        const events = JSON.stringify((await decodeRecording(recording)).events)
        for (const secret of [
            'Classified',
            'dossier',
            'zebra',
            'quokka',
            'hunter2',
            'longer2',
            'Alice',
            'Bobby',
            'pelican',
            'flamingo',
            'giraffe',
            'okapi',
            'walrus'
        ]) {
            expect(events).not.toContain(secret)
        }
        const [state] = await replay(recording, [time], 2000)
        const lines = (state ?? '').split('\n').map(line => line.trim())
        expect(lines).toEqual(
            expect.arrayContaining([
                '"********** ******* "',
                '"******"',
                '<input class="free" id="password" type="password" value="*******"> (value: "********")',
                '<input id="name" value="*****"> (value: "*****")',
                '<input class="free" id="free" value="shown"> (value: "typed")',
                '<textarea id="memo"> (value: "********")',
                '<div class="blocked" data-timecat-blocked="" style="width:120px;height:30px">',
                '<input class="free" id="ignored" value="v"> (value: "v")'
            ])
        )
    })
})
