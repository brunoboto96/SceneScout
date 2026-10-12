---
"scenescout": patch
---

Files and missing files are reported by their HTTP status on every browser. On WebKit a crawl or `scenescout check` no longer reports a PDF, CSV or other download that answered 200 as `route-load-failed`: it is listed under "Not pages" with its status and content type, as on Chromium and Firefox. On Chromium a missing feed (a 404 served as a feed) is no longer a dead end: it is the route's client error, as on Firefox. A saved flow's or plan's navigate step to a missing file fails with `the file answered HTTP 404 (application/pdf)` instead of the browser's "Download is starting" or `NS_ERROR_NET_ERROR_RESPONSE`, and `scout_navigate` says the same. A navigation cancelled by answering "stay" to a leave confirmation is now logged when the answer is given, so it no longer lands after the next action in a finding's repro steps.
