/** Fixed track ids. Each chunk belongs to exactly one track. */
export const Track = {
    Dom: 1,
    Input: 2,
    Pointer: 3,
    Scroll: 4,
    Viewport: 5,
    Navigation: 6,
    Console: 16,
    Network: 17,
    Perf: 18,
    Custom: 19,
    Assets: 32
} as const

export type Track = (typeof Track)[keyof typeof Track]

/** Track ids from here on are allocated while recording (one per media stream) and declared in the recording. */
export const FIRST_DYNAMIC_TRACK = 256
