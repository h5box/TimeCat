import { SheetChangeKind } from '@timecat-js/protocol'
import type { SheetChange } from '@timecat-js/protocol'

/** Rules that never apply, which stand in for one this browser cannot parse, so later indexes still match. */
const INERT_RULES = ['@media not all {}', '@layer timecat-inert;']

/** Changes the top-level rules of a sheet as recorded, after passing each rule through `rewrite`. */
export function changeRules(
    sheet: CSSStyleSheet,
    changes: readonly SheetChange[],
    rewrite: (text: string) => string
): void {
    for (const change of changes) {
        switch (change.kind) {
            case SheetChangeKind.Replace:
                // From the end, which leaves `@namespace` rules for last: they go only once no other rules are left.
                for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
                    deleteRule(sheet, i)
                }
                for (const [i, rule] of change.rules.entries()) {
                    insertRule(sheet, rewrite(rule), i)
                }
                break
            case SheetChangeKind.Insert:
                insertRule(sheet, rewrite(change.rule), change.index)
                break
            case SheetChangeKind.Delete:
                if (change.index < sheet.cssRules.length) {
                    deleteRule(sheet, change.index)
                }
                break
        }
    }
}

/** `changeRules` on the text of the rules. Changes `rules` in place, unless a change replaces them all. */
export function changeRuleTexts(rules: string[], changes: readonly SheetChange[]): string[] {
    let result = rules
    for (const change of changes) {
        switch (change.kind) {
            case SheetChangeKind.Replace:
                // A copy: whoever applies the event next may change it too.
                result = [...change.rules]
                break
            case SheetChangeKind.Insert:
                result.splice(Math.min(change.index, result.length), 0, change.rule)
                break
            case SheetChangeKind.Delete:
                if (change.index < result.length) {
                    result.splice(change.index, 1)
                }
                break
        }
    }
    return result
}

/**
 * The sheets recordings make with `new CSSStyleSheet()`, by number. A document can adopt only sheets made in its
 * own window, so each document that adopts one gets a sheet of its own, with the same rules.
 */
export class ConstructedSheets {
    readonly #rewrite: (text: string) => string
    readonly #rules = new Map<number, string[]>()
    readonly #sheets = new Map<Document, Map<number, CSSStyleSheet>>()

    constructor(rewrite: (text: string) => string) {
        this.#rewrite = rewrite
    }

    /** Applies the changes of a StyleSheet event; the first event of a number makes the sheet. */
    change(number: number, changes: readonly SheetChange[]): void {
        this.#rules.set(number, changeRuleTexts(this.#rules.get(number) ?? [], changes))
        for (const sheets of this.#sheets.values()) {
            const sheet = sheets.get(number)
            if (sheet !== undefined) {
                changeRules(sheet, changes, this.#rewrite)
            }
        }
    }

    /** The sheets of `document` with the given numbers, leaving out numbers no event made a sheet for. */
    sheetsFor(document: Document, numbers: readonly number[]): CSSStyleSheet[] {
        const view = document.defaultView
        let sheets = this.#sheets.get(document)
        if (sheets === undefined) {
            sheets = new Map()
            this.#sheets.set(document, sheets)
        }
        const result: CSSStyleSheet[] = []
        for (const number of numbers) {
            let sheet = sheets.get(number)
            const rules = this.#rules.get(number)
            if (sheet === undefined && rules !== undefined && view !== null) {
                sheet = new view.CSSStyleSheet()
                changeRules(sheet, [{ kind: SheetChangeKind.Replace, rules }], this.#rewrite)
                sheets.set(number, sheet)
            }
            if (sheet !== undefined) {
                result.push(sheet)
            }
        }
        return result
    }

    /** Drops the sheets of a document that is gone. */
    forget(document: Document): void {
        this.#sheets.delete(document)
    }

    /** Drops every sheet, as a snapshot does. */
    clear(): void {
        this.#rules.clear()
        this.#sheets.clear()
    }
}

function insertRule(sheet: CSSStyleSheet, rule: string, index: number): void {
    // An index past the end, after rules that did not go in, inserts at the end.
    const at = Math.min(index, sheet.cssRules.length)
    try {
        sheet.insertRule(rule, at)
        return
    } catch {
        // A rule this browser does not parse, or does not take there.
    }
    for (const inert of INERT_RULES) {
        try {
            sheet.insertRule(inert, at)
            return
        } catch {
            // Not taken there either, such as a rule before `@import` rules.
        }
    }
}

function deleteRule(sheet: CSSStyleSheet, index: number): void {
    try {
        sheet.deleteRule(index)
    } catch {
        // An `@namespace` rule, while other rules are left.
    }
}
