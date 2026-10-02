---
"scenescout": patch
---

`check.sarif` and `ci.sarif` results now point at a repository file, so GitHub code scanning keeps them instead of dropping every one. An issue a saved flow raised points at that flow's file; every other result points at the anchor: the new `--sarif-file-anchor` option (and `sarif-file-anchor` action input) when given, else the running workflow's file from `GITHUB_WORKFLOW_REF`, else `package.json`, else `README.md`, whichever exists first; a missing option or workflow file is named in a warning, and when none exists the SARIF is still written with a warning that code scanning will drop its results. The page each result was seen on moves to the message, a logical location and `properties`; fingerprints are unchanged, so existing alerts keep their identity. In `check.json`, an issue a saved flow raised names that flow's file in `flow`.
