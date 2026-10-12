---
"scenescout": patch
---

On Firefox, a crawl or `scenescout check` no longer reports a healthy page as `route-load-failed` when the route before it was a feed or file that answered with an error status (a missing feed). Firefox fails that load and then commits its own error page for it a moment later; the crawl now waits for that page before loading the next route, as it already did after a page that failed to load, so the next route's load is not interrupted by it.
