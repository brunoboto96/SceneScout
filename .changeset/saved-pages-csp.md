---
"scenescout": patch
---

`report.html`, a recorded check's `replay.html` and its template test report each carry a Content-Security-Policy in their own head. The check pages run no script at all; `report.html` runs only its picture handler, and the copy the live view serves only its own watch on the engine. Pictures and videos beside the page load as before, opened from disk or served.
