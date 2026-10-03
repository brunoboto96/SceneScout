---
"scenescout": patch
---

`scenescout check` no longer passes when the only page it measured was a start page showing at most one control and linking nowhere, which is what an app measured before it finished drawing looks like. Without `--paths`, that check now exits 2 saying only the start page was measured, rather than going green having checked nothing.
