---
"scenescout": minor
---

`/scenescout qa check [focus]` runs a project's own recorded check from a pull-request comment, for projects with no preview deployments. Set the repository variable `SCENESCOUT_QA_CHECK_WORKFLOW` to a workflow that runs `scenescout check --record --video` (`examples/workflows/scenescout-qa-check.yml` is one): the comment workflow dispatches it on the pull request's branch, waits for it, and replies with the verdict, each journey's result, the findings by severity, the first failing step and links to the run and its artifact. No model key is involved, and pull requests from forks are refused. `/scenescout qa`, `show` and `compare` are unchanged.
