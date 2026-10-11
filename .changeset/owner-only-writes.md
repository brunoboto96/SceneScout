---
"scenescout": patch
---

Files under `.scenescout/` are never written through a symbolic link left at their names: the status files, memory and its notes, its `.gitignore`, the report, recorded frames, finding pictures and captures are each written under a temporary name and renamed into place, and the session log refuses a link rather than append through it. The status files, memory and the session log are owner-only; the report, `ASSUMPTIONS.md`, the `.gitignore`, frames, pictures and captures keep the mode your umask gives a new file, so other tools and teammates can still read them. The live view no longer serves a frame that is a link out of `recordings/`, matching `scenescout export`.
