import { EventType, InputKind, SheetChangeKind, SheetOwner } from '@timecat-js/protocol'
import type { SheetChange, SnapshotEvent, TcrEvent } from '@timecat-js/protocol'
import * as fc from 'fast-check'
import { build, mutations, pageOf } from './recording.ts'
import type { Spec, Timed } from './recording.ts'

/**
 * A random change to a recorded page. Targets are picked among the ids in use, or among those of a kind, see
 * `recordingOf`.
 */
export type Operation =
    | { kind: 'add'; parent: number; before: number; tag: string; text: string | null }
    | { kind: 'remove'; target: number }
    | { kind: 'attribute'; target: number; name: string; value: string | null }
    | { kind: 'text'; target: number; data: string }
    | { kind: 'input'; target: number; value: string }
    | { kind: 'scroll'; target: number; y: number }
    | { kind: 'snapshot' }
    | { kind: 'shadow'; target: number; text: string }
    | { kind: 'frame'; target: number; text: string; quirks: boolean }
    | { kind: 'style'; parent: number; text: string }
    | { kind: 'sheet'; target: number; changes: SheetChange[] }
    | { kind: 'constructed'; number: number; changes: SheetChange[] }
    | { kind: 'adopt'; target: number; sheets: number[] }

/** Rules, some of which no browser parses. */
const rule = fc.constantFrom(
    'p { color: red; }',
    'div { margin: 1px; }',
    '@media screen {\n  a { color: blue; }\n}',
    'not a rule',
    '@timecat-unknown;'
)

const sheetChange: fc.Arbitrary<SheetChange> = fc.oneof(
    fc.record({ kind: fc.constant(SheetChangeKind.Replace), rules: fc.array(rule, { maxLength: 3 }) }),
    fc.record({ kind: fc.constant(SheetChangeKind.Insert), index: fc.nat(4), rule }),
    fc.record({ kind: fc.constant(SheetChangeKind.Delete), index: fc.nat(4) })
)

const sheetChanges = fc.array(sheetChange, { minLength: 1, maxLength: 3 })

const operation: fc.Arbitrary<Operation> = fc.oneof(
    {
        weight: 4,
        arbitrary: fc.record({
            kind: fc.constant('add'),
            parent: fc.nat(),
            before: fc.nat(),
            tag: fc.constantFrom('div', 'span', 'p', 'input', 'textarea', 'iframe'),
            text: fc.option(fc.string({ maxLength: 4 }))
        })
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove'), target: fc.nat() }) },
    {
        weight: 2,
        arbitrary: fc.record({
            kind: fc.constant('attribute'),
            target: fc.nat(),
            name: fc.constantFrom('class', 'id', 'title', 'type'),
            value: fc.option(fc.string({ maxLength: 3 }))
        })
    },
    {
        weight: 2,
        arbitrary: fc.record({ kind: fc.constant('text'), target: fc.nat(), data: fc.string({ maxLength: 4 }) })
    },
    {
        weight: 1,
        arbitrary: fc.record({ kind: fc.constant('input'), target: fc.nat(), value: fc.string({ maxLength: 3 }) })
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('scroll'), target: fc.nat(), y: fc.nat(1000) }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'snapshot' as const }) },
    {
        weight: 2,
        arbitrary: fc.record({ kind: fc.constant('shadow'), target: fc.nat(), text: fc.string({ maxLength: 3 }) })
    },
    {
        weight: 2,
        arbitrary: fc.record({
            kind: fc.constant('frame'),
            target: fc.nat(),
            text: fc.string({ maxLength: 3 }),
            quirks: fc.boolean()
        })
    },
    {
        weight: 1,
        arbitrary: fc.record({
            kind: fc.constant('style'),
            parent: fc.nat(),
            text: fc.constantFrom('', 'p { color: green; }', 'a { padding: 1px; }\nb { margin: 2px; }')
        })
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('sheet'), target: fc.nat(), changes: sheetChanges }) },
    {
        weight: 2,
        arbitrary: fc.record({
            kind: fc.constant('constructed'),
            number: fc.integer({ min: 1, max: 3 }),
            changes: sheetChanges
        })
    },
    {
        weight: 2,
        arbitrary: fc.record({
            kind: fc.constant('adopt'),
            target: fc.nat(),
            // Sheet 4 is never made.
            sheets: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 3 })
        })
    }
)

/**
 * Up to `maxLength` operations. At full size rather than fast-check's default, which keeps arrays short: changes
 * then build on each other, such as sheets that roots adopt once they exist, and snapshots fall in between.
 */
export function operations(maxLength: number): fc.Arbitrary<Operation[]> {
    return fc.array(operation, { minLength: 1, maxLength, size: 'max' })
}

/** A new page each time: a virtual document takes over the nodes of the events it applies, and changes them. */
function page(): SnapshotEvent {
    return pageOf([{ tag: 'p', children: [{ text: 'hello' }] }])
}

/**
 * Turns operations into a recording that starts with a snapshot and has one event per millisecond after it.
 * Ids are dense, so targets picked among those given out so far mostly exist. Parents and hosts are picked among
 * elements, and frames, `<style>` elements and the roots that adopt sheets among those of their kind, most of the
 * time: the rest of the time any id goes, for the DOM to refuse.
 */
export function recordingOf(steps: readonly Operation[]): Timed[] {
    const first = page()
    const events: Timed[] = [{ time: 0, event: first }]
    let next = first.nextId
    // The body and the paragraph of `page()`.
    let elements = [5, 6]
    let frames: number[] = []
    let styles: number[] = []
    let roots = [1]
    const pick = (n: number): number => 1 + (n % (next - 1))
    const pickFrom = (ids: readonly number[], n: number): number =>
        ids.length === 0 || n % 4 === 0 ? pick(n >> 2) : ids[(n >> 2) % ids.length]!
    /** A run of the node `spec` describes, numbered from the next id. */
    const run = (parentId: number, spec: Spec, beforeId = 0) => {
        const ids = { next }
        const node = build(spec, ids)
        next = ids.next
        return { parentId, beforeId, nodes: [node] }
    }
    for (const [i, step] of steps.entries()) {
        let event: TcrEvent
        switch (step.kind) {
            case 'add': {
                const id = next
                const beforeId = step.before % 3 === 0 ? 0 : pick(step.before)
                const spec = { tag: step.tag, children: step.text === null ? [] : [{ text: step.text }] }
                event = mutations({ adds: [run(pickFrom(elements, step.parent), spec, beforeId)] })
                elements.push(id)
                if (step.tag === 'iframe') {
                    frames.push(id)
                }
                break
            }
            case 'remove':
                // Mostly not the body, which would take everything with it.
                event = mutations({ removes: [pickFrom(elements.slice(1), step.target)] })
                break
            case 'attribute':
                event = mutations({
                    attributes: [{ id: pick(step.target), name: step.name, value: step.value }]
                })
                break
            case 'text':
                event = mutations({ texts: [{ id: pick(step.target), data: step.data }] })
                break
            case 'input':
                event = {
                    type: EventType.Input,
                    changes: [{ kind: InputKind.Value, id: pick(step.target), value: step.value }]
                }
                break
            case 'scroll':
                event = { type: EventType.Scroll, positions: [{ id: pick(step.target), x: 0, y: step.y }] }
                break
            case 'snapshot': {
                const snapshot = page()
                event = snapshot
                next = snapshot.nextId
                elements = [5, 6]
                frames = []
                styles = []
                roots = [1]
                break
            }
            case 'shadow': {
                // The shadow root, then its span.
                roots.push(next)
                elements.push(next + 1)
                const spec = { shadow: [{ tag: 'span', children: [{ text: step.text }] }] }
                event = mutations({ adds: [run(pickFrom(elements, step.target), spec)] })
                break
            }
            case 'frame': {
                const body = { tag: 'body', children: [{ text: step.text }] }
                const spec = { document: [{ tag: 'html', children: [{ tag: 'head' }, body] }], quirks: step.quirks }
                if (frames.length === 0) {
                    // A frame first, with the document in it.
                    frames.push(next)
                    elements.push(next, next + 4)
                    roots.push(next + 1)
                    event = mutations({
                        adds: [run(pickFrom(elements, step.target), { tag: 'iframe', children: [spec] })]
                    })
                } else {
                    // The document, then its html, head and body.
                    roots.push(next)
                    elements.push(next + 3)
                    event = mutations({ adds: [run(pickFrom(frames, step.target), spec)] })
                }
                break
            }
            case 'style':
                styles.push(next)
                event = mutations({
                    adds: [
                        run(pickFrom(elements, step.parent), {
                            tag: 'style',
                            children: step.text === '' ? [] : [{ text: step.text }]
                        })
                    ]
                })
                break
            case 'sheet':
                event = {
                    type: EventType.StyleSheet,
                    owner: SheetOwner.Node,
                    id: pickFrom(styles, step.target),
                    changes: step.changes
                }
                break
            case 'constructed':
                event = {
                    type: EventType.StyleSheet,
                    owner: SheetOwner.Constructed,
                    id: step.number,
                    changes: step.changes
                }
                break
            case 'adopt':
                event = { type: EventType.AdoptedStyleSheets, id: pickFrom(roots, step.target), sheets: step.sheets }
                break
        }
        events.push({ time: i + 1, event })
    }
    return events
}
