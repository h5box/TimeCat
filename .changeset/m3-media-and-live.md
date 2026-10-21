---
'@timecat-js/protocol': minor
'@timecat-js/recorder': minor
'@timecat-js/player-core': minor
'@timecat-js/player': minor
'@timecat-js/plugin-canvas': minor
'@timecat-js/plugin-media': minor
---

Media and live replay (M3).

- `@timecat-js/protocol`: media tracks and their packets in media chunks, the playback state of media elements,
  sync points that tell readers of a stream how far everything is known, and streams of segments one after the other.
- `@timecat-js/recorder`: `openMedia` for plugins, which writes the packets of a media track as they come, and
  `recordStream`, which records a `MediaStream` into one with `MediaRecorder`. With `onData`, the recording streams
  out every `latency` milliseconds, sync points included, for live replay.
- `@timecat-js/player-core`: a `ReadableStream` of a recording plays live, from its edge; `live`, `hasMedia`,
  `volume`, `muted`, and `durationchange` and `volumechange` events. Video tracks are decoded with WebCodecs into the
  replayed canvases, container tracks play in the replayed media elements or in elements of the player's own, and
  media elements follow their recorded playback state.
- `@timecat-js/player`: streams play live, with a Live badge that goes back to the edge; a mute button and volume
  slider for recordings with media, and a button to unmute when the browser muted the replay.
- `@timecat-js/plugin-canvas`: what 2D and WebGL canvases show, encoded with WebCodecs in VP9, AV1, H.264 or VP8,
  or recorded with `MediaRecorder` where WebCodecs is missing.
- `@timecat-js/plugin-media`: the playback state of `<audio>` and `<video>` elements, optionally what videos show,
  and narration from the microphone or a stream of the page's, as Opus, or AAC in Safari.
