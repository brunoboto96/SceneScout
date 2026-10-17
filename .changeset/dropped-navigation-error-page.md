---
"scenescout": patch
---

In Chromium, a click whose navigation the write policy drops (a native form posting a write) now waits for the browser's error page and goes back to the app before it returns. Read too early, the click reported an unmoved page and left the session on the error page, where every following `scout_request` failed with "Failed to fetch".
