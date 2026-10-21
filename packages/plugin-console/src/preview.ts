/** Depth of the objects inside an argument that are shown with their properties. */
const MAX_DEPTH = 3
/** Entries shown of an object, an array, a map or a set. */
const MAX_ENTRIES = 100
const IDENTIFIER = /^[$A-Z_a-z][\w$]*$/u
const ELLIPSIS = '…'

/**
 * The text of a console argument, as a console shows it: strings as they are, other values as a preview that stops
 * at depth 3 and at 100 entries, and marks references to an object it is inside of as `[Circular]`. The text is at
 * most `maxLength` long, plus an ellipsis where it is cut. Reading a property that throws shows the error instead
 * of the value.
 */
export function preview(value: unknown, maxLength: number): string {
    const out = new Output(maxLength)
    if (typeof value === 'string') {
        out.push(value)
    } else {
        write(out, value, 0, new Set())
    }
    return out.finish()
}

/** `Name: message` of an error, or undefined for a value that is not one. */
export function errorHead(value: unknown): string | undefined {
    if (!isError(value)) {
        return undefined
    }
    const name = attempt(() => value.name, 'Error')
    const message = attempt(() => value.message, '')
    return message === '' ? name : `${name}: ${message}`
}

/** The stack of an error, or empty. */
export function errorStack(value: unknown): string {
    return isError(value) ? attempt(() => (typeof value.stack === 'string' ? value.stack : ''), '') : ''
}

class Output {
    text = ''
    readonly #limit: number
    #cut = false

    constructor(limit: number) {
        this.#limit = limit
    }

    /** Whether the text was cut, after which nothing is added. */
    get full(): boolean {
        return this.#cut
    }

    push(text: string): void {
        if (this.#cut) {
            return
        }
        const room = this.#limit - this.text.length
        if (text.length > room) {
            this.text += text.slice(0, room)
            this.#cut = true
        } else {
            this.text += text
        }
    }

    finish(): string {
        return this.#cut ? this.text + ELLIPSIS : this.text
    }
}

function write(out: Output, value: unknown, depth: number, seen: Set<object>): void {
    if (out.full) {
        return
    }
    switch (typeof value) {
        case 'string':
            out.push(depth === 0 ? value : JSON.stringify(value.length > 1000 ? value.slice(0, 1000) : value))
            return
        case 'number':
            out.push(Object.is(value, -0) ? '-0' : String(value))
            return
        case 'bigint':
            out.push(`${value}n`)
            return
        case 'symbol':
            out.push(value.toString())
            return
        case 'function':
            out.push(`ƒ ${attempt(() => value.name, '') || 'anonymous'}()`)
            return
        case 'object':
            if (value !== null) {
                writeObject(out, value, depth, seen)
                return
            }
    }
    out.push(String(value))
}

function writeObject(out: Output, value: object, depth: number, seen: Set<object>): void {
    if (seen.has(value)) {
        out.push('[Circular]')
        return
    }
    const head = errorHead(value)
    if (head !== undefined) {
        out.push(head)
        return
    }
    if (isNode(value)) {
        out.push(describeNode(value))
        return
    }
    const tag = attempt(() => Object.prototype.toString.call(value).slice(8, -1), '')
    if (isDate(value, tag)) {
        const time = value.getTime()
        out.push(Number.isNaN(time) ? 'Invalid Date' : value.toISOString())
        return
    }
    if (isRegExp(value, tag)) {
        out.push(value.toString())
        return
    }
    const name = constructorName(value)
    if (depth >= MAX_DEPTH) {
        out.push(Array.isArray(value) ? '[Array]' : `[${name || 'Object'}]`)
        return
    }
    seen.add(value)
    try {
        if (isList(value, tag)) {
            const length = value.length
            out.push(Array.isArray(value) ? '[' : `${name}(${length}) [`)
            writeEntries(out, length, i => write(out, value[i], depth + 1, seen))
            out.push(']')
        } else if (value instanceof Map) {
            const entries = [...value]
            out.push(`Map(${entries.length}) {`)
            writeEntries(out, entries.length, i => {
                const [key, item] = entries[i]!
                write(out, key, depth + 1, seen)
                out.push(' => ')
                write(out, item, depth + 1, seen)
            })
            out.push('}')
        } else if (value instanceof Set) {
            const items = [...value]
            out.push(`Set(${items.length}) {`)
            writeEntries(out, items.length, i => write(out, items[i], depth + 1, seen))
            out.push('}')
        } else {
            const keys = Object.keys(value)
            out.push(name === 'Object' ? '{' : `${name || 'Object'} {`)
            writeEntries(out, keys.length, i => {
                const key = keys[i]!
                out.push(IDENTIFIER.test(key) ? key : JSON.stringify(key))
                out.push(': ')
                let item: unknown
                try {
                    item = Reflect.get(value, key)
                } catch (error) {
                    out.push(`[Thrown: ${errorHead(error) ?? safe(() => String(error))}]`)
                    return
                }
                write(out, item, depth + 1, seen)
            })
            out.push('}')
        }
    } catch (error) {
        out.push(`[Thrown: ${errorHead(error) ?? safe(() => String(error))}]`)
    } finally {
        seen.delete(value)
    }
}

function writeEntries(out: Output, count: number, entry: (index: number) => void): void {
    const shown = Math.min(count, MAX_ENTRIES)
    for (let i = 0; i < shown && !out.full; i++) {
        if (i > 0) {
            out.push(', ')
        }
        entry(i)
    }
    if (count > shown) {
        out.push(`, … ${count - shown} more`)
    }
}

function constructorName(value: object): string {
    return attempt(() => {
        const prototype: unknown = Object.getPrototypeOf(value)
        if (prototype === null) {
            return 'Object'
        }
        const constructor: unknown = typeof prototype === 'object' ? Reflect.get(prototype, 'constructor') : undefined
        return typeof constructor === 'function' ? constructor.name : ''
    }, '')
}

/** Works for errors of any realm, which `instanceof` does not. */
function isError(value: unknown): value is Error {
    if (typeof value !== 'object' || value === null) {
        return false
    }
    const tag = attempt(() => Object.prototype.toString.call(value), '')
    return tag === '[object Error]' || tag === '[object DOMException]'
}

function isNode(value: object): value is Node {
    return attempt(
        () =>
            'nodeType' in value &&
            typeof value.nodeType === 'number' &&
            'nodeName' in value &&
            typeof value.nodeName === 'string',
        false
    )
}

function isElement(node: Node): node is Element {
    return node.nodeType === 1
}

function isCharacterData(node: Node): node is CharacterData {
    return node.nodeType === 3 || node.nodeType === 8
}

function isDate(value: object, tag: string): value is Date {
    return tag === 'Date'
}

function isRegExp(value: object, tag: string): value is RegExp {
    return tag === 'RegExp'
}

/** Arrays and typed arrays. */
function isList(value: object, tag: string): value is ArrayLike<unknown> {
    return Array.isArray(value) || (ArrayBuffer.isView(value) && tag !== 'DataView')
}

/** A node in a line, such as `<div id="a" class="b">` or `#text "hi"`. */
function describeNode(node: Node): string {
    return safe(() => {
        if (isElement(node)) {
            let text = `<${node.localName}`
            for (const name of ['id', 'class']) {
                const attribute = node.getAttribute(name)
                if (attribute !== null) {
                    text += ` ${name}=${JSON.stringify(attribute)}`
                }
            }
            return `${text}>`
        }
        if (isCharacterData(node)) {
            const data = node.data
            return `${node.nodeName} ${JSON.stringify(data.length > 100 ? data.slice(0, 100) + ELLIPSIS : data)}`
        }
        return node.nodeName
    })
}

/** What `read` returns, or `fallback` when it throws: a value can throw from anywhere, as a proxy can. */
function attempt<T>(read: () => T, fallback: T): T {
    try {
        return read()
    } catch {
        return fallback
    }
}

/** What `read` returns, or a note that it threw. */
function safe(read: () => string): string {
    return attempt(read, '[Thrown]')
}
