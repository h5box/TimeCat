import { isInput, isStyle, isTextArea } from './dom.ts'
import type { FormControl } from './dom.ts'

export interface PrivacyOptions {
    /** CSS selector of elements whose text, including their descendants' text, is recorded as asterisks. */
    maskText?: string | undefined
    /** CSS selector of elements recorded as empty placeholders of the same size. */
    block?: string | undefined
    /** CSS selector of elements whose form input is not recorded, including inside them. */
    ignore?: string | undefined
    /**
     * CSS selector of form controls whose values are recorded as typed. Every other value is masked, and
     * password fields are masked even when they match.
     */
    unmaskInputs?: string | undefined
}

/** Marks a blocked element in the recording. */
export const BLOCKED_ATTRIBUTE = 'data-timecat-blocked'

/** Input types whose value is a fixed label or token rather than something the user types. */
const LABEL_TYPES = new Set(['button', 'submit', 'reset', 'image', 'checkbox', 'radio'])

/** How text directly inside an element is recorded. */
export const TextMask = {
    None: 0,
    /** Text in a masked region. */
    Text: 1,
    /** The default value of a masked `<textarea>`, masked like the values typed into it. */
    Value: 2
} as const

export type TextMask = (typeof TextMask)[keyof typeof TextMask]

/** Masks text but keeps its whitespace, so the replay keeps roughly the same line breaks. */
function maskText(text: string): string {
    return text.replace(/\S/gu, '*')
}

/** Masks a form value completely; only the length remains. */
export function maskValue(value: string): string {
    return '*'.repeat(value.length)
}

export function applyTextMask(mask: TextMask, text: string): string {
    return mask === TextMask.None ? text : mask === TextMask.Text ? maskText(text) : maskValue(text)
}

export class Privacy {
    readonly #maskText: string | undefined
    readonly #block: string | undefined
    readonly #ignore: string | undefined
    readonly #unmaskInputs: string | undefined

    /** Throws a `SyntaxError` for an invalid selector, so mistakes surface when recording starts. */
    constructor(options: PrivacyOptions, document: Document) {
        const probe = document.createElement('div')
        const check = (selector: string | undefined): string | undefined => {
            if (selector !== undefined) {
                probe.matches(selector)
            }
            return selector
        }
        this.#maskText = check(options.maskText)
        this.#block = check(options.block)
        this.#ignore = check(options.ignore)
        this.#unmaskInputs = check(options.unmaskInputs)
    }

    /** Mask of the text directly inside `element`, given the mask of the text around the element. */
    textMaskBelow(element: Element, outer: TextMask): TextMask {
        if (isStyle(element)) {
            // CSS, which masking would break.
            return TextMask.None
        }
        if (isTextArea(element) && this.masksValue(element)) {
            return TextMask.Value
        }
        return outer !== TextMask.None || (this.#maskText !== undefined && element.matches(this.#maskText))
            ? TextMask.Text
            : TextMask.None
    }

    /** Mask of the text directly inside `parent`, worked out from its ancestors. */
    textMaskIn(parent: Element): TextMask {
        if (isStyle(parent)) {
            return TextMask.None
        }
        if (isTextArea(parent) && this.masksValue(parent)) {
            return TextMask.Value
        }
        return this.#maskText !== undefined && parent.closest(this.#maskText) !== null ? TextMask.Text : TextMask.None
    }

    blocks(element: Element): boolean {
        return this.#block !== undefined && element.matches(this.#block)
    }

    ignores(element: Element): boolean {
        return this.#ignore !== undefined && element.closest(this.#ignore) !== null
    }

    /** Whether the value of `control` is recorded masked. For `<select>`, masked means not recorded at all. */
    masksValue(control: FormControl): boolean {
        if (isInput(control)) {
            const type = control.type
            if (type === 'password') {
                return true
            }
            if (LABEL_TYPES.has(type)) {
                return false
            }
        }
        return this.#unmaskInputs === undefined || !control.matches(this.#unmaskInputs)
    }
}
