---
"scenescout": patch
---

`scout_tickets` refuses a ticket path outside the project, and outside the folders `SCENESCOUT_TICKET_DIRS` names, with the same message whether or not the file exists, so the refusal no longer tells an agent what is on the disk elsewhere. A missing file inside the project is still reported as missing. The server now checks `SCENESCOUT_TICKET_DIRS` as it starts: an entry that is relative or starts with `~` stops it with a message naming the entry, instead of being reported the first time a ticket outside the project is asked for. A folder it names that is not there is warned about by name as the server starts, and the server still starts. An empty entry is skipped as before. A link in the project is followed to its end however many links it passes through, so a chain of links whose end is missing is answered as one whose end is there.
