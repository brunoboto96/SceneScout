---
"scenescout": patch
---

A session close whose browser teardown overruns its bound no longer leaves the browser running. The browser is still closed on a bound of its own, and if it is still running after that its process is killed by the pid recorded at launch; the timeout is logged. The browser used to keep running as a child of the server and hold it open.
