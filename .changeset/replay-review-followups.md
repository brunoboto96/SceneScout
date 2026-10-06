---
"scenescout": patch
---

`scenescout check --video` now films each saved flow on the session's own page, so sessionStorage one flow writes is there for the next, and only the flows are filmed, not the crawl. The replay page marks and counts every step and visit left without a frame because its session reached the frame cap, has no scripts or inline event handlers, and carries a generator mark: a check removes only a `replay.html` that has it, so a file of that name the project keeps in the output folder stays.
