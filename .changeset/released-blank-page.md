---
"scenescout": patch
---

A snapshot of `about:blank`, where SceneScout leaves a page whose read was held by a navigation that never landed, no longer records it as a new state of the app or reports a dead end: it says the session is not on a page of the app, which page was left and why, and to navigate to it again. A released snapshot says the page was left and to navigate to it again, rather than to take a snapshot again later. A crawled route or a navigation whose page sent itself to `about:blank` is not counted as covered, and a recorded check names that page as `about:blank` rather than as the path `blank`.
