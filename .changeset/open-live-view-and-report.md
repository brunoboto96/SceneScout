---
"scenescout": minor
---

The engine can open the live view in the default browser when a session attaches, and report.html when `scout_report` writes it. The new `open` setting (`scout_attach {open}` or `SCENESCOUT_OPEN`: `live`, `report`, `both` or `none`) defaults to both on a local desktop session, headed or headless, and to none in CI, over SSH, or on Linux with no display. `scenescout ci` opens nothing. The live view keeps its loopback-and-token rules.
