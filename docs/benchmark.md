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

These score the demo, which is the default. The held-out app takes `--app
holdout`; see [the held-out app](#the-held-out-app).

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
| **Set aside** | Findings matching a *contextual* entry: something that is a defect only under a convention the run cannot see. They are in neither precision's numerator nor its denominator, and are not unlabelled; the scorecard lists them and says how many. |
| **Severity** | Each filed defect's severity against the key's. |
| **Lane calibration** | Whether a lane's verdict was right *according to the key*, bucketed by the confidence it stated, with an expected calibration error and a Brier score. A "not a defect" whose reason is that the thing belongs to another lane is not scored: it is a verdict about ownership, not about whether the thing is broken. Nor is a verdict about a contextual entry, either way: both answers are defensible. Each reason a verdict was not scored is counted and printed. |

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

A **contextual** entry (`contextual` in the key) names an observation that is a
defect only under a convention the run cannot see, and its `reason` says which
convention: padding off a 4px grid matters only where the project declares a
spacing scale. It is one more claimant on the same terms as a real entry: it
wins over nothing, no non-defect may list it in `overrides`, and text it shares
with any other entry is ambiguous. That is deliberate: setting a finding aside
takes it out of precision, so a contextual pattern that won its overlaps would
hide a real defect from the score as quietly as a greedy non-defect once did.

The key tests itself (`bench-test`): every entry's title and examples,
non-defects' and contextual entries' included, must classify to that entry, and no counter-example may.
When a run is scored, add any phrasing it used that the key got wrong as an
example or counter-example in the same change.

## What it does not measure — read before quoting a number

- **One small app.** Fourteen planted defects is a narrow test. A skill tuned
  hard against it will learn *this app*, and the score will rise without the
  engine getting better anywhere else. The [held-out app](#the-held-out-app)
  is the check on that: a second app nothing is tuned against. It is small too,
  so it bounds the problem rather than removing it.
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
  key as well. Runs 9 and 10 left 4 each (precision bounded at 87–100% and
  83–100%); those are judged and in the key too. The held-out key is in the
  same position after its first two runs: beyond the thirteen planted defects,
  one also-real entry and six non-defects it started with, every entry was
  judged from what those runs reported (see
  [Held-out runs 1 and 2](#held-out-runs-1-and-2)).
- **A negated claim still matches.** "Export CSV works, no error" is credited
  as the Export CSV defect: the key recognises *what* a finding is about, not
  whether it says the thing is broken. Findings are filed as defects, so this
  matters little for recall and precision, and not at all for calibration,
  which scores the verdict separately.
- **The answers are on disk, and some are served to the lanes.** The demo's
  source marks each seeded defect with a comment, and this key sits beside it.
  One lane in run 0 cited such a comment. Lanes are not told where the demo's
  source is, but nothing stops them reading it. More directly: eleven of those
  comments are in files the browser downloads (eight in the pages' own markup
  and scripts, three in the stylesheet), and a lane that reads a page's own
  script reads the answer. Run 8's orders lane quoted the line directly under
  one. Every run so far was made with the comments served; removing them is
  tracked in issue #133, and runs made after that are the first whose recall
  cannot have been read from a page.

## The held-out app

[`holdout-app/`](../holdout-app/) is a second small app, a library loans desk,
with thirteen planted defects of the same kinds as the demo's (an HTTP failure,
a layout defect, a contrast failure, an unnamed control, a dead end, a
permission the server skips, a filter that lies, a silent no-op, a double
submit, a false success, a stored XSS, stale state and a page error) but none
of the demo's particular bugs. It has its own [answer key](../holdout-app/answer-key.json)
in the same schema. It exists to answer one question the demo cannot: **does
what was learned on the demo generalise?** A change that lifts the demo's
recall and leaves the held-out app's flat taught the engine the demo. Five of
the thirteen share both kind and mechanism with a demo defect (the double
submit, the stored XSS, the dead end, the false success and the contrast
failure), so on those the held-out score mostly measures transfer to the same
kind of bug in a new place; the other eight work by different mechanisms.

```bash
npm run holdout:serve                      # http://127.0.0.1:4180; restart it before each run
npm run bench -- /tmp/bench/holdout-1 --app holdout
npm run bench -- --archive /tmp/bench/holdout-1 --app holdout --run holdout-1 --note "what changed"
npm run bench -- --all --app holdout       # --all alone prints one table per app
```

`--app` picks the key; it defaults to `demo`, so every earlier command and
archive scores as before. An archive records its app, and is always scored
with that app's key: asking for another app's key for it, by `--app` or by
passing the other app's key file to `--key`, is refused, and `--all` scores
each archive against its own app's key, one table per app. (`--key` can still
name a key no benchmark app ships, for trying out a draft.)
Archives made before there was a second app carry no `app` and are the demo's.

The rules that keep it held out:

- **Nothing is tuned against it.** Runs on it are reported beside the demo's,
  never optimised against. A miss on the held-out app is not a bug report for
  the engine: do not add its failures to an engine rule, an oracle, the skill
  or a brief. If a demo change is what fixes it, the held-out score says so on
  its own.
- **Its key is not read by anyone writing lane briefs for it.** A brief written
  by someone who knows the answers measures the brief's author. The same goes
  for its `server.mjs`, which marks where the defects are, and for the spoilers
  table in its README. Like the demo's, these answers are on disk in this
  repository; a run whose lanes cite them is not a held-out run.
- **Nothing it serves names a defect.** `holdout-test` fails if a served file
  mentions a planted defect, its key's ids, or the words a tester would search
  for, so a lane that reads a page's own script does not read the answer. The
  demo learned this late (see "The answers are on disk" above).
- **Labelling is allowed; teaching is not.** When a held-out run reports
  something the key does not know, a person may judge it against the source
  and add it to the held-out key as `alsoReal` or a non-defect, as for the
  demo. What must not happen is the engine being changed so the next held-out
  run finds more.
- **Its planted defects stay planted.** `holdout-test` fails if a well-meant
  fix removes one, because every held-out score before and after would stop
  being comparable.

Its runs are reported in [Held-out results](#held-out-results).

## Results

Each row is one run of the demo app at `medium`, in `safe-write`, eight
parallel lanes on a mid-tier model, each lane on the same routes. Every row is
re-scored against **one** key by `npm run bench -- --all`. The table below is
key `71458d9246`; a struck value is the same run under the previous key,
`f8e0862a8b`. For runs 0–8 the whole change is the new `contextual` list (see
"Runs 9 and 10"): the findings and verdicts on the spacing-grid and nav-link
entries are set aside instead of scored. The narrowed approve pattern and the
entries added for runs 9 and 10 change no finding or verdict in runs 0–8, and
the rule for "not mine" dismissals is unchanged. Recall did not move for any run. "All findings" counts every finding
the run filed, including the ones set aside. The archived runs are in [`bench/runs/`](../bench/runs/).

| Run | Date | What changed | Recall | Precision (labelled) | All findings | Unlabelled | False pos. | Judged, not filed | Lane calibration | Cost | Kept? |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| 0 | 2026-09-22 | Baseline, 3.4.0, briefs as written on the day | 11/13 | ~~16/21 (76%)~~ 14/19 (74%) | 21 (2 set aside) | 0 | 5 | 1 | ~~26/31 (84%), ECE 0.05, Brier 0.113~~ 24/29 (83%), ECE 0.05, Brier 0.109 | ~725k tokens, 241 tool calls, longest lane 3m38s | — |
| 1 | 2026-09-22 | **Lane briefs only** (engine unchanged) — see below | 12/13 | ~~28/28 (100%)~~ 25/25 (100%) | 28 (3 set aside) | 0 | 0 | 0 | ~~34/35 (97%), ECE 0.12, Brier 0.035~~ 31/31 (100%), ECE 0.10, Brier 0.017 | ~698k tokens, 283 tool calls, longest lane 5m09s | Yes, into the skill |
| 2 | 2026-09-22 | **Engine 3.5.0 only** — run 1's briefs verbatim | 9/13 | ~~25/25 (100%)~~ 20/20 (100%) | 26 (5 set aside) | 1 | 0 | 1 | ~~29/30 (97%), ECE 0.10, Brier 0.053~~ 25/26 (96%), ECE 0.07, Brier 0.046 | ~687k tokens, 266 tool calls, longest lane 5m37s | See runs 2–4 |
| 3 | 2026-09-22 | Repeat of run 2 | 10/13 | ~~29/32 (91%)~~ 23/26 (88%) | 33 (6 set aside) | 1 | 3 | 0 | ~~30/33 (91%), ECE 0.10, Brier 0.090~~ 24/27 (89%), ECE 0.08, Brier 0.082 | ~680k tokens, 260 tool calls, longest lane 5m40s | See runs 2–4 |
| 4 | 2026-09-22 | Repeat of run 2 | 11/13 | ~~26/27 (96%)~~ 22/23 (96%) | 27 (4 set aside) | 0 | 1 | 1 | ~~29/35 (83%), ECE 0.07, Brier 0.101~~ 25/29 (86%), ECE 0.05, Brier 0.080 | ~683k tokens, 271 tool calls, longest lane 4m40s | See runs 2–4 |
| 5 | 2026-09-23 | **Engine 3.6.1 only** — run 1's briefs verbatim | 11/13 | ~~30/31 (97%)~~ 25/26 (96%) | 31 (5 set aside) | 0 | 1 | 0 | ~~31/35 (89%), ECE 0.09, Brier 0.080~~ 27/29 (93%), ECE 0.12, Brier 0.060 | ~697k tokens, 248 tool calls, longest lane 9m30s | See runs 5–7 |
| 6 | 2026-09-23 | Repeat of run 5 | 10/13 | ~~31/33 (94%)~~ 26/28 (93%) | 33 (5 set aside) | 0 | 2 | 0 | ~~33/37 (89%), ECE 0.06, Brier 0.092~~ 28/30 (93%), ECE 0.06, Brier 0.064 | ~685k tokens, 264 tool calls, longest lane 4m39s | See runs 5–7 |
| 7 | 2026-09-23 | Repeat of run 5 | 10/13 | ~~29/30 (97%)~~ 26/27 (96%) | 30 (3 set aside) | 0 | 1 | 0 | ~~30/35 (86%), ECE 0.12, Brier 0.089~~ 27/30 (90%), ECE 0.07, Brier 0.072 | ~725k tokens, 292 tool calls, longest lane 6m08s | See runs 5–7 |
| 8 | 2026-09-25 | **Engine 3.9.0 only** (frames) — run 1's briefs verbatim | 11/13 | ~~25/26 (96%)~~ 22/23 (96%) | 26 (3 set aside) | 0 | 1 | 0 | ~~27/28 (96%), ECE 0.09, Brier 0.042~~ 24/24 (100%), ECE 0.09, Brier 0.014 | ~679k tokens, 240 tool calls, longest lane 4m00s | See run 8 |
| 9 | 2026-09-26 | **Engine 3.10.0 (wave 1)** — run 1's briefs verbatim, demo served without its seeded-defect comments | 13/13 | 31/31 (100%) | 31 | 0 | 0 | 0 | 30/33 (91%), ECE 0.12, Brier 0.123 | not recorded | See runs 9–10 |
| 10 | 2026-09-26 | Repeat of run 9 | 11/13 | 22/22 (100%) | 24 (2 set aside) | 0 | 0 | 0 | 23/26 (88%), ECE 0.14, Brier 0.109 | not recorded | See runs 9–10 |

**Brier is the number to compare; ECE says which way a lane is off.** Run 1's verdicts were
right more often (97% against 84% under key `f8e0862a8b`; 100% against 83% now), and its expected calibration error is
*worse*, because the lanes were right more often than they said: every verdict
stated at 0.6–0.8 was right. Lower ECE is not the goal on its own; a lane that
is right and says so less loudly than it could is underconfident, not wrong.
The Brier score — the mean squared gap between stated confidence and being
right, with no buckets — rewards both being right and saying so, and ranks run 1
ahead (0.113 → 0.035 under key `f8e0862a8b`; 0.109 → 0.017 now).
The first version of this scorer counted the five "belongs to another lane"
dismissals as wrong verdicts, which gave ECE 0.09 → 0.04 and read as an
improvement; that one choice was enough to reverse the comparison.

### Runs 9 and 10 — engine 3.10.0 (wave 1), measured twice

Only the engine changed: run 1's briefs verbatim, a fresh demo app and project
directory each time. 3.10.0 carries the first wave of fixes from run 8: a
field labelled only by its placeholder is flagged, forms never submitted empty
are listed in coverage, character references a relay adds to a lane's report
are decoded, a lane's session is not closed before its report is folded (the
lane-close guard), and a failed load another site's frame sent is attributed
to that embed. They are also the first two runs made
with the demo's seeded-defect comments no longer served (issue #133), so their
recall cannot have been read from a page.

| Defect | Runs 5–8 | Run 9 | Run 10 |
|---|:---:|:---:|:---:|
| Email field has no label | 0/4 | found | found |
| Empty customer does nothing | 1/4 | found | missed |
| Sticky bar covers Save notes | 4/4 | found | missed |
| Double-submit creates two orders | 3/4 | found | found |
| Archived filter hides a 500 | 2/4 | found | found |
| Every other planted defect (8) | 4/4 each | found | found |

Recall was 13/13 and 11/13. The email-label defect, missed in every run from 1
to 8, was found in both: the placeholder-label rule is the change aimed at it.
Run 10 missed two:

- **The empty-customer submit.** The new-order lane submitted the empty form,
  saw no new order on the server and judged it "blocked client-side", not a
  defect, at 0.8. The page says nothing when it refuses, which is the defect.
  The key now matches that verdict, so it is scored as a wrong one.
- **The sticky bar.** The order-detail lane measured Save notes covered by the
  bar at the top of the page and clear at the bottom, and judged it harmless
  because it covers Save only before scrolling, at 0.7. A control covered at
  the position the page loads in is the defect, so the verdict is scored as
  wrong.

Under the new key the wrong verdicts are three in run 9 and three in run 10:
the four "not my page" verdicts on the dashboard's broken image (below), the
empty-customer verdict and the sticky-bar verdict.

One run each is a direction, not a size: 13 against a range of 10–11 for runs
5–8, then 11. The email-label defect found twice is the result worth repeating.

**Calibration, and why the key gained a third list.** Under the previous key
(`f8e0862a8b`) the lanes' verdicts were right 26/39 and 22/31 times, the lowest of
any run, and the 22 wrong verdicts break down as:

- **16 were lanes calling two convention-dependent entries "not a defect"**:
  padding off a 4px grid (12 verdicts) and navigation links without an
  underline (4). The demo declares no spacing scale, and a link inside a
  navigation bar is recognisable by its position; WCAG's distinguishable-links
  rule is aimed at links in running text. Those lanes were not wrong, and
  neither were the lanes in earlier runs that filed the same things.
- **4 were "not my page" verdicts on the dashboard's broken image**, worded
  in ways the dismissal rule does not read as "not mine": "an asset of
  another page, not /route", "absent on a direct load", "from the other
  page's load", "not from this route". They stay scored as wrong under the
  unchanged rule. Widening the rule's wording was tried and not kept: the
  rule cannot know which routes a lane owns, so the same words also dismiss a
  lane's wrong verdict about its own page ("absent on a direct
  /orders-new.html load, so fine"), and runs 2, 4, 6 and 7 used equivalent
  wordings that the old rule scored, so the runs would no longer be scored
  alike. Those own-page wordings are now table-tested as not dismissals. The
  structural fix is follow-up work, not done here: archive each lane's
  routes from its lane report, and treat a not-a-defect as a dismissal only
  when the matched key entry's route is outside that lane's routes.
- **1 was a key mis-match.** "The page hides approve and reject from a clerk,
  not a defect" was classified as the planted defect that the approve
  *endpoint* accepts a clerk. The entry no longer matches a page hiding the
  controls, and that wording is its counter-example.
- **1 was a genuinely wrong verdict**: the sticky bar, above. The key also
  gained a sixth wrong one it did not match before: the empty-customer
  verdict, above.

So the key has a `contextual` list, for observations that are defects only
under a convention the run cannot see, each with the convention in `reason`.
The spacing-grid and nav-link entries moved there from the also-real list, and
a third joined them: run 10's "the orders filter is not kept in the URL",
which is a defect only where a project treats list state as addressable. A
finding matching one is set aside — neither right nor wrong — and a verdict on
one is not scored either way. Re-scored, every earlier run's labelled
precision and calibration moved, and for runs 0–8 this list is the only cause
(struck values in the table above); recall did not.

The seven findings the key did not know were judged against the demo's source:

- **Real, and new to the key:** Delete workspace and Save changes offered to a
  clerk and a read-only auditor, whom the server refuses; the order page still
  saying "open" after approval is requested; and the sticky bar's "Line items
  are edited from the list" pointing at a list with no way to edit items
  (found in both runs).
- **Real, and a rewording of an entry the key had:** orders created with 0
  items (the orders API's missing validation, which already covered negative
  counts), the confirmation email discarded (the email never sent to the
  server), and Request approval still offered on a pending order.
- **Contextual:** the orders filter not kept in the URL, above.

What else the runs showed:

- **A nav-link entry had to name the navigation.** Its generic "link(s) with
  no underline" pattern would have set aside unstyled links in running text,
  which the distinguishable-links rule does cover; it now needs "nav" nearby,
  and a paragraph-link wording is its counter-example.
- **The lane-close guard raised one false alarm in run 9.** The finding's
  evidence named the endpoint as `/api/orders/{id}/approve` while the lane
  quoted `/api/orders/1038/approve`, so the guard did not pair the two. Not
  fixed here; recorded so the pairing can be checked when it is.
- **No false positives in either run.**

**Kept?** Nothing is decided from one run each. The wave stays; repeat before
reading a size into any number here.

### Run 8 — engine 3.9.0, measured once

Only the engine changed again: run 1's briefs verbatim, a fresh demo app and
project directory. 3.9.0 added frame support (listing and acting inside frames,
the cross-origin write rules, trusted embeds, and attributing an embed's
failures to it). The demo has no frames, so no direct effect was expected; the
run checks that the frame work cost nothing on an app without frames.

| Defect | Runs 5–7 | Run 8 |
|---|:---:|:---:|
| Sticky bar covers Save notes | 3/3 | found |
| Double-submit creates two orders | 2/3 | found |
| Archived filter hides a 500 | 1/3 | found |
| Empty customer does nothing | 1/3 | missed |
| Email field has no label | 0/3 | missed |
| Every other planted defect (8) | 3/3 each | found |

Recall 11 is inside runs 5–7's range (11, 10, 10), so no change is claimed.
The Brier score is 0.042 against 0.080–0.092, but from 28 verdicts the key
could judge, against 35–37: one run, and a smaller sample, so a direction to
repeat rather than a result.

What else the run showed:

- **One finding needed a person.** "Failed orders fetch renders as a silent
  empty table" is the empty-table half of the Archived defect: one code path
  renders any failed fetch as an empty table, and only the Archived filter
  fails. The key now matches that phrasing as the Archived defect, so it counts
  as a duplicate. Runs 0–7 score the same under the new key.
- **That finding quoted the page's own script, directly under a comment naming
  the seeded defect.** See "The answers are on disk" above.
- **Relayed evidence still carried `-&gt;` for `->`** in five of the eight
  lane reports. Decoding it before evidence is stored is tracked in issue #130.
- **One lane's decisions nearly went uncounted.** The planner closed the audit
  lane's session before folding its report, so the fold kept nothing for
  calibration. The session was re-attached read-only and the same report
  folded again, which kept all six decisions. A guard for this is tracked in
  issue #132.
- **The unlabelled-email defect has now been missed in eight consecutive
  runs** (1–8; run 0 found it). The snapshot names an input by its placeholder
  when it has no label, so no rule can tell the two apart; that is tracked in
  issue #128.

**Kept?** Nothing to keep or reject: the run measures a feature the demo does
not exercise, and shows no loss.

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

## Held-out results

Each row is one run of the [held-out app](#the-held-out-app) at `medium`, in
`safe-write`, eight parallel lanes, re-scored by `npm run bench -- --all`
against key `4ffabb6bd3`. A struck value is the same run under the key the runs
were made against, `77ebf9b0d9`. Nothing in this table is kept or rejected:
held-out runs are reported, never optimised against.

| Run | Date | What changed | Recall | Precision (labelled) | All findings | Unlabelled | False pos. | Judged, not filed | Lane calibration | Cost | Kept? |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| holdout-1 | 2026-09-26 | **Engine 3.10.0 (wave 1)**, first held-out run; briefs written by an agent that saw the app only through the browser | 9/10 | ~~11/11 (100%)~~ 15/18 (83%) | 20 (2 set aside) | ~~9~~ 0 | ~~0~~ 3 | 0 | ~~19/21 (90%), ECE 0.13, Brier 0.111~~ 23/26 (88%), ECE 0.12, Brier 0.098 | not recorded | — |
| holdout-2 | 2026-09-26 | Repeat of holdout-1, same briefs | ~~8/10~~ 7/10 | ~~11/11 (100%)~~ 22/23 (96%) | 24 (1 set aside) | ~~13~~ 0 | ~~0~~ 1 | 0 | ~~18/20 (90%), ECE 0.15, Brier 0.069~~ 29/32 (91%), ECE 0.16, Brier 0.113 | not recorded | — |

### Held-out runs 1 and 2

The held-out app is the check on the demo: a second app nothing is tuned
against, so a gain that shows on the demo and not here was learned from the
demo. These are its first two runs, on engine 3.10.0, the engine of demo runs 9
and 10. The eight lane briefs were written by an agent that saw the app only
through the browser and never read its key, its `server.mjs` or its README's
spoilers table; both runs used the same briefs, a fresh app and a fresh project
directory.

| Defect | holdout-1 | holdout-2 |
|---|:---:|:---:|
| Overdue tag contrast 1.84:1 | found | missed |
| Place hold on a book with copies on the shelf does nothing | missed | missed (a near miss, below) |
| Renew double-click spends both renewals | found | missed |
| Every other planted defect at `medium` (7) | found | found |
| Stored XSS in reviews (above `medium`) | found | found |

Recall was 9/10 and 7/10. What the archives show about the misses:

- **Place hold, both runs.** No lane clicked Place hold on a book with a copy
  on the shelf; the holds the lanes placed were on books all out on loan, or
  withdrawn. A coverage miss, not a judgement one.
- **The overdue tag, run 2.** The loans lane renewed the member's only overdue
  loan (its own decisions record the overdue count going to 0), after which the
  page has no overdue tag to measure. The archive does not keep the order, so
  whether the audit ran before or after is not known.
- **The renew double-submit, run 2.** The lane renewed one loan twice in
  sequence (0 → 1 → 2) and did not double-click. Lane behaviour, as with the
  demo's double-submit in runs 2–7.

**Near misses, decided by what the planted defect is:**

- Run 2's "Book not found page still shows a Place hold button that does
  nothing" was credited, under the old key, as the Place hold no-op. It is a
  different defect: the page sets `hidden` on the button, which the
  stylesheet's `display: inline-block` for buttons overrides, and the handler
  returns early because there is no book. The planted defect is a real book
  with copies on the shelf. It is now its own also-real entry and the planted
  entry's counter-example, which is why run 2's recall fell from 8 to 7.
- Run 2's "Renew button stays enabled on a loan already renewed 2 of 2 times"
  is not the double-submit: it is the button offered where the server always
  refuses, one click, one 409 with a clear message. It is a separate low
  also-real entry, on the same terms as the demo's "Request approval still
  offered on a pending order". Run 1's "Renew stays enabled at the renewal
  limit and a quick double-click reports an error" *is* the double-submit:
  its evidence is two renew requests from one double-click (200, then 409),
  which is the planted mechanism, though the loan had only one renewal left to
  spend.
- Run 2's "Double-clicking Check out creates two loans of the same book for
  one member" is real and not planted: the checkout button is not disabled
  while it saves either. It is also-real, not a match for the renew defect.
- "A hold on a book with zero copies" and "a hold on a withdrawn book" are the
  same defect (the one zero-copy title is the withdrawn one), and one entry.
  The same `hidden` override means the page also offers Place hold on the
  withdrawn book, so this one is reachable without calling the API.

**Precision and the key.** Under the key the runs were made against, precision
was 11/11 in both runs and meant little: 9 and 13 findings were unlabelled, so
all it could say was 55–100% and 46–100%. The key has since been completed
from these runs' findings, judged against the app's source, so **these rows
are the first runs the held-out key never saw, and its new entries were judged
from what these same runs found**; the next held-out run is the first scored
by a key that was not fitted to it. The judgements:

- **Real, new to the key (11):** Renew offered at the renewal limit; a
  double-click on Check out lending one book twice; a hold accepted on a
  withdrawn book; Place hold shown on a book that is not found; Place hold
  offered to staff with no way to name a member, so it always fails; "1 holds
  waiting"; the events page never showing which events a member joined; the
  holds list not saying which holds are ready or where each is in its queue;
  dropping a hold and waiving a fine each in one click with no confirmation
  or undo (irreversible for the member, as the demo's Delete workspace); and a
  double-click on a hold's drop button dropping it and then showing "No such
  hold".
- **Real, a rewording of an entry the key had:** the checkout book list
  offering titles with no copy on the shelf.
- **Not a defect (3), each with the false claim as its matcher:** the Download
  my data link "styled like body text" (it is a bordered button); the
  Available now only checkbox "has no accessible name and a 13x13 target"
  (it is wrapped in its label, whose text names it and is part of the click
  target); and the fines page "a dead end" for a member (it refuses a member
  with a 403, says so, and keeps the header's navigation), as the key already
  treats the members page.
- **Contextual (3):** nav links without an underline, as on the demo; a link
  with no `data-testid`, because a test id is a project convention no user
  meets (the app uses them on most controls, so a run sees the habit but not
  whether it is a rule; the demo's key counts one missing test id as real, from
  before it had a contextual list, and is not changed here); and the events
  list not being in date order, which the page never claims.

Four matches in the old key were wrong, and each is fixed: the `holds-drop` test-id
pattern claimed every finding about that button (so run 2's "no confirmation"
counted as a duplicate of the unnamed button, and two correct "dropping works"
verdicts in run 1 were scored as wrong); the third-renewal non-defect claimed
"Renew is still offered at the limit"; the Place hold no-op claimed the
not-found page; and the export-clipped pattern claimed the "styled like body
text" finding by its test id (now overridden by that finding's non-defect).
One finding in each run names the home page's notices 500 on the account page;
it stays counted as that defect: the request is the home page's, reported by a
lane that saw it in the network log.

**Calibration** is 23/26 and 29/32. Under the old key it was 19/21 and 18/20,
and three of its four wrong verdicts were the mis-matches above. The wrong
verdicts now are the lanes' own verdicts on the three false positives in run 1;
in run 2, the verdicts on the export link's styling and the checkbox, plus one
"not a defect" on the notices 500 whose reason is that it is the home lane's, worded ("home lane") in a way the dismissal rule does not
read, like the demo's runs 9 and 10. Run 2's Brier rose (0.069 → 0.113)
because eleven verdicts stated at 0.4–0.6 are now judged where before most
were not.

**Against the demo on the same engine** (runs 9 and 10, 3.10.0):

| | Demo runs 9, 10 | Held-out runs 1, 2 |
|---|---|---|
| Recall | 13/13, 11/13 (24/26, 92%) | 9/10, 7/10 (16/20, 80%) |
| Precision (labelled) | 100%, 100% | 83%, 96% |
| False positives | 0, 0 | 3, 1 |
| Brier | 0.123, 0.109 | 0.098, 0.113 |

Recall is lower on the held-out app, and the misses are not where a demo-only
engine would put them. Of the four `medium` defects that share kind and
mechanism with a demo defect (double-submit, dead end, false success,
contrast), run 1 found 4 and run 2 found 2; of the six that work by other
mechanisms, each run found 5. Every miss traces to what a lane did or did not
do, not to a finding judged wrong. The briefs also differ: the demo's were
revised against its own scores after run 0, these were written blind, so the
gap mixes transfer with brief authorship. One run each is a direction, not a
size: on a ten-defect app one defect is 10 points of recall.

**An engine observation, recorded here and addressed by task 32 (#172).** In run 2 the account
lane filed "export link styled as body text", and SceneScout's finding dedup
merged it into a different finding on the same element, the link clipped out
of view: two distinct findings on one element became one. The merged-away
claim is judged not a defect above, so run 2's score lost nothing (run 1, which
kept both, took a false positive for it), but the same merge would hide a real
second defect on an element that already has one. Task 32 changes the dedup
so findings of different kinds on one element stay apart (ADR 4); it was made
against the test fixtures, not tuned here. The archived runs cannot show its
effect: their findings were stored after dedup, so re-scoring them changes
nothing. The effect will be measured in the next demo and held-out runs, after
the wave 3 engine changes land, against runs 9 and 10 and held-out runs 1 and
2. One cost is expected: the finding run 2 lost to the merge is a known
non-defect, so on the held-out app the change should show as one more false
positive, as run 1 already did.

A second, from both runs: the evidence for the checkbox finding gives its name
as `"checkbox"`, while the browser's accessibility tree names it "Available
now only" from the label that wraps it. Where that name came from is not in the
archive; it is recorded so it can be checked, not fixed against this app.

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
- **Widening the "not mine" wording rule to take more phrasings.** Rejected
  in review for runs 9 and 10. Phrasings such as "absent on a direct load" or
  "from the other page's load" are as likely to be the owning lane's verdict
  on its own page, which the rule cannot tell apart without knowing each
  lane's routes, and a wider rule would score new runs differently from old
  runs that used the same words. The rule stays as it was; the follow-up is to
  archive each lane's routes and decide by the matched entry's route.
