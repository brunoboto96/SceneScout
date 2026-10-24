---
"scenescout": patch
---

A write a saved flow's page sends as the flow leaves it is judged under the flow's write rule however late the browser reports it. The flow's rule used to be held for five seconds after the flow handed back, so on Chromium a beacon reported later than that was judged under the session's rule, and read-only let a same-origin beacon out. The rule is now held until the page's leave marker, which the browser reports after the page's own leaving writes, has been heard, for at most 30 seconds. Past that the session's own rule applies, as before.
