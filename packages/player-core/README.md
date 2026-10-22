# @timecat-js/player-core

The TimeCat replay engine: it indexes a recording, seeks anywhere in it through keyframes and rebuilds the recorded
page in a sandboxed frame where no recorded script can run. It has no UI of its own; [`@timecat-js/player`](../player)
adds controls on top.

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

### Live playback

A `ReadableStream` of recording bytes plays as it comes, such as a stream the recorder's `onData` feeds through a
WebSocket or a `fetch` response: segments one after the other, like the files of a session.

```ts
const response = await fetch('/sessions/42/live')
const player = await createPlayer(response.body!, { container, autoplay: true })
player.addEventListener('durationchange', () => console.log(player.live, player.duration))
```

The player is ready once the stream gave something to show, and starts at its edge: the latest time up to which
everything is known, which the recorder's sync points move on every `latency` milliseconds. While `live`,
`duration` grows; playing on at the edge waits for more rather than ending. Once the stream ends, the player is no
longer live, and plays what came like a recording. A stream that fails ends there: its error goes to `onError`.

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
read, with a `RangeError` when segments of different sessions are mixed, and with the error of a stream that failed
before it gave anything to show. A recording that was cut off plays up
to where it ends, and `player.warnings` says what was left out.

### Player

| Member | |
| --- | --- |
| `sessionId`, `startedAt`, `meta` | From the recording's header. `startedAt` is in epoch milliseconds. |
| `duration`, `currentTime` | In milliseconds from the first recorded event. |
| `live` | More of the recording is to come, from a stream. |
| `hasMedia` | The recording has media to play: tracks of the plugins, such as narration and the video of canvases, or media elements whose playback state was recorded. |
| `paused`, `speed` | Playback state; `speed` can be changed while playing. |
| `volume`, `muted` | How loud recorded media and narration play, from 0 to 1, and whether they are silent. A browser that does not let them play with sound before the viewer interacted with the page makes the player mute itself. |
| `play()`, `pause()` | Play from the current time, or from the start once ended; while live, at the edge, wait for more. |
| `seek(time)` | Resolves once the replay shows `time`, or a later time asked for meanwhile. |
| `document` | The replayed document, to look at. Changing it breaks the replay. |
| `events` | What was recorded beside the page, in time order: console messages, requests and performance measurements of the plugins, and the events of the application. Each is `{ time, event }`, with `time` on the clock of `currentTime`; `event.type` is one of `EventType.Console`, `Network`, `Perf` and `Custom`, which this package exports. |
| `warnings` | Problems the recording was read despite. |
| `destroy()` | Stops playing and removes the replay from its container. |

It dispatches `play`, `pause`, `ended`, `timeupdate` (while playing and after each seek), `durationchange` (when
more of a live recording came, and when it ended) and `volumechange`.

## How it works

**Indexing.** A worker decompresses the recording's chunks, puts the events of all tracks and segments in one
timeline and returns it as transferable typed arrays: times, types, byte ranges of the event bodies and the cost of
applying each event. Segments play one after the other, at the offset their clocks give or after the previous one,
whichever is later. Pointer movement is kept apart, as columns the cursor is read from at any time. A stream is
indexed as it comes and handed on a part at a time, at most every 100 ms, which the player's timeline adds to its
columns. Since the tracks of a page end their chunks at different times, page events wait in the worker until a sync
chunk, or the end of their segment, says that no earlier one can come; then they are put in order.

**Keyframes.** While indexing, the worker applies the events to a plain-data model of the document. Once the events
since the last keyframe take enough work, it writes the model's state as a keyframe: a compressed snapshot that
keeps the recording's node ids, with form values, scroll positions and the rules that changed through the CSSOM on
top. Recorded snapshots are keyframes already. The model follows the DOM's rules, refusals included, so a keyframe
shows what applying the events before it shows: a second shadow root on a host is left out, and a `<style>` whose
children or type change parses its text anew, losing what the CSSOM changed.

**Seeking.** A seek goes forward through the events when that is cheaper than rebuilding, and otherwise restores
the last keyframe before the target and applies the events after it, so its cost is bounded by the keyframe interval
rather than by the length of the recording. Restoring a keyframe changes what the replay shows into it rather than
building the DOM anew: nodes with the same id stay, given the keyframe's attributes and text, and only what differs
is created, moved or removed. What stays costs no style, layout or paint, and its images and frames do not load
again. Form controls, scripts and `<style>` elements whose rules changed through the CSSOM are made anew, since they
hold state a keyframe does not describe.

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

**Canvases.** A document without scripts shows a canvas's fallback content rather than its bitmap, which leaves the
canvas with no size. So each replayed `<canvas>` gets a picture as the `content` of its style: what was drawn in it,
or an empty picture of its bitmap's size. The canvas then shows the picture, in the room the canvas took when it was
recorded.

**Interaction.** No one interacts with the replay, so its elements are in none of the states that interaction puts
them in. Instead, selectors with `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within` are rewritten to
select attributes, which the player sets on the elements in those states: the element recorded as focused, with
the hosts and ancestors that share its focus, and what the replay finds under the recorded pointer and where it
pressed. Recordings whose rules select neither pointer state cost no hit testing. Style sheets that `<link>`
elements load, but those the recording keeps, are fetched once more, which the browser's cache mostly serves, and
those that select a state are swapped for a rewritten copy once it has loaded, so nothing shows unstyled meanwhile;
this needs CORS, unless the player runs in an extension that may read the sheet's site. A focused element that shows
its focus gets an outline, as browsers draw one. The modal dialogs and popovers recorded in the top layer are put
there again, in the recorded order, without taking the focus from the page the player is in. This code loads in a
chunk of its own, while the recording is indexed, as does the code that serves the resources the recording keeps.

**In extensions.** Chrome adds a style sheet to every document of an extension, the replay's too, which sets the font
of `body`. When the replay's document has one, the player undoes it, so that the page's own rules decide the font, as
when it was recorded.

**Media.** The player's media code loads only for recordings that have some. Media packets are kept apart from the
events, per track. A video track encoded with WebCodecs is decoded with `VideoDecoder`, from the last key packet
before the time shown, and drawn into the replayed `<canvas>` it belongs to. A container track, such as what
`MediaRecorder` made, plays through Media Source Extensions, or from a blob made anew now and then where those do
not take its type: in the replayed `<audio>` or `<video>` it belongs to, or in an element of the player's own, whose
frames are drawn into the replayed `<canvas>` it belongs to, and which plays a narration that belongs to no element.
Replayed media elements without a track of their own follow their recorded playback state: position, rate, volume
and whether they play, from their source URL. Media follow the replay's time, speed, volume and muting.

**URLs.** Relative URLs resolve against the recorded page's URL, or its first `<base>` element, through a `<base>`
element the player keeps first in the head. Images, styles, fonts and media load from where the recorded page had
them, except what the recording keeps: the content of `blob:` URLs, which lived only in the recorded page, and the
`http:` and `https:` resources that a recorder such as the [TimeCat extension](../../apps/extension) downloaded.
Those are served from `blob:` URLs the player makes, wherever the replay refers to them, relative URLs included: in
`src`, `srcset`, `poster`, the `href` of `<link>` and SVG elements, inline styles, style sheets and their rules. A
recorded style sheet is served with the URLs in it replaced in turn, and the states of interaction rewritten; a
`srcset` keeps the candidates recorded, when there are any, so the replay shows what the page did. The font faces
scripts added are added to every replayed document.

## Content security policy

The default worker starts from a `blob:` URL, which needs `worker-src blob:`. Pages that do not allow it can serve
`@timecat-js/player-core/worker` (`dist/worker.js`, a self-contained script) and pass its URL as `worker`, or index
on the main thread.

The replay frame inherits the policy of the page it is in. For the recorded page to look right, that policy has to
allow its styles, inline ones included (`style-src 'unsafe-inline'`, or `style-src-elem` and `style-src-attr`), and
the images and fonts it loads, `blob:` ones included where the recording carries `blob:` content. Linked style sheets
are fetched again by the player, which needs `connect-src` to allow their URLs, and those rewritten for the states
of interaction load from `blob:` URLs (`style-src blob:`); without either, they stay as they are. The player's own
styles need nothing: they are constructed style sheets.

## Browser support

The last two versions of Chrome, Edge, Firefox and Safari.

## Limitations

- Frames the recorder could not read, such as cross-origin ones, show a blank page.
- Canvas content shows only where `@timecat-js/plugin-canvas` recorded it (other canvases keep their size, empty),
  and the pixels of a `<video>` only where `@timecat-js/plugin-media` captured them; otherwise media elements play their own source again. Audio tracks
  encoded with WebCodecs are not played.
- Resources the recording does not keep load at replay time: whatever has changed or gone since, or does not allow
  cross-origin use (fonts without CORS headers, for example), shows differently.
- Text selection is not shown. The states of interaction show as when no one interacts with the page in style
  sheets the player cannot fetch again (cross-origin ones without CORS headers, outside an extension that may read
  them), in sheets that `@import` rules load, unless the recording keeps them, and after pseudo-elements, as in
  `::part(label):hover`. What is under
  the pointer is what is under it in the replay, which differs where the layout does.
- A relative `<base href>` resolves against the page URL at the time shown; browsers keep resolving it against the
  URL the page had when the element was added.
- Recorded attributes with names the DOM does not accept are left out, and elements with such names are replaced
  by `<timecat-invalid>` so their content still shows.
- Firefox parses the text of a `<style>` anew when its `media` or `title` changes, losing what the CSSOM changed;
  keyframes keep those changes, so after a seek such a sheet may show them.
- After a seek, CSS transitions of the elements that stayed may run from what was shown before.

## License

GPL-3.0-or-later
