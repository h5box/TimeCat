import { encodeInput, InputKind } from '@timecat-js/protocol'
import type { InputChange } from '@timecat-js/protocol'
import { isCheckable, isDocument, isFormControl, isInput, isOptGroup, isOption, isSelect, isShadowRoot } from './dom.ts'
import type { FormControl } from './dom.ts'
import type { NodeIds } from './ids.ts'
import { maskValue } from './privacy.ts'
import type { Privacy } from './privacy.ts'
import type { Scope } from './tree.ts'

/**
 * Records the state of form controls: values, checked state and selected options. Controls are marked when
 * they may have changed; their state is read when the input event is written, once per flush.
 */
export class InputRecorder {
    readonly #ids: NodeIds
    readonly #privacy: Privacy
    readonly #scope: Scope
    readonly #marked = new Set<FormControl>()
    /** Last recorded value or selection per control, to leave out writes that change nothing. */
    readonly #last = new WeakMap<FormControl, string>()

    constructor(ids: NodeIds, privacy: Privacy, scope: Scope) {
        this.#ids = ids
        this.#privacy = privacy
        this.#scope = scope
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
        return changes.length === 0 ? undefined : encodeInput({ changes })
    }

    #change(control: FormControl): InputChange | undefined {
        const id = this.#ids.get(control)
        const privacy = this.#privacy
        if (id === undefined || !this.#scope.contains(control) || privacy.ignores(control) || privacy.blocks(control)) {
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

    /**
     * Inserting a checked radio button unchecks the others of its group, which fires no event. A group is made of
     * the radio buttons of one tree: a document or a shadow tree.
     */
    #markGroup(radio: HTMLInputElement): void {
        const name = radio.name
        if (name === '') {
            return
        }
        const form = radio.form
        const root = radio.getRootNode()
        const candidates: Iterable<Element> = isDocument(root)
            ? root.getElementsByName(name)
            : isShadowRoot(root)
              ? root.querySelectorAll('input')
              : []
        for (const element of candidates) {
            if (
                element !== radio &&
                isInput(element) &&
                element.type === 'radio' &&
                element.name === name &&
                element.form === form
            ) {
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
