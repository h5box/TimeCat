---
'@timecat-js/player': minor
---

The player UI and export to HTML (M2).

- `<timecat-player>`, a web component built on Lit: playback controls, a timeline that marks errors and the events
  of the application, keyboard control, full screen, and a panel listing the console messages, requests,
  measurements and events recorded beside the page, to filter, search and seek to. It loads a recording from its
  `recording` property, its `src` attribute or the segments its children hold.
- `@timecat-js/player/standalone`, the element as one classic script with all it needs.
- `exportHtml(recording)` from `@timecat-js/player/export`, which writes a recording as one HTML page that plays it.
