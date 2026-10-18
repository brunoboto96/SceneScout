---
"scenescout": patch
---

The report's steps name a plan's controls by what a person sees ("Choose an option in the "orders status filter" list") instead of `testid=…`, and the Evidence captions no longer end in a finding id (the id stays in a hidden comment the HTML report reads). A finding title containing `</details>` is escaped in the folded technical details of `report.md`, so it no longer closes the fold early on GitHub.
