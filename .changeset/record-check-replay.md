---
"scenescout": minor
---

`scenescout check --record` (or `SCENESCOUT_RECORD=on`) keeps a frame after each route visit and each saved-flow step and writes `replay.html` beside the report: each role, each journey with a pass or fail badge, each step with its caption, result and frame, the first failing step highlighted, and the run's version, times, origin and commit in the header. `--video` records a WebM of each saved flow, each on a page of its own, and the replay page plays it beside the journey's steps. The GitHub Action gains `record` and `video` inputs and a `replay` output, and keeps the page, its frames and its videos in the uploaded artifact.
