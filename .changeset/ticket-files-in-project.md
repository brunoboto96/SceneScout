---
"scenescout": minor
---

`scout_tickets` reads a ticket file only from inside the project folder, following links first. A folder outside it can be allowed explicitly with `SCENESCOUT_TICKET_DIRS`, absolute paths separated as in `PATH`. The guide's safety model now says that the project folder is the trust boundary for uploads and ticket files.
