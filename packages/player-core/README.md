# @timecat-js/player-core

The TimeCat replay engine: it indexes a recording, seeks anywhere in it through keyframes and rebuilds the recorded
page in a sandboxed frame where no recorded script can run. It has no UI of its own; `@timecat-js/player` (M2) adds
controls on top.

> Pre-release. The API and the recording format may change without notice until 1.0.

## Usage

```ts
import { createPlayer } from '@timecat-js/player-core'

// A recording from `@timecat-js/recorder`: a Blob, an ArrayBuffer or a view of one, or several segments of a session.
const player = await createPlayer(recording, { container: document.querySelector('#replay')! })

player.addEventListener('timeupdate', () => console.log(player.currentTime, '/', player.duration))
player.play()
await player.seek(30_000) // milliseconds from the first recorded event
player.destroy()
```

The replay fills the container, scaled to fit with the recorded proportions. A container without a height of its
own takes the proportions of the recorded viewport.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `container` | required | Element the replay fills. It must be in the document. |
| `worker` | `true` | Where the recording is indexed. `true` starts a worker from a bundled script through a `blob:` URL; a URL starts the worker script published as `@timecat-js/player-core/worker` from there; `false` indexes on the main thread. When a worker cannot start, the main thread takes over. |
| `keyframeInterval` | `2000` | How much work, counted in nodes and changes, the events between two keyframes may take, or half the size of the document if that is more. Smaller values make seeking faster and use more memory. |
| `speed` | `1` | Playback rate. |
| `autoplay` | `false` | Starts playing once loaded. |
| `onError` | logs | Receives errors playback goes on after, such as an event that does not apply. |

`createPlayer` rejects with a `TcrDecodeError` (exported from this package) when a source is not a recording it can
read, and with a `RangeError` when segments of different sessions are mixed. A recording that was cut off plays up
to where it ends, and `player.warnings` says what was left out.

### Player

| Member | |
| --- | --- |
| `sessionId`, `startedAt`, `meta` | From the recording's header. `startedAt` is in epoch milliseconds. |
| `duration`, `currentTime` | In milliseconds from the first recorded event. |
| `paused`, `speed` | Playback state; `speed` can be changed while playing. |
| `play()`, `pause()` | Play from the current time, or from the start once ended. |
| `seek(time)` | Resolves once the replay shows `time`, or a later time asked for meanwhile. |
| `document` | The replayed document, to look at. Changing it breaks the replay. |
| `warnings` | Problems the recording was read despite. |
| `destroy()` | Stops playing and removes the replay from its container. |

It dispatches `play`, `pause`, `ended` and `timeupdate` (while playing and after each seek).

## How it works

**Indexing.** A worker decompresses the recording's chunks, puts the events of all tracks and segments in one
timeline and returns it as transferable typed arrays: times, types, byte ranges of the event bodies and the cost of
applying each event. Segments play one after the other, at the offset their clocks give or after the previous one,
whichever is later. Pointer movement is kept apart, as columns the cursor is read from at any time.

**Keyframes.** While indexing, the worker applies the events to a plain-data model of the document. Once the events
since the last keyframe take enough work, it writes the model's state as a keyframe: a compressed snapshot that
keeps the recording's node ids, with form values, scroll positions and the rules that changed through the CSSOM on
top. Recorded snapshots are keyframes already. The model follows the DOM's rules, refusals included, so a keyframe
shows what applying the events before it shows: a second shadow root on a host is left out, and a `<style>` whose
children or type change parses its text anew, losing what the CSSOM changed.

**Seeking.** A seek goes forward through the events when that is cheaper than rebuilding, and otherwise builds the
DOM from the last keyframe before the target and applies the events after it, so its cost is bounded by the keyframe
interval rather than by the length of the recording.

**Shadow trees and frames.** Shadow roots are attached again, open whatever their recorded mode. The documents of
frames are built from the recording into the frames' own blank documents, in the recorded mode and with the frame's
recorded URL for relative URLs; a frame whose document the recording does not have shows a blank page.

**Style sheets.** Rules that script changed through the CSSOM are changed the same way in the replay. A rule this
browser does not parse is replaced by one that never applies, so the indexes of later changes still match. Sheets
made with `new CSSStyleSheet()` are made again for each replayed document that adopts them, since a document can
adopt only the sheets of its own window.

**Safety.** The replay is built in an `<iframe sandbox="allow-same-origin">`: without `allow-scripts`, nothing
recorded runs, whatever it contains. Frames in it inherit the sandbox. On top of that, the replayed documents have a
content security policy that allows no scripts, plugins, frames, workers or form submissions, and recorded
attributes are filtered: event handlers, `javascript:` URLs, `autofocus`, `autoplay`, refreshes and other
`http-equiv` directives, referrer policies, the sources of frames, objects and embeds, and the `sandbox` and `csp`
of frames are left out. Scripts are kept, with a type no browser runs. The frame is `inert` and covered by a shield,
so the viewer's clicks and keys never reach the recorded page.

**URLs.** Relative URLs resolve against the recorded page's URL, or its first `<base>` element, through a `<base>`
element the player keeps first in the head. Images, styles and fonts load from where the recorded page had them,
except what lived only in the recorded page: the content of its `blob:` URLs comes from the recording, served from
`blob:` URLs the player makes, and the font faces its scripts added are added to every replayed document.

## Content security policy

The default worker starts from a `blob:` URL, which needs `worker-src blob:`. Pages that do not allow it can serve
`@timecat-js/player-core/worker` (`dist/worker.js`, a self-contained script) and pass its URL as `worker`, or index
on the main thread.

The replay frame inherits the policy of the page it is in. For the recorded page to look right, that policy has to
allow its styles, inline ones included (`style-src 'unsafe-inline'`, or `style-src-elem` and `style-src-attr`), and
the images and fonts it loads, `blob:` ones included where the recording carries `blob:` content. The player's own
styles need nothing: they are constructed style sheets.

## Browser support

The last two versions of Chrome, Edge, Firefox and Safari.

## Limitations

- Frames the recorder could not read, such as cross-origin ones, show a blank page, and canvas, video and audio
  content is not replayed.
- Resources load at replay time: whatever has changed or gone since, or does not allow cross-origin use (fonts
  without CORS headers, for example), shows differently.
- States the recording does not capture are not shown: `:hover` and focus styles, open dialogs and popovers in the
  top layer, text selection.
- A relative `<base href>` resolves against the page URL at the time shown; browsers keep resolving it against the
  URL the page had when the element was added.
- Recorded attributes with names the DOM does not accept are left out, and elements with such names are replaced
  by `<timecat-invalid>` so their content still shows.
- Firefox parses the text of a `<style>` anew when its `media` or `title` changes, losing what the CSSOM changed;
  keyframes keep those changes, so after a seek such a sheet may show them.

## License

GPL-3.0-or-later
