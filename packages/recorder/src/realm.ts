import { isDocument, isElement, isNode, isShadowRoot } from './dom.ts'

/** What the hooks report. Calls come for everything of a hooked realm, recorded or not. */
export interface RealmHooks {
    /** Script set the state of a form control, which fires no event. */
    formSet(node: Node): void
    /** Script attached a shadow root, which no mutation record reports. */
    shadowAttached(host: Element, root: ShadowRoot): void
    /**
     * Script changed the top-level rules of a sheet: inserted the rule now at `index`, deleted the one that was
     * there, or changed them otherwise, with no `index`.
     */
    sheetChanged(sheet: CSSStyleSheet, index?: number, deleted?: boolean): void
    /** Script changed a rule inside `rule`, or its declarations. */
    ruleChanged(rule: CSSRule): void
    /** Script read or set the sheets a document or shadow root adopts; what it read, it can change in place. */
    adoptedSheetsUsed(root: Document | ShadowRoot): void
    /** Script made a font face from `source`, whose URLs resolve against `base`. */
    fontFaceCreated(face: unknown, source: unknown, base: string): void
    /** Script added a font face to a set of fonts. */
    fontFaceAdded(fonts: unknown, face: unknown): void
    /** Script made `url` for `object`, or revoked it, with no `object`. */
    objectUrl(url: string, object?: unknown): void
}

/** Setters that change form state without an input event, by interface. */
const FORM_SETTERS: [name: string, properties: string[]][] = [
    ['HTMLInputElement', ['value', 'checked']],
    ['HTMLTextAreaElement', ['value']],
    ['HTMLSelectElement', ['value', 'selectedIndex']],
    ['HTMLOptionElement', ['selected']]
]

/** Methods that change the rules inside a rule, by interface. */
const RULE_METHODS: [name: string, methods: string[]][] = [
    ['CSSGroupingRule', ['insertRule', 'deleteRule']],
    ['CSSKeyframesRule', ['appendRule', 'deleteRule']]
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
        // A window stays the same object across navigations, which bring new realms, each with its own `Object`.
        const realm: unknown = Reflect.get(global, 'Object')
        if (typeof realm !== 'function' || this.#hooked.has(realm)) {
            return
        }
        this.#hooked.add(realm)
        const hooks = this.#hooks
        const removers = this.#removers
        const prototype = (name: string): object | undefined => prototypeOf(global, name)
        const formSet = (target: unknown): void => {
            if (isNode(target)) {
                hooks.formSet(target)
            }
        }
        for (const [name, properties] of FORM_SETTERS) {
            const form = prototype(name)
            if (form === undefined) {
                continue
            }
            for (const property of properties) {
                removers.push(hookAccessor(form, property, formSet))
            }
        }
        const element = prototype('Element')
        if (element !== undefined) {
            removers.push(
                hookMethod(element, 'attachShadow', (target, result) => {
                    if (isNode(target) && isElement(target) && isNode(result) && isShadowRoot(result)) {
                        hooks.shadowAttached(target, result)
                    }
                })
            )
        }
        this.#hookStyles(global)
        for (const name of ['Document', 'ShadowRoot']) {
            const root = prototype(name)
            if (root !== undefined) {
                removers.push(
                    hookAccessor(
                        root,
                        'adoptedStyleSheets',
                        target => {
                            if (isNode(target) && (isDocument(target) || isShadowRoot(target))) {
                                hooks.adoptedSheetsUsed(target)
                            }
                        },
                        true
                    )
                )
            }
        }
        // Chromium has no `FontFaceSet` interface object: the fonts of the realm's document lead to the prototype.
        const fonts = prototype('FontFaceSet') ?? fontsPrototypeOf(global)
        if (fonts !== undefined) {
            removers.push(hookMethod(fonts, 'add', (target, _result, args) => hooks.fontFaceAdded(target, args[0])))
        }
        removers.push(
            hookConstructor(global, 'FontFace', (face, args) => hooks.fontFaceCreated(face, args[1], baseOf(global)))
        )
        const url: unknown = Reflect.get(global, 'URL')
        if (typeof url === 'function') {
            removers.push(
                hookMethod(url, 'createObjectURL', (_target, result, args) => {
                    if (typeof result === 'string') {
                        hooks.objectUrl(result, args[0])
                    }
                }),
                hookMethod(url, 'revokeObjectURL', (_target, _result, args) => hooks.objectUrl(String(args[0])))
            )
        }
    }

    /** Removes every hook. */
    unhook(): void {
        for (const remove of this.#removers.splice(0)) {
            remove()
        }
    }

    /** Hooks what changes the rules of style sheets. */
    #hookStyles(global: object): void {
        const hooks = this.#hooks
        const removers = this.#removers
        const sheet = prototypeOf(global, 'CSSStyleSheet')
        if (sheet !== undefined) {
            const changed = (target: unknown): void => {
                if (isSheet(target)) {
                    hooks.sheetChanged(target)
                }
            }
            removers.push(
                hookMethod(sheet, 'insertRule', (target, result) => {
                    if (isSheet(target) && typeof result === 'number') {
                        hooks.sheetChanged(target, result)
                    }
                }),
                hookMethod(sheet, 'deleteRule', (target, _result, args) => {
                    if (isSheet(target)) {
                        // The index as WebIDL converts an `unsigned long`.
                        hooks.sheetChanged(target, Number(args[0]) >>> 0, true)
                    }
                }),
                hookMethod(sheet, 'addRule', changed),
                hookMethod(sheet, 'removeRule', changed),
                hookMethod(sheet, 'replaceSync', changed),
                hookMethod(sheet, 'replace', (target, result) => {
                    changed(target)
                    // The rules may change only once the promise settles.
                    if (isThenable(result)) {
                        void result.then(() => changed(target), noop)
                    }
                })
            )
        }
        const ruleChanged = (target: unknown): void => {
            if (isRule(target)) {
                hooks.ruleChanged(target)
            }
        }
        for (const [name, methods] of RULE_METHODS) {
            const rule = prototypeOf(global, name)
            if (rule === undefined) {
                continue
            }
            for (const method of methods) {
                removers.push(hookMethod(rule, method, ruleChanged))
            }
        }
        const styleRule = prototypeOf(global, 'CSSStyleRule')
        if (styleRule !== undefined) {
            removers.push(hookAccessor(styleRule, 'selectorText', ruleChanged))
        }
        // Declarations of rules; inline styles, which are attributes, have no rule.
        const declarationChanged = (target: unknown): void => {
            const rule = isDeclaration(target) ? target.parentRule : null
            if (rule !== null) {
                hooks.ruleChanged(rule)
            }
        }
        const declaration = prototypeOf(global, 'CSSStyleDeclaration')
        if (declaration !== undefined) {
            removers.push(
                hookMethod(declaration, 'setProperty', declarationChanged),
                hookMethod(declaration, 'removeProperty', declarationChanged),
                hookAccessor(declaration, 'cssText', declarationChanged)
            )
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

/** The prototype of the fonts of the document of `global`. */
function fontsPrototypeOf(global: object): object | undefined {
    const document: unknown = Reflect.get(global, 'document')
    const fonts: unknown = isNode(document) && isDocument(document) ? document.fonts : undefined
    const prototype: unknown = typeof fonts === 'object' && fonts !== null ? Object.getPrototypeOf(fonts) : undefined
    return typeof prototype === 'object' && prototype !== null ? prototype : undefined
}

/** The URL relative URLs of the realm of `global` resolve against. */
function baseOf(global: object): string {
    const document: unknown = Reflect.get(global, 'document')
    return isNode(document) ? document.baseURI : ''
}

/**
 * Calls `after` once the setter of `property` ran, and with `get`, the getter too. Returns a function that
 * removes the hook.
 */
function hookAccessor(prototype: object, property: string, after: (target: unknown) => void, get = false): () => void {
    const original = Object.getOwnPropertyDescriptor(prototype, property)
    if (original?.set === undefined || original.configurable !== true) {
        return noop
    }
    const set = function (this: unknown, value: unknown): void {
        original.set!.call(this, value)
        after(this)
    }
    const hooked: PropertyDescriptor = { ...original, set }
    if (get && original.get !== undefined) {
        hooked.get = function (this: unknown): unknown {
            const value: unknown = original.get!.call(this)
            after(this)
            return value
        }
    }
    Object.defineProperty(prototype, property, hooked)
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
function hookMethod(
    owner: object,
    name: string,
    after: (target: unknown, result: unknown, args: unknown[]) => void
): () => void {
    const original = Object.getOwnPropertyDescriptor(owner, name)
    const method: unknown = original?.value
    if (original === undefined || typeof method !== 'function' || original.configurable !== true) {
        return noop
    }
    const value = function (this: unknown, ...args: unknown[]): unknown {
        const result: unknown = Reflect.apply(method, this, args)
        after(this, result, args)
        return result
    }
    Object.defineProperty(owner, name, { ...original, value })
    return () => {
        if (Object.getOwnPropertyDescriptor(owner, name)?.value === value) {
            Object.defineProperty(owner, name, original)
        }
    }
}

/**
 * Calls `after` with each object the constructor `global[name]` makes. Returns a function that removes the hook.
 */
function hookConstructor(global: object, name: string, after: (made: object, args: unknown[]) => void): () => void {
    const original: unknown = Reflect.get(global, name)
    if (typeof original !== 'function') {
        return noop
    }
    // A proxy keeps the prototype, the statics and `instanceof`, and subclasses that call it.
    const hooked = new Proxy(original, {
        construct(target, args: unknown[], newTarget): object {
            const made: object = Reflect.construct(target, args, newTarget)
            after(made, args)
            return made
        }
    })
    Reflect.set(global, name, hooked)
    return () => {
        try {
            if (Reflect.get(global, name) === hooked) {
                Reflect.set(global, name, original)
            }
        } catch {
            // The window shows a document of another origin now; the realm hooked is gone.
        }
    }
}

// Checks that work across realms.

function isSheet(value: unknown): value is CSSStyleSheet {
    return typeof value === 'object' && value !== null && 'cssRules' in value && 'ownerNode' in value
}

function isRule(value: unknown): value is CSSRule {
    return typeof value === 'object' && value !== null && 'parentStyleSheet' in value && 'parentRule' in value
}

function isDeclaration(value: unknown): value is CSSStyleDeclaration {
    return typeof value === 'object' && value !== null && 'getPropertyValue' in value && 'parentRule' in value
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}

function noop(): void {}
