// What a replay has to reproduce of a page, as text, so that the recorded page and its replay compare line by
// line: the tree with every attribute, shadow trees and the documents of frames included, the state of form
// controls, the rules of style sheets, scroll offsets, the viewport, the base URLs and the rendering modes. Nodes
// are checked by type, across realms: both documents live in frames.

/** Elements the player adds to the replayed document. */
const PLAYER_ATTRIBUTE = 'data-timecat-player'
const HTML = 'http://www.w3.org/1999/xhtml'
const SVG = 'http://www.w3.org/2000/svg'
const MATHML = 'http://www.w3.org/1998/Math/MathML'
/**
 * Attributes the player leaves out of frames, which would load a document, or keep the player out of the one it
 * builds from the recording. That document is compared instead.
 */
const FRAME_SOURCES = new Set(['src', 'srcdoc', 'sandbox', 'csp'])

/** The shadow root of a host, closed ones included, which `shadowRoot` leaves out. */
export type ShadowRootOf = (host: Element) => ShadowRoot | null

export function describePage(document: Document, shadowRootOf: ShadowRootOf = openShadowRoot): string {
    const view = document.defaultView
    const lines = [
        `${document.compatMode} ${document.baseURI}`,
        `viewport ${view?.innerWidth}x${view?.innerHeight}, scrolled ${offset(view?.scrollX, view?.scrollY)}`
    ]
    const visit = (node: Node, depth: number): void => {
        const indent = '  '.repeat(depth)
        switch (node.nodeType) {
            case 3:
            case 4:
                lines.push(`${indent}${JSON.stringify(isCharacterData(node) ? node.data : '')}`)
                return
            case 8:
                lines.push(`${indent}<!--${isCharacterData(node) ? node.data : ''}-->`)
                return
            case 10:
                lines.push(
                    `${indent}${isDoctype(node) ? `<!DOCTYPE ${node.name} "${node.publicId}" "${node.systemId}">` : ''}`
                )
                return
            case 9:
                // The page's mode and base URL are on the first line; those of frames' documents go here.
                lines.push(
                    `${indent}#document${node === document || !isDocument(node) ? '' : ` ${node.compatMode} ${node.baseURI}`}`
                )
                lines.push(...adopted(node, indent))
                break
            case 11:
                lines.push(`${indent}#shadow-root`, ...adopted(node, indent))
                break
            case 1: {
                if (!isElement(node) || node.hasAttribute(PLAYER_ATTRIBUTE)) {
                    return
                }
                lines.push(`${indent}${describeElement(node)}`)
                const sheet = isStyle(node) ? node.sheet : null
                if (sheet !== null) {
                    lines.push(`${indent}  @rules ${JSON.stringify(rulesOf(sheet))}`)
                }
                const shadow = shadowRootOf(node)
                if (shadow !== null) {
                    visit(shadow, depth + 1)
                }
                const content = isFrame(node) ? node.contentDocument : null
                if (content !== null) {
                    visit(content, depth + 1)
                }
                break
            }
            default:
                lines.push(`${indent}#node ${node.nodeType}`)
                return
        }
        for (const child of node.childNodes) {
            visit(child, depth + 1)
        }
    }
    visit(document, 0)
    return lines.join('\n')
}

function openShadowRoot(host: Element): ShadowRoot | null {
    return host.shadowRoot
}

/** The rules of the sheets a document or shadow root adopts, as a line, if any. */
function adopted(root: Node, indent: string): string[] {
    const sheets = isDocument(root) || isShadowRoot(root) ? root.adoptedStyleSheets : []
    return sheets.length === 0 ? [] : [`${indent}  @adopted ${JSON.stringify(sheets.map(rulesOf))}`]
}

function rulesOf(sheet: CSSStyleSheet): string[] {
    return [...sheet.cssRules].map(rule => rule.cssText)
}

function describeElement(element: Element): string {
    const namespace = element.namespaceURI
    const prefix =
        namespace === HTML ? '' : namespace === SVG ? 'svg:' : namespace === MATHML ? 'math:' : `{${namespace}}`
    const attributes = [...element.attributes]
        .filter(({ name }) => !(isFrame(element) && FRAME_SOURCES.has(name)))
        .map(
            ({ name, namespaceURI, value }) =>
                `${name}${namespaceURI === null ? '' : `{${namespaceURI}}`}=${JSON.stringify(value)}`
        )
        .toSorted()
    let state = ''
    if (isInput(element)) {
        state =
            element.type === 'checkbox' || element.type === 'radio'
                ? ` (checked: ${element.checked})`
                : ` (value: ${JSON.stringify(element.value)})`
    } else if (isTextArea(element)) {
        state = ` (value: ${JSON.stringify(element.value)})`
    } else if (isSelect(element)) {
        const selected = [...element.options].flatMap((option, i) => (option.selected ? [i] : []))
        state = ` (selected: ${selected.join(',')})`
    }
    if (element.scrollLeft !== 0 || element.scrollTop !== 0) {
        state += ` (scrolled: ${offset(element.scrollLeft, element.scrollTop)})`
    }
    return `<${prefix}${element.localName}${attributes.map(attribute => ` ${attribute}`).join('')}>${state}`
}

function offset(x: number | undefined, y: number | undefined): string {
    return `${Math.round(x ?? 0)},${Math.round(y ?? 0)}`
}

export function isElement(node: Node): node is Element {
    return node.nodeType === 1
}

export function isCharacterData(node: Node): node is CharacterData {
    return node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8
}

function isDoctype(node: Node): node is DocumentType {
    return node.nodeType === 10
}

export function isDocument(node: Node): node is Document {
    return node.nodeType === 9
}

export function isShadowRoot(node: Node): node is ShadowRoot {
    return node.nodeType === 11 && 'host' in node
}

function isHtml(element: Element, localName: string): boolean {
    return element.localName === localName && element.namespaceURI === HTML
}

export function isInput(node: Node): node is HTMLInputElement {
    return isElement(node) && isHtml(node, 'input')
}

export function isTextArea(node: Node): node is HTMLTextAreaElement {
    return isElement(node) && isHtml(node, 'textarea')
}

export function isSelect(node: Node): node is HTMLSelectElement {
    return isElement(node) && isHtml(node, 'select')
}

export function isForm(node: Node): node is HTMLFormElement {
    return isElement(node) && isHtml(node, 'form')
}

export function isFrame(node: Node): node is HTMLIFrameElement | HTMLFrameElement {
    return isElement(node) && (isHtml(node, 'iframe') || isHtml(node, 'frame'))
}

export function isStyle(node: Node): node is HTMLStyleElement | SVGStyleElement {
    return isElement(node) && node.localName === 'style' && (node.namespaceURI === HTML || node.namespaceURI === SVG)
}
