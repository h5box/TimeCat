---
'@timecat-js/player-core': patch
---

Seeking restores a keyframe by changing what the replay shows into it rather than building the DOM anew: nodes with
the same id stay, given the keyframe's attributes and text, and only what differs is created, moved or removed. On a
page that changes in part, seeks take about half as long, and images and frames that stay do not load again.
