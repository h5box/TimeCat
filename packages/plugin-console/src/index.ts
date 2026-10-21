import { ConsoleLevel, ConsoleSource, EventType } from '@timecat-js/protocol'
import type { PluginContext, RecorderPlugin } from '@timecat-js/recorder'
import { errorHead, errorStack, preview } from './preview.ts'

const METHODS = ['debug', 'log', 'info', 'warn', 'error', 'assert', 'trace'] as const

/** The `console` methods the plugin can record. */
export type ConsoleMethod = (typeof METHODS)[number]

export interface ConsolePluginOptions {
    /** Methods recorded. All of them by default. */
    methods?: readonly ConsoleMethod[] | undefined
    /** Records errors no script caught and promise rejections no script handled. `true` by default. */
    errors?: boolean | undefined
    /** Longest text kept of one argument, in UTF-16 code units; longer ones are cut. 1000 by default. */
    maxLength?: number | undefined
    /** Messages recorded in one second at most. The number of the others is recorded instead. 100 by default. */
    rate?: number | undefined
}

const LEVELS: Readonly<Record<ConsoleMethod, ConsoleLevel>> = {
    debug: ConsoleLevel.Debug,
    log: ConsoleLevel.Log,
    info: ConsoleLevel.Info,
    warn: ConsoleLevel.Warn,
    error: ConsoleLevel.Error,
    assert: ConsoleLevel.Error,
    trace: ConsoleLevel.Log
}
/** Methods whose messages come with the stack of the call. */
const STACKED: ReadonlySet<ConsoleMethod> = new Set(['warn', 'error', 'assert', 'trace'])
/** Arguments recorded of one message. */
const MAX_ARGS = 50

/**
 * Records what the page writes to the console, the errors no script caught and the promise rejections no script
 * handled. Arguments are recorded as text, as a console previews them; the console still gets them as they are.
 */
export function consolePlugin(options: ConsolePluginOptions = {}): RecorderPlugin {
    const methods = options.methods ?? METHODS
    for (const method of methods) {
        if (!Object.hasOwn(LEVELS, method)) {
            throw new RangeError(`unknown console method ${method}`)
        }
    }
    const maxLength = options.maxLength ?? 1000
    const rate = options.rate ?? 100
    for (const [name, value] of [
        ['maxLength', maxLength],
        ['rate', rate]
    ] as const) {
        if (!(value > 0)) {
            throw new RangeError(`${name} must be a positive number, got ${value}`)
        }
    }
    const errors = options.errors ?? true
    return {
        name: 'console',
        start: context => startConsole(context, { methods, errors, maxLength, rate })
    }
}

interface Settings {
    methods: readonly ConsoleMethod[]
    errors: boolean
    maxLength: number
    rate: number
}

function startConsole(context: PluginContext, settings: Settings): () => void {
    const target = context.window
    const consoleObject = target.console
    let active = true
    /** Set while a message is recorded, which can run the page's code, as a getter, that logs. */
    let busy = false
    let second = -1
    let count = 0
    let dropped = 0

    const writeDropped = (): void => {
        if (dropped > 0) {
            const args = [`${dropped} console messages were not recorded`]
            context.write({
                type: EventType.Console,
                level: ConsoleLevel.Warn,
                source: ConsoleSource.Call,
                args,
                stack: ''
            })
            dropped = 0
        }
    }

    const record = (level: ConsoleLevel, source: ConsoleSource, values: readonly unknown[], stack: string): void => {
        if (busy) {
            return
        }
        busy = true
        try {
            const time = context.now()
            const current = Math.floor(time / 1000)
            if (current !== second) {
                second = current
                count = 0
            }
            if (++count > settings.rate) {
                dropped++
                return
            }
            writeDropped()
            const args = values.slice(0, MAX_ARGS).map(value => preview(value, settings.maxLength))
            if (values.length > MAX_ARGS) {
                args.push(`… ${values.length - MAX_ARGS} more`)
            }
            context.write({ type: EventType.Console, level, source, args, stack }, time)
        } catch (error) {
            context.onError(error)
        } finally {
            busy = false
        }
    }

    const restores: (() => void)[] = []
    for (const method of settings.methods) {
        const original: unknown = Reflect.get(consoleObject, method)
        if (typeof original !== 'function') {
            continue
        }
        const level = LEVELS[method]
        const stacked = STACKED.has(method)
        const wrapper = function (this: unknown, ...args: unknown[]): unknown {
            if (active && !busy && (method !== 'assert' || !args[0])) {
                const values = method === 'assert' ? ['Assertion failed', ...args.slice(1)] : args
                // Called from here, so that the stack starts where the console method was called.
                const stack = stackOf(values) || (stacked ? callStack() : '')
                record(level, ConsoleSource.Call, values, stack)
            }
            return Reflect.apply(original, this, args)
        }
        Reflect.set(consoleObject, method, wrapper)
        restores.push(() => {
            // Script that wrapped the method meanwhile keeps the wrapper, which only calls the original now.
            if (Reflect.get(consoleObject, method) === wrapper) {
                Reflect.set(consoleObject, method, original)
            }
        })
    }

    if (settings.errors) {
        const onError = (event: Event): void => {
            // Errors of resources that fail to load do not reach the window, unless captured.
            if (!isErrorEvent(event)) {
                return
            }
            const { message, error, filename, lineno, colno } = event
            const at = filename ? `at ${filename}:${lineno}:${colno}` : ''
            const text = message || errorHead(error) || 'Script error.'
            record(ConsoleLevel.Error, ConsoleSource.Exception, [text], errorStack(error) || at)
        }
        const onRejection = (event: Event): void => {
            const reason: unknown = isRejectionEvent(event) ? event.reason : undefined
            record(ConsoleLevel.Error, ConsoleSource.Rejection, [reason], errorStack(reason))
        }
        target.addEventListener('error', onError)
        target.addEventListener('unhandledrejection', onRejection)
        restores.push(() => {
            target.removeEventListener('error', onError)
            target.removeEventListener('unhandledrejection', onRejection)
        })
    }

    return () => {
        active = false
        for (const restore of restores) {
            restore()
        }
        writeDropped()
    }
}

/** Duck-typed: the window recorded can be of another realm than this code. */
function isErrorEvent(event: Event): event is ErrorEvent {
    return 'message' in event
}

function isRejectionEvent(event: Event): event is PromiseRejectionEvent {
    return 'reason' in event
}

/** The stack of the first error among `values`, or empty. */
function stackOf(values: readonly unknown[]): string {
    for (const value of values) {
        const stack = errorStack(value)
        if (stack !== '') {
            return stack
        }
    }
    return ''
}

/** The stack of the caller of the function that calls this one. */
function callStack(): string {
    const lines = (new Error().stack ?? '').split('\n')
    // V8 starts with the error's name. The frames of this function and its caller come next.
    const start = lines[0] === 'Error' ? 3 : 2
    return lines
        .slice(start)
        .filter(line => line !== '')
        .join('\n')
}
