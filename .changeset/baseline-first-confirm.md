---
"scenescout": patch
---

A visual baseline written for the first time is now taken from two page loads and written only when the two pictures agree. A third load settles a disagreement; if all three differ, nothing is written and the target is reported as not captured, so a render that is off for one load is not kept as the reference for every later compare.
