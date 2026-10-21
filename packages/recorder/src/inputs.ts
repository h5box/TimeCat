import { encodeEvent, EventType, InputKind } from '@timecat-js/protocol'
import type { InputChange } from '@timecat-js/protocol'
import { isCheckable, isFormControl, isInput, isOptGroup, isOption, isSelect } from './dom.ts'
import type { FormControl } from './dom.ts'
import type { NodeIds } from './ids.ts'
import { maskValue } from './privacy.ts'
import type { Privacy } from './privacy.ts'

/**
 * Records the state of form controls: values, checked state and selected options. Controls are marked when
 * they may have changed; their state is read when the input event is written, once per flush.
 */
export class InputRecorder {
    readonly #ids: NodeIds
    readonly #privacy: Privacy
    readonly #marked = new Set<FormControl>()
    /** Last recorded value or selection per control, to leave out writes that change nothing. */
    readonly #last = new WeakMap<FormControl, string>()

    constructor(ids: NodeIds, privacy: Privacy) {
        this.#ids = ids
        this.#privacy = privacy
    }

    /**
     * Marks the control `node` belongs to as possibly changed; options and option groups belong to their
     * `<select>`.
     */
    mark(node: Node): void {
        const control = controlOf(node)
        if (control !== undefined) {
            this.#marked.add(control)
        }
    }

    /**
     * Marks the control `node` belongs to after its markup changed. The replay makes the same change, which can
     * change the control's state there, as an inserted option that is selected by default does: the state is
     * written even when it is what was recorded last.
     */
    invalidate(node: Node): void {
        const control = controlOf(node)
        if (control !== undefined) {
            this.#last.delete(control)
            this.#marked.add(control)
        }
    }

    /**
     * Takes controls the recording just wrote. The replay creates them from their markup, so only state that
     * differs from the markup is recorded.
     */
    added(controls: readonly FormControl[]): void {
        for (const control of controls) {
            this.#last.delete(control)
            if (differsFromMarkup(control)) {
                this.#marked.add(control)
            }
            if (isInput(control) && control.type === 'radio' && control.checked) {
                this.#markGroup(control)
            }
        }
    }

    /** The body of an Input event for the marked controls, or undefined when nothing changed. */
    write(): Uint8Array<ArrayBuffer> | undefined {
        const changes: InputChange[] = []
        for (const control of this.#marked) {
            const change = this.#change(control)
            if (change !== undefined) {
                changes.push(change)
            }
        }
        this.#marked.clear()
        return changes.length === 0 ? undefined : encodeEvent({ type: EventType.Input, changes })
    }

    #change(control: FormControl): InputChange | undefined {
        const id = this.#ids.get(control)
        const privacy = this.#privacy
        if (id === undefined || !control.isConnected || privacy.ignores(control) || privacy.blocks(control)) {
            return undefined
        }
        if (isCheckable(control)) {
            // Never left out as unchanged: checking a radio button unchecks the others of its group without
            // telling them, so the last recorded state of those is not reliable.
            return { kind: InputKind.Checked, id, checked: control.checked }
        }
        const masked = privacy.masksValue(control)
        if (isSelect(control)) {
            if (masked) {
                return undefined
            }
            const selected: number[] = []
            const options = control.options
            for (let i = 0; i < options.length; i++) {
                if (options[i]!.selected) {
                    selected.push(i)
                }
            }
            return this.#changed(control, selected.join()) ? { kind: InputKind.Selection, id, selected } : undefined
        }
        const value = masked ? maskValue(control.value) : control.value
        return this.#changed(control, value) ? { kind: InputKind.Value, id, value } : undefined
    }

    /** Inserting a checked radio button unchecks the others of its group, which fires no event. */
    #markGroup(radio: HTMLInputElement): void {
        const name = radio.name
        if (name === '') {
            return
        }
        const form = radio.form
        for (const element of radio.ownerDocument.getElementsByName(name)) {
            if (element !== radio && isInput(element) && element.type === 'radio' && element.form === form) {
                this.#marked.add(element)
            }
        }
    }

    #changed(control: FormControl, state: string): boolean {
        if (this.#last.get(control) === state) {
            return false
        }
        this.#last.set(control, state)
        return true
    }
}

function controlOf(node: Node): FormControl | undefined {
    const control = isOption(node) || isOptGroup(node) ? node.closest('select') : node
    return control !== null && isFormControl(control) ? control : undefined
}

function differsFromMarkup(control: FormControl): boolean {
    if (isCheckable(control)) {
        return control.checked !== control.defaultChecked
    }
    if (isSelect(control)) {
        for (const option of control.options) {
            if (option.selected !== option.defaultSelected) {
                return true
            }
        }
        return false
    }
    return control.value !== control.defaultValue
}

/** Setters that change form state without an input event. */
const SETTERS: [tag: string, properties: string[]][] = [
    ['input', ['value', 'checked']],
    ['textarea', ['value']],
    ['select', ['value', 'selectedIndex']],
    ['option', ['selected']]
]

/**
 * Wraps the setters that change form state, so script changes are seen too. Hooks the prototypes of the realm
 * `document` belongs to, and of the realm this code runs in when that is another one: Chromium gives a node the
 * wrapper of the realm that first reaches it, which for nodes added later is the realm of the mutation
 * observer. Returns a function that removes the hooks.
 */
export function hookFormSetters(document: Document, onSet: (node: Node) => void): () => void {
    const removers: (() => void)[] = []
    const prototypes = new Set<object>()
    for (const [tag, properties] of SETTERS) {
        for (const owner of [document, globalThis.document]) {
            const prototype: object = Object.getPrototypeOf(owner.createElement(tag))
            if (prototypes.has(prototype)) {
                continue
            }
            prototypes.add(prototype)
            for (const property of properties) {
                removers.push(hookSetter(prototype, property, onSet))
            }
        }
    }
    return () => {
        for (const remove of removers) {
            remove()
        }
    }
}

function hookSetter(prototype: object, property: string, onSet: (node: Node) => void): () => void {
    const original = Object.getOwnPropertyDescriptor(prototype, property)
    if (original?.set === undefined || original.configurable !== true) {
        return noop
    }
    const set = function (this: Node, value: unknown): void {
        original.set!.call(this, value)
        onSet(this)
    }
    Object.defineProperty(prototype, property, { ...original, set })
    return () => {
        // Someone may have wrapped the setter again since; removing ours would remove theirs too.
        if (Object.getOwnPropertyDescriptor(prototype, property)?.set === set) {
            Object.defineProperty(prototype, property, original)
        }
    }
}

function noop(): void {}
