---
"scenescout": patch
---

Snapshots and crawled routes are much faster to read. The engine no longer sleeps a fixed 300–500 ms after the page has settled. It reads the page's controls again after 50, 100, 200 and 400 ms until two reads agree on a quiet page. An empty page with nothing on its way now counts as read after two reads, where it used to take eight reads, about 4 s. A snapshot right after an action that has already settled no longer waits the quiet window again. Evidence pictures are encoded about twice as fast. On a scripted 35-call session against the demo app, tool time went from 21.4 s to 6.1 s.
