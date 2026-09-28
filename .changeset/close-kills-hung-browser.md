---
"scenescout": patch
---

A session close whose browser teardown overruns its bound no longer leaves the browser running. The browser is launched as a Playwright browser server, so the engine holds its process: after the bound the server is closed on a bound of its own, and if the browser is still running its process is killed. The timeout is logged. The browser used to keep running as a child of the server and hold it open. The two bounds can be set with `SCENESCOUT_TEARDOWN_MS` and `SCENESCOUT_BROWSER_CLOSE_MS`.
