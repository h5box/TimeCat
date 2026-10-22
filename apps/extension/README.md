# @timecat-js/extension

TimeCat for Chrome: records a tab with the toolbar button, across the pages it goes to, and replays it with its
console, requests and performance beside the page. Recordings stay in the browser, in the extension's own storage,
until you export or delete them.

> Pre-release, not on the Chrome Web Store. The recording format may change, and recordings made by one version may
> not play in the next.

## Install

The extension is built from the workspace's sources, so nothing needs building first:

```bash
pnpm install
pnpm --filter @timecat-js/extension build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick `apps/extension/dist`.
After a rebuild, press the reload button on the extension's card. Chrome 120 or later.

## Use

- **Record:** click the toolbar button and **Start recording**, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>
  (change it at `chrome://extensions/shortcuts`). The button shows **REC** while the tab records. The recording goes
  on as the tab goes to other pages, reloads or goes back; each page is recorded on its own and played one after the
  other.
- **Stop:** the same button or keys. The recording opens in a new tab. Closing the tab stops its recording too.
- **What is recorded:** the popup sets it for the recordings to come. The images, style sheets, fonts and media the
  pages load, console messages and errors, requests and performance (Web Vitals, long animation frames) are on;
  canvases and the pictures of videos, which take much more room, are off. What is typed into fields is masked, its length kept, unless **What is typed into fields** is on;
  passwords always are. **Mask all text of pages** records the page's text as asterisks, keeping its spaces.
- **Recordings:** **All recordings** in the popup lists them, newest first. Each one can be played, exported as one HTML
  file that plays anywhere with nothing to install, downloaded as a `.tcr` file for
  [`@timecat-js/player`](../../packages/player), or deleted.

- **Offline:** the images, style sheets, fonts, audio and video the pages load are downloaded while recording, into
  the recording, so it plays as the pages looked then, without the network, from the extension or as an exported
  HTML file. Downloads go after the page's own requests, with the cookies of the page's site for its own resources,
  as the page sent them; a resource of another site is downloaded without cookies. Each file is kept up to 10 MB, or
  20 MB for audio and video, and a recording up to 100 MB in all; what is left out loads from the network when the
  recording plays. Stopping waits up to 10 seconds for downloads still going on.

## How it works

| Part | Where it runs | What it does |
| --- | --- | --- |
| `background.ts` | Service worker | Keeps which tabs record in `chrome.storage.session`; injects the recorder into each page the tab shows; stores what it records in IndexedDB |
| `bridge.ts` | Content script, isolated world | Connects the page to the service worker: says which page it is, starts and stops the recorder, passes on what it records |
| `main.ts` | Content script, the page's world | [`@timecat-js/recorder`](../../packages/recorder) and its plugins, which wrap the page's `console`, `fetch` and DOM methods, so they run where the page does; `resources.ts` finds the URLs of the resources the page and its same-origin frames load, from resource timing |
| `downloads.ts` | Service worker | Downloads those resources into the recording, as Asset events on its `Assets` track |
| `popup.ts` | Toolbar popup | Starts and stops the tab's recording; what to record |
| `recordings.ts`, `player.ts` | Pages of the extension | The list of recordings, and [`<timecat-player>`](../../packages/player) with export, download and delete |

Each page the tab shows is a segment of the recording: the recorder streams it with `onData` once a second, and the
segments, one after the other, are the recording, as the player and the `.tcr` file take it. The resources downloaded
for a page are chunks of its segment too, after what the recorder gave; each resource is kept once per recording. Chrome stops the service
worker when it has nothing to do; the bridge then reconnects and the page goes on recording as the same segment.

The bridge is registered for every page while a tab records, at `document_start`, so a page the tab goes to is
recorded from its start, and pages of other tabs check in and are told they don't record.

## Limitations

- The recorder starts a few messages after the page does, so the requests and logs of the page's first moments may be
  missing.
- Frames from other origins are not recorded (frames from the page's own origin are).
- There is no narration: the extension has no microphone permission.
- The page shares its world with the recorder, so it could see or change what is recorded, and have resources
  downloaded that it did not load. Record pages you trust.
- Resources are found from resource timing, so those that loaded before recording started are missing once a page
  loaded more than its buffer holds (250 by default). What scripts fetch, scripts themselves and documents are not
  downloaded, nor what streams through Media Source Extensions. A server may answer the extension's request
  differently from the page's, such as by its `Referer`, which the extension does not send.
- Chrome's own pages (`chrome://`), the Web Store and other extensions' pages cannot be recorded.

## Development

```bash
pnpm --filter @timecat-js/extension build   # into dist/
pnpm --filter @timecat-js/extension icons   # icons/*.png from assets/icon.svg
pnpm test:extension                         # the built extension in Chromium, driven by Playwright
```

The tests need Chromium itself rather than the headless shell, as Chromium loads extensions only there: set
`CHROMIUM_EXECUTABLE_PATH`, or install it with `pnpm exec playwright install chromium`.
