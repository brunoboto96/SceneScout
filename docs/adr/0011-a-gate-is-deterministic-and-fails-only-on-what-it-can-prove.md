# 11. A gate is deterministic, and fails only on what it can prove

Status: accepted

## Context

SceneScout's exploratory runs are driven by a model. That is what lets them
find a double-submit or a permission leak, and it is also why two runs of the
same app do not produce the same findings. A pull-request gate needs the
opposite property: the same app must give the same verdict, or people learn to
re-run the job until it goes green.

Much of what the engine measures needs no model at all: HTTP and page errors,
layout geometry, broken images, contrast, controls with no name, pages with no
way out. `scenescout check` is that part on its own.

## Decision

- **No model at any step.** `check` visits routes (the start URL, the project's
  scanned routes and every same-origin link it finds, up to `--max-routes`) and
  measures each one. It never fills a form, clicks through a flow or judges
  anything. Exploration belongs to the agent-driven run, which reports rather
  than gates.
- **Visiting only.** `--mode` accepts `observe` and `read-only`, nothing that
  writes. A check never needs a write, and a gate pointed at a shared
  environment should not be able to make one.
- **Default gate: high.** Only facts that mean the page is broken fail it by
  default: a page that did not load or answered 5xx, an uncaught exception, a
  5xx from a request the page made, a failed request shown as success or as an
  empty result, markup rendered from typed input, an overlay the user cannot
  get past (a leaked scroll lock, a backdrop with no dialog, an empty dialog).
  A dialog that is merely badly placed is medium: it may still be usable.
  Everything else is reported at medium or low and gates only when asked for
  with `--fail-on`.
- **A console error is medium.** Its cause almost always shows as its own
  request or page error, which carries the severity. Gating on the console line
  as well would fail a pull request twice for one 404 image, and fail it on the
  noise many apps print at load.
- **An embed's failure is medium at most**, as in the report (ADR 2's frame
  rules): another site's behaviour is not the app's defect.
- **One issue per fact.** The same failing request on ten pages is one issue
  listing ten routes. Evidence carries no snapshot refs and no origin, so its
  fingerprint is the same on a laptop, a CI runner and a preview deployment.
- **A throwaway memory.** A check never reads or writes the project's
  `.scenescout/memory.json`: earlier exploratory runs' visits would otherwise
  count as this check's and skip those routes.
- **Exit codes mean one thing each:** 0 passed, 1 failed the gate, 2 could not
  run (a bad argument, an app that never answered, a saved session that no
  longer signs in, a start page that bounces to sign-in, results that could not be
  written). A broken setup must never read as either verdict: a check of the
  sign-in page is not a check of the app.
- **Nothing measured is not clean.** A page whose design audit could not read
  it is named in the verdict line and in `check.json`, so silent contrast and
  focus rules are never mistaken for passing ones. A layout line no rule knows
  is kept as a low `layout-issue`, never dropped.
- **Nothing secret is written.** Credentials in the start URL are refused, and
  tokens in routes and request URLs are redacted before the report, the JSON,
  the SARIF or the CI job summary is written.

## Consequences

- A check finds less than a run. On the demo app it finds the five answer-key
  defects that show at page load (the missing chart, the badge over a button,
  the faint hint, the covered Save button, the dead end) and none of the ones
  that need an interaction, and its report says what it does not cover. The
  unlabelled email field is missed: the snapshot names an input by its
  placeholder, so no rule can yet tell a placeholder from a label.
- Severities are a fixed table in `check.ts`. Moving a rule's default severity
  changes every user's gate, so it is a user-visible change with a changeset,
  and `check-test` pins the table's consequences.

## Failure direction

When a rule could either fail a clean pull request or pass a broken one, the
default gate passes. A gate that fails on noise gets switched off, and then it
catches nothing. `--fail-on medium` is there for teams that want a stricter one.
