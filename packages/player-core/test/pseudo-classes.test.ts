import { describe, expect, it } from 'vitest'
import { absoluteUrls, PseudoClasses } from '../src/pseudo-classes.ts'

describe('PseudoClasses', () => {
    it('rewrites the states in selectors to attributes, and notes those used', () => {
        const pseudoClasses = new PseudoClasses()
        expect(pseudoClasses.rewrite('a:hover, b:focus-visible > i:FOCUS { color: red }')).toBe(
            'a[data-timecat-hover], b[data-timecat-focus-visible] > i[data-timecat-focus] { color: red }'
        )
        expect([...pseudoClasses.used].toSorted()).toEqual(['focus', 'focus-visible', 'hover'])
        expect(pseudoClasses.rewrite(':is(a:active, .x:focus-within) {}')).toBe(
            ':is(a[data-timecat-active], .x[data-timecat-focus-within]) {}'
        )
    })

    it('rewrites the rules nested in at-rules and other rules, but not at-rules', () => {
        const pseudoClasses = new PseudoClasses()
        expect(
            pseudoClasses.rewrite('@media (hover: hover) { a:hover { b { c: d } } }\n.x { &:hover { color: red } }')
        ).toBe(
            '@media (hover: hover) { a[data-timecat-hover] { b { c: d } } }\n.x { &[data-timecat-hover] { color: red } }'
        )
        expect(pseudoClasses.rewrite('@supports selector(:focus-visible) { p { x: y } }')).toBe(
            '@supports selector(:focus-visible) { p { x: y } }'
        )
    })

    it('keeps states after pseudo-elements, and in comments, strings, URLs and attribute selectors', () => {
        const pseudoClasses = new PseudoClasses()
        const kept = [
            '::part(label):hover { x: y }',
            'a:before:hover { x: y }',
            '/* a:hover { */ b { x: y }',
            'a { content: ":hover {" }',
            'a { background: url(x:hover{.png) }',
            '[title=":hover"] { x: y }',
            ':hover() { x: y }',
            'a:hovering { x: y }'
        ]
        for (const text of kept) {
            expect(pseudoClasses.rewrite(text)).toBe(text)
        }
        expect(pseudoClasses.used.size).toBe(0)
        expect(pseudoClasses.rewrite('a::after, b:hover::after { x: y }')).toBe(
            'a::after, b[data-timecat-hover]::after { x: y }'
        )
        expect(pseudoClasses.rewrite('a\\:hover:focus { x: y }')).toBe('a\\:hover[data-timecat-focus] { x: y }')
        expect(pseudoClasses.rewrite('/* [ */ a:hover { x: y }')).toBe('/* [ */ a[data-timecat-hover] { x: y }')
    })
})

describe('absoluteUrls', () => {
    const base = 'https://example.com/css/site.css'

    it('resolves the relative URLs of a sheet against where it loaded from', () => {
        expect(
            absoluteUrls('@import "reset.css";\na { background: url(../img/a.png) } b { mask: url( "b.svg#m" ) }', base)
        ).toBe(
            '@import "https://example.com/css/reset.css";\na { background: url("https://example.com/img/a.png") } ' +
                'b { mask: url("https://example.com/css/b.svg#m") }'
        )
    })

    it('keeps absolute URLs, fragments and empty ones', () => {
        const text = 'a { b: url(data:image/png;base64,AA==) url(#f) url() url("https://cdn.example/x.png") }'
        expect(absoluteUrls(text, base)).toBe(text)
    })
})
