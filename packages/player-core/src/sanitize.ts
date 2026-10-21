import { HTML_NAMESPACE } from './dom.ts'

/** The type replayed scripts get, which no browser runs. */
export const INERT_SCRIPT_TYPE = 'text/plain'

const XLINK = 'http://www.w3.org/1999/xlink'
const XML = 'http://www.w3.org/XML/1998/namespace'
const XMLNS = 'http://www.w3.org/2000/xmlns/'

/**
 * Attributes that the HTML parser puts in a namespace on SVG and MathML elements. They need it to work: `<use>`
 * only follows an `xlink:href` in the XLink namespace.
 */
export const FOREIGN_ATTRIBUTES: ReadonlyMap<string, string> = new Map([
    ['xlink:actuate', XLINK],
    ['xlink:arcrole', XLINK],
    ['xlink:href', XLINK],
    ['xlink:role', XLINK],
    ['xlink:show', XLINK],
    ['xlink:title', XLINK],
    ['xlink:type', XLINK],
    ['xml:lang', XML],
    ['xml:space', XML],
    ['xmlns', XMLNS],
    ['xmlns:xlink', XMLNS]
])

/** Attributes whose value is a URL. */
const URL_ATTRIBUTES = new Set([
    'action',
    'background',
    'cite',
    'codebase',
    'data',
    'formaction',
    'href',
    'icon',
    'longdesc',
    'manifest',
    'poster',
    'src',
    'xlink:href'
])

/** SVG animations, which can set any attribute, a link's `href` included. */
const ANIMATIONS = new Set(['animate', 'animateMotion', 'animateTransform', 'set'])
const ANIMATION_VALUES = new Set(['by', 'from', 'to', 'values'])

/**
 * What the replay sets for a recorded attribute: the value, a replacement, or `null` for no attribute. Recorded
 * pages are untrusted. The sandbox already keeps their scripts from running and the replay's CSP keeps plugins,
 * frames and workers from loading; this leaves out what could still navigate the replay, load documents or the
 * page's own policies, start media or take focus, and handlers and `javascript:` URLs for good measure.
 */
export function sanitize(element: Element, name: string, value: string | null): string | null {
    const tag = element.localName
    const lower = name.toLowerCase()
    if (tag === 'script' && lower === 'type') {
        return INERT_SCRIPT_TYPE
    }
    if (value === null || lower.startsWith('on') || lower === 'autofocus') {
        return null
    }
    if (element.namespaceURI === HTML_NAMESPACE) {
        if (isBlocked(tag, lower, value)) {
            return null
        }
    } else if (ANIMATIONS.has(tag) && ANIMATION_VALUES.has(lower) && compact(value).includes('javascript:')) {
        return null
    }
    return URL_ATTRIBUTES.has(lower) && isJavascriptUrl(value) ? null : value
}

function isBlocked(tag: string, name: string, value: string): boolean {
    switch (tag) {
        // Recorded frames are separate documents, which the recording does not have.
        case 'iframe':
        case 'frame':
            return name === 'src' || name === 'srcdoc'
        case 'object':
            return name === 'data'
        case 'embed':
            return name === 'src'
        // Refreshes, cookies and content security policies, and a referrer policy that could weaken the replay's.
        case 'meta':
            return name === 'http-equiv' || (name === 'name' && value.trim().toLowerCase() === 'referrer')
        case 'audio':
        case 'video':
            return name === 'autoplay'
        default:
            return false
    }
}

/**
 * Whether a URL has the `javascript:` scheme. URL parsing skips leading control characters and spaces, and tabs
 * and newlines anywhere; this skips all of them, which errs on the safe side.
 */
function isJavascriptUrl(value: string): boolean {
    let scheme = ''
    for (let i = 0; i < value.length && scheme.length < 11; i++) {
        const char = value[i]!
        if (char > ' ') {
            scheme += char.toLowerCase()
        }
    }
    return scheme === 'javascript:'
}

/** Lowercase, without control characters and spaces. */
function compact(value: string): string {
    let result = ''
    for (const char of value.toLowerCase()) {
        if (char > ' ') {
            result += char
        }
    }
    return result
}
