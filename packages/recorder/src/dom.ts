// Node checks that work across realms: the recorded document can belong to another window (a same-origin
// iframe), where `instanceof HTMLInputElement` of the recorder's own window would be false.

export const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4
const COMMENT_NODE = 8
const DOCUMENT_NODE = 9
const DOCUMENT_TYPE_NODE = 10

export type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

export function isNode(target: EventTarget | null): target is Node {
    return target !== null && 'nodeType' in target
}

export function isElement(node: Node): node is Element {
    return node.nodeType === ELEMENT_NODE
}

/** Text and CDATA sections; the latter only occur in foreign content and are recorded as text. */
export function isText(node: Node): node is Text {
    return node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE
}

export function isComment(node: Node): node is Comment {
    return node.nodeType === COMMENT_NODE
}

export function isDocument(node: Node): node is Document {
    return node.nodeType === DOCUMENT_NODE
}

export function isDoctype(node: Node): node is DocumentType {
    return node.nodeType === DOCUMENT_TYPE_NODE
}

/** Whether the recorder writes this kind of node at all. Processing instructions are left out. */
export function isRecordable(node: Node): boolean {
    const type = node.nodeType
    return (
        type === ELEMENT_NODE ||
        type === TEXT_NODE ||
        type === COMMENT_NODE ||
        type === CDATA_SECTION_NODE ||
        type === DOCUMENT_TYPE_NODE
    )
}

function isHtml(node: Node, localName: string): boolean {
    return isElement(node) && node.localName === localName && node.namespaceURI === HTML_NAMESPACE
}

export function isInput(node: Node): node is HTMLInputElement {
    return isHtml(node, 'input')
}

export function isTextArea(node: Node): node is HTMLTextAreaElement {
    return isHtml(node, 'textarea')
}

export function isSelect(node: Node): node is HTMLSelectElement {
    return isHtml(node, 'select')
}

export function isOption(node: Node): node is HTMLOptionElement {
    return isHtml(node, 'option')
}

export function isOptGroup(node: Node): node is HTMLOptGroupElement {
    return isHtml(node, 'optgroup')
}

export function isFormControl(node: Node): node is FormControl {
    return isInput(node) || isTextArea(node) || isSelect(node)
}

export function isForm(node: Node): node is HTMLFormElement {
    return isHtml(node, 'form')
}

/** Checkboxes and radio buttons, whose state is `checked` rather than a value. */
export function isCheckable(control: FormControl): control is HTMLInputElement {
    return isInput(control) && (control.type === 'checkbox' || control.type === 'radio')
}

export function isPointerEvent(event: Event): event is PointerEvent {
    return 'pointerId' in event
}

/** Script source and `<noscript>` fallback markup are never recorded, only the elements themselves. */
export function recordsChildren(element: Element): boolean {
    const name = element.localName
    return name !== 'script' && !(name === 'noscript' && element.namespaceURI === HTML_NAMESPACE)
}

/** Text in `<style>` is CSS, which masking would break. */
export function isStyle(element: Element): boolean {
    return element.localName === 'style'
}
