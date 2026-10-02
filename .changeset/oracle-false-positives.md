---
"scenescout": patch
---

Fewer false oracle violations. A `scout_request` probe the server refuses is no longer reported as an `http_error` or `console_error` of the page visited next. `false_success` now pairs a refused write only with a success message the action put on screen: a status badge or heading already there, a column header, a write the page sent in the background or to its own telemetry, and a message beside a write of the same action that went through no longer count, and an announced "was refused", "rejected" or "could not" counts as the page admitting the refusal. The silent-submit note matches its words ("sign", "post", "save") as whole words and waits for a client-side route change before calling a click silent. A page error raised by a link click that left the URL unchanged and opened a confirmation, or whose message says a route change was cancelled, is reported at medium with a note instead of high.
