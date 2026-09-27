---
"scenescout": patch
---

`scenescout ci` tells the model that turns, not tool calls, are its budget: it should put every call that does not depend on an earlier one's result into the same turn, and check `scout_coverage` and file what it judged before calling `scout_report`.
