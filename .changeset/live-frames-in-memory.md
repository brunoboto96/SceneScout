---
"scenescout": patch
---

The live view's timeline now shows a past step on every run, not only a recorded one. The live view holds a frame of each of the last 100 steps per session in memory (at most 12 MB a session), never on disk, and drops them when the session closes. A step whose frame has aged out says so and names how to keep every frame (`record: true` or `SCENESCOUT_RECORD=on`). The "page may be closed, or not answering" message now appears only for a live page that does not answer. The task panel says "No task was set for these steps" for steps taken before any task. `scout_attach {open: "live"}` opens the live view on every attach that asks for it, or says why it could not.
