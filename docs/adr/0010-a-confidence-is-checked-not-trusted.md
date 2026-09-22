# 10. A lane's confidence is checked, not trusted

Status: accepted

## Context

A parallel run asks each lane for a verdict and a confidence between 0 and 1
on everything it judged. Asking for a calibrated number and never checking it
costs nothing and buys nothing: a lane that writes 0.95 on everything reads
exactly like one that is right 95% of the time.

There are two things a confidence can be checked against, and neither is
complete:

- **What the run filed.** Available on every run, against any app. But it
  measures agreement between the lanes and the planner that files, and when
  the lane that stated the confidence is the one that filed, that is close to
  circular. It can only join a decision to a finding by a failing endpoint's
  signature, so most decisions — layout, copy, accessibility — cannot be
  joined at all. On one measured run it could check 7 decisions.
- **An answer key.** On an app whose defects are known, each verdict can be
  judged right or wrong directly. On the same run the key could judge 31. It
  exists only for the demo app, and it is only as good as its own patterns.

The first version of the in-product check fell back to matching evidence text
when no signature could be built. `500 on GET /api/r0` against a finding filed
as `GET /api/r0 500` matched nothing, and a lane that was right about a bug
that was filed published an expected calibration error of 0.90.

## Decision

Both checks exist, and each says what it is.

- **In the report** (`calibration.ts`), a decision is checked only when it
  called a defect, named a failing endpoint, and stated a usable confidence.
  Anything else is counted as unjoinable and disclosed, never scored as wrong.
  No figure is published below eight checkable decisions; the section says so
  instead of vanishing. The section leads with what it is not: agreement with
  the project's bar over its whole history, not evidence about the app.
  Verdicts from `scout_verify`, which are about the app, are reported beside it.
- **In the benchmark** (`bench.ts`), each verdict is judged against the key. An
  unsure verdict, a decision the key does not name or names ambiguously, and a
  not-a-defect whose stated reason is that another lane owns the thing are not
  scored, and each is counted by reason. It reports a Brier score beside the
  expected calibration error.

## Consequences

The report's figure is an ordering, not a measurement, and says so. The
benchmark's figure is a measurement on one small app, and
[its page](../benchmark.md) says so beside every number.

Brier is the number to compare runs on. ECE on its own ranked a run whose
lanes were right 97% of the time but said so quietly below one right 84% of
the time: it measures honesty, not accuracy, and five out-of-scope dismissals
scored as wrong were enough to reverse which run looked better.

## Failure direction

**Disclose rather than score** whenever a decision cannot be judged. A missing
data point shrinks the denominator, visibly; a wrong one moves the figure and
reads as a finding about the lanes.
