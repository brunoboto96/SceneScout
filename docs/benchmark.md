# Measuring whether a change helped

Every change to the engine and the skill used to be made on judgement:
something looked wrong in a run, it was fixed, and the next run looked better —
or looked *different*, which is not the same thing. There was no number that
could go up or down, so a fix could not be told from a coincidence, and a change
that made things worse would not have been noticed.

The demo app makes a number possible, because it contains **known** defects.
[`demo-app/answer-key.json`](../demo-app/answer-key.json) lists them as data,
and `npm run bench` scores a run against it.

The discipline is borrowed from skill-optimisation work that treats an agent's
instructions as trainable state: **keep a change only when it moves a measured
score, and write down the ones that did not.**

## Running it

```bash
npm run demo:serve                         # restart it before each run: created orders persist in memory
# run SceneScout against http://127.0.0.1:4173 with a FRESH projectPath, e.g. /tmp/bench/run-3
npm run bench -- /tmp/bench/run-3          # --level medium by default; --json writes the scorecard
npm run bench -- --archive /tmp/bench/run-3 --run run-3 --note "what changed"   # dated by its last lane decision
npm run bench -- --all                     # re-score every archived run against the current key
```

Archive every run you intend to compare. An archive keeps only what scoring
reads — findings and lane decisions, with local paths removed — so when the key
changes, `--all` re-scores the old runs against the new key. Two scorecards
from different keys are not comparable, and each one prints its key's hash.

Use a fresh project directory per run. A project's memory accumulates findings
across runs, and scoring an accumulated one credits a run with what an earlier
one found.

## What the scorecard measures

| Number | Meaning |
|---|---|
| **Recall** | Planted defects found **and filed**, out of those the key expects at the run's level. A defect only a fuzzing pass can reach is not a miss at `medium`. |
| **Precision** | Findings that match a planted defect or a known real one, out of every finding the key can label. Unlabelled findings are listed and counted beside it, and the scorecard prints the bounds: precision if every unlabelled finding turned out wrong, and if every one turned out right. |
| **Judged, never filed** | A lane called it a defect in its report and nobody called `scout_finding`, so it never reached the report. |
| **False positives** | Findings matching a known non-defect, with the reason it is not one. |
| **Severity** | Each filed defect's severity against the key's. |
| **Lane calibration** | Whether a lane's verdict was right *according to the key*, bucketed by the confidence it stated, with an expected calibration error and a Brier score. A "not a defect" whose reason is that the thing belongs to another lane is not scored: it is a verdict about ownership, not about whether the thing is broken. |

The lane calibration here is the **real** one. The report's own calibration
section can only join a decision to a finding on a failing-endpoint signature,
and it measures agreement with what the run filed — which is close to circular
when the lane that stated the confidence is also the one that filed. The key
judges the verdict itself: in run 0 it could judge 31 decisions where the
in-product join could check 7.

### How the key decides what a piece of text is

Each entry carries regular expressions tried against a finding's evidence and
title. A **known non-defect** can be a deliberate narrowing of a real defect —
"the filter is stuck after the Archived 500" names the Archived failure and
claims something false about it — so it lists the defects it narrows in
`overrides`, and wins over those and nothing else. Text that any other pair of
entries both claim is **ambiguous**, listed, and scored as neither, so an
unanticipated phrasing shows up as a line asking for the key to be sharpened
instead of as a confident false positive.

The key tests itself (`bench-test`): every entry's title and examples,
non-defects' included, must classify to that entry, and no counter-example may.
When a run is scored, add any phrasing it used that the key got wrong as an
example or counter-example in the same change.

## What it does not measure — read before quoting a number

- **One small app.** Fourteen planted defects is a narrow test. A skill tuned
  hard against it will learn *this app*, and the score will rise without the
  engine getting better anywhere else. The fix is a held-out set — a second app
  the skill is never tuned against — and there is not one yet.
- **One run per configuration.** An agent run is not deterministic. A change of
  one finding between two runs can be noise. Treat single-run deltas as
  indicative, and repeat before acting on a small one.
- **Severities in the key are a judgement**, the key author's, and the
  scorecard says so.
- **The key only knows what it has been told.** An unlabelled finding is not
  wrong; it needs a person to judge it, after which it belongs in the key.
- **The key was written from the runs it scores.** 78 of its first 108
  examples are phrasings runs 0 and 1 used, so their zero ambiguous and zero
  unlabelled findings are true by construction; the rest are rewordings a
  reviewer wrote to break it. Runs 2–4 were the first runs it had not seen:
  against the key of the day they left 2, 10 and 5 findings unlabelled, and
  precision for runs 3 and 4 was then only bounded (70–100% and 78–96%). A
  person has since judged those findings against the demo's source and the
  judgements are in the key, so runs 2–4 are now fitted data too. Two stay
  unjudged on purpose: a placeholder a lane filed in run 2, and a dashboard
  count in run 3 that other lanes were changing while it was read. Runs 5–7
  were the next unseen runs: against the key of the day they left 1, 5 and 3
  findings unlabelled and one ambiguous, and those judgements are now in the
  key as well.
- **A negated claim still matches.** "Export CSV works, no error" is credited
  as the Export CSV defect: the key recognises *what* a finding is about, not
  whether it says the thing is broken. Findings are filed as defects, so this
  matters little for recall and precision, and not at all for calibration,
  which scores the verdict separately.
- **The answers are on disk.** The demo's source marks each seeded defect with
  a comment, and this key sits beside it. One lane in run 0 cited such a
  comment. Lanes are not told where the demo's source is, but nothing stops
  them reading it.

## Results

Each row is one run of the demo app at `medium`, in `safe-write`, eight
parallel lanes on a mid-tier model, each lane on the same routes. Every row is
re-scored against **one** key by `npm run bench -- --all`; the table below is
key `f7695befb6`. The archived runs are in [`bench/runs/`](../bench/runs/).

| Run | Date | What changed | Recall | Precision (labelled) | All findings | Unlabelled | False pos. | Judged, not filed | Lane calibration | Cost | Kept? |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| 0 | 2026-09-22 | Baseline, 3.4.0, briefs as written on the day | 11/13 | 16/21 (76%) | 21 | 0 | 5 | 1 | 26/31 (84%), ECE 0.05, Brier 0.113 | ~725k tokens, 241 tool calls, longest lane 3m38s | — |
| 1 | 2026-09-22 | **Lane briefs only** (engine unchanged) — see below | 12/13 | 28/28 (100%) | 28 | 0 | 0 | 0 | 34/35 (97%), ECE 0.12, Brier 0.035 | ~698k tokens, 283 tool calls, longest lane 5m09s | Yes, into the skill |
| 2 | 2026-09-22 | **Engine 3.5.0 only** — run 1's briefs verbatim | 9/13 | 25/25 (100%) | 26 | 1 | 0 | 1 | 29/30 (97%), ECE 0.10, Brier 0.053 | ~687k tokens, 266 tool calls, longest lane 5m37s | See runs 2–4 |
| 3 | 2026-09-22 | Repeat of run 2 | 10/13 | 29/32 (91%) | 33 | 1 | 3 | 0 | 30/33 (91%), ECE 0.10, Brier 0.090 | ~680k tokens, 260 tool calls, longest lane 5m40s | See runs 2–4 |
| 4 | 2026-09-22 | Repeat of run 2 | 11/13 | 26/27 (96%) | 27 | 0 | 1 | 1 | 29/35 (83%), ECE 0.07, Brier 0.101 | ~683k tokens, 271 tool calls, longest lane 4m40s | See runs 2–4 |
| 5 | 2026-09-23 | **Engine 3.6.1 only** — run 1's briefs verbatim | 11/13 | 30/31 (97%) | 31 | 0 | 1 | 0 | 31/35 (89%), ECE 0.09, Brier 0.080 | ~697k tokens, 248 tool calls, longest lane 9m30s | See runs 5–7 |
| 6 | 2026-09-23 | Repeat of run 5 | 10/13 | 31/33 (94%) | 33 | 0 | 2 | 0 | 33/37 (89%), ECE 0.06, Brier 0.092 | ~685k tokens, 264 tool calls, longest lane 4m39s | See runs 5–7 |
| 7 | 2026-09-23 | Repeat of run 5 | 10/13 | 29/30 (97%) | 30 | 0 | 1 | 0 | 30/35 (86%), ECE 0.12, Brier 0.089 | ~725k tokens, 292 tool calls, longest lane 6m08s | See runs 5–7 |

**Brier is the number to compare; ECE says which way a lane is off.** Run 1's verdicts were
right more often (97% against 84%), and its expected calibration error is
*worse*, because the lanes were right more often than they said: every verdict
stated at 0.6–0.8 was right. Lower ECE is not the goal on its own; a lane that
is right and says so less loudly than it could is underconfident, not wrong.
The Brier score — the mean squared gap between stated confidence and being
right, with no buckets — rewards both being right and saying so, and ranks run 1
ahead (0.113 → 0.035).
The first version of this scorer counted the five "belongs to another lane"
dismissals as wrong verdicts, which gave ECE 0.09 → 0.04 and read as an
improvement; that one choice was enough to reverse the comparison.

### Runs 5–7 — engine 3.6.1, measured three times

Again only the engine changed: run 1's briefs verbatim, a fresh demo app and
project directory per run. 3.6.1 carried the three changes runs 2–4 pointed at:
the duplicate check merges on a quoted title only between findings of one
family of kinds, `false_success` reads refusal wording only in live regions, and
the fold's unfiled check matches test ids and contrast ratios as well as exact
evidence. Per defect, runs 2–4 (3.5.0) against runs 5–7 (3.6.1):

| Defect | Runs 2–4 | Runs 5–7 | Reading |
|---|:---:|:---:|---|
| Sticky bar covers Save notes | 1/3 | **3/3** | The target of the family gate. Filed and kept as its own finding every run. Kept. |
| Double-submit creates two orders | 1/3 | 2/3 | The new-order lane double-clicked Create in runs 5 and 7; in run 6 it submitted twice in sequence instead. Lane behaviour. |
| Archived filter hides a 500 | 2/3 | 1/3 | The orders lane never selected Archived in runs 5 and 7, though run 5's report says it tried "all 7 options". Lane coverage, not judgement. |
| Empty customer does nothing | 2/3 | 1/3 | Run 6 probed an empty customer through the API only; run 7 submitted the empty form and judged doing nothing correct. |
| Email field has no label | 0/3 | 0/3 | Never found by any run since run 0. |
| Every other planted defect (8) | 3/3 each | 3/3 each | Stable. |

Recall is 11, 10, 10 against 9, 10, 11: no net change. The one engine effect in
the table is the sticky bar, and it moved from 1/3 to 3/3; the three rows that
moved the other way trace to what a lane chose to do, each in the logs.
Calibration is flat (Brier 0.080, 0.092, 0.089 against 0.053, 0.090, 0.101).

What else the series measured:

- **No `false_success` false positive in three runs**, against one in runs 2–4.
  One occurrence before is too few to call it fixed from the runs alone; the
  contrastive fixtures in `claims-test` are the evidence the rule holds.
- **The unfiled check: about 10 flags across three runs, against about 41.**
  Two were real. One made a lane withdraw a verdict on a second look (a sort
  button that does not reverse, where the page has no reverse feature); the
  other was a defect the duplicate check had merged away, below. Of the eight
  false flags, two were filings whose evidence *contains* the reported evidence
  word for word, and the rest were the same finding worded differently. (Counted
  by hand from the fold results.)
- **The duplicate check still merges across two different bugs within one
  family.** In run 6, "an unknown order id still shows live controls"
  (`GET /api/orders/9999 404`) was merged into "Request manager approval stays
  enabled on a pending order" (`POST …/request-approval 409`): its detail
  mentioned the button the other's title quotes, and both are flow findings.
  Asked to file it, the lane answered with the older finding's id.
- **The planner's relay changed the reports.** The notification that carries a
  lane's reply escapes `<` and `>`, and those entities reached the parser: one
  report was refused because `<n>` became `&lt;n&gt;` and pushed a route past
  200 characters, and most relayed evidence strings carried `-&gt;` for `->`.
- **Waiting after finishing: 38, 16 and 24 minutes a run** after a lane's
  report was folded, summed over the lanes. While working, gaps over 30 seconds
  were 36%, 3% and 0% of working time; run 5's lanes ran up to 9m30s against
  about 5 minutes in the other runs.

The key gained four real findings the runs surfaced (every created order has a
$0.00 total, the switch-role page does not show the active role, the new-order
form keeps its values after a create, and the email field accepts a malformed
address because the form sets `novalidate`) and two non-defects (the Reorder
flag is a badge, not a control; "an unknown id shows another order's data" is
false). The quantity-sort pattern was narrowed after it claimed a sort-toggle
finding that quoted the same row order. Every archived run was re-scored.

**Kept?** The family gate stays: it is the only line that moved, and it moved
the way it was aimed. Next, each with its own test: no quoted-title merge when
both findings carry request signatures that disagree, and say so when a filing
is merged; count filed evidence that contains the reported evidence as filed;
list the options of a `<select>` a lane never chose; and close each lane as
soon as its report is folded.

### Runs 2–4 — engine 3.5.0, measured three times

The engine changed and nothing else: run 1's eight lane briefs verbatim, a fresh
demo app and project directory per run, the same planner behaviour. Three runs,
because at 13 planted defects one defect is about 8 points of recall and a
single run could not tell a one-defect effect from noise. Per defect, run 1
(3.4.0) against runs 2–4 (3.5.0):

| Defect | Run 1 | Runs 2–4 | Reading |
|---|:---:|:---:|---|
| Delete reports success after a refused write | ✓ (by luck) | **3/3** | The target of answering a refused write with a 403. Kept. |
| Stored XSS (above the `medium` contract) | ✓ | **3/3** | The injection oracle fired in the list lane for a value the create-form lane typed. Kept. |
| Sticky bar covers Save notes | ✓ | **1/3** | Judged every run; merged away in runs 2 and 4, see below. Run 3's survived because its title blamed the textarea. |
| Double-submit creates two orders | ✓ | 1/3 | The logs show the new-order lane double-clicked Create only in run 4, the run that found it. Lane behaviour, not the engine. |
| Archived filter hides a 500 | ✓ | 2/3 | The run-3 orders lane selected Archived seven times and filed nothing about it: a judgement miss, not unexplored ground. |
| Empty customer does nothing | ✓ | 2/3 | Not established. |
| Email field has no label | · | 0/3 | Missed in run 1 too; not an engine effect. |
| Every other planted defect (7) | ✓ | 3/3 each | Stable. |

**The sticky bar is lost to the duplicate check, depending on how it is
titled.** The store merges two findings on one route when a string of 8–80
characters quoted (or in parentheses) in one title matches one quoted in the
other finding's title, detail or evidence.
When a lane titled the sticky-bar defect with the button's quoted label
(`… covers the "Save notes" button`), that label also appeared in the
save-notes false-success finding's detail (`clicking "Save notes" shows
"Saved."`), and the layout defect was folded into the data one — in runs 2 and
4. Run 1 filed both without a merge because its sticky-bar title did not quote
the label; run 3's survived because it blamed the textarea. The archives hold
findings only after the merge, so the mechanism is shown by a test that
reproduces it, in the change that fixes it, rather than by these files.

What else the series measured:

- **Refusals on format: 1 in 24 lane reports**, for an observation over the
  64-character limit, fixed in one round trip. Five reports wrapped their JSON
  in prose and were accepted with no unwrapping by hand.
- **The fold's unfiled check is noisy.** About 41 flags across the three runs;
  2 were real (one lane then filed a missed defect; the other was the sticky
  bar the merge had swallowed), 3 were variants the lanes confirmed were
  covered, and the rest were the same finding worded differently in the report
  and the filing. It needs a looser match before it is worth reading. (Counted
  by hand from the fold results, which the archives do not keep.)
- **A `false_success` false positive.** A real 409 followed by "Only an open
  order can be sent for approval" was read as a success claim on the word
  "sent". The rule knows error wording, not refusal wording.
- **Waiting, not idling.** Split from the logs, idle gaps while lanes were
  working were 0–6% of their working time. Separately, lanes that had finished
  held their browsers for 18–28 minutes a run in total, summed over eight
  lanes, until the slowest lane's report was folded — planner overhead, which
  the pace section now reports apart from the lanes' working time.
- **Lane calibration fell** (Brier 0.035 in run 1; 0.053, 0.090, 0.101), with
  low-confidence verdicts (0.4–0.6) wrong more often than stated in run 4. Three
  runs is not enough to tell whether that is the engine or the lanes.

**Kept?** The refusal answer hit its target in 3/3 runs, against one lucky find
in run 1, and stays. The shared probes stay on the evidence of the logs — the
list lane's injection oracle fired for a value only the create lane had typed —
but run 1 found the stored XSS by hand without them, so 3/3 does not show they
were needed. The duplicate check, the `false_success` refusal wording and the
unfiled check's matching are the next changes, each with its own test, and the
next measured series re-runs these briefs against them.

### Run 1 — what changed, and what each change moved

Six changes to the lane briefs, bundled because a run costs about 700k tokens,
and each aimed at a *different* line of the scorecard so the effect can still be
attributed:

| Change to the brief | Line it targeted | What happened |
|---|---|---|
| File every judged defect *before* writing the report | Judged, not filed | 1 → 0. The sticky bar was filed this time. |
| Before calling a list empty or stuck, check its request's status | False positives | The stuck-filter claim did not recur: the lane checked `Rejected` returned `200 []` and said so. |
| On a create form, submit one markup value, then view where it is listed | Stored XSS (above level) | **Found**, by both the create lane and the list lane. |
| Go straight to your own route; ignore the landing page | Duplicates | Mixed: most lanes ignored the dashboard's broken image, one still filed it. |
| Check coverage before finishing | Gap ledger | Lanes reported doing it; not scored by the benchmark yet. |
| Do not close your session; the planner folds, then closes | Calibration data kept | 56 decisions kept with no re-attach, where run 0 needed seven re-attaches. |

What the numbers do **not** show:

- **Recall rose by one, net.** Run 1 gained the sticky bar and the delete
  false-success, and **lost the email-label defect** run 0 had found. The lane
  that owns that form spent 54 tool calls on the markup check and the journey.
  One run cannot tell budget from noise.
- **The delete false-success was partly luck.** It surfaced because one lane
  deleted an order another lane had created: ownership is shared across a run's
  sessions, so the request reached the server, which refused it, and the page
  navigated away as if it had succeeded. Nothing in the brief asked for that.
- **Four false positives vanished with no change aimed at them** — the two
  empty live regions reported as unnamed, the inert customer rows, and the
  sign-in double-click. Only the stuck filter was targeted. Treat the other
  four as noise until a run proves otherwise.
- **Protocol compliance got worse.** Six of eight lanes wrapped their JSON
  report in prose, which the parser refuses; in run 0 none did. The planner
  unwrapped them by hand. A brief that asks for more steps seems to invite more
  narration.
- **The briefs were not identical across lanes.** Two generic method lines —
  call the endpoint behind a withheld control, and check a sort or filter
  result is what it claims — were added part-way, so the first lanes launched
  without them. Neither route those lanes owned had a defect either line could
  reach. Run 0, meanwhile, told one lane about two of its routes' defects, which
  made run 0 *easier*, not harder.

### Run 0 — what went wrong

- **Missed: Delete reporting success after a refusal.** The write policy
  *aborted* the blocked request, the aborted `fetch` threw before the page's
  unconditional success line ran, and the lie never appeared. The safety net
  hid the bug it should have exposed.
- **Judged, never filed: the sticky bar covering *Save notes*.** A lane put it
  in its report at 0.75 and never filed it.
- **Not attempted: the stored XSS** (expected only at `extensive`). Even if a
  lane had typed markup into the new-order form, injection probes belong to one
  session, and the list that renders it belonged to another lane's session.
- **A high-severity false positive.** A correct empty list for *Rejected* had
  the same state fingerprint as the *Archived* 500, and a lane read identical
  fingerprints as a stuck filter. Only the request's status tells them apart.
- **Two false positives from empty live regions** reported as unnamed.
- **Mechanics:** every lane attached on `/` first, so five lanes met the
  dashboard's broken image; lanes closed before their reports were folded, so
  nothing was kept for calibration until they were re-attached; and the report
  gate counted design audits per session, which forced the planner to run one.

## Rejected and not-yet-tried

Edits considered and not kept, so they are not retried blind:

- **Scoring a run against its accumulated project memory.** Rejected: a
  project remembers findings across runs, so a later run would be credited with
  an earlier one's finds. Every benchmark run uses a fresh project directory.
- **A literal-text fallback for evidence that names no endpoint.** Rejected in
  the in-product calibration after it scored a correct lane as wrong; the same
  reasoning keeps this scorer on explicit key patterns rather than text
  similarity.
- **Non-defect patterns that exclude by a list of banned words** ("coming soon"
  unless the text says "dead end" or "no nav"). Rejected after a second review
  found ordinary phrasings the list missed, each scored as a false positive. A
  non-defect's pattern now has to state the specific false claim.
- **A known non-defect that wins every match it takes part in.** Rejected
  after review: realistic rewordings of three planted defects — a delete that
  navigates away "anyway", a dead end that "says coming soon", an XSS "escaped
  on the detail page but executed on the list" — were scored as false
  positives. A non-defect now wins only over the defects it names in
  `overrides`.
