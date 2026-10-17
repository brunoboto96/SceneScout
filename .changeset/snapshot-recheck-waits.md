---
"scenescout": patch
---

Snapshots and crawled routes are much faster to read. The engine no longer sleeps a fixed 300–500 ms after the page has settled. It reads the page's controls again after 50, 100, 200 and 400 ms until two reads agree on a quiet page that has been up for at least 400 ms since it loaded or was last acted on (4 s for a page with no controls, so an empty shell still drawing is not called a dead end). A snapshot of a page that has been up that long is read in about 50 ms instead of 300 ms or more. A snapshot right after an action that has already settled no longer waits the quiet window again. Evidence pictures are encoded about twice as fast.
