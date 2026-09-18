# 3. A gap-ledger entry must be actionable, and suppression must be visible

Status: accepted

## Context

The GAP LEDGER is the product's trust mechanism: `scout_report {level:'extensive'}`
refuses while the ledger is non-empty, so "nothing known was left untested" is a
checkable claim rather than a promise. That only works if two things hold.

**Every entry must be actionable.** In a real audit the ledger reported twelve
routes as "form filled but NEVER submitted" that no one could ever close:

- register **search boxes** — typing in a filter is the control working, and
  there is no submit on that route at all;
- **read-only filter pages** (an audit-trail view, a usage dashboard) — same
  shape, nothing to submit;
- **wizard intermediate steps** — the POST lands on the final step's URL, so
  every earlier `?step=` route looked abandoned even after the wizard completed.

A reader learns to skip a list like that, and a skipped ledger is worse than no
ledger: it still blocks `extensive`, so the completion contract becomes
unsatisfiable and the only way to finish is `force=true` — which trains people
to force every run.

**But suppression is how a completeness guarantee dies quietly.** Every rule
that removes an entry can remove a real one. "No submit control found" also
describes a genuine form whose submit is icon-only, unlabeled, or below the
collector's 150-element cap.

## Decision

An entry is reported only when it is actionable, and everything the heuristic
*declined to judge* is reported separately as a non-gating disclosure.

- Filter-ish fields are ignored when deciding whether a form was filled, matched
  **per token** (`tid:widget_submit_btn` splits the same as `widget-submit-btn`
  and `widgetSubmitBtn`; `research-title` is not a "search").
- A state must actually offer a submit control, **or** be at the collector cap —
  "we did not look far enough" is not "there is nothing to submit".
- A wizard's submission clears its sibling `step=` routes, and only `step=`:
  `tab=`/`section=` are distinct screens everywhere else in the engine, so
  treating them as one form silenced real gaps on exactly the routes the ledger
  exists for.
- Routes that are not pages (API endpoints, downloads) never enter the route
  contract at all, however they were discovered.
- States filled with no recognizable submit are printed in the report as an
  explicit `ℹ` disclosure and are **excluded from `computeGaps`**, so they can
  never gate `extensive`.

## Consequences

The ledger is short enough to read, and `extensive` is reachable on an app that
has a search box. In exchange the report carries a disclosure line the reader
has to scan, and a form with a genuinely unlabeled submit lands in that line
rather than in the gap list.

## Failure direction

Chosen deliberately: **disclose rather than either report or hide.** Reporting a
filter as a gap makes the contract unsatisfiable; hiding an unjudgeable state
makes the completeness claim a lie. Naming it as "not judged" is the only option
that keeps both the contract satisfiable and the claim honest.
