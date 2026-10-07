---
"scenescout": patch
---

A recorded `scenescout check` (`--record` or `--video`) no longer overwrites a `replay.html` in the output folder that it did not write: it stops before it starts, with exit code 2 and a message naming the file. With `--video`, a video that fails to start no longer stops every later flow from being filmed.
