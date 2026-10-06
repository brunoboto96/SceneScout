---
"scenescout": minor
---

`scenescout check --record` (or `SCENESCOUT_RECORD=on`) keeps a frame after each route visit and each saved-flow step and writes `replay.html` beside the report: each role, each journey with a pass or fail badge, each step with its caption, result and frame, the first failing step highlighted, and the run's version, times, origin and commit in the header. The GitHub Action gains a `record` input and a `replay` output, and keeps the page and its frames in the uploaded artifact.
