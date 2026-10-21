// Node checks that work across realms: the replay is built in the document of an iframe, whose nodes are not
// instances of this window's `Element` or `HTMLInputElement`.

export const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const COMMENT_NODE = 8
const DOCUMENT_NODE = 9
const DOCUMENT_TYPE_NODE = 10
const DOCUMENT_FRAGMENT_NODE = 11

export function isElement(node: Node): node is Element {
    return node.nodeType === ELEMENT_NODE
}

export function isDocument(node: Node): node is Document {
    return node.nodeType === DOCUMENT_NODE
}

export function isShadowRoot(node: Node): node is ShadowRoot {
    return node.nodeType === DOCUMENT_FRAGMENT_NODE && 'host' in node
}

export function isText(node: Node): node is Text {
    return node.nodeType === TEXT_NODE
}

export function isComment(node: Node): node is Comment {
    return node.nodeType === COMMENT_NODE
}

export function isDoctype(node: Node): node is DocumentType {
    return node.nodeType === DOCUMENT_TYPE_NODE
}

/** Text and comments, the nodes with data. */
export function isCharacterData(node: Node): node is CharacterData {
    return node.nodeType === TEXT_NODE || node.nodeType === COMMENT_NODE
}

export function isHtml(element: Element, localName: string): boolean {
    return element.localName === localName && element.namespaceURI === HTML_NAMESPACE
}

export function isInput(element: Element): element is HTMLInputElement {
    return isHtml(element, 'input')
}

export function isTextArea(element: Element): element is HTMLTextAreaElement {
    return isHtml(element, 'textarea')
}

export function isSelect(element: Element): element is HTMLSelectElement {
    return isHtml(element, 'select')
}

/** HTML and SVG scripts. */
export function isScript(element: Element): boolean {
    return element.localName === 'script'
}

/** `<iframe>` and `<frame>`, which show a document of their own. */
export function isFrame(element: Element): element is HTMLIFrameElement | HTMLFrameElement {
    return isHtml(element, 'iframe') || isHtml(element, 'frame')
}

/** `<style>`, in HTML or SVG: its text is CSS. */
export function isStyle(element: Element): element is HTMLStyleElement | SVGStyleElement {
    return (
        element.localName === 'style' &&
        (element.namespaceURI === HTML_NAMESPACE || element.namespaceURI === SVG_NAMESPACE)
    )
}
