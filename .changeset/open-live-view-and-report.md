---
"scenescout": minor
---

The engine can open the live view in the default browser when a session attaches, and report.html when `scout_report` writes it. The new `open` setting (`scout_attach {open}` or `SCENESCOUT_OPEN`: `live`, `report`, `both` or `none`) defaults to both when the browser window is visible or the MCP client is interactive, and to none in CI, over SSH, with no display, or in a headless run with no interactive client. The live view keeps its loopback-and-token rules.
