import { TimecatPlayer } from './player.ts'

export { TimecatPlayer } from './player.ts'
export { TcrDecodeError } from '@timecat-js/player-core'
export type { DataEvent, Player, RecordingSource, TimedEvent } from '@timecat-js/player-core'

// Another copy of the element, such as the standalone script, may have defined it already.
if (customElements.get('timecat-player') === undefined) {
    customElements.define('timecat-player', TimecatPlayer)
}

declare global {
    interface HTMLElementTagNameMap {
        'timecat-player': TimecatPlayer
    }
}
