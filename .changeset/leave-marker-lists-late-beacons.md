---
"scenescout": patch
---

`scenescout check` on Chromium: a beacon a page sends as a flow leaves it, which the write policy refuses, is now listed among the flow's background requests. Chromium can report such a beacon a moment after the page has been left, and one reported that late was refused but missing from the list. The engine now has the page send a marker of its own last on its way out (after anything it sends on pagehide, visibilitychange or unload), which never leaves the browser, and waits (up to a second) until the marker is heard before it closes the flow's list.
