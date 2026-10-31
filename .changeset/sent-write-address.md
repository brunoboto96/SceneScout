---
"scenescout": patch
---

The notice of state-changing requests a session sent, the double-submit signal and the WebSocket lists (the observe limit notice and a replayed check's report) now name a request to another site by its origin and path, without its query, as the write guard's refusal notice does. A request to the app keeps its path and query, and a repeated request to another site still counts as one request sent twice.
