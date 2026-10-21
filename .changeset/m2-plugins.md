---
'@timecat-js/recorder': minor
'@timecat-js/player-core': minor
'@timecat-js/plugin-console': minor
'@timecat-js/plugin-network': minor
'@timecat-js/plugin-perf': minor
---

Recorder plugins, and the events of the application (M2).

- `@timecat-js/recorder`: the `plugins` option, which runs plugins that write Console, Network, Perf and Custom
  events while recording, and `addEvent(name, data)` for events of the application's own.
- `@timecat-js/player-core`: `player.events`, the events recorded beside the page, in time order.
- `@timecat-js/plugin-console`: console messages, uncaught errors and unhandled rejections, arguments previewed as
  text.
- `@timecat-js/plugin-network`: requests made with `fetch`, `XMLHttpRequest` and `sendBeacon`, and the resources
  the page loads.
- `@timecat-js/plugin-perf`: LCP, CLS, INP, FCP, TTFB, layout shifts and long animation frames.
