---
"scenescout": patch
---

Files under `.scenescout/` are written owner-only and never through a symbolic link left at their names: the status files, memory and its notes, its `.gitignore`, the report, recorded frames and finding pictures are each written under a temporary name and renamed into place, and the session log refuses a link rather than append through it. The live view no longer serves a frame that is a link out of `recordings/`, matching `scenescout export`.
