---
"scenescout": patch
---

The `/scenescout qa` reply no longer lets a finding's title, a journey's name or anything else from the run render as maths (`$…$`), reference an issue or pull request (`#12`, `GH-12`, `owner/repo/issues/12`), or reorder the line with bidirectional control characters. GitHub acted on these even when backslash-escaped; the reply now breaks each with a zero-width space, so what the reader sees is unchanged. Names shown as code (the branch, the workflow, the artifact) drop bidirectional and C1 control characters too.
