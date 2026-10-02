---
"scenescout": minor
---

Observe mode can be told which POST endpoints only read, and the label check no longer refuses controls for the record text they show.

- `scout_attach` takes `readPosts` (`["POST /api/search"]`), and `SCENESCOUT_READ_POSTS` sets the same for `check`, `ci` and a first look. Observe then lets those POSTs out, so a search or query page that loads its data through POST can be tested. Nothing is named by default. A named endpoint is still refused when its path or body looks destructive or its body is a GraphQL mutation, and each one let out is logged. The gap ledger names the pages where observe refused a script's POST, with the endpoint.
- A row, card, heading or panel is judged by its test id and the control at its centre, not by the record text it shows. Its own text counts only for a clickable element whose text is a short command, and a heading's never does.
- Removing a filter chip ("Remove Status: Open filter") is allowed; "Remove member" is still refused.
- "Sign off" is refused only as a command, at the start of a label or joined to another verb ("Save and sign off"). "Manager sign-off", "Final sign-off recorded" and "Confirm sign off" are allowed.
