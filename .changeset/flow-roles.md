---
"scenescout": minor
---

A saved flow can name the `role` it runs as. `scenescout check` replays it in a browser of its own, signed in with the profile `scenescout login --role <name>` saved in the project, while flows naming no role keep the check's own session. Flows run in file-name order, so a journey that passes between people (one submits, another approves) is a sequence of flows. A role with no saved profile stops the check before it starts, with exit 2 and the command that saves one.
