---
"scenescout": patch
---

A crawl of a route whose page starts a navigation of its own after it was checked no longer holds the read of that route without limit: the read is released at the page-load limit and the route is reported as a navigation pending. The settle smoke check prints the crawl's last steps if the crawl runs on.
