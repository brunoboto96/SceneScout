---
"scenescout": patch
---

In Chromium, a `scout_run_plan` step that clicks a form the write policy refuses now goes back from the browser's error page before the next step, and its line says so. Before, the plan was left on the error page: the next step could not find its target and timed out.
