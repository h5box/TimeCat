import * as fc from 'fast-check'
import {
    isCharacterData,
    isDocument,
    isElement,
    isFrame,
    isInput,
    isSelect,
    isShadowRoot,
    isStyle,
    isTextArea
} from './describe.ts'

type NewNode = { tag: string; text: string | null } | { text: string } | { comment: string }

/**
 * A change a page makes to its body, and to the shadow trees and the documents of frames in it. Targets are
 * numbers that pick among the nodes there at the time.
 */
export type PageOperation =
    | { kind: 'insert'; parent: number; before: number; node: NewNode }
    | { kind: 'move'; target: number; parent: number; before: number }
    | { kind: 'remove'; target: number }
    | { kind: 'attribute'; target: number; name: string; value: string | null }
    | { kind: 'text'; target: number; data: string }
    | { kind: 'html'; target: number; html: string }
    /** Sets the value of a text control, toggles a checkbox or radio button, or picks an option. */
    | { kind: 'value'; target: number; value: string; event: boolean }
    | { kind: 'shadow'; target: number; closed: boolean; html: string }
    /** Inserts a frame and fills the body of its blank document. */
    | { kind: 'frame'; parent: number; before: number; html: string }
    /** Inserts a rule into the sheet of a `<style>` or one adopted somewhere, or deletes one from it. */
    | { kind: 'rule'; target: number; index: number; rule: string | null }
    /** Makes a sheet and adds it to those a document or shadow root adopts, or lets them adopt that one alone. */
    | { kind: 'adopt'; target: number; rules: string; alone: boolean }

const text = fc.string({ maxLength: 4 })
const NOT_BLANK = /\S/u

const rule = fc.constantFrom('p { color: red; }', 'div { margin: 1px; }', '@media screen {\n  b { color: blue; }\n}')

const newNode: fc.Arbitrary<NewNode> = fc.oneof(
    {
        weight: 3,
        arbitrary: fc.record({
            tag: fc.constantFrom('div', 'span', 'p', 'b', 'input', 'textarea', 'style'),
            text: fc.option(text)
        })
    },
    { weight: 1, arbitrary: fc.record({ text }) },
    { weight: 1, arbitrary: fc.record({ comment: fc.stringMatching(/^[a-z ]{0,4}$/u) }) }
)

export const pageOperation: fc.Arbitrary<PageOperation> = fc.oneof(
    {
        weight: 4,
        arbitrary: fc.record({ kind: fc.constant('insert'), parent: fc.nat(), before: fc.nat(), node: newNode })
    },
    {
        weight: 2,
        arbitrary: fc.record({ kind: fc.constant('move'), target: fc.nat(), parent: fc.nat(), before: fc.nat() })
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove'), target: fc.nat() }) },
    {
        weight: 2,
        arbitrary: fc.record({
            kind: fc.constant('attribute'),
            target: fc.nat(),
            name: fc.constantFrom('class', 'title', 'data-x', 'hidden', 'value', 'checked', 'selected', 'type'),
            value: fc.option(text)
        })
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('text'), target: fc.nat(), data: text }) },
    {
        weight: 1,
        arbitrary: fc.record({
            kind: fc.constant('html'),
            target: fc.nat(),
            html: fc.constantFrom(
                '',
                'x',
                '<b>bold</b> text',
                '<span title="t">s</span><!--c-->',
                '<input value="v"><textarea>t</textarea>',
                '<input type="checkbox" checked><select><option>a</option><option selected>b</option></select>',
                '<select multiple><option selected>a</option><option>b</option><optgroup><option>c</option></optgroup></select>',
                '<p>a</p><p>b</p>'
            )
        })
    },
    {
        weight: 1,
        arbitrary: fc.record({ kind: fc.constant('value'), target: fc.nat(), value: text, event: fc.boolean() })
    },
    {
        weight: 1,
        arbitrary: fc.record({
            kind: fc.constant('shadow'),
            target: fc.nat(),
            closed: fc.boolean(),
            html: fc.constantFrom('', 'shadow', '<b>in</b><slot></slot>', '<style>b { color: red; }</style><p>s</p>')
        })
    },
    {
        weight: 1,
        arbitrary: fc.record({
            kind: fc.constant('frame'),
            parent: fc.nat(),
            before: fc.nat(),
            html: fc.constantFrom('', 'frame', '<p>in a frame</p><input value="v">', '<style>p { margin: 0; }</style>')
        })
    },
    {
        weight: 2,
        arbitrary: fc.record({ kind: fc.constant('rule'), target: fc.nat(), index: fc.nat(), rule: fc.option(rule) })
    },
    {
        weight: 1,
        arbitrary: fc.record({ kind: fc.constant('adopt'), target: fc.nat(), rules: rule, alone: fc.boolean() })
    }
)

/** What the page's code would know, and what the recorder sees of it. */
export interface PageContext {
    /** Where closed shadow roots go once attached. Without it, they are attached open: nothing finds them else. */
    closedRoots?: Map<Element, ShadowRoot>
    /**
     * Windows whose realms the recorder hooks. Shadow roots are attached closed, and the sheets of `<style>`
     * elements with text change, only through the methods of those realms: the recorder misses it elsewhere. A
     * node keeps the methods of the realm it was made in when it moves to another document.
     */
    realms?: ReadonlySet<Window & typeof globalThis>
}

/** Whether `object` is of the interface `name` of one of `realms`. */
function isFrom(
    object: object,
    name: 'CSSStyleSheet' | 'Element',
    realms: ReadonlySet<Window & typeof globalThis> = new Set()
): boolean {
    for (const realm of realms) {
        if (object instanceof realm[name]) {
            return true
        }
    }
    return false
}

/**
 * Applies an operation to the body of `document`, or nothing when it does not fit the page as it is: what the DOM
 * refuses is left out.
 */
export function applyOperation(document: Document, operation: PageOperation, context: PageContext = {}): void {
    try {
        apply(document, operation, context)
    } catch (error) {
        // From the realm of the page or of one of its frames.
        if (Object.prototype.toString.call(error) !== '[object DOMException]') {
            throw error
        }
    }
}

/** The documents of the frames in `document`, at any depth and in shadow trees too. */
export function frameDocuments(document: Document, closedRoots?: Map<Element, ShadowRoot>): Document[] {
    const body = document.body
    return body === null
        ? []
        : subtree(document, body, closedRoots).roots.filter(
              (root): root is Document => isDocument(root) && root !== document
          )
}

function apply(document: Document, operation: PageOperation, { closedRoots, realms }: PageContext): void {
    const body = document.body
    if (body === null) {
        return
    }
    const { nodes, roots } = subtree(document, body, closedRoots)
    const elements = nodes.filter(isElement)
    switch (operation.kind) {
        case 'insert': {
            const parent = pick(elements, operation.parent)!
            parent.insertBefore(create(parent.ownerDocument, operation.node), childAt(parent, operation.before))
            break
        }
        case 'move': {
            const target = pick(nodes, operation.target)!
            const parent = pick(elements, operation.parent)!
            if (target !== body) {
                parent.insertBefore(target, childAt(parent, operation.before))
            }
            break
        }
        case 'remove': {
            const target = pick(nodes, operation.target)!
            if (target !== body) {
                target.parentNode?.removeChild(target)
            }
            break
        }
        case 'attribute': {
            const element = pick(elements, operation.target)!
            if (operation.value === null) {
                element.removeAttribute(operation.name)
            } else {
                element.setAttribute(operation.name, operation.value)
            }
            break
        }
        case 'text': {
            const node = pick(nodes.filter(isCharacterData), operation.target)
            if (node !== undefined) {
                node.data = operation.data
            }
            break
        }
        case 'html': {
            pick(elements, operation.target)!.innerHTML = operation.html
            break
        }
        case 'value': {
            const control = pick(
                elements.filter(element => isInput(element) || isTextArea(element) || isSelect(element)),
                operation.target
            )
            if (control === undefined) {
                break
            }
            if (isSelect(control)) {
                control.selectedIndex = (operation.value.length % (control.options.length + 1)) - 1
            } else if (isInput(control) && (control.type === 'checkbox' || control.type === 'radio')) {
                control.checked = !control.checked
            } else if (isInput(control) || isTextArea(control)) {
                control.value = operation.value
            }
            if (operation.event) {
                control.dispatchEvent(new Event('input', { bubbles: true }))
            }
            break
        }
        case 'shadow': {
            const host = pick(elements, operation.target)!
            const closed = operation.closed && closedRoots !== undefined && isFrom(host, 'Element', realms)
            const root = host.attachShadow({ mode: closed ? 'closed' : 'open' })
            if (closed) {
                closedRoots.set(host, root)
            }
            root.innerHTML = operation.html
            break
        }
        case 'frame': {
            const parent = pick(elements, operation.parent)!
            const frame = parent.ownerDocument.createElement('iframe')
            parent.insertBefore(frame, childAt(parent, operation.before))
            const content = frame.contentDocument
            if (content?.body != null) {
                content.body.innerHTML = operation.html
            }
            break
        }
        case 'rule': {
            const sheets = [
                ...elements.flatMap(element =>
                    isStyle(element) &&
                    element.sheet !== null &&
                    (isFrom(element.sheet, 'CSSStyleSheet', realms) || !NOT_BLANK.test(element.textContent))
                        ? [element.sheet]
                        : []
                ),
                ...roots.flatMap(root => root.adoptedStyleSheets)
            ]
            const sheet = pick(sheets, operation.target)
            if (sheet === undefined) {
                break
            }
            const rules = sheet.cssRules.length
            if (operation.rule === null) {
                sheet.deleteRule(operation.index % Math.max(rules, 1))
            } else {
                sheet.insertRule(operation.rule, operation.index % (rules + 1))
            }
            break
        }
        case 'adopt': {
            const root = pick(roots, operation.target)!
            const view = (isDocument(root) ? root : root.ownerDocument).defaultView
            if (view === null) {
                break
            }
            // A root adopts only the sheets of its own window.
            const sheet = new view.CSSStyleSheet()
            sheet.replaceSync(operation.rules)
            root.adoptedStyleSheets = operation.alone ? [sheet] : [...root.adoptedStyleSheets, sheet]
            break
        }
    }
}

function pick<T>(list: readonly T[], n: number): T | undefined {
    return list[n % list.length]
}

/**
 * `body` and the nodes below it in tree order, those of shadow trees and of the documents of frames included, and
 * the documents and shadow roots they are in. Those go to `roots` alone: they are not where nodes go.
 */
function subtree(
    document: Document,
    body: HTMLElement,
    closedRoots?: Map<Element, ShadowRoot>
): { nodes: Node[]; roots: (Document | ShadowRoot)[] } {
    const nodes: Node[] = []
    const roots: (Document | ShadowRoot)[] = [document]
    const visit = (node: Node): void => {
        if (isDocument(node) || isShadowRoot(node)) {
            roots.push(node)
        } else {
            nodes.push(node)
        }
        if (isElement(node)) {
            const shadow = node.shadowRoot ?? closedRoots?.get(node) ?? null
            if (shadow !== null) {
                visit(shadow)
            }
            const content = isFrame(node) ? node.contentDocument : null
            if (content !== null) {
                visit(content)
            }
        }
        for (const child of node.childNodes) {
            visit(child)
        }
    }
    visit(body)
    return { nodes, roots }
}

function childAt(parent: Node, n: number): Node | null {
    return parent.childNodes[n % (parent.childNodes.length + 1)] ?? null
}

function create(document: Document, spec: NewNode): Node {
    if ('comment' in spec) {
        return document.createComment(spec.comment)
    }
    if (!('tag' in spec)) {
        return document.createTextNode(spec.text)
    }
    const element = document.createElement(spec.tag)
    if (spec.text !== null) {
        element.append(spec.text)
    }
    return element
}
