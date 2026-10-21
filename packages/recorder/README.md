# @timecat-js/recorder

The TimeCat session recorder: it records what happens in a page (DOM and style sheet changes, form input, pointer,
scrolling, the viewport and same-document navigation), its shadow trees and same-origin frames included, as a TCR
recording, which `@timecat-js/player-core` replays. Fonts that script adds, and the content of `blob:` URLs, which is
gone with the page, are recorded too. The main thread only reads the page and encodes what changed; compression and
storage run in a worker.

> Pre-release. The API and the recording format may change without notice until 1.0.

## Usage

```ts
import { record } from '@timecat-js/recorder'

const recorder = record({
    maskText: '.private', // text shown as asterisks
    onData: bytes => upload(bytes) // the recording while it is written, chunk by chunk
})

await recorder.ready // the first snapshot is written
const blob = await recorder.stop() // the whole recording, as a TCR file
```

Recording starts when `record` is called, which throws for invalid options, such as a selector that does not
parse. The concatenation of what `onData` receives is a complete recording, so it can feed an upload or a live
stream, which `@timecat-js/player-core` plays as it comes; `export()` returns the recording so far without
stopping.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `maskText` | none | Selector of elements whose text, their descendants' included, is recorded as asterisks. Whitespace is kept. |
| `block` | none | Selector of elements recorded as empty placeholders of the same size. |
| `ignore` | none | Selector of elements whose form input is not recorded, inside them included. |
| `unmaskInputs` | none | Selector of form controls whose values are recorded as typed. Every other value is masked, its length kept, and passwords are masked even when they match. |
| `assetBudget` | 8 MiB | Bytes of `blob:` content and of fonts given as bytes that the recording keeps, all together. Content that does not fit in what is left is not recorded; `0` records none. |
| `storage` | `'memory'` | Where finished chunks are kept until `export` or `stop`: `'memory'`, or `'opfs'`, the origin private file system, where a recording outlives a crashed page. OPFS needs the worker. |
| `worker` | `true` | Where encoding, compression and storage run. `true` starts a worker from a bundled script through a `blob:` URL; a URL starts the worker script published as `@timecat-js/recorder/worker` from there; `false` uses the main thread. When a worker cannot start, the main thread takes over without losing data. |
| `sessionId` | random | Id shared by the segments of one session, such as the pages of one visit. |
| `segment` | `0` | Index of this page load within the session. |
| `meta` | `{}` | JSON data stored in the recording's header. |
| `plugins` | none | Plugins that record more than the page, such as console messages (see [Plugins](#plugins)). |
| `onData` | none | Receives the header, then each chunk as it is finished, and every `latency` a sync chunk that tells live players how far they can play. |
| `latency` | `5000` | Milliseconds it takes at most until what was recorded is stored, and with `onData`, until a live player can play it. Chunks end at least this often, so lower values make a larger recording; at least `100`. |
| `onError` | logs | Receives errors recording goes on after. |

### Recorder

| Member | |
| --- | --- |
| `sessionId` | The session's id. |
| `ready` | Settles once the initial snapshot is written. |
| `addEvent(name, data)` | Records an event of the application's own, such as a user signing in, with data that `JSON.stringify` takes; throws for data it does not. Players list these events with the plugins'. |
| `flush()` | Writes pending changes and finishes the open chunks, so storage and `onData` have everything so far, and live players can play it. Recording also flushes when the page is hidden. |
| `export()` | The recording so far, as a `Blob`. Recording goes on. |
| `stop()` | Stops recording and returns the whole recording, as a `Blob`. |

## Plugins

Plugins record what happens beside the page, each on a track of its own:

| Package | Records |
| --- | --- |
| [`@timecat-js/plugin-console`](../plugin-console) | Console messages, uncaught errors and unhandled promise rejections. |
| [`@timecat-js/plugin-network`](../plugin-network) | Requests made with `fetch`, `XMLHttpRequest` and `sendBeacon`, and the resources the page loads. |
| [`@timecat-js/plugin-perf`](../plugin-perf) | LCP, CLS, INP, FCP, TTFB and long animation frames. |
| [`@timecat-js/plugin-canvas`](../plugin-canvas) | What 2D and WebGL canvases show, as video. |
| [`@timecat-js/plugin-media`](../plugin-media) | How `<audio>` and `<video>` elements play, what videos show, and narration from the microphone. |

```ts
import { consolePlugin } from '@timecat-js/plugin-console'
import { networkPlugin } from '@timecat-js/plugin-network'

const recorder = record({ plugins: [consolePlugin(), networkPlugin()] })
```

A plugin is an object with a `name` and a `start(context)` method, called right after recording starts, which
returns a function that stops it, called when recording stops; that function can still write events, such as
measurements that were not final, and can return a promise, until which it can write, such as for an encoder to
flush (recording waits for it up to 2 seconds). The context gives the window recorded, the recording's clock
(`now()`, and `time()` for a `performance.now()` time such as a performance entry's, `microseconds()` for media
packets), `write(event, time?)` for Console, Network, Perf, Custom and MediaState events, `openMedia(format)` for a
media track, whose packets the writer it returns writes, `ready`, which settles once the first snapshot gave the
page's nodes their ids, `nodeId(node)` for the id a recorded node has in the recording, `blocks(element)` for whether
the `block` option leaves out what an element holds, which a plugin that records what elements show leaves out too,
`observeRoots(callback)` for the documents and shadow roots recorded, now and as they come, and `onError`. Errors a
plugin throws as it starts or stops go to `onError`, and recording goes on.

`recordStream(context, stream, options)` records a `MediaStream` with `MediaRecorder` into a container track: a
file, written every `timeslice` milliseconds (1000 by default), in the first of `types` the browser records. It
returns the track's writer and `stop()`, which settles once the last bytes are written; passing that writer as
`writer` goes on with the same track, as a new file.

## Privacy

Form values are masked unless `unmaskInputs` says otherwise, and passwords always are: masking happens in the page,
before anything is encoded, so what is masked never reaches the worker, storage or `onData`. The labels of buttons,
checkboxes and radio buttons, and which of them are checked, are recorded as they are. A `<select>` with a masked
value records no selection. Text in `<style>` elements is never masked, since that would break the CSS.

The regions `maskText` and `ignore` select take in the shadow trees and frames inside them. Selectors match within
each tree, as CSS does: `.private p` does not reach a paragraph in a shadow tree below `.private`, but `.private`
covers it.

## How it works

**Snapshot.** Recording starts with a snapshot of the document, taken in slices of 8 ms with the page's own work in
between (`scheduler.yield`, or a message task where that is missing), so a large page causes no long task. A
mutation observer is attached first: nodes that move or appear while the snapshot is taken are left to the changes
written right after it.

**Changes.** Mutations, form state, scroll offsets, the viewport size and the URL are collected and written in a task
of their own once the task that changed them ends, or once the frame renders when animation frame callbacks changed
them, so every frame's changes are written. They are coalesced: however often a node, an attribute or a text changed
in between, what is written is where it ended up, once, and a node added and removed again in between is left out.
Script changes to form controls, which fire no event, are caught by wrapping the `value`, `checked`, `selectedIndex`
and `selected` setters, in the page's realm and in each of its frames'. Pointer moves are batched into columns and
written once a batch spans a second, by a timer: a moving pointer costs no task per move.

**Shadow trees and frames.** Shadow roots and the documents of same-origin frames are written with their hosts and
frames, and observed from then on. Shadow roots that script attaches are caught by wrapping `attachShadow`, which is
also the only way to reach closed ones; declarative shadow roots that the parser attaches to hosts already written
are looked for once a document is parsed. Frames are checked for a new document whenever changes are written and
when they load; a document the recorder cannot read, as a cross-origin one, leaves the frame empty. Pointer
positions in frames are converted to the page's viewport.

**Style sheets, fonts and `blob:` content.** Changes that script makes to style sheets through the CSSOM are caught
by wrapping `insertRule`, `deleteRule` and the other methods that change rules, in each realm. A sheet is written
whole the first time, then as the top-level rules inserted and deleted; a rule changed inside, as by `setProperty`,
is written as deleted and inserted again. A sheet is written whole again when that is no longer than its changes,
when changes made where no wrapper sees them leave the rules apart, and when a change to the children of a `<style>`
element whose sheet script changed makes the browser parse its text anew: the replay may never see that change, if
it was undone before it was written. `<style>` elements without text, whose rules script inserted as CSS-in-JS
libraries do, are written whole with the snapshot. Constructed sheets are written once a
document or shadow root adopts them, which wrapping `adoptedStyleSheets` reports. Font faces that script makes and
adds to a document's fonts are written with their source, URLs made absolute. The `blob:` URLs in what is written
(attributes, style text, rules and font sources) are read in the background, once each, and written as assets that
replays serve in their place; `export()` and `stop()` wait for those reads.

**Encoding.** Events are encoded into the binary TCR format as they are written, with ids implied by the order of
nodes and strings shared through tables, and handed to the worker in batches, without a copy. The worker groups
events into chunks per track, compresses them where that pays, and keeps them in memory or OPFS. Media packets go
the same way, into chunks of their own that start at key frames and are not compressed.

**Live streams.** Chunks of different tracks end at different times, so a player that plays a recording as it comes
needs to know how far it is complete. With `onData`, the page writes a sync point every `latency`, and when it is
hidden or flushed: it writes what changed and the pointer moves collected so far, and the worker then ends every
open chunk and writes a sync chunk, which promises that no event of the page earlier than its time comes later.

## Content security policy

The default worker starts from a `blob:` URL, which needs `worker-src blob:`. Pages that do not allow it can serve
`@timecat-js/recorder/worker` (`dist/worker.js`, a self-contained script) and pass its URL as `worker`, or record on
the main thread.

## Browser support

Chrome and Edge 111, Firefox 115, Safari 16.4 and later.

## Limitations

- Cross-origin frames are recorded empty, and canvas, video and audio content is not recorded.
- Closed shadow roots attached before recording started or in a frame before its document was recorded, and
  closed declarative shadow roots, are not recorded: nothing outside them can reach them.
- Pointer positions in frames ignore CSS transforms of the frames.
- `document.open()` on the page itself keeps the page's mode (quirks or standards) as the snapshot found it; frames
  are written anew in their new mode.
- The sheets of `<style>` elements with text are taken to hold the rules of their text: CSSOM changes made to them
  before recording started, or in a frame before its document was recorded, are not recorded. Changes made through
  the CSSOM to the sheets of `<link>` elements and `@import` rules are not recorded.
- Changes to the declarations of rules through named properties, as `rule.style.color = 'red'`, are not recorded;
  `setProperty`, `removeProperty` and `cssText` are.
- Script that keeps the array of `adoptedStyleSheets` and changes it in a later task is seen once script reads or
  sets `adoptedStyleSheets` again.
- Font faces made before recording started, or in a frame before its document was recorded, are not recorded.
- `blob:` content beyond `assetBudget`, and media source URLs, are not recorded.
- Hover and focus states, text selection and the top layer (open dialogs and popovers) are not recorded.
- Script content is not recorded: replays never run it.

## License

GPL-3.0-or-later
