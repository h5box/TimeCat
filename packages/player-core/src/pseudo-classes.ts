import { stateAttribute, STATES } from './states.ts'
import type { State } from './states.ts'

/** Most CSS has none of the states, which this finds without looking at the text closely. */
const ANY_STATE = /:(?:focus|hover|active)/i

/** Pseudo-elements that also go by one colon. */
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter'])

/** Texts rewritten lately, which each build rewrites again. */
const CACHED = 128

/**
 * Rewrites the selectors of style sheets for the states the replay shows: `:hover` becomes
 * `[data-timecat-hover]`, which the player sets on the elements the recorded pointer is over, and so on.
 * Selectors after a pseudo-element, as in `::part(label):hover`, cannot take attributes and stay as they are.
 */
export class PseudoClasses {
    /** The states some rewritten rule depends on, which no others need to be shown. */
    readonly used: Set<State> = new Set()
    readonly #cache = new Map<string, string>()

    /** `text`, a style sheet or a rule, with the states in its selectors rewritten. */
    rewrite(text: string): string {
        if (!ANY_STATE.test(text)) {
            return text
        }
        const cache = this.#cache
        let rewritten = cache.get(text)
        if (rewritten === undefined) {
            rewritten = rewriteSheet(text, this.used)
            if (cache.size >= CACHED) {
                cache.delete(cache.keys().next().value!)
            }
            cache.set(text, rewritten)
        }
        return rewritten
    }
}

/** Rewrites the preludes of the style rules of `text`, those before a `{` that do not start an at-rule. */
function rewriteSheet(text: string, used: Set<State>): string {
    let result = ''
    let copied = 0
    let start = 0
    for (let i = 0; i < text.length;) {
        const c = text[i]
        if (c === '/' && text[i + 1] === '*') {
            i = skipComment(text, i)
        } else if (c === '"' || c === "'") {
            i = skipString(text, i)
        } else if (c === '\\') {
            i += 2
        } else if ((c === 'u' || c === 'U') && text.slice(i, i + 4).toLowerCase() === 'url(') {
            i = skipUrl(text, i + 4)
        } else {
            if (c === '{') {
                const prelude = text.slice(start, i)
                if (ANY_STATE.test(prelude) && !isAtRule(prelude)) {
                    const rewritten = rewriteSelector(prelude, used)
                    if (rewritten !== prelude) {
                        result += text.slice(copied, start) + rewritten
                        copied = i
                    }
                }
                start = i + 1
            } else if (c === '}' || c === ';') {
                start = i + 1
            }
            i++
        }
    }
    return copied === 0 ? text : result + text.slice(copied)
}

function isAtRule(prelude: string): boolean {
    return prelude
        .replaceAll(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
        .trimStart()
        .startsWith('@')
}

function rewriteSelector(selector: string, used: Set<State>): string {
    let result = ''
    let copied = 0
    // Whether the compound selector so far, at each depth of parentheses, has a pseudo-element.
    const pseudoElement = [false]
    for (let i = 0; i < selector.length; i++) {
        const c = selector[i]!
        const depth = pseudoElement.length - 1
        if (c === '\\') {
            i++
        } else if (c === '/' && selector[i + 1] === '*') {
            i = skipComment(selector, i) - 1
        } else if (c === '"' || c === "'") {
            i = skipString(selector, i) - 1
        } else if (c === '[') {
            i = skipAttribute(selector, i) - 1
        } else if (c === '(') {
            pseudoElement.push(false)
        } else if (c === ')') {
            if (depth > 0) {
                pseudoElement.pop()
            }
        } else if (c === ':') {
            if (selector[i + 1] === ':') {
                pseudoElement[depth] = true
                i++
                continue
            }
            let end = i + 1
            while (end < selector.length && /[\w-]/.test(selector[end]!)) {
                end++
            }
            const name = selector.slice(i + 1, end).toLowerCase()
            if (LEGACY_PSEUDO_ELEMENTS.has(name)) {
                pseudoElement[depth] = true
            } else if (isState(name) && selector[end] !== '(' && !pseudoElement[depth]) {
                result += `${selector.slice(copied, i)}[${stateAttribute(name)}]`
                copied = end
                used.add(name)
            }
            i = end - 1
        } else if (/[\s>+~,]/.test(c)) {
            // A combinator: the next compound selector starts.
            pseudoElement[depth] = false
        }
    }
    return copied === 0 ? selector : result + selector.slice(copied)
}

function isState(name: string): name is State {
    return (STATES as readonly string[]).includes(name)
}

/** The index after the comment at `i`. */
function skipComment(text: string, i: number): number {
    const end = text.indexOf('*/', i + 2)
    return end === -1 ? text.length : end + 2
}

/** The index after the string whose quote is at `i`. A newline ends one left open. */
function skipString(text: string, i: number): number {
    const quote = text[i]
    for (let j = i + 1; j < text.length; j++) {
        const c = text[j]
        if (c === '\\') {
            j++
        } else if (c === quote || c === '\n') {
            return j + 1
        }
    }
    return text.length
}

/** The index after the attribute selector whose `[` is at `i`. */
function skipAttribute(text: string, i: number): number {
    for (let j = i + 1; j < text.length; j++) {
        const c = text[j]
        if (c === '\\') {
            j++
        } else if (c === '"' || c === "'") {
            j = skipString(text, j) - 1
        } else if (c === ']') {
            return j + 1
        }
    }
    return text.length
}

/** The index after the URL that starts at `i`, after `url(`. */
function skipUrl(text: string, i: number): number {
    for (let j = i; j < text.length; j++) {
        const c = text[j]
        if (c === '\\') {
            j++
        } else if (c === '"' || c === "'") {
            j = skipString(text, j) - 1
        } else if (c === ')') {
            return j + 1
        }
    }
    return text.length
}
