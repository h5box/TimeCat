# @timecat-js/player

The TimeCat player: `<timecat-player>`, a web component that plays a recording with controls, a timeline that marks
errors and the events of the application, and a panel listing what was recorded beside the page. It also writes a
recording as one HTML file that plays it anywhere, with nothing to install or fetch. Built on
[`@timecat-js/player-core`](../player-core) and [Lit](https://lit.dev), so it works in any page or framework.

> Pre-release. The API and the recording format may change without notice until 1.0.

## Usage

```ts
import '@timecat-js/player'
```

```html
<timecat-player src="/recordings/session.tcr" style="height: 600px"></timecat-player>
```

Or give it the recording `@timecat-js/recorder` returned:

```ts
const player = document.querySelector('timecat-player')!
player.recording = await recorder.stop()
player.addEventListener('load', () => player.play())
```

A stream of a recording, such as one the recorder's `onData` feeds through a WebSocket or a `fetch` response, plays
live, from its latest moment:

```ts
const response = await fetch('/sessions/42/live')
player.recording = response.body!
```

A stream is read once: the element cannot load it again when it is moved, and dispatches `error` then.

Without a bundler, load the element as one classic script: `@timecat-js/player/standalone`
(`dist/timecat-player.js`), which has all it needs.

### Attributes and properties

| | Default | Meaning |
| --- | --- | --- |
| `src` | none | URL of the recording, or URLs of its segments separated by spaces. |
| `recording` (property) | none | The recording: a Blob, an ArrayBuffer or a view of one, the segments of a session, or a `ReadableStream` of a recording, which plays live. It takes the place of `src`. |
| `autoplay` | `false` | Starts playing once loaded. |
| `speed` | `1` | Playback rate. The controls offer 0.5 to 8. |
| `volume` | `1` | Volume of the recorded media and narration, from 0 to 1. |
| `muted` | `false` | Mutes the recorded media and narration. The player mutes itself when the browser lets them play with no sound only. |
| `panel` | `false` | Shows the panel of events recorded beside the page. |
| `worker` (property) | `true` | Where the recording is indexed, as `createPlayer`'s `worker` option. |

Without `recording` or `src`, the element plays the segments its `<script type="application/x-timecat-recording">`
children hold in base64, which is how exported pages carry them.

| Member | |
| --- | --- |
| `play()`, `pause()` | Before the recording is loaded, `play()` plays it once it is. |
| `seek(time)` | Resolves once the replay shows `time`, in milliseconds from the first recorded event. |
| `currentTime`, `duration`, `paused` | Playback state, `0`, `0` and `true` until loaded. |
| `live` | More of the recording is to come, from a stream: `duration` grows as it does. |
| `player` | The `Player` of `@timecat-js/player-core` once loaded, for the recording's metadata, its `events` and the replayed `document`. |

The element dispatches `load` once it shows a recording, `error` (an `ErrorEvent`) when it cannot, and `play`,
`pause`, `ended`, `timeupdate`, `durationchange` and `volumechange` as its player does. A new `src` or `recording` loads again, and so does moving
the element, since that reloads its frame; removing it lets go of the replay.

### Controls

Space or `k` plays and pauses, `m` mutes, the arrow keys move 5 seconds, Home and End go to the start and the end.
Clicking the replay plays or pauses it; the timeline seeks where it is pressed and while dragged. Its marks are
console errors, failed requests and the events of the application.

A recording with media, such as videos, the video of canvases or narration, has a mute button and a volume slider.
Browsers that let media play with sound only once the viewer interacted with the page make the player mute itself;
a button on the replay unmutes it. A live recording shows a Live badge, red while it plays at the edge of what came;
away from it, as after pausing or seeking back, the badge goes back to the edge.

The events panel lists console messages, requests, performance measurements and the events of the application, as
the plugins and `addEvent` recorded them, by kind and with a search; those already played stand out. Choosing one
seeks to it and shows all of it: arguments and stack, the request's facts, or the event's data.

### Styling

The player is light or dark as the system prefers; setting `color-scheme` on the element chooses one. Its colors
are custom properties:

| Property | |
| --- | --- |
| `--timecat-accent` | Progress, focus rings. |
| `--timecat-background`, `--timecat-color`, `--timecat-muted`, `--timecat-border`, `--timecat-hover` | Controls and panel. |
| `--timecat-screen` | Around the replay, where its proportions leave room. |
| `--timecat-error`, `--timecat-warn`, `--timecat-custom` | Errors, warnings and the events of the application. |
| `--timecat-panel-width` | Width of the panel, `340px` by default. In a player narrower than 640px, it covers the replay. |

The parts `stage`, `controls`, `timeline` and `panel` can be styled with `::part()`. A player without a height of
its own takes the proportions of the recorded viewport.

## Export to HTML

```ts
import { exportHtml } from '@timecat-js/player/export'

const page = await exportHtml(recording, { title: 'Checkout failed' })
const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(page), download: 'replay.html' })
link.click()
```

`exportHtml(recording, options)` resolves with a `text/html` Blob: a page with the standalone element and the
segments in base64, a third larger than the recording plus about 120 kB of script, which plays the recording when
opened from a disk, a mail or any server. It rejects with a `TcrDecodeError` for a segment that is not a recording, and
with a `RangeError` for segments of different sessions. The element's script loads on the first call, so importing
`exportHtml` costs little until then.

| Option | Default | Meaning |
| --- | --- | --- |
| `title` | when recording started | The page's title. |
| `autoplay` | `false` | Starts playing once the page opens. |

## Content security policy

The element's styles are constructed style sheets and need nothing. The replay needs what `@timecat-js/player-core`
describes: `worker-src blob:` for the default worker, or a `worker` URL, and styles, images and fonts of the
recorded page.

## Browser support

The last two versions of Chrome, Edge, Firefox and Safari.

## License

GPL-3.0-or-later
