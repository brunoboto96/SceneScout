---
"scenescout": patch
---

`scenescout --help` and the other usage text read through a pipe now arrive whole. On macOS the output was cut at about 8 KB because the usage exited before standard output had drained.
