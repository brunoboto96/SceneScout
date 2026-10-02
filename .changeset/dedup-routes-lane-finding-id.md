---
"scenescout": minor
---

Finding dedup no longer merges two findings that both carry evidence on a quoted literal that one names in its title and the other only mentions in its detail: a control's label quoted in passing names where two defects were found, not one defect. The literal must be in the other finding's title or evidence; with no evidence on one side the detail still counts. A finding merged from another page now records that page (`seenOn`, at most 20), and the report prints it as "also seen on" beside the finding's route; the merge note returned to the lane says so. A lane report's decision can name the finding it was filed as (`finding`, the id `scout_finding` returned), and the fold's check for judged defects nobody filed counts it as filed when the project holds that defect. The check's text match also reads underscores inside kebab-case ids and treats ids in paths (`/things/5,/1`) as the route's (`/things/:id`).
