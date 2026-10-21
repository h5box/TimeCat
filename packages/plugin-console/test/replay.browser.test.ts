import { createPlayer, ConsoleLevel, EventType } from '@timecat-js/player-core'
import { record } from '@timecat-js/recorder'
import { expect, it } from 'vitest'
import { consolePlugin } from '../src/index.ts'

it('records console messages that the player lists with the events of the application', async () => {
    const recorder = record({ worker: false, plugins: [consolePlugin()] })
    await recorder.ready
    console.info('recorded', { n: 1 })
    recorder.addEvent('checkout', { total: 3 })
    const recording = await recorder.stop()
    console.info('not recorded')
    const container = document.createElement('div')
    document.body.append(container)
    const player = await createPlayer(recording, { container, worker: false })
    try {
        expect(player.events.map(({ event }) => event)).toEqual([
            { type: EventType.Console, level: ConsoleLevel.Info, source: 0, args: ['recorded', '{n: 1}'], stack: '' },
            { type: EventType.Custom, name: 'checkout', data: '{"total":3}' }
        ])
        const [first, second] = player.events
        expect(first!.time).toBeLessThanOrEqual(second!.time)
        expect(second!.time).toBeLessThanOrEqual(player.duration)
    } finally {
        player.destroy()
        container.remove()
    }
})
