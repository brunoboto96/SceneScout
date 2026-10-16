---
"scenescout": minor
---

`scout_attach {dedup: "judge"}` no longer switches the model dedup judge on by itself. The judge sends finding text to a model provider, so it now runs only when the person running the server sets `SCENESCOUT_DEDUP=judge` (or when a `scenescout ci` run answers it with its own model). An attach that asks for it without that setting is told why and the rule decides duplicates; `dedup: "rule"` still switches it off.
