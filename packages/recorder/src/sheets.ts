import {
    encodeAdoptedStyleSheets,
    encodeStyleSheet,
    EventType,
    SheetChangeKind,
    SheetOwner,
    Track
} from '@timecat-js/protocol'
import type { SheetChange } from '@timecat-js/protocol'
import { findBlobUrls } from './assets.ts'
import type { EventSink } from './batch.ts'
import { isStyle, isText } from './dom.ts'
import type { NodeIds } from './ids.ts'
import type { Scope } from './tree.ts'

/** A document or shadow root, which can adopt constructed sheets. */
export type SheetRoot = Document | ShadowRoot

/** How the top-level rules of a sheet changed since the last write. */
interface Changes {
    /**
     * Rules inserted, with the rule, and deleted, with null, by index and in order; null once the order is not
     * known, when the rules are compared instead.
     */
    ops: [index: number, inserted: CSSRule | null][] | null
    /** Top-level rules whose content changed: rules or declarations inside them. */
    rules: Set<CSSRule>
}

const NONE: readonly CSSStyleSheet[] = []
const NOT_BLANK = /\S/

/**
 * Records the style rules script changes through the CSSOM, which no mutation record reports: the rules of the
 * sheets of `<style>` elements and of constructed sheets, and which constructed sheets documents and shadow roots
 * adopt.
 *
 * A sheet is written whole the first time, then as top-level rules inserted and deleted, in the order the hooks
 * report them. A rule whose content changed is written as deleted and inserted again. A `<style>` element's sheet
 * is taken to hold the rules of its text, as a replay that parses the text has, unless the element has no text:
 * then script inserted the rules, as CSS-in-JS libraries do, and they are written once the element is. A change
 * to the children makes a new sheet, which is written whole if script had changed the old one: the replay may not
 * see that change, when it was undone before it was written.
 */
export class SheetRecorder {
    readonly #ids: NodeIds
    readonly #scope: Scope
    /** Top-level rules of the sheets written, as the replay has them. */
    readonly #rules = new WeakMap<CSSStyleSheet, CSSRule[]>()
    /** The sheet each `<style>` element had when it was last written or its text changed. */
    readonly #sheets = new WeakMap<HTMLStyleElement | SVGStyleElement, CSSStyleSheet>()
    /** Sheets written whole with the rules of their element's text, which script has not changed since. */
    readonly #parsed = new WeakSet<CSSStyleSheet>()
    readonly #changes = new Map<CSSStyleSheet, Changes>()
    /** Numbers of the constructed sheets written, by which the replay knows them. */
    readonly #numbers = new WeakMap<CSSStyleSheet, number>()
    #nextNumber = 1
    /** The sheets each root adopts, as written. */
    readonly #adopted = new WeakMap<SheetRoot, readonly CSSStyleSheet[]>()
    /** Roots whose adopted sheets may have changed. */
    readonly #roots = new Set<SheetRoot>()
    /** Set while the recorder reads adopted sheets, which the hooks report like any read. */
    #reading = false
    /** `blob:` URLs in the CSS written. The caller empties it. */
    readonly urls: string[] = []

    constructor(ids: NodeIds, scope: Scope) {
        this.#ids = ids
        this.#scope = scope
    }

    /**
     * Script inserted the top-level rule now at `index`, deleted the one that was there, or changed the rules
     * otherwise, with no `index`.
     */
    sheetChanged(sheet: CSSStyleSheet, index?: number, deleted = false): void {
        this.#parsed.delete(sheet)
        const changes = this.#changesOf(sheet)
        const ops = changes.ops
        if (ops === null) {
            return
        }
        const inserted = deleted || index === undefined ? null : (sheet.cssRules[index] ?? null)
        if (index === undefined || (!deleted && inserted === null)) {
            changes.ops = null
        } else {
            ops.push([index, inserted])
        }
    }

    /** Script changed a rule inside `rule`, or its declarations. */
    ruleChanged(rule: CSSRule): void {
        let top = rule
        for (let parent = rule.parentRule; parent !== null; parent = parent.parentRule) {
            top = parent
        }
        const sheet = top.parentStyleSheet
        if (sheet !== null) {
            this.#parsed.delete(sheet)
            this.#changesOf(sheet).rules.add(top)
        }
    }

    /** Script read or set the sheets `root` adopts. Returns false for the recorder's own reads. */
    adoptedSheetsUsed(root: SheetRoot): boolean {
        if (this.#reading) {
            return false
        }
        this.#roots.add(root)
        return true
    }

    /** `root` was written, without the sheets it adopts, which are written next. */
    entered(root: SheetRoot): void {
        this.#adopted.delete(root)
        this.#roots.add(root)
    }

    /** A `<style>` element was written, or its text changed, which makes a new sheet. */
    styleWritten(element: HTMLStyleElement | SVGStyleElement): void {
        let blank = true
        for (let child = element.firstChild; child !== null; child = child.nextSibling) {
            if (isText(child)) {
                const data = child.data
                blank &&= !NOT_BLANK.test(data)
                findBlobUrls(data, this.urls)
            }
        }
        const sheet = element.sheet
        if (sheet === null) {
            return
        }
        // The browser parses the text anew on any change to the children, even one undone before it is written,
        // which the replay then never sees: the rules script changed in the old sheet would stay there.
        const previous = this.#sheets.get(element)
        const reparsed =
            previous !== undefined && previous !== sheet && this.#rules.has(previous) && !this.#parsed.has(previous)
        this.#sheets.set(element, sheet)
        if (reparsed && !this.#changes.has(sheet)) {
            this.#parsed.add(sheet)
        }
        // A sheet written before, of an element written again, is written whole again: the replay parses the text.
        if (this.#rules.delete(sheet) || reparsed || (blank && sheet.cssRules.length > 0)) {
            this.#changesOf(sheet)
        }
    }

    /** Writes the changes since the last write, after the mutations that wrote the nodes they refer to. */
    write(sink: EventSink, time: number): void {
        // Sheets adopted for the first time are written whole, which takes in their changes.
        this.#reading = true
        try {
            for (const root of this.#roots) {
                this.#writeAdopted(sink, time, root)
            }
        } finally {
            this.#reading = false
            this.#roots.clear()
        }
        try {
            for (const [sheet, changes] of this.#changes) {
                this.#writeSheet(sink, time, sheet, changes)
            }
        } finally {
            this.#changes.clear()
        }
    }

    #changesOf(sheet: CSSStyleSheet): Changes {
        let changes = this.#changes.get(sheet)
        if (changes === undefined) {
            changes = { ops: [], rules: new Set() }
            this.#changes.set(sheet, changes)
        }
        return changes
    }

    #writeAdopted(sink: EventSink, time: number, root: SheetRoot): void {
        const id = this.#ids.get(root)
        if (id === undefined || !this.#scope.contains(root)) {
            return
        }
        const sheets = root.adoptedStyleSheets
        const written = this.#adopted.get(root) ?? NONE
        if (sheets.length === written.length && sheets.every((sheet, i) => sheet === written[i])) {
            return
        }
        const numbers = sheets.map(sheet => this.#numberOf(sink, time, sheet))
        this.#adopted.set(root, [...sheets])
        sink.event(Track.Dom, EventType.AdoptedStyleSheets, time, encodeAdoptedStyleSheets({ id, sheets: numbers }))
    }

    /** The number of a constructed sheet. The first time, the sheet is written, which creates it in the replay. */
    #numberOf(sink: EventSink, time: number, sheet: CSSStyleSheet): number {
        let number = this.#numbers.get(sheet)
        if (number === undefined) {
            number = this.#nextNumber++
            this.#numbers.set(sheet, number)
            this.#changes.delete(sheet)
            const changes = [this.#replace(sheet)]
            sink.event(
                Track.Dom,
                EventType.StyleSheet,
                time,
                encodeStyleSheet({ owner: SheetOwner.Constructed, id: number, changes })
            )
        }
        return number
    }

    #writeSheet(sink: EventSink, time: number, sheet: CSSStyleSheet, changes: Changes): void {
        const node = sheet.ownerNode
        // Without an owner, a sheet is constructed, or was an element's: only adopted ones are numbered.
        let id: number | undefined
        if (node === null) {
            id = this.#numbers.get(sheet)
        } else if (isStyle(node) && this.#scope.contains(node)) {
            id = this.#ids.get(node)
        }
        if (id === undefined) {
            return
        }
        const list = this.#diff(sheet, changes)
        if (list.length > 0) {
            const owner = node === null ? SheetOwner.Constructed : SheetOwner.Node
            sink.event(Track.Dom, EventType.StyleSheet, time, encodeStyleSheet({ owner, id, changes: list }))
        }
    }

    /** The changes that bring the replay's rules of `sheet` up to date. */
    #diff(sheet: CSSStyleSheet, changes: Changes): SheetChange[] {
        const list = sheet.cssRules
        const rules = this.#rules.get(sheet)
        if (rules === undefined) {
            return [this.#replace(sheet)]
        }
        const result: SheetChange[] = []
        if (changes.ops === null) {
            this.#compare(rules, Array.from(list), changes.rules, result)
        } else {
            this.#apply(rules, changes.ops, changes.rules, result)
        }
        // Changes made where no hook is, as through a realm not recorded, leave the counts apart, which writing
        // the sheet whole repairs. It is also no longer once as many rules are written as it has.
        let inserted = 0
        for (const change of result) {
            if (change.kind === SheetChangeKind.Insert) {
                inserted++
            }
        }
        return rules.length !== list.length || (result.length > 0 && inserted >= list.length)
            ? [this.#replace(sheet)]
            : result
    }

    /** Applies the changes the hooks reported to `rules`, adding them to `result`. */
    #apply(
        rules: CSSRule[],
        ops: readonly [index: number, inserted: CSSRule | null][],
        changed: ReadonlySet<CSSRule>,
        result: SheetChange[]
    ): void {
        for (const [index, rule] of ops) {
            if (rule === null) {
                rules.splice(index, 1)
                result.push({ kind: SheetChangeKind.Delete, index })
            } else {
                rules.splice(index, 0, rule)
                result.push({ kind: SheetChangeKind.Insert, index, rule: this.#text(rule) })
            }
        }
        for (const rule of changed) {
            const index = rules.indexOf(rule)
            if (index !== -1) {
                result.push(
                    { kind: SheetChangeKind.Delete, index },
                    { kind: SheetChangeKind.Insert, index, rule: this.#text(rule) }
                )
            }
        }
    }

    /**
     * Turns `rules` into `current`, adding the changes to `result`. The rules kept are in the same order in both:
     * the CSSOM only inserts and deletes.
     */
    #compare(
        rules: CSSRule[],
        current: readonly CSSRule[],
        changed: ReadonlySet<CSSRule>,
        result: SheetChange[]
    ): void {
        const kept = new Set(current)
        for (let i = rules.length - 1; i >= 0; i--) {
            const rule = rules[i]!
            if (!kept.has(rule) || changed.has(rule)) {
                rules.splice(i, 1)
                result.push({ kind: SheetChangeKind.Delete, index: i })
            }
        }
        const left = new Set(rules)
        for (const [index, rule] of current.entries()) {
            if (!left.has(rule)) {
                rules.splice(index, 0, rule)
                result.push({ kind: SheetChangeKind.Insert, index, rule: this.#text(rule) })
            }
        }
    }

    #replace(sheet: CSSStyleSheet): SheetChange {
        const rules = Array.from(sheet.cssRules)
        this.#rules.set(sheet, rules)
        return { kind: SheetChangeKind.Replace, rules: rules.map(rule => this.#text(rule)) }
    }

    #text(rule: CSSRule): string {
        const text = rule.cssText
        findBlobUrls(text, this.urls)
        return text
    }
}
