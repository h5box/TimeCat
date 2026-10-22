/** The states of user interaction the replay shows with attributes, as no one interacts with it: longest first. */
export const STATES = ['focus-visible', 'focus-within', 'focus', 'hover', 'active'] as const

export type State = (typeof STATES)[number]

/** The attribute that stands for a state on the replayed elements in it. */
export function stateAttribute(state: State): string {
    return `data-timecat-${state}`
}
