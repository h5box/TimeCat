import { EventType } from '@timecat-js/protocol'
import type { AssetEvent } from '@timecat-js/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { cssUrls } from '../src/css-urls.ts'
import { PseudoClasses } from '../src/pseudo-classes.ts'
import { Resources } from '../src/resources.ts'

const PAGE = 'https://example.com/shop/'

function asset(url: string, mimeType: string, text: string): AssetEvent {
    return { type: EventType.Asset, url, mimeType, data: new TextEncoder().encode(text) }
}

async function textOf(url: string | undefined): Promise<string> {
    if (url === undefined) {
        throw new Error('not recorded')
    }
    return (await fetch(url)).text()
}

/** An element as `attribute` sees it: its name and namespace. */
function element(
    localName: string,
    namespaceURI = 'http://www.w3.org/1999/xhtml'
): Pick<Element, 'localName' | 'namespaceURI'> {
    return { localName, namespaceURI }
}

const base = (): string => PAGE

const made: Resources[] = []

function recorded(...events: AssetEvent[]): Resources {
    const resources = new Resources(new PseudoClasses())
    resources.add(events)
    made.push(resources)
    return resources
}

afterEach(() => {
    for (const resources of made.splice(0)) {
        resources.revoke()
    }
})

describe('Resources', () => {
    it('serves recorded http URLs, relative ones included, with their fragments, and leaves out others', async () => {
        const resources = recorded(
            asset('https://example.com/img/a.png', 'image/png', 'png'),
            asset('blob:https://example.com/0b6f', 'image/png', 'blob'),
            asset('https://example.com/sprite.svg', 'image/svg+xml', '<svg/>')
        )
        expect(resources.size).toBe(2)
        const image = resources.url('../img/a.png', PAGE)
        expect(image).toMatch(/^blob:/)
        expect(await textOf(image)).toBe('png')
        expect(resources.url('https://example.com/img/a.png', PAGE)).toBe(image)
        expect(resources.url('/sprite.svg#dot', PAGE)).toMatch(/^blob:.*#dot$/)
        expect(resources.url('other.png', PAGE)).toBeUndefined()
        expect(resources.url('#a.png', PAGE)).toBeUndefined()
        expect(resources.url('blob:https://example.com/0b6f', PAGE)).toBeUndefined()
        // The same events again add nothing.
        expect(resources.add([asset('https://example.com/img/a.png', 'image/png', 'png')])).toBe(false)
    })

    it('replaces the URLs of attributes that load something, and keeps those of links', () => {
        const resources = recorded(
            asset('https://example.com/a.png', 'image/png', 'a'),
            asset('https://example.com/b.png', 'image/png', 'b')
        )
        const a = resources.url('/a.png', PAGE)!
        const b = resources.url('/b.png', PAGE)!
        expect(resources.attribute(element('img'), 'src', '/a.png', base)).toBe(a)
        expect(resources.attribute(element('video'), 'poster', '/b.png', base)).toBe(b)
        expect(resources.attribute(element('a'), 'href', '/a.png', base)).toBe('/a.png')
        expect(resources.attribute(element('img'), 'alt', '/a.png', base)).toBe('/a.png')
        expect(resources.attribute(element('link'), 'href', '/a.png', base)).toBe(a)
        const svg = 'http://www.w3.org/2000/svg'
        expect(resources.attribute(element('use', svg), 'href', '/a.png#i', base)).toBe(`${a}#i`)
        expect(resources.attribute(element('image', svg), 'xlink:href', '/b.png', base)).toBe(b)
        expect(resources.attribute(element('a', svg), 'href', '/a.png', base)).toBe('/a.png')
        expect(resources.attribute(element('div'), 'style', 'background: url(/a.png) , url(c.png)', base)).toBe(
            `background: url("${a}") , url("${PAGE}c.png")`
        )
    })

    it('keeps the recorded candidates of a srcset, or all of them when none is', () => {
        const resources = recorded(
            asset('https://example.com/a,1.png', 'image/png', 'a'),
            asset('https://example.com/b.png', 'image/png', 'b')
        )
        const a = resources.url('/a,1.png', PAGE)!
        const b = resources.url('/b.png', PAGE)!
        const img = element('img')
        expect(resources.attribute(img, 'srcset', '/a,1.png 1x, /c.png 2x,/b.png 3x', base)).toBe(`${a} 1x, ${b} 3x`)
        expect(resources.attribute(img, 'srcset', '/c.png 100w, /b.png,', base)).toBe(b)
        expect(resources.attribute(img, 'srcset', '/b.png  (min-width: 1px) 2x', base)).toBe(`${b} (min-width: 1px) 2x`)
        expect(resources.attribute(img, 'srcset', '/c.png 1x, /d.png 2x', base)).toBe('/c.png 1x, /d.png 2x')
    })

    it('serves a recorded style sheet with its URLs replaced, relative to it, and its states rewritten', async () => {
        const resources = recorded(
            asset(
                'https://example.com/css/site.css',
                'text/css; charset=utf-8',
                '@import "reset.css";\na:hover { background: url(../img/a.png) } b { mask: url(missing.svg#m) }'
            ),
            asset('https://example.com/css/reset.css', 'text/css', '@import url("site.css"); p { margin: 0 }'),
            asset('https://example.com/img/a.png', 'image/png', 'a')
        )
        const sheet = resources.attribute(element('link'), 'href', 'css/site.css', () => 'https://example.com/')
        const text = await textOf(sheet)
        const reset = resources.url('/css/reset.css', PAGE)!
        const image = resources.url('/img/a.png', PAGE)!
        expect(text).toBe(
            `@import "${reset}";\na[data-timecat-hover] { background: url("${image}") } ` +
                'b { mask: url("https://example.com/css/missing.svg#m") }'
        )
        // The sheet imports itself back, which a browser leaves out: its own URL stays.
        expect(await textOf(reset)).toBe('@import url("https://example.com/css/site.css"); p { margin: 0 }')
    })

    it('leaves text as it is without resources', () => {
        const resources = recorded()
        expect(resources.css('a { b: url(c.png) }', PAGE)).toBe('a { b: url(c.png) }')
        expect(resources.attribute(element('img'), 'src', 'c.png', base)).toBe('c.png')
    })
})

describe('cssUrls', () => {
    const sheet = 'https://example.com/css/site.css'

    it('resolves the relative URLs of a sheet against where it loaded from', () => {
        expect(
            cssUrls('@import "reset.css";\na { background: url(../img/a.png) } b { mask: url( "b.svg#m" ) }', sheet)
        ).toBe(
            '@import "https://example.com/css/reset.css";\na { background: url("https://example.com/img/a.png") } ' +
                'b { mask: url("https://example.com/css/b.svg#m") }'
        )
    })

    it('keeps absolute URLs, fragments and empty ones, unless it replaces them', () => {
        const text = 'a { b: url(data:image/png;base64,AA==) url(#f) url() url("https://cdn.example/x.png") }'
        expect(cssUrls(text, sheet)).toBe(text)
        expect(cssUrls(text, sheet, url => (url === 'https://cdn.example/x.png' ? 'blob:x' : undefined))).toBe(
            'a { b: url(data:image/png;base64,AA==) url(#f) url() url("blob:x") }'
        )
    })
})
