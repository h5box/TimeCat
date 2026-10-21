# @timecat-js/recorder

The TimeCat session recorder: it records what happens in a page (DOM changes, form input, pointer, scrolling, the
viewport and same-document navigation) as a TCR recording, which `@timecat-js/player-core` replays. The main thread
only reads the page and encodes what changed; compression and storage run in a worker.

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
stream; `export()` returns the recording so far without stopping.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `maskText` | none | Selector of elements whose text, their descendants' included, is recorded as asterisks. Whitespace is kept. |
| `block` | none | Selector of elements recorded as empty placeholders of the same size. |
| `ignore` | none | Selector of elements whose form input is not recorded, inside them included. |
| `unmaskInputs` | none | Selector of form controls whose values are recorded as typed. Every other value is masked, its length kept, and passwords are masked even when they match. |
| `storage` | `'memory'` | Where finished chunks are kept until `export` or `stop`: `'memory'`, or `'opfs'`, the origin private file system, where a recording outlives a crashed page. OPFS needs the worker. |
| `worker` | `true` | Where encoding, compression and storage run. `true` starts a worker from a bundled script through a `blob:` URL; a URL starts the worker script published as `@timecat-js/recorder/worker` from there; `false` uses the main thread. When a worker cannot start, the main thread takes over without losing data. |
| `sessionId` | random | Id shared by the segments of one session, such as the pages of one visit. |
| `segment` | `0` | Index of this page load within the session. |
| `meta` | `{}` | JSON data stored in the recording's header. |
| `onData` | none | Receives the header, then each chunk as it is finished. |
| `onError` | logs | Receives errors recording goes on after. |

### Recorder

| Member | |
| --- | --- |
| `sessionId` | The session's id. |
| `ready` | Settles once the initial snapshot is written. |
| `flush()` | Writes pending changes and finishes the open chunks, so storage and `onData` have everything so far. Recording also flushes when the page is hidden. |
| `export()` | The recording so far, as a `Blob`. Recording goes on. |
| `stop()` | Stops recording and returns the whole recording, as a `Blob`. |

## Privacy

Form values are masked unless `unmaskInputs` says otherwise, and passwords always are: masking happens in the page,
before anything is encoded, so what is masked never reaches the worker, storage or `onData`. The labels of buttons,
checkboxes and radio buttons, and which of them are checked, are recorded as they are. A `<select>` with a masked
value records no selection. Text in `<style>` elements is never masked, since that would break the CSS.

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
and `selected` setters. Pointer moves are batched into columns and written once a batch spans a second, by a timer:
a moving pointer costs no task per move.

**Encoding.** Events are encoded into the binary TCR format as they are written, with ids implied by the order of
nodes and strings shared through tables, and handed to the worker in batches, without a copy. The worker groups
events into chunks per track, compresses them where that pays, and keeps them in memory or OPFS.

## Content security policy

The default worker starts from a `blob:` URL, which needs `worker-src blob:`. Pages that do not allow it can serve
`@timecat-js/recorder/worker` (`dist/worker.js`, a self-contained script) and pass its URL as `worker`, or record on
the main thread.

## Browser support

Chrome and Edge 111, Firefox 115, Safari 16.4 and later.

## Limitations

- Frames and shadow roots inside the page are not recorded yet, nor canvas, video and audio content (M2).
- Style sheet changes made through the CSSOM (`insertRule`, constructed style sheets) are not recorded; changes to
  `<style>` and `<link>` elements are.
- Hover and focus states, text selection and the top layer (open dialogs and popovers) are not recorded.
- Script content is not recorded: replays never run it.

## License

GPL-3.0-or-later
