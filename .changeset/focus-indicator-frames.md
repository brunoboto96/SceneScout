---
"scenescout": patch
---

The focus-indicator rule no longer reports an iframe as a control with no visible focus indicator. A Tab onto a frame moves focus into the frame's document, so the design audit and `scenescout check` now follow focus into a same-origin frame and measure the control focused there, reported by its own name. A press that leaves focus inside another site's frame is skipped.
