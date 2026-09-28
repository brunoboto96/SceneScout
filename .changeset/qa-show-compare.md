---
"scenescout": minor
---

Add `/scenescout qa show <element>` and `/scenescout qa compare <element>`: the QA comment captures one element of the pull request's preview with a real browser screenshot (its bounds plus a margin), and `compare` captures the same element on a base URL (`SCENESCOUT_QA_BASE_URL`, else the base branch's newest successful deployment) and adds a diff picture with the share of pixels changed. The reply shows the pictures inline: a new keyless `shots` job pushes them to the `scenescout-shots` branch, one folder per run, and the reply links only images whose URLs the workflow builds itself. Underneath, `scenescout ci` takes `--show "<words>"` and `--compare-url <url>` (and the ci action `show` and `compare-url`), and a new `scout_capture` tool saves a PNG of one element by its ref. The QA template now pins v3.14.0.
