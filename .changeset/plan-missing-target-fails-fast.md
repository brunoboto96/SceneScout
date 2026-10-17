---
"scenescout": patch
---

A `scout_run_plan` step whose control the page no longer has now fails after one action limit (5 s by default) rather than about a minute: the step waits once for its target and names it in one read as it is found, instead of each read falling to the browser driver's 30 s default. A target gone for a moment while it is named is waited for rather than named empty, so a read-only plan or saved flow still refuses a destructive control the page redraws. Any other wait on the page that names no time of its own now takes the session's action limit, or its page-load limit for a load.
