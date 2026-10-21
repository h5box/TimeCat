export { createPlayer } from './player.ts'
export type { Player, PlayerOptions, RecordingSource } from './player.ts'
// What `createPlayer` rejects with for bytes that are not a recording it can read.
export { TcrDecodeError } from '@timecat-js/protocol'
