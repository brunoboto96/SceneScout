---
"scenescout": patch
---

A crawl, a snapshot and a plan's coverage no longer record a page that was leaving as it was read. A page that starts a navigation of its own while its controls are read (a script setting `location` mid-read) is now judged by where it went, in Chromium, Firefox and WebKit alike: read again where it landed, or reported as `NAVIGATION PENDING` and left for `about:blank` when that navigation is still on its way at the page-load limit. Before, a read that finished before the browser sent the navigation's request was recorded as the route's state, and the next snapshot then waited on the navigation; and a page that went to another page or to `about:blank` during a snapshot's read could be recorded under the address it went to, with the controls of the page it left.
