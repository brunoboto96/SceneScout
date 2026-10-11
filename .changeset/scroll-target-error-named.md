---
"scenescout": patch
---

`scout_scroll` with a `target` now says "Scroll target not found" only when nothing on the page matches it. Any other failure, such as the page navigating or closing during the scroll, or a target that did not answer within the action limit, is reported as it is.
