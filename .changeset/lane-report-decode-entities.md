---
"scenescout": patch
---

`scout_lane_report` decodes the HTML character references a relay adds when it escapes a lane's reply (`&lt;`, `&gt;`, `&amp;`, `&quot;`, `&#39;`, `&apos;` and numeric ones), once, in every string of the report, so evidence such as `-&gt;` matches the finding filed as `->` again. A reply that holds a literal `<` or `>` was not escaped on the way and is left as it is, so a lane reporting a page that double-escapes its text keeps its evidence. Length caps apply to the decoded text, so a route that only went over its cap by being escaped is no longer refused, and the fold says how many references it decoded.
