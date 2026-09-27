---
"scenescout": minor
---

Add a "worth a look" tier for observations that are defects only under a convention of the project the run cannot see, such as a spacing scale, link styling in navigation, or test ids on every control. SceneScout reports each one with the convention that would decide it, and never counts it as a defect.

- Lane reports accept the verdict `worth_a_look`, which must name its `convention`. A `convention` on any other verdict is ignored, and the fold says so. Lane calibration and the benchmark's key calibration leave it unscored and count it under its own reason.
- `scout_finding` takes an optional `convention`, which files the finding in this tier. The report lists these findings under "Worth a look", below the findings, as "a defect only if your project uses …", and leaves them out of every defect total. Filing the same thing again as a defect promotes it, at the defect's severity, and the reply says so. The benchmark sets such findings aside from recall and precision, and the fold lists a lane's judged defect as unfiled when it was filed only as worth a look.
- `scenescout check` reports two new rules, `off-grid-spacing` and `indistinct-link`, in this tier. They have no severity and never fail the gate at any `--fail-on`. SARIF reports them at level `note`. The report and the job summary list them in their own section, `check.json` puts them under `worthALook`, separate from `issues`, and the GitHub Action publishes their number as the `worth-a-look` output. Every existing rule is unchanged.
