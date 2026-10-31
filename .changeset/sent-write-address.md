---
"scenescout": patch
---

The notice of state-changing requests a session sent, the double-submit signal and the WebSocket lists (the observe limit notice and a replayed check's report) now name a request to another site by its origin and path, without its query, as the write guard's refusal notice does. A request to the app keeps its path and query, and a repeated request to another site still counts as one request sent twice. `scout_network`'s listing and a contradiction finding (refused_empty, false_success) name another site's request the same way: the listing printed its whole URL, and a finding its path and query without its origin.

A check whose page or replayed page load ends on another site that answers with an error status reports that once, as the page's own failure, rather than again as a request error.
