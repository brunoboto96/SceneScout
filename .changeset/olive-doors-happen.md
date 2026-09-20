---
"scenescout": minor
---

Record a run, and read the whole thing back afterwards.

`scout_attach {record: true}` keeps a frame of the page after every action, and
`scout_report` then writes `report.html` beside `report.md`: the report, the
screenshots taken around each finding, and every session's trail in the blocks
its tasks made — one self-contained page that opens from the file system with
nothing running. Recording is off unless asked for, because the frames are
pictures of the app under test and no redaction can read a picture
([ADR 8](docs/adr/0008-a-recorded-run-is-evidence-and-must-be-asked-for.md)).

The live view serves the same document at its own address and goes there when
the run ends, so the report survives a refresh instead of dying with the board.
The close-up gains a timeline: a tick per action, coloured by task, that plays
a recorded run back while it is still going. A finding's screenshots also hang
under it in the live report panel, which no longer resets itself while it is
being read.

Fixes: a listener left on a control that had been replaced threw on load and
left the board blank; a viewer arriving after the last browser closed saw the
empty state instead of the finished run; a finding's evidence could be drawn
from a different session than the one that filed it.
