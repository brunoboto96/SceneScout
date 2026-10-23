---
"scenescout": patch
---

With a saved sign-in, a page that goes to the sign-in page on its own after a navigation has returned is now caught by the next call. A snapshot, an action, a back, a navigation or a crawl compares the address with the one the last call ended on, reports `⚠ SIGNED OUT AFTER LOAD`, records the route the page was on as not covered, and counts it toward `⚠ SESSION AUTH LOST` (and a role session's one re-attach) in place of the navigation that seemed to reach it. Before, such a redirect more than about a second after load was never recorded. It costs one read of the address per call with a saved sign-in, and nothing without one.
