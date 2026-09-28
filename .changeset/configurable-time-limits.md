---
"scenescout": minor
---

The time an action on the page and a page load may take are now settings. An action (click, typing, hover, pick, upload, and a saved flow step's wait) keeps its 5 s default and a page load its 20 s (15 s for a crawled page or a flow's navigate step, 10 s for going back). Raise them with `actionTimeoutMs` and `navTimeoutMs` on `scout_attach`, with `SCENESCOUT_ACTION_TIMEOUT_MS` and `SCENESCOUT_NAV_TIMEOUT_MS` in the environment, or with `--action-timeout-ms` and `--nav-timeout-ms` on `scenescout check` and `scenescout ci` (and the matching inputs on both GitHub Actions). An option wins over the variable, and the variable over the default; a value out of bounds refuses the attach with a sentence naming it. A timeout now says which limit ran out, how long it was, and how to raise it, so a slow machine is not mistaken for a slow app.
