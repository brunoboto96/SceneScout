---
"scenescout": minor
---

`scenescout check` accepts `--ignore-path`: a path drops every rule filed on that route, and `rule:/path` drops that one rule there. A page meant to answer HTTP 500 can stay off the gate while the same status on another path still fails `--fail-on high`. The GitHub Action takes the same input.
