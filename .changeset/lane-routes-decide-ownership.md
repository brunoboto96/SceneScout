---
"scenescout": patch
---

`scout_lane_report` keeps the routes each lane's accepted report lists in the project's memory (`laneRoutes` in `.scenescout/memory.json`), with query strings and fragments removed so no token in an address is stored, and `npm run bench -- --archive` carries them into the run archive. The benchmark then decides whether a lane's "not a defect" is a remark about another lane's page by where the matched defect is, not by how the verdict is worded: a defect none of whose pages the lane covered is set aside as another lane's and listed on the scorecard, and one on the lane's own page, or one every lane can reach, is scored. Answer-key entries can name further pages with `alsoOn` and mark a defect every lane can reach with `everyPage`. Archives made before routes were kept, and lanes with a route that names no page, are scored by wording, as before.
