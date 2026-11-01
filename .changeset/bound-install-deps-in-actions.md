---
"scenescout": patch
---

The check and ci actions' "Install the browser's system libraries" step no longer waits on a stalled package mirror until the job's own time limit. Each attempt of `playwright install-deps` is stopped after five minutes and tried once more, and when both fail the step ends with an error that names it and says how to skip it (`install-deps: "false"` on a runner that already has the libraries).
