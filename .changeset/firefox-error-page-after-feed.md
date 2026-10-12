---
"scenescout": patch
---

A crawl or `scenescout check` no longer reports a healthy page as `route-load-failed` when the route before it was a feed or file that answered with an error status (a missing feed on Firefox, a missing PDF or CSV on Chromium). The browser fails that load and then commits its own error page for it a moment later; SceneScout now waits for that page before the next navigation, as it already did after a page that failed to load, so the next load is not interrupted by it. The same wait applies after `scout_navigate`, a plan's navigate step and a saved flow's navigate step, so a flow that opens a page straight after a flow that ended at a missing file no longer fails. A file that answered and downloaded is not waited for.
