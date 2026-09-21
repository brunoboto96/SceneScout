---
"scenescout": minor
---

The report is a worklist again.

A project that has been tested for a while accumulates findings, and the report printed every one of them in full. On one real project that was 737 findings, 1.75 MB, of which 423 were open but unverified by that run and 314 were already fixed — and the eleven findings the run had actually just made were buried in the middle of it. A document nobody opens is not a report.

Findings from this run still print in full. Findings from earlier runs, and resolved ones, are now an index: one row each with the id, severity, how long ago it was last seen, how many runs have seen it, and the title. The same project's report becomes 113 KB, 94% smaller, with nothing lost — every id is there, and `scout_report {history: "full"}` prints all of it exactly as before, which is what to use when handing the document to someone who cannot read the project's memory.

Age is on every row because it is what decides whether an unverified finding is worth re-testing: one nobody has re-confirmed in four months is a different proposition from one seen last week.
