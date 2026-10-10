---
"scenescout": patch
---

`scout_close` no longer lets a tool call that timed out write into the project after it has answered. It closes the browser, waits up to 10 seconds for such calls to finish, then writes any save they left pending; if one is still running at the end of the wait, the reply says so. `SCENESCOUT_WATCHDOG_MS` caps how long any tool call may run before it is answered as timed out.
