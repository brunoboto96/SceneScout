---
"scenescout": patch
---

`scenescout check --baseline` now takes each picture again, a frame later, until two in a row are the same, so a baseline is no longer of a moment the page was still drawing: the last frame of an animation it had just stopped, or a script still filling something in after the load. A page that never holds still within the action limit keeps its last picture, and the report says so on that target's line.
