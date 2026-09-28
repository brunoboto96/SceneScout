---
"scenescout": patch
---

A session close whose browser will not close no longer leaves it running. The browser is launched as a Playwright browser server, so the engine holds its process: when teardown overruns its bound, the server is closed on a bound of its own, and if the browser is still running its process is killed. The timeout and what it took are logged. Both bounds can be set with `SCENESCOUT_TEARDOWN_MS` and `SCENESCOUT_BROWSER_CLOSE_MS`.
