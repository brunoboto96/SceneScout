---
"scenescout": patch
---

A request still loading when its page is left, its frame is removed or its frame navigates away is no longer counted as in flight, so the next wait for the page to go quiet no longer runs to its 2 s cap.
