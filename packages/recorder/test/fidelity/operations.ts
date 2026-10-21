import * as fc from 'fast-check'
import { isCharacterData, isElement, isInput, isSelect, isTextArea } from './describe.ts'

type NewNode = { tag: string; text: string | null } | { text: string } | { comment: string }

/** A change a page makes to its body. Targets are numbers that pick among the nodes there at the time. */
export type PageOperation =
    | { kind: 'insert'; parent: number; before: number; node: NewNode }
    | { kind: 'move'; target: number; parent: number; before: number }
    | { kind: 'remove'; target: number }
    | { kind: 'attribute'; target: number; name: string; value: string | null }
    | { kind: 'text'; target: number; data: string }
    | { kind: 'html'; target: number; html: string }
    /** Sets the value of a text control, toggles a checkbox or radio button, or picks an option. */
    | { kind: 'value'; target: number; value: string; event: boolean }

const text = fc.string({ maxLength: 4 })

const newNode: fc.Arbitrary<NewNode> = fc.oneof(
    {
        weight: 3,
        arbitrary: fc.record({
            tag: fc.constantFrom('div', 'span', 'p', 'b', 'input', 'textarea'),
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
            name: fc.constantFrom('class', 'title', 'data-x', 'hidden', 'value', 'checked', 'selected'),
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
    }
)

/** Applies an operation to the body of `document`, or nothing when it does not fit the page as it is. */
export function applyOperation(document: Document, operation: PageOperation): void {
    const body = document.body
    if (body === null) {
        return
    }
    const nodes = subtree(body)
    const elements = nodes.filter(isElement)
    switch (operation.kind) {
        case 'insert': {
            const parent = pick(elements, operation.parent)!
            parent.insertBefore(create(document, operation.node), childAt(parent, operation.before))
            break
        }
        case 'move': {
            const target = pick(nodes, operation.target)!
            const parent = pick(elements, operation.parent)!
            if (target !== body && !target.contains(parent)) {
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
    }
}

function pick<T>(list: readonly T[], n: number): T | undefined {
    return list[n % list.length]
}

/** `root` and the nodes below it, in tree order. */
function subtree(root: Node): Node[] {
    const nodes: Node[] = []
    const visit = (node: Node): void => {
        nodes.push(node)
        for (const child of node.childNodes) {
            visit(child)
        }
    }
    visit(root)
    return nodes
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
