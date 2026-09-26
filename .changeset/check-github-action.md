---
"scenescout": minor
---

`scenescout check` is now a GitHub Action: `uses: brunoboto96/SceneScout@v3.10.0` (or the release you are on) with a `url` installs SceneScout and the browser (cached between runs), runs the check, puts the report on the job summary, keeps `report.md`, `check.json` and `check.sarif` as an artifact, and can upload the SARIF to code scanning (`upload-sarif: true`, which needs `security-events: write`). Its inputs are the CLI's options by name, its outputs are the verdict and the counts by severity, and the step fails with the CLI's exit code: 1 when the gate fails, 2 with a "could not run" annotation when there is no verdict. `docs/ci.md` has a complete workflow and the same check on GitLab CI, CircleCI and plain shell. Each release also points the major tag (`v3`) at itself where the repository settings allow it.
