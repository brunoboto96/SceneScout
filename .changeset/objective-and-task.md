---
"scenescout": major
---

**A session now says two things, and the second is required.** Its **objective** is the whole remit it was given, set once at `scout_attach {objective}` — "Admin lane: §2 registers, §7 plan gating". Its **task** is what it is doing right now, and every tool that acts on the app — `scout_navigate`, `scout_back`, `scout_click`, `scout_type`, `scout_select`, `scout_press`, `scout_upload`, `scout_run_plan` — takes one: a few words for the batch in front of it ("Filtering the documents register by status"). It stays set until a different one is passed, `scout_journey` sets it while a journey runs, and reading the page needs none. A call that acts with no task standing is refused, with what to pass and why.

This exists because both were optional and therefore usually absent: someone watching a run saw sessions working through their app with nothing to say why, which is the one thing the live view is for. Stating a task also marks the action log, so the close-up's feed groups and tints the actions that follow it, as it already did for a journey's.

Breaking, in two ways. An agent that never states a task now gets a refusal instead of a click. And the two names swapped to match what they mean: `scout_attach {task}` is now `scout_attach {objective}`, and the per-call `objective` of 2.0 is now `task`. Both old names are still accepted, so a caller written against 2.0 keeps working.
