---
"scenescout": patch
---

A `scout_run_plan` step whose control the page no longer has now fails after one action limit (5 s by default) rather than about a minute: the step waits once for its target, and its reads of the target's label, test id and kind are bounded instead of falling to the browser driver's 30 s default. Any other wait on the page that names no time of its own now takes the session's action limit, or its page-load limit for a load.
