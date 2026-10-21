# @timecat-js/plugin-console

A plugin for `@timecat-js/recorder` that records what the page writes to the console, the errors no script caught
and the promise rejections no script handled. Players list them with the other events recorded beside the page
(`player.events` in `@timecat-js/player-core`).

> Pre-release. The API and the recording format may change without notice until 1.0.

## Usage

```ts
import { consolePlugin } from '@timecat-js/plugin-console'
import { record } from '@timecat-js/recorder'

const recorder = record({ plugins: [consolePlugin()] })
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `methods` | all | The `console` methods recorded: `debug`, `log`, `info`, `warn`, `error`, `assert` and `trace`. |
| `errors` | `true` | Records errors no script caught and promise rejections no script handled. |
| `maxLength` | `1000` | Longest text kept of one argument, in UTF-16 code units; longer ones are cut, with an ellipsis. |
| `rate` | `100` | Messages recorded in one second at most. The others are counted, and their number recorded as a warning. |

## What is recorded

Each message is recorded with its level, where it came from (a call, an uncaught error or an unhandled rejection),
its arguments and a stack. The console still gets the arguments as they are.

- **Arguments** are recorded as text, as a console previews them: strings as they are; numbers, booleans and the
  like as they print; errors as `Name: message`; elements as `<div id="a" class="b">`; arrays, objects, maps, sets
  and typed arrays with their entries, down to depth 3 and up to 100 entries each, with `[Circular]` for a reference
  to an object they are inside of. A property that throws as it is read shows the error instead. Format directives
  such as `%s` are kept as they are.
- **Stacks** are those of the first error among the arguments, or, for `warn`, `error`, `assert` and `trace`, the
  stack of the call. Uncaught errors have their error's stack, or where they were thrown.
- `assert` is recorded only when the assertion fails, as an error, with `Assertion failed` first.
- Messages logged while the plugin reads an argument, as by a getter, reach the console but are not recorded.

The plugin wraps the console methods of the window recorded, and listens to its `error` and `unhandledrejection`
events. It puts the methods back when recording stops, unless script wrapped them meanwhile: that script's wrapper
keeps calling the plugin's, which then only passes calls on.

## Privacy

Console messages can hold anything the page logs, user data included, and are recorded as they are: the recorder's
masking options apply to the page, not to the console. Use `methods` to leave out levels that carry such data.

## License

GPL-3.0-or-later
