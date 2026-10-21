# @timecat-js/plugin-network

A plugin for `@timecat-js/recorder` that records the requests a page makes with `fetch`, `XMLHttpRequest` and
`navigator.sendBeacon`, and the resources it loads otherwise, such as images, scripts and style sheets. Players list
them with the other events recorded beside the page (`player.events` in `@timecat-js/player-core`).

> Pre-release. The API and the recording format may change without notice until 1.0.

## Usage

```ts
import { networkPlugin } from '@timecat-js/plugin-network'
import { record } from '@timecat-js/recorder'

const recorder = record({
    plugins: [
        networkPlugin({
            // Leaves out a token, and the requests of an analytics service altogether.
            url: url => (url.startsWith('https://analytics.example.com/') ? null : url.replace(/token=[^&]*/, 'token=x'))
        })
    ]
})
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `resources` | `true` | Records the resources the page loads otherwise, from resource timing. |
| `url` | none | Rewrites the URL of each request before it is recorded, or returns `null` to leave the request out. It gets absolute URLs, without user name and password. |

## What is recorded

A request is recorded when it ends, with what made it (`fetch`, `xmlhttprequest`, `beacon`, or the resource timing
initiator, such as `img` or `script`), its method, URL, status, duration and size, and how it failed, if it did:

| Made with | Ends | Status | Size | Failure |
| --- | --- | --- | --- | --- |
| `fetch` | when the response headers arrive | as the response has it; 0 for opaque responses | `Content-Length`, if the page can read it | `abort`, or the error's message, as `Failed to fetch` |
| `XMLHttpRequest` | when it loads, fails, is aborted or times out | as the request has it | `Content-Length`, if the page can read it | `error`, `abort` or `timeout` |
| `sendBeacon` | when it is queued | 0 | 0 | `not queued` |
| other resources | when the response ended | as resource timing has it, where the browser reports it; 0 otherwise | bytes transferred, or the body's encoded size | none |

Sizes are 0 when unknown. Requests to anything but `http:` and `https:` URLs, such as `blob:` and `data:` URLs,
are local and not recorded. Neither headers nor bodies are recorded.

The plugin wraps `fetch`, the `open` and `send` methods of `XMLHttpRequest` and `navigator.sendBeacon` of the window
recorded, and puts them back when recording stops, unless script wrapped them meanwhile: that script's wrapper keeps
calling the plugin's, which then only passes calls on. Requests sent before recording started, and requests made
through references to those functions taken before, are not recorded.

## Privacy

URLs can carry tokens and user data in their path or query. Use the `url` option to rewrite or leave out such URLs.

## License

GPL-3.0-or-later
