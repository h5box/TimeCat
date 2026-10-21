import { isElement, isNode, isShadowRoot } from './dom.ts'

/** What the hooks report. Calls come for every document of a hooked realm, recorded or not. */
export interface RealmHooks {
    /** Script set the state of a form control, which fires no event. */
    formSet(node: Node): void
    /** Script attached a shadow root, which no mutation record reports. */
    shadowAttached(host: Element, root: ShadowRoot): void
}

/** Setters that change form state without an input event, by interface. */
const FORM_SETTERS: [name: string, properties: string[]][] = [
    ['HTMLInputElement', ['value', 'checked']],
    ['HTMLTextAreaElement', ['value']],
    ['HTMLSelectElement', ['value', 'selectedIndex']],
    ['HTMLOptionElement', ['selected']]
]

/**
 * Wraps built-in methods and setters of realms, so the recording sees changes that script makes without an event
 * or a mutation record. Each realm is hooked once: the realm of every recorded document, and the realm the
 * recorder runs in, because Chromium gives a node the wrapper of the realm that first reaches it, which for
 * nodes added later is the realm of the mutation observer.
 */
export class RealmHooker {
    readonly #hooks: RealmHooks
    readonly #hooked = new WeakSet<object>()
    readonly #removers: (() => void)[] = []

    constructor(hooks: RealmHooks) {
        this.#hooks = hooks
        this.hook(globalThis)
    }

    /** Hooks the realm of `global`, a window, unless it is hooked already. */
    hook(global: object): void {
        if (this.#hooked.has(global)) {
            return
        }
        this.#hooked.add(global)
        const hooks = this.#hooks
        const removers = this.#removers
        for (const [name, properties] of FORM_SETTERS) {
            const prototype = prototypeOf(global, name)
            if (prototype === undefined) {
                continue
            }
            for (const property of properties) {
                removers.push(
                    hookSetter(prototype, property, target => {
                        if (isNode(target)) {
                            hooks.formSet(target)
                        }
                    })
                )
            }
        }
        const element = prototypeOf(global, 'Element')
        if (element !== undefined) {
            removers.push(
                hookMethod(element, 'attachShadow', (target, result) => {
                    if (isNode(target) && isElement(target) && isNode(result) && isShadowRoot(result)) {
                        hooks.shadowAttached(target, result)
                    }
                })
            )
        }
    }

    /** Removes every hook. */
    unhook(): void {
        for (const remove of this.#removers.splice(0)) {
            remove()
        }
    }
}

/** The prototype of the interface `name` in the realm of `global`. */
function prototypeOf(global: object, name: string): object | undefined {
    const constructor: unknown = Reflect.get(global, name)
    if (typeof constructor !== 'function') {
        return undefined
    }
    const prototype: unknown = constructor.prototype
    return typeof prototype === 'object' && prototype !== null ? prototype : undefined
}

/** Calls `after` once the setter of `property` ran. Returns a function that removes the hook. */
function hookSetter(prototype: object, property: string, after: (target: unknown) => void): () => void {
    const original = Object.getOwnPropertyDescriptor(prototype, property)
    if (original?.set === undefined || original.configurable !== true) {
        return noop
    }
    const set = function (this: unknown, value: unknown): void {
        original.set!.call(this, value)
        after(this)
    }
    Object.defineProperty(prototype, property, { ...original, set })
    return () => {
        // Someone may have wrapped the setter again since; removing ours would remove theirs too.
        if (Object.getOwnPropertyDescriptor(prototype, property)?.set === set) {
            Object.defineProperty(prototype, property, original)
        }
    }
}

/**
 * Calls `after` with the result once the method `name` returned. Returns a function that removes the hook.
 */
function hookMethod(prototype: object, name: string, after: (target: unknown, result: unknown) => void): () => void {
    const original = Object.getOwnPropertyDescriptor(prototype, name)
    const method: unknown = original?.value
    if (original === undefined || typeof method !== 'function' || original.configurable !== true) {
        return noop
    }
    const value = function (this: unknown, ...args: unknown[]): unknown {
        const result: unknown = Reflect.apply(method, this, args)
        after(this, result)
        return result
    }
    Object.defineProperty(prototype, name, { ...original, value })
    return () => {
        if (Object.getOwnPropertyDescriptor(prototype, name)?.value === value) {
            Object.defineProperty(prototype, name, original)
        }
    }
}

function noop(): void {}
