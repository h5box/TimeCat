---
'@timecat-js/protocol': minor
'@timecat-js/recorder': minor
'@timecat-js/player-core': minor
---

First recorder and replay engine (M1).

- `@timecat-js/protocol`: TCR v0 event payloads (snapshot, mutations, input, pointer moves and buttons, scroll,
  viewport, navigation), their encoders and decoders, and the writer the recorder encodes snapshots with.
- `@timecat-js/recorder`: `record()`, with time-sliced snapshots, changes coalesced per frame, form values masked by
  default, encoding on the page, and compression and storage (in memory or OPFS) in a worker.
- `@timecat-js/player-core`: `createPlayer()`, which indexes a recording in a worker, seeks through keyframes and
  replays in a sandboxed frame where no recorded script runs.
