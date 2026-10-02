---
"scenescout": minor
---

A run can answer the tickets it was given. `scout_tickets` reads acceptance criteria from pasted text or a ticket file (`.md`, `.txt`, `.feature`): Given/When/Then scenarios, checklists, numbered or `AC1:` criteria, and lists under an "Acceptance criteria" heading; a ticket with none of these is reported as having no recognisable criteria rather than guessed at. `scout_criterion` records each criterion as passed, failed (linked to the findings that show it) or not tested (`no-access`, `observe-blocked` or `out-of-scope`), with the agent's confidence. The report answers each ticket at the top of the plain section, with a failing criterion's pictures, and lists every verdict with its confidence in a new "Acceptance criteria" section of the technical report. A parallel run's lane briefs list the criteria, and the plain questions' "what to check" reads tickets this way.
