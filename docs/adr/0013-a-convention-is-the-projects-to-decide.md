# 13. What depends on a project's convention is the project's to decide

Status: accepted

## Context

SceneScout is open source and used against any web app. Some of what it
measures is exact, and still is a defect only under a convention of the
project that a run cannot see:

- paddings and margins off a 4px grid, which matter where a project keeps a
  4px spacing scale and not where it uses another scale or none;
- links styled like body text, which are hard to find in running text and
  ordinary in navigation;
- controls with no `data-testid`, which matter where a test suite selects by
  test id;
- touch-target size on an app that may be desktop-only, where a lane can see
  the targets but not whether the app ships to touch screens;
- no visually dominant action on a list page, or a list order the page never
  promises.

Until now each of these had to be judged one of two ways. A lane called it a
defect or not a defect, and either answer was defensible, so the benchmark
already sets them aside (the key's `contextual` list, ADR 10). Calling these
defects decides a project's conventions for it; calling them non-defects hides
something real from the projects that do follow the convention.

## Decision

**SceneScout does not decide what depends on a project's convention.** It
reports the observation, names the convention that would make it a defect, and
leaves the call to the project. The defaults serve first-time and AI-agent use,
where nobody has told SceneScout the project's conventions; what gates in CI is
the developer's decision; and the documentation describes each behaviour's
effect without telling a project what to adopt.

That is a third verdict beside "defect" and "not a defect", **worth a look**:

- **Lane reports** accept `"worth_a_look"`, which must carry `convention`, one
  line naming the convention ("a 4px spacing scale"); one without it is
  refused. A `convention` on any other verdict is ignored, and the fold says
  so: refusing a whole report over a field the planner does not use would cost
  a round trip for nothing. It is not "I could not tell": that stays
  `"unsure"`. The instruction a lane is given states both rules, as it states
  every rule the parser enforces.
- **Calibration** does not score it, in the report or against the benchmark's
  key, and counts it under its own reason: whether one was filed, or whether
  the key calls the thing a defect, says nothing about whether the lane was
  right.
- **Findings** carry `tier: "worth_a_look"` and the convention
  (`scout_finding`'s `convention`). The report lists them in their own
  section below the findings, each with what was seen and "a defect only if
  your project uses …", and leaves them out of every defect total. When the
  same thing is filed again as a defect, it becomes a defect: someone decided.
  A defect is never demoted by a later worth-a-look, including when two
  processes write the same memory at once; a promotion takes the severity
  the defect was filed at. A check never re-tests
  one, so it can never gate through `--gate-retests`.
- **`scenescout check`** reports two rules in this tier, `off-grid-spacing`
  and `indistinct-link`: the design audit's spacing and link lines, measured
  with the thresholds the audit already used, and worded without counts so
  the same values on several pages are one entry. They have no severity, are not counted, never fail the
  gate at any `--fail-on`, are SARIF results at level `note` with
  `properties.tier` `worth-a-look`, and are listed separately in the report
  (so the CI job summary) and under `worthALook` in `check.json`, apart from
  `issues` and `counts`. The GitHub Action publishes their number as its
  `worth-a-look` output. `--ignore` takes them like any rule. Every other rule
  is unchanged.
- **A published standard is not a project convention.** `tiny-target` stays a
  low issue: WCAG 2.2 sets its 24×24px minimum (2.5.8, level AA) for any
  pointer, not only touch, so whether it applies does not depend on something
  the check cannot see. Contrast is the same. A lane may still judge touch-target
  size beyond that minimum on an app that may be desktop-only as worth a look.

## Consequences

- Two new lines appear in a check's report on pages that have them. They
  cannot change a verdict, and `--ignore off-grid-spacing,indistinct-link`
  removes them.
- The benchmark sets a finding the run filed as worth a look aside, like a
  finding matching a contextual key entry: no recall credit, and outside
  precision. The run archive keeps the tier so a re-score does the same. A
  run that files everything as worth a look therefore scores low recall
  rather than escaping the score, and the scorecard lists what it set aside.
- The in-product calibration joins lane defects only to findings filed as
  defects, so a lane that judged a defect which was then filed as worth a
  look is listed as unfiled at the fold.
- The fold prints how many worth-a-looks each lane returned.
- The tier names the convention in the reader's terms. The report cannot say
  whether the project follows it; only the project knows.

## Failure direction

When a rule could either decide a project's convention for it or leave a real
defect to be read rather than gated, SceneScout leaves it to be read. An
unknown tier read from a findings file counts as a defect, never as a
worth-a-look: the tier can take something out of the defect count only when it
says so exactly.
