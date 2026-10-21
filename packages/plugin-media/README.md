# @timecat-js/plugin-media

A plugin for `@timecat-js/recorder` that records audio and video: how the page's `<audio>` and `<video>` elements
play, optionally what videos show, and optionally narration from the microphone. `@timecat-js/player-core` plays
the replayed elements along, and the narration with the replay.

> Pre-release. The API and the recording format may change without notice until 1.0.

## Usage

```ts
import { mediaPlugin } from '@timecat-js/plugin-media'
import { record } from '@timecat-js/recorder'

const recorder = record({ plugins: [mediaPlugin({ pixels: 'video.stream', narration: true })] })
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `state` | `true` | Records the playback state of `<audio>` and `<video>` elements: playing or not, position, rate, volume and muting. Players play the replayed elements along, from the sources the page had. |
| `pixels` | `false` | Records what `<video>` elements show and play, as video: `true` for every video, or a CSS selector of the videos. For sources a replay cannot load again, such as the `blob:` URLs of streaming players. |
| `pixelsBitrate` | the browser's | Bits per second of the video recorded of a `<video>`. |
| `narration` | `false` | Records narration that plays with the replay: `true` for the microphone, or a `MediaStream` of the page's, or a function that gives one. |
| `narrationBitrate` | `32000` | Bits per second of the narration. |

## How it works

The state of an element is written each time it plays, pauses, waits for data, seeks, ends, changes rate or volume,
or loads a source, and once for each element when recording starts; an element that waits for data is recorded as
paused until it plays on. Players replay the element with the source it had and follow the state, so the replay
plays, seeks and pauses with the recording; nothing of the sound or the picture is recorded, which keeps recordings
small.

With `pixels`, a video is captured as a stream (`captureStream`) once it first plays, and `MediaRecorder` records the
stream into a WebM or MP4 file of a media track that belongs to the video, written every second. A video that gets a
new source starts a new file in the same track. Players play the track in the replayed video in place of its source,
so the replay shows what the page showed.

With `narration`, `MediaRecorder` records the sound of the stream into an audio track of its own, as Opus, or AAC
where WebM is not recorded, as in Safari. With `true`, the browser asks the user for the microphone when recording
starts, and the microphone is released when it stops. Players play the narration in an element of their own.

Elements are found in the page's documents, the documents of same-origin frames and shadow trees. Elements the
recorder's `block` option covers are not recorded, nor are those inside a blocked element.

## Limitations

- A video of another origin, without CORS, cannot be captured: its pixels are not recorded, and `onError` says so
  once. Its state still is.
- Firefox captures videos only with `mozCaptureStream`, which `pixels` does not use: their pixels are not recorded
  there.
- A source a replay cannot load, such as a `blob:` URL, plays nothing without `pixels`.
- If the user does not allow the microphone, the narration is not recorded and `onError` says so. The recording goes
  on without it.

## License

GPL-3.0-or-later
