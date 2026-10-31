---
"scenescout": patch
---

`projectsRoot` now also holds `scenescout login --project` and the earlier run's record that `scout_lane_brief`'s `fromRun` and `ci --from-run` read. The guided plan and prompts take a stricter `maxMode` from the site's own project file into account, not only the operator's file. A write let through by the route handler no longer excuses a copy at the browser level that carries a method override naming another method.
