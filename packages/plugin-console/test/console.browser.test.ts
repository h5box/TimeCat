import { ConsoleLevel, ConsoleSource, EventType } from '@timecat-js/protocol'
import type { ConsoleEvent } from '@timecat-js/protocol'
import type { PluginContext, PluginEvent } from '@timecat-js/recorder'
import { afterEach, describe, expect, it } from 'vitest'
import { consolePlugin } from '../src/index.ts'
import type { ConsoleMethod, ConsolePluginOptions } from '../src/index.ts'

const frames: HTMLIFrameElement[] = []

afterEach(() => {
    for (const frame of frames.splice(0)) {
        frame.remove()
    }
})

/**
 * The window of a frame, whose console methods only note their calls: the tests neither log nor dispatch errors
 * that the test runner, which watches its own window, would report.
 */
function frameWindow() {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    frames.push(frame)
    const view = frame.contentDocument!.defaultView!
    const calls: [ConsoleMethod, unknown[]][] = []
    const spy =
        (method: ConsoleMethod) =>
        (...args: unknown[]): void =>
            void calls.push([method, args])
    const spies = {
        debug: spy('debug'),
        log: spy('log'),
        info: spy('info'),
        warn: spy('warn'),
        error: spy('error'),
        assert: spy('assert'),
        trace: spy('trace')
    }
    Object.assign(view.console, spies)
    return { view, calls, spies }
}

function start(view: Window & typeof globalThis, options: ConsolePluginOptions = {}) {
    const events: (ConsoleEvent & { time: number })[] = []
    const errors: unknown[] = []
    let clock = 0
    const context: PluginContext = {
        window: view,
        now: () => clock,
        time: time => time,
        microseconds: time => time * 1000,
        write(event: PluginEvent, time = clock) {
            if (event.type === EventType.Console) {
                events.push({ ...event, time })
            }
        },
        openMedia() {
            throw new Error('plugins of this kind write no media')
        },
        nodeId: () => 0,
        onError: error => void errors.push(error)
    }
    const stop = consolePlugin(options).start(context)
    return {
        events,
        errors,
        stop: (): void => {
            if (typeof stop === 'function') {
                void stop()
            }
        },
        tick: (ms: number): void => {
            clock += ms
        }
    }
}

describe('consolePlugin', () => {
    it('records the console methods, which it still calls', () => {
        const { view, calls } = frameWindow()
        const { events, errors, stop } = start(view)
        const self = { name: 'self' }
        view.console.log('text', 1, { a: [2] })
        view.console.debug('debug')
        view.console.info('info')
        view.console.warn('careful')
        view.console.error('failed', self)
        view.console.assert(false, 'broken')
        view.console.assert(true, 'holds')
        view.console.trace('here')
        stop()
        expect(calls.map(([method]) => method)).toEqual([
            'log',
            'debug',
            'info',
            'warn',
            'error',
            'assert',
            'assert',
            'trace'
        ])
        expect(calls[4]![1][1]).toBe(self)
        expect(events.map(({ level, source, args }) => ({ level, source, args }))).toEqual([
            { level: ConsoleLevel.Log, source: ConsoleSource.Call, args: ['text', '1', '{a: [2]}'] },
            { level: ConsoleLevel.Debug, source: ConsoleSource.Call, args: ['debug'] },
            { level: ConsoleLevel.Info, source: ConsoleSource.Call, args: ['info'] },
            { level: ConsoleLevel.Warn, source: ConsoleSource.Call, args: ['careful'] },
            { level: ConsoleLevel.Error, source: ConsoleSource.Call, args: ['failed', '{name: "self"}'] },
            { level: ConsoleLevel.Error, source: ConsoleSource.Call, args: ['Assertion failed', 'broken'] },
            { level: ConsoleLevel.Log, source: ConsoleSource.Call, args: ['here'] }
        ])
        // Warnings, errors, assertions and traces come with the stack of the call, starting at the caller.
        const stacks = events.map(event => event.stack.split('\n')[0] ?? '')
        expect(stacks.slice(0, 3)).toEqual(['', '', ''])
        for (const stack of stacks.slice(3)) {
            expect(stack).toContain('console.browser.test.ts')
        }
        expect(errors).toEqual([])
    })

    it('records the stack of an error among the arguments', () => {
        const { view } = frameWindow()
        const { events, stop } = start(view)
        const error = new RangeError('out of range')
        view.console.log('caught', error)
        stop()
        expect(events).toMatchObject([{ args: ['caught', 'RangeError: out of range'], stack: error.stack }])
    })

    it('records errors no script caught and rejections no script handled', () => {
        const { view } = frameWindow()
        const { events, stop } = start(view)
        const error = new Error('boom')
        view.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: boom', error }))
        view.dispatchEvent(
            new ErrorEvent('error', {
                message: 'Script error.',
                filename: 'https://example.com/a.js',
                lineno: 3,
                colno: 7
            })
        )
        // Resource errors are plain events.
        view.dispatchEvent(new Event('error'))
        const promise = new Promise(() => {})
        view.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason: new TypeError('bad') }))
        view.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason: { code: 7 } }))
        stop()
        view.dispatchEvent(new ErrorEvent('error', { message: 'after' }))
        const exception = { level: ConsoleLevel.Error, source: ConsoleSource.Exception }
        const rejection = { level: ConsoleLevel.Error, source: ConsoleSource.Rejection }
        expect(events).toMatchObject([
            { ...exception, args: ['Uncaught Error: boom'], stack: error.stack },
            { ...exception, args: ['Script error.'], stack: 'at https://example.com/a.js:3:7' },
            { ...rejection, args: ['TypeError: bad'] },
            { ...rejection, args: ['{code: 7}'], stack: '' }
        ])
        expect(events[2]!.stack).toContain('TypeError: bad')
    })

    it('records only the methods asked for, and errors only when asked', () => {
        const { view } = frameWindow()
        const { events, stop } = start(view, { methods: ['error'], errors: false })
        view.console.log('left out')
        view.console.error('kept')
        view.dispatchEvent(new ErrorEvent('error', { message: 'left out' }))
        stop()
        expect(events.map(event => event.args)).toEqual([['kept']])
        const unknown: ConsoleMethod[] = JSON.parse('["table"]')
        expect(() => consolePlugin({ methods: unknown })).toThrow(RangeError)
        expect(() => consolePlugin({ maxLength: 0 })).toThrow(RangeError)
        expect(() => consolePlugin({ rate: Number.NaN })).toThrow(RangeError)
    })

    it('records what a message logs while it is read only in the console', () => {
        const { view, calls } = frameWindow()
        const { events, stop } = start(view)
        const noisy = {
            get value(): number {
                view.console.log('read')
                return 1
            }
        }
        view.console.log(noisy)
        stop()
        expect(events.map(event => event.args)).toEqual([['{value: 1}']])
        expect(calls.map(([, args]) => args[0])).toEqual(['read', noisy])
    })

    it('records as many messages a second as its rate, and the number of the others', () => {
        const { view } = frameWindow()
        const { events, stop, tick } = start(view, { rate: 2, maxLength: 5 })
        for (let i = 0; i < 5; i++) {
            view.console.log(`message ${i}`)
        }
        tick(1000)
        view.console.log('next second')
        view.console.log('kept')
        view.console.log('dropped')
        stop()
        expect(events.map(({ time, level, args }) => ({ time, level, args }))).toEqual([
            { time: 0, level: ConsoleLevel.Log, args: ['messa…'] },
            { time: 0, level: ConsoleLevel.Log, args: ['messa…'] },
            { time: 1000, level: ConsoleLevel.Warn, args: ['3 console messages were not recorded'] },
            { time: 1000, level: ConsoleLevel.Log, args: ['next …'] },
            { time: 1000, level: ConsoleLevel.Log, args: ['kept'] },
            { time: 1000, level: ConsoleLevel.Warn, args: ['1 console messages were not recorded'] }
        ])
    })

    it('puts the console back once stopped, unless script wrapped it meanwhile', () => {
        const { view, spies } = frameWindow()
        const { events, stop } = start(view)
        expect(view.console.log).not.toBe(spies.log)
        const wrapped: unknown = Reflect.get(view.console, 'warn')
        const outer = (...args: unknown[]): void => {
            if (typeof wrapped === 'function') {
                Reflect.apply(wrapped, view.console, args)
            }
        }
        view.console.warn = outer
        stop()
        expect(view.console.log).toBe(spies.log)
        expect(view.console.warn).toBe(outer)
        view.console.warn('after')
        view.console.log('after')
        expect(events).toEqual([])
    })

    it('records the console of the window recorded', () => {
        const before: unknown = Reflect.get(console, 'info')
        const { events, stop } = start(window)
        console.info('from the page', document.createElement('main'))
        stop()
        expect(Reflect.get(console, 'info')).toBe(before)
        expect(events).toMatchObject([{ level: ConsoleLevel.Info, args: ['from the page', '<main>'] }])
    })

    it('shows nodes by their name, id and class', () => {
        const { view } = frameWindow()
        const { events, stop } = start(view)
        const element = document.createElement('div')
        element.id = 'a'
        element.className = 'b c'
        view.console.log(element, document.createTextNode('hi'), document.createComment('note'), document)
        stop()
        expect(events[0]!.args).toEqual(['<div id="a" class="b c">', '#text "hi"', '#comment "note"', '#document'])
    })
})
