---
"scenescout": major
---

**A tool that acts on the app now needs an objective.** `scout_navigate`, `scout_back`, `scout_click`, `scout_type`, `scout_select`, `scout_press`, `scout_upload` and `scout_run_plan` take an `objective`: one short sentence naming what the current batch of actions is for. It stays set until a different one is passed, so a batch costs one sentence rather than one per call, and `scout_journey` still sets it (and outranks it) while a journey runs. A call that acts with none standing is refused with what to pass and why.

This is the breaking part: an agent that never states one now gets a refusal instead of a click. It exists because the objective was optional and therefore usually absent — someone watching a run saw sessions working through their app with nothing to say why, which is the one thing the live view is for. The objective now also appears on each card in the grid, not only in a session's close-up, and a session that has not said anything yet says so.
