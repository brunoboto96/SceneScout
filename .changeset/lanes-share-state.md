---
"scenescout": minor
---

Parallel lanes now share what a run knows, and the planner is told what a lane left undone.

- A markup value typed in one session is watched for in every session on the same project, so a stored injection is caught when another lane opens the list that renders it.
- The report gate counts design audits from every session in the run, so a planner whose lanes audited the pages is no longer refused.
- Folding a lane report lists each judged defect that no finding matches yet, so it can be filed before the lane's session closes.
- A lane report wrapped in prose around one fenced JSON block is accepted, with the prose discarded unread.
- `scout_lane_brief` gives each lane a landing route of its own and the rules a measured run found worth stating.
- The pace section shows how long each session held a browser idle before its first action and after its last, including sessions that attached and never acted.
- An empty live region (`role="status"` and similar) is no longer shown or counted as an unnamed control.
