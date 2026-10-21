# @timecat-js/plugin-perf

A plugin for `@timecat-js/recorder` that records what the browser measures of the page's performance: the Core Web
Vitals (LCP, CLS and INP), FCP, TTFB, layout shifts and long animation frames, each with the node it is about. In a
replay, they show where in the session the page was slow, and what moved. Players list them with the other events
recorded beside the page (`player.events` in `@timecat-js/player-core`).

> Pre-release. The API and the recording format may change without notice until 1.0.

## Usage

```ts
import { perfPlugin } from '@timecat-js/plugin-perf'
import { record } from '@timecat-js/recorder'

const recorder = record({ plugins: [perfPlugin()] })
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `longTasks` | `true` | Records long animation frames, or long tasks where the browser does not report those. |

## What is recorded

Each measurement is a `Perf` event with a metric, a value and a target, the id of the node it is about in the
recording, or 0:

| Metric | Value | Target | Recorded |
| --- | --- | --- | --- |
| `TTFB` | ms from the start of navigation to the first byte of the response | none | once |
| `FCP` | ms from the start of navigation to the first contentful paint | none | once |
| `LCP` | ms from the start of navigation to the paint of the largest content so far | the element | for each candidate; the last one is the LCP |
| `layout-shift` | the shift's score | the first node that moved | for each shift no recent input caused |
| `CLS` | the largest sum of the shifts of a session window: shifts less than 1 s apart, within 5 s | none | each time it grows |
| `INP` | ms of the longest interaction, leaving out one of every 50, as an approximation of the 98th percentile | the target of that interaction | each time it changes |
| `long-animation-frame` or `long-task` | ms the frame or task took | none | for each one over 50 ms |

Measurements made before recording started, such as `TTFB` and `FCP` of a recording started late, are recorded at
its start, with their values as they are. Browsers measure what they support: Chromium-based ones report all of
these, others fewer. INP leaves out interactions shorter than 16 ms, which event timing does not report.

## License

GPL-3.0-or-later
