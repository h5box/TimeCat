# @timecat-js/plugin-canvas

A plugin for `@timecat-js/recorder` that records what the page's canvases show, 2D and WebGL alike, as video.
`@timecat-js/player-core` draws the video into the replayed canvases.

> Pre-release. The API and the recording format may change without notice until 1.0.

## Usage

```ts
import { canvasPlugin } from '@timecat-js/plugin-canvas'
import { record } from '@timecat-js/recorder'

const recorder = record({ plugins: [canvasPlugin()] })
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `fps` | `15` | Frames recorded of a canvas in a second at most. Frames come only as the canvas changes, so a still canvas costs nothing. |
| `keyframeInterval` | `3000` | Longest time between key frames, in milliseconds, which seeking decodes from: longer times make recordings smaller and seeking slower. |
| `maxSize` | `1920` | Largest width and height of the video. Larger canvases are scaled down. |
| `bitrate` | by size | Bits per second of the video of a canvas: by default 0.05 bits per pixel of each frame at `fps`, and at least 100 kbps. |
| `codecs` | VP9, AV1, H.264, VP8 | WebCodecs codec strings tried in order. The first `VideoEncoder` supports is used. |

## How it works

Each canvas is captured as a stream (`captureStream`), which gives a frame each time the canvas changes, up to
`fps` a second: what it shows, also for WebGL canvases whose drawing buffer is cleared once shown. Where the
browser can take frames of a stream (`MediaStreamTrackProcessor`) and has a `VideoEncoder` for one of `codecs`, as
Chrome and Edge do, the frames are encoded in real-time mode into a media track of encoded chunks, with a key frame
at least every `keyframeInterval` while the canvas changes; packets go into the recording as they are encoded, so
live players show them right away. Elsewhere, as in Firefox and Safari, `MediaRecorder` records the stream into a
WebM or MP4 file, written every second. A canvas that changes size starts a new format, or file, at its new size.

The page is looked through for canvases twice a second, in its documents, the documents of same-origin frames and
shadow trees, so a canvas is recorded from shortly after it is added until it is removed; one that comes back goes
on in the same track. Canvases the recorder's `block` option covers are not recorded, nor are those inside a
blocked element.

## Limitations

- A canvas that shows content of other origins cannot be captured: it is not recorded, and `onError` says so once.
- A WebGL canvas that does not change while it is recorded is recorded from when it is drawn next: what it showed
  before is gone from its drawing buffer, unless the context was made with `preserveDrawingBuffer`.
- With `MediaRecorder`, the file starts with the first frame the canvas gives, so the video of a canvas that does not
  change when recording starts may show early on replay.

## License

GPL-3.0-or-later
