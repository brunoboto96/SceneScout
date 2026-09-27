---
"scenescout": minor
---

Add a QA review started from a pull-request comment. An account the repository allows (by default its owners) comments `/scenescout qa` on a pull request, optionally with a preview URL and a focus, and an unattended `scenescout ci` run explores that pull request's deployed preview and posts its results as a reply, with a link to the full report. The job that holds the model's key checks out nothing and runs SceneScout from an exact release tag, so the pull request's code never runs beside the key; pull requests from forks are refused unless the repository allows them. The workflow to copy is `examples/workflows/scenescout-qa.yml`, and the new `brunoboto96/SceneScout/qa` action runs its keyless steps.
