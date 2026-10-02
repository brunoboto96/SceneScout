---
"scenescout": patch
---

The gap ledger's three route lines now count over the known routes and name that set (`3 of 54 known route(s) …`), treat a tab or section of a page as part of that page, and judge "nothing exercised" and "never design-audited" over the routes this run reached rather than every earlier run's. `scout_coverage` in a session's scope lists only the controls on the pages that session saw, not another role's on the same route, and labels the route figure as the project's. A wrapper flagged as not a control in any state of a route no longer counts in coverage because an older state left it unflagged. Record ids shaped like codes (`WID-2025-001`, `A1B2C3`) collapse to `:id` like numeric ones, and a dropdown's option already selected when the page loaded is no longer listed as never chosen.
