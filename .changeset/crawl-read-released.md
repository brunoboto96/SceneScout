---
"scenescout": patch
---

A crawl or a snapshot of a page that starts a navigation of its own while it is being read no longer waits on that page without limit: the read is released at the page-load limit and the route or snapshot is reported as a navigation pending to the address the page was going to. The checks run on the page after an action are skipped, rather than waited on, when such a navigation holds them past that limit.
