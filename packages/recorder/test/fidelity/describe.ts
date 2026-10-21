// What a replay has to reproduce of a page, as text, so that the recorded page and its replay compare line by
// line: the tree with every attribute, the state of form controls, scroll offsets, the viewport, the base URL and
// the rendering mode. Nodes are checked by type, across realms: both documents live in frames.

/** Elements the player adds to the replayed document. */
const PLAYER_ATTRIBUTE = 'data-timecat-player'
const HTML = 'http://www.w3.org/1999/xhtml'
const SVG = 'http://www.w3.org/2000/svg'
const MATHML = 'http://www.w3.org/1998/Math/MathML'

export function describePage(document: Document): string {
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
                lines.push(`${indent}#document`)
                break
            case 1:
                if (!isElement(node) || node.hasAttribute(PLAYER_ATTRIBUTE)) {
                    return
                }
                lines.push(`${indent}${describeElement(node)}`)
                break
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

function describeElement(element: Element): string {
    const namespace = element.namespaceURI
    const prefix =
        namespace === HTML ? '' : namespace === SVG ? 'svg:' : namespace === MATHML ? 'math:' : `{${namespace}}`
    const attributes = [...element.attributes]
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
