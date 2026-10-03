---
"scenescout": patch
---

Text drawn over a positioned `<img>`, `<picture>`, `<video>` or `<canvas>` is no longer reported as a contrast failure measured against the page background (often as 1.00:1). Like text over a CSS background image, it has no single background colour, so the design audit and `scenescout check` leave it unmeasured.
