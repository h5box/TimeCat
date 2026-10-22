import { afterEach, describe, expect, it } from 'vitest'
import { LinkedSheets } from '../src/linked-sheets.ts'
import { PseudoClasses } from '../src/pseudo-classes.ts'

/** A sheet with a rule for `:hover`, served by the test server. */
const SHEET = new URL('fixtures/hover.css', import.meta.url).href

const frames: HTMLIFrameElement[] = []

afterEach(() => {
    for (const frame of frames.splice(0)) {
        frame.remove()
    }
})

/** The document of a new frame, with `head` in its head. */
function pageWith(head: string): Document {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    frames.push(frame)
    const page = frame.contentDocument!
    page.open()
    page.write(`<!DOCTYPE html><head>${head}</head><body><p>text</p></body>`)
    page.close()
    return page
}

/** A link to a style sheet, which takes its `href` from `sheets` as the materializer gives it one. */
function linkTo(page: Document, sheets: LinkedSheets): HTMLLinkElement {
    const link = page.createElement('link')
    link.rel = 'stylesheet'
    link.setAttribute('href', sheets.href(link, SHEET))
    page.head.append(link)
    return link
}

/** Sheets that resolve `changed` once they swapped one in. */
function linkedSheets(pseudoClasses = new PseudoClasses()): { sheets: LinkedSheets; changed: Promise<void> } {
    let sheets: LinkedSheets | undefined
    const changed = new Promise<void>(resolve => {
        sheets = new LinkedSheets(pseudoClasses, resolve)
    })
    return { sheets: sheets!, changed }
}

async function until(condition: () => boolean): Promise<void> {
    for (let tries = 0; tries < 100 && !condition(); tries++) {
        // oxlint-disable-next-line no-await-in-loop -- waits for the browser
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

describe('LinkedSheets', () => {
    it('swaps a sheet with states for a rewritten copy, which later links get at once', async () => {
        const pseudoClasses = new PseudoClasses()
        const { sheets, changed } = linkedSheets(pseudoClasses)
        const page = pageWith('')
        const link = linkTo(page, sheets)
        expect(link.getAttribute('href')).toBe(SHEET)
        await changed
        const copy = link.getAttribute('href')!
        expect(copy).toMatch(/^blob:/)
        await until(() => link.sheet?.href === copy)
        expect([...link.sheet!.cssRules].map(rule => rule.cssText)).toEqual([
            'p[data-timecat-hover] { color: rgb(255, 0, 0); }'
        ])
        expect([...pseudoClasses.used]).toEqual(['hover'])
        expect(linkTo(page, sheets).getAttribute('href')).toBe(copy)
        sheets.revoke()
    })

    it('gives a link its sheet back where the copy cannot load, and keeps later links to the sheet', async () => {
        const { sheets, changed } = linkedSheets()
        // A policy without `blob:` style sheets.
        const page = pageWith(`<meta http-equiv="Content-Security-Policy" content="style-src 'self' 'unsafe-inline'">`)
        const link = linkTo(page, sheets)
        await changed
        await until(() => link.getAttribute('href') === SHEET)
        expect(link.getAttribute('href')).toBe(SHEET)
        expect(linkTo(page, sheets).getAttribute('href')).toBe(SHEET)
        sheets.revoke()
    })
})
