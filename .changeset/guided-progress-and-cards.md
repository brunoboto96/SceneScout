---
"scenescout": minor
---

A guided check can now be followed and read in plain words. `scout_status` (and its MCP App pane) shows the check's progress: one sentence for what is happening now and the few before it, each chosen area's state, pages and time against the plan's limits, problems so far by impact, the newest finding cards, and the clicking it saved, always with the basis for that figure. New `scout_cards` returns findings as plain cards, worst first, with their pictures inline where the client shows images. New `scout_feedback` records the person's own "not a bug" or "confirmed" on a finding: the finding is kept and still dedups, and `{export: true}` lists the labels as candidates for a maintainer, never written into an answer key. While a guided plan is open, `SCENESCOUT_READ_POSTS` is no longer read, so it cannot loosen a Look only check.
