---
"scenescout": minor
---

Start a run from an earlier run's record, opt-in. Every run that writes its report now keeps a record of what it worked on and left (routes in order, each session's steps, and on each route the controls never exercised, forms never submitted and options never chosen), in the project's memory and in `ci.json` under `record`. `scenescout ci --from-run <ci.json or project directory>` (or `SCENESCOUT_FROM_RUN`) with `--from-run-mode continue` (the default) takes first the routes that run never worked on, then the ones it left work on, told exactly what to do first on each, then the rest; `--from-run-mode replay` follows its routes and steps in order, one lane per session it had. `scout_lane_brief` takes `fromRun` and `fromRunMode`, the ci action takes `from-run` and `from-run-mode`, and the run it started from is named in the report, `summary.md` and `ci.json` (`fromRun`). Without it, runs behave as before.
