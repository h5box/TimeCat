export { createPlayer } from './player.ts'
export type { DataEvent, Player, PlayerOptions, RecordingSource, TimedEvent } from './player.ts'
export { ConsoleLevel, ConsoleSource, EventType } from '@timecat-js/protocol'
export type { ConsoleEvent, CustomDataEvent, NetworkEvent, PerfEvent } from '@timecat-js/protocol'
// What `createPlayer` rejects with for bytes that are not a recording it can read.
export { TcrDecodeError } from '@timecat-js/protocol'
