---
"scenescout": minor
---

Add `scout_lane_brief`, and remember how a login state is regenerated.

Dividing an app between parallel lanes by hand fails in two ways a finished run cannot tell apart from success. Lanes overlap, so two browsers audit the same register while a third module is never opened — and route coverage reads complete either way, because both lanes visiting a route makes it covered. And lanes launch underspecified: in one real four-session run the first two sessions acted with no task set, so the person watching the live view saw browsers clicking through their app with nothing to say why.

`scout_lane_brief {lanes, goal}` computes the split instead. Routes are grouped into whole modules by their first path segment, so a lane that owns everything under one module carries state between its own steps rather than re-learning the app on every route, and modules are dealt out so the lanes come out within a route or two of each other. It returns each lane's session name, the `objective` to attach with, the routes it owns, and the two rules a hand-written brief keeps dropping. The same routes always produce the same split, so a lane that has to be re-run is handed the same brief.

Separately, `scout_note` gains a `setup` section for how to get an app testable at all, and the `⚠ AUTH FAILED` message now quotes back whatever an earlier run recorded there. A storage state expires on a timer nobody remembers, and "regenerate it" is advice the reader already had; the command that worked last time is the part worth keeping.
