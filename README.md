<h1 align="center">TimeCat</h1>

<p align="center">High-performance, privacy-first web session recording and replay</p>

<p align="center">English | <a href="./README.zh-CN.md">中文</a></p>

> **Rewrite in progress.** TimeCat is being rebuilt from scratch. The recorder and a replay engine without UI (M1)
> are in place, but nothing is published yet and the recording format may still change; the player UI comes next.
> See [RFC 0001](./rfcs/0001-timecat-next.md) for the architecture and roadmap.

TimeCat records what happens in a web page (DOM changes, input, scrolling, pointer movement) and replays it like a
video, without capturing actual video frames.

## Design goals

- **Invisible to the page.** The main thread only reads the DOM, encoding what it reads in the same pass. Compression,
  storage and upload run in a Worker, and snapshots are time-sliced so recording never causes long tasks.
- **Small recordings.** A purpose-built binary format ([TCR](./rfcs/0002-tcr-format.md)) with string tables, implicit
  node ids and columnar high-frequency streams. Measured against the 1.x JSON format, snapshots are 2.5–3.5× smaller
  after gzip.
- **Private by default.** Input values are masked before they leave the page, and passwords always are.
- **Safe replay.** Recorded scripts never run: replay happens in a sandbox without `allow-scripts`.
- **Native media.** Canvas, video and audio go through the browser's own codecs (WebCodecs, MediaRecorder).

## Packages

| Package | Status |
| --- | --- |
| [`@timecat-js/protocol`](./packages/protocol) | v0 draft: binary primitives, string tables, chunk container, event payloads |
| [`@timecat-js/recorder`](./packages/recorder) | M1: time-sliced snapshots, coalesced changes, input (masked), pointer, scroll, viewport and navigation; compression and storage in a worker |
| [`@timecat-js/player-core`](./packages/player-core) | M1: replay without UI, indexed in a worker, seeking through keyframes, in a sandbox |
| `@timecat-js/player` | planned (M2): the player UI |

[`apps/bench`](./apps/bench) measures TimeCat and rrweb on the same fixture pages, and seek time in a one-hour
recording.

## Development

Requires Node.js 24 and pnpm (enabled through Corepack).

```bash
corepack enable
pnpm install
pnpm check          # format, lint, types, unused code, unit tests, build, size budget
pnpm test:browser   # tests in Chromium, Firefox and WebKit (Playwright)
pnpm bench          # recorder benchmarks, against rrweb
pnpm bench:seek     # seek time in a one-hour recording
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for conventions.

## History

TimeCat was created by [oct16](https://github.com/oct16/TimeCat) in 2020. This rewrite is an independent
implementation: it shares no code with 1.x and cannot read 1.x recordings. The last 1.x source is kept at the
`legacy-1.x` tag.

## License

[GPL-3.0-or-later](./LICENSE)
