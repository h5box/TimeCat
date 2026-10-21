import { EventType, InputKind } from '@timecat-js/protocol'
import type { SnapshotEvent, TcrEvent } from '@timecat-js/protocol'
import * as fc from 'fast-check'
import { build, mutations, pageOf } from './recording.ts'
import type { Timed } from './recording.ts'

/** A random change to a recorded page. Targets are picked among the ids in use, see `recordingOf`. */
export type Operation =
    | { kind: 'add'; parent: number; before: number; tag: string; text: string | null }
    | { kind: 'remove'; target: number }
    | { kind: 'attribute'; target: number; name: string; value: string | null }
    | { kind: 'text'; target: number; data: string }
    | { kind: 'input'; target: number; value: string }
    | { kind: 'scroll'; target: number; y: number }
    | { kind: 'snapshot' }

export const operation: fc.Arbitrary<Operation> = fc.oneof(
    {
        weight: 4,
        arbitrary: fc.record({
            kind: fc.constant('add'),
            parent: fc.nat(),
            before: fc.nat(),
            tag: fc.constantFrom('div', 'span', 'p', 'input', 'textarea'),
            text: fc.option(fc.string({ maxLength: 4 }))
        })
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove'), target: fc.nat() }) },
    {
        weight: 2,
        arbitrary: fc.record({
            kind: fc.constant('attribute'),
            target: fc.nat(),
            name: fc.constantFrom('class', 'id', 'title'),
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
    { weight: 1, arbitrary: fc.constant({ kind: 'snapshot' as const }) }
)

/** A new page each time: a virtual document takes over the nodes of the events it applies, and changes them. */
function page(): SnapshotEvent {
    return pageOf([{ tag: 'p', children: [{ text: 'hello' }] }])
}

/**
 * Turns operations into a recording that starts with a snapshot and has one event per millisecond after it.
 * Ids are dense, so targets picked among those given out so far mostly exist.
 */
export function recordingOf(operations: readonly Operation[]): Timed[] {
    const first = page()
    const events: Timed[] = [{ time: 0, event: first }]
    let next = first.nextId
    const pick = (n: number): number => 1 + (n % (next - 1))
    for (const [i, step] of operations.entries()) {
        let event: TcrEvent
        switch (step.kind) {
            case 'add': {
                const ids = { next }
                const node = build({ tag: step.tag, children: step.text === null ? [] : [{ text: step.text }] }, ids)
                const beforeId = step.before % 3 === 0 ? 0 : pick(step.before)
                event = mutations({ adds: [{ parentId: pick(step.parent), beforeId, nodes: [node] }] })
                next = ids.next
                break
            }
            case 'remove':
                event = mutations({ removes: [pick(step.target)] })
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
                break
            }
        }
        events.push({ time: i + 1, event })
    }
    return events
}
