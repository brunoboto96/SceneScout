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
reads — findings, lane decisions and the routes each lane's report said it
covered, with local paths removed — so when the key
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
| **Set aside** | Findings matching a *contextual* entry: something that is a defect only under a convention the run cannot see. They are in neither precision's numerator nor its denominator, and are not unlabelled; the scorecard lists them and says how many. So are findings the run itself filed as worth a look ([ADR 13](adr/0013-a-convention-is-the-projects-to-decide.md)): the run did not claim them as defects, so they are in neither recall nor precision, whatever the key says about them; the archive keeps a finding's tier, and the scorecard lists them and says how many. Archives made before the tier existed hold none. |
| **Severity** | Each filed defect's severity against the key's. |
| **Lane calibration** | Whether a lane's verdict was right *according to the key*, bucketed by the confidence it stated, with an expected calibration error and a Brier score. A "not a defect" about something on another lane's page is not scored: it is a remark about ownership, not a verdict on whether the thing is broken. Where the run archived its lanes' routes, that is decided by where the thing is: the verdict matches a planted or also-real defect none of whose pages (`route`, `alsoOn`) the lane covered, and one marked `everyPage` (something every lane can reach) is every lane's. Where it did not — runs 0–11 and held-out runs 1–3, archived before routes were kept — it is decided by the verdict's wording, as before. Nor is a verdict about a contextual entry, either way: both answers are defensible. Nor is a lane's own "worth a look", which says the answer depends on a convention and names it ([ADR 13](adr/0013-a-convention-is-the-projects-to-decide.md)). Each reason a verdict was not scored is counted and printed. |

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
  83–100%); those are judged and in the key too, and so are run 11's 4 and
  held-out run 3's 3. The held-out key is in the same position after its first two runs: beyond the thirteen planted defects,
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
key `6daa97e78d`, which adds what run 12 found (see
[Run 12 and held-out run 4](#run-12-and-held-out-run-4-engine-3231-issue-421));
no earlier value moved under it. `f915c444a2`, the key before, adds the labels of
[issue 420](#labelling-the-unmatched-findings-issue-420); under it only runs 2
and 3 moved, and their last struck value is under `c1786bc817`.
`c1786bc817` differs from `19cc8e67e8` only in saying which pages
an entry is on (see [Ownership by route](#ownership-by-route-task-29)); no value
moved. `19cc8e67e8` adds what run 11 found (see
[Run 11 and held-out run 3](#run-11-and-held-out-run-3-wave-3s-engine-fixes)).
Against the key before it, `83cb84211d`, only one earlier value moved: run 1's
reports lane judged the report cards' fixed figures "not a defect", and the
cards are now an also-real entry, so run 1's calibration shows two struck
values, the first under `71458d9246` and the second under `83cb84211d`. Run
11's struck values are its score under `83cb84211d`, before its four
unlabelled findings were judged. Every other struck value is the same run
under `71458d9246`, the key before `83cb84211d`. That change was one entry: the sticky bar's link with no
`data-testid` moved from the also-real list to the `contextual` list (see
"Runs 9 and 10"), so in runs 1–9 that finding is set aside instead of counted
correct, and a verdict on it is no longer scored. Runs 0 and 10 did not file
it and did not move. The key before that, `f8e0862a8b`, is the one the
contextual list was introduced against; the Brier comparison below quotes it.
Recall did not move for any run. "All findings" counts every finding
the run filed, including the ones set aside. The archived runs are in [`bench/runs/`](../bench/runs/).

| Run | Date | What changed | Recall | Precision (labelled) | All findings | Unlabelled | False pos. | Judged, not filed | Lane calibration | Cost | Kept? |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| 0 | 2026-09-22 | Baseline, 3.4.0, briefs as written on the day | 11/13 | 14/19 (74%) | 21 (2 set aside) | 0 | 5 | 1 | 24/29 (83%), ECE 0.05, Brier 0.109 | ~725k tokens, 241 tool calls, longest lane 3m38s | — |
| 1 | 2026-09-22 | **Lane briefs only** (engine unchanged) — see below | 12/13 | ~~25/25 (100%)~~ 24/24 (100%) | 28 (4 set aside) | 0 | 0 | 0 | ~~31/31 (100%), ECE 0.10, Brier 0.017~~ ~~30/30 (100%), ECE 0.11, Brier 0.017~~ 30/31 (97%), ECE 0.08, Brier 0.033 | ~698k tokens, 283 tool calls, longest lane 5m09s | Yes, into the skill |
| 2 | 2026-09-22 | **Engine 3.5.0 only** — run 1's briefs verbatim | 9/13 | ~~20/20 (100%)~~ ~~19/19 (100%)~~ 19/20 (95%) | 26 (6 set aside) | ~~1~~ 0 | ~~0~~ 1 | 1 | ~~25/26 (96%), ECE 0.07, Brier 0.046~~ 24/25 (96%), ECE 0.07, Brier 0.048 | ~687k tokens, 266 tool calls, longest lane 5m37s | See runs 2–4 |
| 3 | 2026-09-22 | Repeat of run 2 | 10/13 | ~~23/26 (88%)~~ ~~22/25 (88%)~~ 23/26 (88%) | 33 (7 set aside) | ~~1~~ 0 | 3 | 0 | ~~24/27 (89%), ECE 0.08, Brier 0.082~~ 23/26 (88%), ECE 0.08, Brier 0.085 | ~680k tokens, 260 tool calls, longest lane 5m40s | See runs 2–4 |
| 4 | 2026-09-22 | Repeat of run 2 | 11/13 | ~~22/23 (96%)~~ 21/22 (95%) | 27 (5 set aside) | 0 | 1 | 1 | ~~25/29 (86%), ECE 0.05, Brier 0.080~~ 24/28 (86%), ECE 0.05, Brier 0.083 | ~683k tokens, 271 tool calls, longest lane 4m40s | See runs 2–4 |
| 5 | 2026-09-23 | **Engine 3.6.1 only** — run 1's briefs verbatim | 11/13 | ~~25/26 (96%)~~ 24/25 (96%) | 31 (6 set aside) | 0 | 1 | 0 | ~~27/29 (93%), ECE 0.12, Brier 0.060~~ 26/28 (93%), ECE 0.12, Brier 0.061 | ~697k tokens, 248 tool calls, longest lane 9m30s | See runs 5–7 |
| 6 | 2026-09-23 | Repeat of run 5 | 10/13 | ~~26/28 (93%)~~ 25/27 (93%) | 33 (6 set aside) | 0 | 2 | 0 | ~~28/30 (93%), ECE 0.06, Brier 0.064~~ 27/29 (93%), ECE 0.06, Brier 0.066 | ~685k tokens, 264 tool calls, longest lane 4m39s | See runs 5–7 |
| 7 | 2026-09-23 | Repeat of run 5 | 10/13 | ~~26/27 (96%)~~ 25/26 (96%) | 30 (4 set aside) | 0 | 1 | 0 | ~~27/30 (90%), ECE 0.07, Brier 0.072~~ 26/29 (90%), ECE 0.07, Brier 0.074 | ~725k tokens, 292 tool calls, longest lane 6m08s | See runs 5–7 |
| 8 | 2026-09-25 | **Engine 3.9.0 only** (frames) — run 1's briefs verbatim | 11/13 | ~~22/23 (96%)~~ 21/22 (95%) | 26 (4 set aside) | 0 | 1 | 0 | ~~24/24 (100%), ECE 0.09, Brier 0.014~~ 23/23 (100%), ECE 0.09, Brier 0.015 | ~679k tokens, 240 tool calls, longest lane 4m00s | See run 8 |
| 9 | 2026-09-26 | **Engine 3.10.0 (wave 1)** — run 1's briefs verbatim, demo served without its seeded-defect comments | 13/13 | ~~31/31 (100%)~~ 30/30 (100%) | 31 (1 set aside) | 0 | 0 | 0 | ~~30/33 (91%), ECE 0.12, Brier 0.123~~ 29/32 (91%), ECE 0.12, Brier 0.126 | not recorded | See runs 9–10 |
| 10 | 2026-09-26 | Repeat of run 9 | 11/13 | 22/22 (100%) | 24 (2 set aside) | 0 | 0 | 0 | 23/26 (88%), ECE 0.14, Brier 0.109 | not recorded | See runs 9–10 |
| 11 | 2026-09-27 | **Engine 3.11.1 (wave 3)** — run 1's briefs verbatim | 11/13 | ~~25/25 (100%)~~ 29/29 (100%) | 30 (1 set aside) | ~~4~~ 0 | 0 | 0 | ~~24/32 (75%), ECE 0.06, Brier 0.165~~ 26/34 (76%), ECE 0.08, Brier 0.169 | not recorded | See run 11 |
| 12 | 2026-10-10 | **Engine 3.23.1** — run 1's briefs verbatim, lanes on Opus 5.5 | 12/13 | 28/28 (100%) | 33 (3 set aside) | 2 | 0 | 0 | 25/25 (100%), ECE 0.19, Brier 0.055 | ~682k tokens, 256 tool calls, longest lane 2m41s | See run 12 |

**Brier is the number to compare; ECE says which way a lane is off.** Run 1's verdicts were
right more often (97% against 84% under key `f8e0862a8b`; 97% against 83% now), and its expected calibration error is
*worse*, because the lanes were right more often than they said: under key
`f8e0862a8b` every verdict stated at 0.6–0.8 was right. Lower ECE is not the goal on its own; a lane that
is right and says so less loudly than it could is underconfident, not wrong.
The Brier score — the mean squared gap between stated confidence and being
right, with no buckets — rewards both being right and saying so, and ranks run 1
ahead (0.113 → 0.035 under key `f8e0862a8b`; 0.109 → 0.033 now).
The first version of this scorer counted the five "belongs to another lane"
dismissals as wrong verdicts, which gave ECE 0.09 → 0.04 and read as an
improvement; that one choice was enough to reverse the comparison.

### Run 12 and held-out run 4: engine 3.23.1 (issue 421)

The engine moved from 3.11.1 to 3.23.1, twelve minor versions that changed
control names, snapshots, oracles, the design audit and the false-positive
fixes from [validation](validation.md). Everything else was held as it was:
run 1's eight briefs on the demo and held-out run 1's eight on the held-out
app, recovered verbatim from the session that wrote them (only the project
path differs), a fresh app and a fresh project directory for each, and every
lane on Opus 5.5, as held-out run 3's were. Two things differ from runs 11 and
held-out 3: the demo and held-out runs went one after the other instead of at
the same time, and the MCP server's process had loaded 3.23.0, whose only
difference from 3.23.1 is how `scout_close` waits for a call its watchdog cut
off, which a lane never meets.

| | Run 11 (3.11.1) | Run 12 (3.23.1) | Held-out 3 (3.11.1) | Held-out 4 (3.23.1) |
|---|---:|---:|---:|---:|
| Recall | 11/13 | 12/13 | 8/10 | 6/10 |
| Precision (labelled) | 29/29 | 28/28 | 15/19 | 17/17 |
| False positives | 0 | 0 | 4 | 0 |
| Extra findings for a defect already filed | ≥ 3 | ≥ 3 | not reported | ≥ 1 |
| Brier (lane calibration) | 0.169 | 0.055 | 0.157 | 0.081 |

- **Demo.** Run 12 found the sticky bar covering Save notes, which run 11
  missed; both missed the silent submit with a blank customer. Duplicates did
  not move.
- **Held out.** Held-out run 4 missed two defects held-out run 3 found: any
  member's record readable by id, and a double-click on Renew. It filed no
  false positive where run 3 filed four. Its `fines` lane came back
  `partial`: a safety stop on the lane agent's side ended it before it
  tested the waive flow's success path, which is in the report as its
  `blocked_by`. Earlier held-out runs found 9, 7 and 8 of 10, so 6 is at
  the low end of a range one run cannot narrow.
- **Calibration** improved on both apps (Brier 0.169 → 0.055 and
  0.157 → 0.081): the lanes were right on more of the verdicts the key
  scores, and as confident.

One run per app is noisy: a single defect is 8 points of demo recall and 10 of
held-out recall, and these rows cannot separate the engine from run-to-run
variance. The direction on precision and calibration holds on both apps.

**Key changes.** Five findings matched no entry, labelled against the apps'
source by the agent that ran the benchmark: on the demo, the order page for an
unknown id still offering Save notes and Delete, a rewording of
`order-not-found-live-controls`; on the held-out app, a double-click posting
the same review twice, a failed holds request shown as "No holds.", and the
checkout form offered to members the server refuses, each a new also-real
entry, and "Check out button not guarded against double submit", a rewording
of `checkout-double-submit`. No archived run's score moved.

### Ownership by route (task 29)

A scorer change, not a run. A lane's "not a defect" about another lane's defect
is a remark about ownership, and the scorer used to recognise one only by its
wording, which cannot tell a lane's own page from another's (see [Rejected and
not-yet-tried](#rejected-and-not-yet-tried)). Runs 9–11 and held-out runs 2 and
3 had such remarks worded in ways the rule misses ("dashboard asset, not
/inventory.html", "raised on / before navigating", "owned by / lane",
"home-page request in flight"), scored as wrong verdicts: 5 in run 11 alone.

Once a lane's routes are known the rule can only take verdicts OUT of the
score, so a page missing from a lane's routes makes its calibration look
better than it is. Every choice below leans towards keeping a verdict scored.

- **What is kept.** `scout_lane_report` now stores the routes a lane's
  accepted report lists in the project's memory, and `npm run bench --
  --archive` copies them into the archive as `laneRoutes`. Every run archived
  from now on carries them; the archive command says so when a run has none,
  which happens when a report is folded after its lane's session has closed.
  Query strings and fragments are removed before a route is stored or
  archived, since a route copied from the address bar can carry a token; a
  hash route (`/#/things`) keeps its path. Two routes naming the same pages
  are kept once, and past the cap of 255 a lane keeps its newest.
- **How it is read.** Every page a route's text names counts, a note's
  included: "/order.html?id=1042 (from /orders.html link)" is both pages,
  "Orders (/orders.html)", "orders.html" and "127.0.0.1:4173/orders.html" are
  /orders.html, a bare origin is "/", and lists split on commas, "and", "+",
  "|", arrows and new lines. If ANY of a lane's routes names no page ("the
  orders area"), the lane's routes are treated as unknown and the wording rule
  decides for it: the unreadable route may be the page the verdict is about.
  A not-a-defect is a remark about ownership when it matches a planted or
  also-real defect none of whose pages the lane covered. The wording plays no
  part then: the same "not my page" from the lane that owns the page is scored
  as its own wrong verdict. A verdict that matches a known non-defect, a
  contextual entry, several entries or none is judged as before. The
  scorecard lists each verdict set aside this way, with its lane, the entry it
  matched and its stated confidence, so a run can be audited.
- **Pages in the key.** Every entry names its page in `route`; `alsoOn` names
  further pages a lane can see it from or cause it on, and `everyPage` marks
  one every lane can reach. The key refuses both on one entry, and a page
  named twice. Entries given `alsoOn`: on the demo, the two deletes reporting
  success (/order.html), the scheduled-reports dead end (/reports.html, where
  its link is), the stored XSS (/orders-new.html, where the name is typed),
  the $0.00 total of a created order (/orders-new.html and /approvals.html),
  the Requested column showing notes (/order.html, where notes are written)
  and the line-items link (/orders.html, where it points); on the held-out
  app, the joined-event dead end (/events.html) and the stale catalogue
  (/checkout.html and /loans.html, where the loan and return happen).
  `everyPage`: the nav entry in each key, since the nav is on the lane's own
  page too, and the endpoint defects any lane can reach with a direct request
  (the approve endpoint accepting a clerk and the orders API accepting invalid
  input on the demo, any member's record on the held-out app). Marking an
  endpoint defect `everyPage` is the conservative choice: a verdict on it is
  always scored, even from a lane that never opened its page. The nav entries
  are contextual, so those marks move no score.
- **What moved: nothing.** No archive before this one recorded its lanes'
  routes, and the lane-to-route split for runs 0–11 and held-out runs 1–3
  lived in briefs that are not in the repository, so those runs keep the
  wording rule and score exactly as before. As a check of the rule, and not
  a score: with routes read off the lane names (the orders lane on
  /orders.html and so on), it takes out exactly the remarks counted by hand
  under [Run 11 and held-out run 3](#run-11-and-held-out-run-3-wave-3s-engine-fixes)
  and runs 9–10 — 3, 1 and 5 in runs 9–11, 1 and 3 in held-out runs 2 and 3 —
  giving the Brier scores quoted there (0.070, 0.093 and 0.110; 0.099 and
  0.107), and nothing else changes. That check was run against the key with
  every `alsoOn` and `everyPage` above in place.

### Run 11 and held-out run 3: wave 3's engine fixes

Only the engine changed: 3.11.1, with run 1's briefs verbatim on the demo and
held-out run 1's briefs on the held-out app, and a fresh app and project
directory for each. Wave 3 carries three fixes from runs 9 and 10 and held-out
runs 1 and 2: a write a page sends as it is left is judged by the write policy
(#177); finding dedup keeps two different kinds of defect on one element as two
findings (#174, task 32); and the lane-close check pairs a finding whose
evidence names an id template (`/api/orders/{id}/approve`) with the concrete
path a lane quoted (#175). The archives keep neither the lane-close check's
alarms nor the writes sent on leaving a page, so only the dedup change is
measured here. Held-out run 3's lanes ran on Opus 5.5, where earlier lanes
inherited the session model; nothing in the archive separates an effect of that
from run-to-run noise.

| Defect | Run 9 | Run 10 | Run 11 |
|---|:---:|:---:|:---:|
| Email field has no label | found | found | found |
| Empty customer does nothing | found | missed | missed |
| Sticky bar covers Save notes | found | missed | missed |
| Every other planted defect (10) | found | found | found |

| Defect | Held-out 1 | Held-out 2 | Held-out 3 |
|---|:---:|:---:|:---:|
| Overdue tag contrast 1.84:1 | found | missed | missed |
| Place hold on a book with copies on the shelf does nothing | missed | missed | missed |
| Renew double-click spends both renewals | found | missed | found |
| Every other planted defect at `medium` (7) | found | found | found |

Recall was 11/13 on the demo and 8/10 on the held-out app. The misses:

- **Empty customer and sticky bar, run 11.** The same two as run 10, missed the
  same way. The new-order lane saw no request after an empty submit and judged
  it "blocked client-side", not a defect, at 0.6; the page says nothing when it
  refuses, which is the defect. The order-detail lane found Save notes out of
  reach at the page's load position and reachable at the bottom, and judged
  that not a defect at 0.6. Both are wrong verdicts.
- **The overdue tag, held-out run 3.** As in held-out run 2: the home lane
  renewed the member's only overdue loan (its decisions record the overdue
  count going from 1 to 0 after the renew), after which no page shows an
  overdue tag to measure, and no lane had measured it before.
- **Place hold, held-out run 3.** The book lane noted Place hold on a book with
  two copies on the shelf and judged the button's presence "not a defect" at
  0.55, and its decisions record no click on it; the holds it placed were on a
  book with every copy out, the withdrawn book and a missing id. A coverage
  miss, as in held-out runs 1 and 2, this time on the right page and control.

**Precision and the key.** Run 11 left 4 findings unlabelled and held-out run 3
left 3 (precision bounded at 86–100% and 70–85%). They were judged against the
apps' source:

- **Real, new to the demo key (2):** the report cards are fixed in the page's
  markup, and say 17 orders and $6,420 "this month" while the app holds 6
  orders worth $5,414.75 (medium); and the audit log shows times with no date,
  so an entry made at 01:58 is listed above one at 09:14 with nothing to say
  it belongs to a later day (low).
- **Rewordings, each an entry widened with a counter-example for its near
  miss:** "Order header keeps showing open after approval is requested" is the
  stale order status (the counter-example is the same wording after a refused
  request, where "open" is right); "Settings accepts a blank workspace name and
  reports Saved." is the missing name validation (the counter-example is Save
  sending no request, which is its own entry); held-out run 3's "Renew button
  stays enabled on a loan that has used all its renewals" is the Renew button
  offered at the limit (the counter-examples are a refused third renewal that
  says nothing about the button, and a loan with one renewal left).
- **Not a defect, held-out (1):** "Join stays enabled, and a double-click sends
  two join requests". The server adds a member to an event once, a repeat join
  answers 200 and takes no second seat, and the page leaves for the
  confirmation after the first answer, so nothing is spent twice. Lanes in
  held-out runs 1 and 2 checked exactly this and judged it not a defect (at 0.8
  and 0.75); those verdicts are now scored right, which is the only change to
  runs 1 and 2.
- **Contextual, held-out (1):** every Waive button has the same accessible name.
  Each sits in a table row whose cells name the member, which WCAG accepts as
  the control's context; a name unique across the page is a stricter
  convention the app does not declare.

The report-cards entry re-scored one earlier verdict: run 1's reports lane
judged the cards "static demo numbers" and not a defect at 0.7, citing the
footer's "demo data only". The footer is on every page and describes the data,
not the cards, and the cards contradict the orders the same app serves, so the
key calls that verdict wrong and run 1's Brier rises from 0.017 to 0.033.
Reading the footer as permission for placeholder figures would make the entry
contextual instead; it is recorded as real.

**Calibration.** Brier is 0.169 for run 11 (0.165 before its findings were
judged) against 0.126 and 0.109 for runs 9 and 10, and 0.157 for held-out run 3
against 0.096 and 0.111. The verdicts the key calls wrong:

- **Run 11, 8 of 34.** Five are "not my page" remarks on the dashboard's broken
  chart image, worded in ways the dismissal rule does not read: "on dashboard,
  not inventory", "raised on / before navigating", "dashboard route, not
  owned", "raised from dashboard load", "owned by / lane" (runs 9 and 10 had
  three and one). One is the dashboard lane's own "the console error is the
  same 404", not a defect, at 0.7: a remark that the console line is not a
  second defect, which the key reads as a verdict on the broken image itself.
  Two are the lane misjudgements behind the two misses above.
- **Held-out run 3, 7 of 26.** Three are "not my page" remarks on the home
  page's notices 500 ("not called by fines.html", "not requested on
  /catalogue.html reload", "owned by /"; held-out runs 1 and 2 had none and
  one). Four are lanes calling a known non-defect a defect and filing it: the
  export link's styling (0.55), the fines page refusing a member (0.45), the
  checkbox's name and target (0.7) and the Join double-click (0.4). The first
  three are held-out run 1's three false positives again, at nearly the stated
  confidences run 1 gave them (0.55, 0.45, 0.75).

No key gap is left among them: the two new demo entries added two right
verdicts to run 11 (at 0.6 and 0.45), which is why its Brier moved from 0.165 to
0.169. Most of the drop is ownership wording. Leaving out the "not my page"
remarks on the chart image and the notices 500, Brier is 0.110 for run 11
against 0.070 and 0.093 for runs 9 and 10, and 0.107 for held-out run 3 against
0.096 and 0.099. What remains is on the demo the same two misjudgements run 10
made, and on the held-out app the same false positives as run 1. The scorer
is unchanged: the follow-up recorded under runs 9 and 10 (archive each lane's
routes, and count a not-a-defect as a dismissal when the matched entry's route
is outside them) is what would take those remarks out, and widening the wording
rule stays rejected. That follow-up has since been made, for runs archived
after it (see [Ownership by route](#ownership-by-route-task-29)).

**Dedup (task 32).** Findings, and extra findings for a planted defect that
already had one, per run:

| Run | Findings | Extra for a planted defect | Of those, one claim filed twice |
|---|---:|---:|---:|
| 9 | 31 | 4 | 2 |
| 10 | 24 | 2 | 1 |
| 11 | 30 | 3 | 1 |
| Held-out 1 | 20 | 0 | 0 |
| Held-out 2 | 24 | 1 | 0 |
| Held-out 3 | 23 | 0 | 0 |

The rest of the "extra" column is one planted defect seen in two places, which
its key entry names as one: Delete order and Delete workspace both reporting
success, the approve endpoint and the audit log both showing a clerk's
approval, and the notices 500 seen from two pages. The claim filed twice is the
scheduled-reports dead end in every demo run (and the stored XSS in run 9).

- **The export link.** "Styled like body text" appears as its own finding in
  held-out run 3, beside the clipped-link finding on the same element, and is
  scored as a known false positive, as expected. It is the fourth false
  positive; the other three are held-out run 1's again.
- **No real second defect surfaced that the old rule would have merged.** The
  old rule merged two kinds only within the one "presentation" family (visual,
  ux-polish, accessibility, test ids), and the export link is the only pair of
  those kinds on one element in either run. Run 11's pairs of different kinds
  on one element (Save changes sending nothing and accepting a blank name;
  Delete workspace having no confirmation and being offered to refused roles)
  are in different families, which the old rule kept apart too, as run 9 shows
  with pairs of its own.
- **The accepted cost did not show.** No layout defect was filed twice under
  neighbouring labels, and duplicates did not rise (3 against 4 and 2 on the
  demo, 0 against 0 and 1 on the held-out app).
- **The archive cannot prove a negative.** Running both rules over the archived
  findings merges no pair in any of the six runs, but an archive drops each
  finding's detail text, which is where held-out run 2's shared quoted name
  was, so that check cannot rule out a merge the store would have made.

**Kept?** One run on each app is a direction, not a size. Recall equals run
10's on the demo and sits between held-out runs 1 and 2; every miss is a lane's
verdict or coverage, not a finding judged wrong. The three wave 3 fixes stay.

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
  structural fix was follow-up work, not done here: archive each lane's
  routes from its lane report, and treat a not-a-defect as a dismissal only
  when the matched key entry's route is outside that lane's routes. It has
  since been made (see [Ownership by route](#ownership-by-route-task-29)).
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

Test ids are now context-dependent in both keys: the demo's missing-`data-testid`
entry (the sticky bar's link) moved from the also-real list to `contextual`, as
the held-out key already had it, because a test id is a test-automation
convention no user meets, and the demo declares no rule that every control
carries one.

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
against key `87b7b2ccd5`, which adds what held-out run 4 found (see
[Run 12 and held-out run 4](#run-12-and-held-out-run-4-engine-3231-issue-421))
and moved no earlier value. `fe4c9a65a6`, the key before, adds the labels of
[issue 420](#labelling-the-unmatched-findings-issue-420) and moved no value in
this table. Before it, `b5a7933f32` differs from `1bc84f1a04` only in saying which
pages an entry is on (see [Ownership by route](#ownership-by-route-task-29); no
value moved); `1bc84f1a04` adds what held-out run 3 found. Where a cell
has two struck values, the first is under `77ebf9b0d9`, the key runs 1 and 2
were made against, and the second under `4ffabb6bd3`, the key completed from
them; a single struck value in runs 1 and 2 is under `77ebf9b0d9`, and in run
3 under `4ffabb6bd3`. Runs 1 and 2 moved under the new key only in
calibration: each had a lane judge a double-click on Join "not a defect", which
the key now agrees with. Nothing in this table is kept or rejected: held-out
runs are reported, never optimised against.

| Run | Date | What changed | Recall | Precision (labelled) | All findings | Unlabelled | False pos. | Judged, not filed | Lane calibration | Cost | Kept? |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| holdout-1 | 2026-09-26 | **Engine 3.10.0 (wave 1)**, first held-out run; briefs written by an agent that saw the app only through the browser | 9/10 | ~~11/11 (100%)~~ 15/18 (83%) | 20 (2 set aside) | ~~9~~ 0 | ~~0~~ 3 | 0 | ~~19/21 (90%), ECE 0.13, Brier 0.111~~ ~~23/26 (88%), ECE 0.12, Brier 0.098~~ 24/27 (89%), ECE 0.13, Brier 0.096 | not recorded | — |
| holdout-2 | 2026-09-26 | Repeat of holdout-1, same briefs | ~~8/10~~ 7/10 | ~~11/11 (100%)~~ 22/23 (96%) | 24 (1 set aside) | ~~13~~ 0 | ~~0~~ 1 | 0 | ~~18/20 (90%), ECE 0.15, Brier 0.069~~ ~~29/32 (91%), ECE 0.16, Brier 0.113~~ 30/33 (91%), ECE 0.16, Brier 0.111 | not recorded | — |
| holdout-3 | 2026-09-27 | **Engine 3.11.1 (wave 3)**, same briefs as holdout-1 | 8/10 | ~~14/17 (82%)~~ 15/19 (79%) | 23 (~~3~~ 4 set aside) | ~~3~~ 0 | ~~3~~ 4 | 0 | ~~18/24 (75%), ECE 0.13, Brier 0.157~~ 19/26 (73%), ECE 0.15, Brier 0.157 | not recorded | — |
| holdout-4 | 2026-10-10 | **Engine 3.23.1**, same briefs as holdout-1, lanes on Opus 5.5 | 6/10 | 17/17 (100%) | 19 (1 set aside) | 1 | 0 | 0 | 24/25 (96%), ECE 0.16, Brier 0.081 | ~681k tokens, 255 tool calls, longest lane 3m09s | — |

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
  whether it is a rule; the demo's key now treats its missing test id the same
  way); and the events
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
| Brier | 0.126, 0.109 | ~~0.098, 0.113~~ 0.096, 0.111 |

Recall is lower on the held-out app, and the misses are not where a demo-only
engine would put them. Of the four `medium` defects that share kind and
mechanism with a demo defect (double-submit, dead end, false success,
contrast), run 1 found 4 and run 2 found 2; of the six that work by other
mechanisms, each run found 5. Every miss traces to what a lane did or did not
do, not to a finding judged wrong. The briefs also differ: the demo's were
revised against its own scores after run 0, these were written blind, so the
gap mixes transfer with brief authorship. One run each is a direction, not a
size: on a ten-defect app one defect is 10 points of recall.

**An engine observation, addressed by task 32 (#172) and measured in held-out run 3.** In run 2 the account
lane filed "export link styled as body text", and SceneScout's finding dedup
merged it into a different finding on the same element, the link clipped out
of view: two distinct findings on one element became one. The merged-away
claim is judged not a defect above, so run 2's score lost nothing (run 1, which
kept both, took a false positive for it), but the same merge would hide a real
second defect on an element that already has one. Task 32 changes the dedup
so findings of different kinds on one element stay apart (ADR 4); it was made
against the test fixtures, not tuned here. Held-out run 3, the first on the
changed engine, kept the two apart: the clipped link is credited as the planted
defect, and "styled like body text" is filed separately and scored as a known
false positive, the one extra false positive this paragraph expected. Neither
held-out run 3 nor demo run 11 surfaced a real second defect on one element
that the old rule would have merged, and neither filed more duplicates than
the runs before it; the measurement is in
[Run 11 and held-out run 3](#run-11-and-held-out-run-3-wave-3s-engine-fixes).

A second, from both runs: the evidence for the checkbox finding gives its name
as `"checkbox"`, while the browser's accessibility tree names it "Available
now only" from the label that wraps it. Where that name came from is not in the
archive; it is recorded so it can be checked, not fixed against this app.

## Unattended runs (scenescout ci)

[`scenescout ci`](ci.md) runs the SceneScout method without an agent at the
keyboard: a model, reached through its API, explores the app in `read-only`
until it finishes or reaches a cap, in one loop or, with `--lanes`, in
several conversations at once that share the caps. Its rows are not comparable with the
[Results](#results) above, which are eight parallel lanes in `safe-write`
driven by an agent; compare them with each other.

The [weekly benchmark workflow](../.github/workflows/bench-weekly.yml) records
them. Once a week it compares the latest GitHub release with the newest
version it has recorded on schedule for the provider it would use, and runs
only when a release has come out since and no results pull request labelled
`benchmark` is still open; otherwise it writes one line to the job summary and
stops. Only scheduled rows count: a dispatched run may have used another model
or effort, and a manual run may have been of a commit no release contains.
When it runs, it checks out the release's tag, runs `scenescout ci` against
the demo and the held-out app through the same
[benchmark workflow](../.github/workflows/ci-benchmark.yml) a manual run uses,
scores each with `npm run bench -- <dir> --app <app> --json`, archives it under
`bench/runs/` as `ci-<app>-<version>-<run number>` and opens a pull request
labelled `benchmark` that appends a row per app to
[`bench/ci-results.json`](../bench/ci-results.json) and regenerates the table
below. If one app's run fails, the other's is still recorded and the job
summary names the one that failed. Dispatched by hand, it takes the provider,
model and effort, and `force` to run with no new release or with a results
pull request open.

It uses one provider per run: OpenAI unless dispatched with another, so a
repository holding both keys is not charged twice. Each provider has its own
record of the last version it benchmarked. The job that calls the model can
only read the repository, and the job that writes the results never holds the
model's key.

A row is one run, and a single run is noisy: ci-run-1 and ci-run-2 differ only
in effort and moved recall by two defects. Dedup is how the run told a filed
finding from one already recorded, as its `ci.json` says: `rule` for the rule
alone, which is every run recorded before the model judge was wired in
([ADR 17](adr/0017-a-model-judges-only-the-merges-the-rule-misses.md)) and any
run of a version without it, and `judge` for the rule with the judge, the
default from the release that wires it in. The judge merges findings the rule
keeps apart, so it changes how many findings a run reports, and with that its
recall and precision: a `judge` row and a `rule` row are two configurations,
and a change between them is not read as the engine's. Precision is the
labelled ratio with its bounds; Brier is lane calibration's, and is "—"
because an unattended run's lanes, when it has any, hand back no lane report stating a confidence. Cost is the run's own estimate from
the model's list price. The first two rows were taken by hand with the
benchmark workflow on the engine at commit `7280e29`, before this workflow
existed. That commit reports itself as 3.12.0, but the v3.12.0 tag predates
`scenescout ci`: its tag has no `ci/action.yml`, so the workflow does not run
it, forced or not, and the first run it makes is of the release after it. Had
it tried, the run would have stopped at the missing `./ci` action, before any
model call.

ci-run-3 was a prompt experiment on the engine at commit `6575b46`, with
ci-run-1's provider, model, effort and caps. In ci-run-1 and ci-run-2 every
turn carried exactly one tool call, although a turn may carry up to 16 and the
40-turn cap is the budget that binds (ci-run-2 reached it; ci-run-1 stopped at
36 turns after 70 seconds of a 20-minute allowance). The edit added two lines
to the CI rules the model is given: turns, not tool calls, are the budget, so
calls that do not need an earlier call's result share a turn; and before
`scout_report`, check `scout_coverage`, visit what it lists as unvisited and
file each judged defect. Recall stayed at 5/13 and precision was 6/6 labelled
(86–100% with one unlabelled). The model put two calls in a turn 3 times in
26 and finished at 27 turns in 65 seconds, earlier than ci-run-1. One run is
noisy, but the edit did not move the behaviour it targeted, so it was
rejected and the rules are unchanged.

**Rejected: asking the OpenAI request for parallel tool calls (ci-parallel-1).**
Unattended runs make about one tool call per model turn, so the 40-turn cap
bounds how much of the app a run reaches. The candidate edit set
`parallel_tool_calls: true` on the Responses API request, with the prompt,
caps, model and effort unchanged; the Anthropic request was confirmed to send
no `tool_choice`, so parallel tool use is not disabled there. The loop already
runs every call in a reply, up to 16, and answers each with its own output.
One run: all 40 turns carried exactly one call (distribution 40 × 1), the run
stopped at the turn cap, and recall stayed at 5/13 against ci-run-1's 5/13 on
the same model and effort, with two defects gained (the double submit, the
approve endpoint accepting a clerk) and two lost (the badge covering its
button, the hint's contrast), which is within one run's noise. The Responses
API's own default for the parameter is already `true`, so the edit changed
nothing the model sees; single calls are the model's choice, not the
request's. The change was reverted and no second run was spent.

<!-- ci-results:start (generated from bench/ci-results.json by scripts/bench/ci-record.ts; do not edit by hand) -->

| Date | App | Version | Source | Provider · model · effort | Dedup | Key | Recall | Precision (bounds) | Brier | Ended | Turns | Tokens in (cached) / out | Wall | Cost |
|---|---|---|---|---|---|---|---:|---:|---:|---|---:|---:|---:|---:|
| 2026-09-27 | demo | 3.12.0 | manual | openai · gpt-6-luna · low | rule | c1786bc817 | 5/13 | 7/8 (88%) | — | done | 36 | 741,675 (716,628) / 2,190 | 1m 10s | $0.011 |
| 2026-09-27 | demo | 3.12.0 | manual | openai · gpt-6-luna · medium | rule | c1786bc817 | 3/13 | 3/3 (100%) | — | turns | 40 | 885,574 (858,517) / 3,152 | 1m 38s | $0.013 |
| 2026-09-27 | demo | 3.13.0 | manual | openai · gpt-6-luna · low | rule | c1786bc817 | 5/13 | 6/6 (86%–100%) | — | done | 27 | 533,110 (509,907) / 1,730 | 1m 05s | $0.008 |
| 2026-09-27 | demo | 3.13.0 | manual | openai · gpt-6-luna · medium | rule | c1786bc817 | 4/13 | 5/5 (100%) | — | done | 65 | 1,657,036 (1,620,750) / 7,123 | 2m 55s | $0.023 |
| 2026-09-27 | demo | 3.13.0 | manual | openai · gpt-6-luna · low | rule | c1786bc817 | 5/13 | 5/5 (71%–100%) | — | turns | 40 | 826,683 (802,609) / 1,597 | 1m 18s | $0.011 |
| 2026-09-27 | demo | 3.13.1 | dispatched | openai · gpt-6-luna · low | rule | c1786bc817 | 5/13 | 5/5 (100%) | — | done | 33 | 670,885 (646,007) / 1,755 | 1m 14s | $0.010 |
| 2026-09-27 | holdout | 3.13.1 | dispatched | openai · gpt-6-luna · low | rule | b5a7933f32 | 3/10 | 3/5 (43%–71%) | — | turns | 40 | 870,166 (842,856) / 1,930 | 2m 34s | $0.012 |
| 2026-09-28 | demo | 3.14.1 | scheduled | openai · gpt-6-luna · low | rule | c1786bc817 | 2/13 | 3/3 (60%–100%) | — | done | 32 | 665,543 (640,873) / 1,395 | 1m 32s | $0.010 |
| 2026-09-28 | holdout | 3.14.1 | scheduled | openai · gpt-6-luna · low | rule | b5a7933f32 | 1/10 | 1/3 (33%) | — | done | 28 | 583,026 (575,890) / 1,444 | 1m 02s | $0.007 |
| 2026-10-02 | demo | 3.14.1 | manual | openai · gpt-6-luna · low · 4 lanes | rule | c1786bc817 | 3/13 | 3/3 (75%–100%) | — | turns | 40 | 774,823 (727,016) / 2,913 | 33s | $0.014 |
| 2026-10-02 | demo | 3.14.1 | manual | openai · gpt-6-luna · low · 4 lanes | rule | c1786bc817 | 3/13 | 3/3 (75%–100%) | — | turns | 40 | 766,576 (756,424) / 2,417 | 33s | $0.010 |
| 2026-10-02 | demo | 3.14.1 | manual | openai · gpt-6-luna · low | rule | c1786bc817 | 3/13 | 4/4 (80%–100%) | — | done | 29 | 609,604 (602,591) / 1,641 | 1m 19s | $0.008 |
| 2026-10-02 | demo | 3.14.1 | manual | openai · gpt-6-luna · low | rule | c1786bc817 | 3/13 | 4/4 (100%) | — | done | 29 | 599,431 (574,840) / 1,647 | 1m 09s | $0.009 |
| 2026-10-02 | holdout | 3.14.1 | manual | openai · gpt-6-luna · low | rule | b5a7933f32 | 1/10 | 1/4 (20%–40%) | — | done | 27 | 558,749 (551,323) / 1,760 | 1m 05s | $0.007 |
| 2026-10-02 | holdout | 3.14.1 | manual | openai · gpt-6-luna · low · 4 lanes | rule | b5a7933f32 | 2/10 | 2/4 (40%–60%) | — | turns | 40 | 780,989 (767,682) / 2,721 | 32s | $0.010 |
| 2026-10-02 | demo | 3.14.1 | manual | openai · gpt-6-luna · low · 4 lanes | rule | c1786bc817 | 8/13 | 9/9 (90%–100%) | — | done | 95 | 2,027,350 (2,001,159) / 6,777 | 1m 29s | $0.026 |
| 2026-10-02 | demo | 3.14.1 | manual | openai · gpt-6-luna · low · 4 lanes | rule | c1786bc817 | 8/13 | 9/9 (100%) | — | done | 86 | 1,804,634 (1,760,945) / 6,753 | 1m 24s | $0.025 |
| 2026-10-02 | demo | 3.14.1 | manual | openai · gpt-6-luna · low | rule | c1786bc817 | 5/13 | 5/5 (100%) | — | done | 37 | 803,803 (777,552) / 2,177 | 1m 24s | $0.011 |
| 2026-10-02 | holdout | 3.14.1 | manual | openai · gpt-6-luna · low · 4 lanes | rule | b5a7933f32 | 7/10 | 7/9 (50%–86%) | — | done | 86 | 1,801,743 (1,776,235) / 7,040 | 1m 13s | $0.024 |
| 2026-10-03 | demo | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 4/13 | 5/5 (100%) | — | done | 38 | 989,487 (958,583) / 1,988 | 1m 34s | $0.014 |
| 2026-10-03 | demo | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 4/13 | 4/4 (80%–100%) | — | done | 30 | 757,486 (749,475) / 1,454 | 1m 08s | $0.009 |
| 2026-10-03 | demo | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 4/13 | 4/4 (80%–100%) | — | done | 33 | 856,648 (846,179) / 1,762 | 1m 25s | $0.010 |
| 2026-10-03 | demo | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 5/13 | 6/7 (75%–88%) | — | done | 33 | 871,173 (861,009) / 2,131 | 1m 22s | $0.011 |
| 2026-10-03 | demo | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 5/13 | 6/6 (75%–100%) | — | done | 40 | 1,058,022 (1,045,955) / 3,026 | 2m 03s | $0.013 |
| 2026-10-03 | demo | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 3/13 | 4/4 (67%–100%) | — | done | 38 | 1,038,682 (1,026,279) / 2,917 | 1m 44s | $0.013 |
| 2026-10-03 | holdout | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 2/10 | 2/4 (40%–60%) | — | turns | 40 | 1,103,020 (1,068,616) / 2,488 | 1m 43s | $0.015 |
| 2026-10-03 | holdout | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 2/10 | 2/3 (67%) | — | turns | 40 | 1,122,825 (1,088,204) / 3,194 | 1m 47s | $0.016 |
| 2026-10-03 | holdout | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 1/10 | 1/3 (25%–50%) | — | done | 39 | 1,041,177 (1,031,224) / 1,972 | 1m 20s | $0.012 |
| 2026-10-03 | holdout | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 1/10 | 1/2 (50%) | — | turns | 40 | 1,077,952 (1,046,244) / 2,142 | 1m 41s | $0.015 |
| 2026-10-03 | holdout | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 1/10 | 1/2 (33%–67%) | — | turns | 40 | 1,134,628 (1,121,793) / 2,916 | 1m 54s | $0.014 |
| 2026-10-03 | holdout | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 1/10 | 1/2 (33%–67%) | — | turns | 40 | 1,087,728 (1,075,597) / 2,692 | 1m 55s | $0.013 |
| 2026-10-03 | holdout | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 1/10 | 1/2 (33%–67%) | — | done | 33 | 894,594 (883,315) / 2,479 | 1m 39s | $0.011 |
| 2026-10-03 | holdout | 3.18.0 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 2/10 | 2/3 (50%–75%) | — | turns | 40 | 1,088,692 (1,077,975) / 2,432 | 1m 51s | $0.013 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 3/13 | 3/3 (75%–100%) | — | done | 30 | 772,798 (742,188) / 1,205 | 1m 08s | $0.011 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 4/13 | 5/6 (71%–86%) | — | done | 31 | 796,263 (764,439) / 1,745 | 1m 18s | $0.012 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 2/13 | 2/2 (67%–100%) | — | done | 24 | 600,856 (571,309) / 1,292 | 1m 01s | $0.009 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 5/13 | 5/5 (71%–100%) | — | done | 64 | 1,890,442 (1,874,734) / 3,907 | 2m 28s | $0.022 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 4/13 | 5/6 (63%–88%) | — | done | 56 | 1,595,572 (1,580,917) / 2,462 | 1m 52s | $0.019 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 5/13 | 6/6 (86%–100%) | — | done | 75 | 2,354,928 (2,333,358) / 3,473 | 2m 52s | $0.027 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 6/13 | 6/6 (86%–100%) | — | done | 41 | 1,113,005 (1,101,514) / 2,757 | 1m 35s | $0.014 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 2/13 | 2/2 (50%–100%) | — | done | 30 | 765,740 (757,723) / 1,290 | 1m 05s | $0.009 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 4/13 | 4/4 (67%–100%) | — | done | 39 | 1,034,915 (1,023,304) / 1,745 | 1m 23s | $0.012 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 7/13 | 7/8 (88%) | — | turns | 80 | 2,192,336 (2,147,221) / 5,390 | 3m 37s | $0.029 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 6/13 | 7/7 (78%–100%) | — | turns | 80 | 2,163,003 (2,119,207) / 4,816 | 1m 51s | $0.028 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 5/13 | 5/5 (63%–100%) | — | turns | 80 | 2,207,894 (2,185,807) / 5,935 | 3m 32s | $0.027 |
| 2026-10-06 | holdout | 3.19.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | b5a7933f32 | 5/10 | 5/6 (83%) | — | done | 75 | 2,083,211 (2,060,420) / 5,057 | 1m 29s | $0.025 |
| 2026-10-06 | holdout | 3.19.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | b5a7933f32 | 4/10 | 5/6 (56%–89%) | — | turns | 80 | 2,199,015 (2,175,729) / 4,675 | 1m 38s | $0.026 |
| 2026-10-06 | holdout | 3.19.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | b5a7933f32 | 4/10 | 4/6 (44%–78%) | — | done | 69 | 1,839,108 (1,820,747) / 3,960 | 2m 22s | $0.022 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 3/13 | 3/3 (75%–100%) | — | done | 39 | 1,046,088 (1,013,708) / 1,967 | 1m 53s | $0.014 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 3/13 | 3/3 (100%) | — | done | 31 | 799,468 (769,468) / 1,665 | 1m 37s | $0.012 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 4/13 | 4/4 (67%–100%) | — | turns | 40 | 1,079,657 (1,068,983) / 2,560 | 1m 58s | $0.013 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 1/13 | 1/1 (50%–100%) | — | turns | 40 | 1,045,157 (1,036,421) / 1,319 | 1m 31s | $0.012 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 5/13 | 5/5 (71%–100%) | — | turns | 40 | 1,065,286 (1,056,116) / 1,814 | 1m 45s | $0.012 |
| 2026-10-06 | demo | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 4/13 | 4/4 (67%–100%) | — | turns | 40 | 1,095,132 (1,063,319) / 2,200 | 3m 11s | $0.015 |
| 2026-10-06 | holdout | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 3/10 | 3/4 (43%–86%) | — | turns | 40 | 1,096,506 (1,085,563) / 2,298 | 1m 31s | $0.013 |
| 2026-10-06 | holdout | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 1/10 | 1/2 (50%) | — | done | 30 | 778,996 (771,292) / 1,420 | 1m 06s | $0.009 |
| 2026-10-06 | holdout | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 1/10 | 1/2 (33%–67%) | — | done | 32 | 835,274 (827,133) / 1,492 | 1m 08s | $0.010 |
| 2026-10-06 | holdout | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 2/10 | 2/3 (67%) | — | turns | 40 | 1,096,791 (1,086,245) / 1,620 | 1m 46s | $0.013 |
| 2026-10-06 | holdout | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 1/10 | 1/1 (33%–100%) | — | turns | 40 | 1,058,668 (1,049,621) / 1,333 | 1m 31s | $0.012 |
| 2026-10-06 | holdout | 3.19.2 | dispatched | openai · gpt-6-luna · low | judge | b5a7933f32 | 3/10 | 3/3 (100%) | — | turns | 40 | 1,116,515 (1,104,332) / 1,497 | 1m 37s | $0.013 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 3/13 | 3/3 (50%–100%) | — | done | 68 | 1,806,166 (1,766,595) / 3,105 | 1m 23s | $0.023 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 6/13 | 6/6 (60%–100%) | — | turns | 80 | 2,177,140 (2,156,267) / 3,392 | 2m 40s | $0.025 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 5/13 | 6/7 (75%–88%) | — | turns | 80 | 2,137,143 (2,120,076) / 3,135 | 1m 27s | $0.024 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 5/13 | 6/6 (86%–100%) | — | done | 71 | 1,883,627 (1,842,934) / 3,654 | 1m 35s | $0.024 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 5/13 | 6/6 (75%–100%) | — | done | 68 | 1,835,668 (1,816,267) / 3,416 | 1m 35s | $0.022 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 5/13 | 5/5 (71%–100%) | — | done | 67 | 1,764,828 (1,747,482) / 3,149 | 1m 28s | $0.021 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 6/13 | 7/7 (78%–100%) | — | done | 73 | 1,987,618 (1,943,666) / 3,885 | 1m 58s | $0.026 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 5/13 | 5/5 (83%–100%) | — | turns | 80 | 2,178,725 (2,159,921) / 3,871 | 1m 41s | $0.025 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 6/13 | 6/6 (60%–100%) | — | turns | 80 | 2,155,125 (2,113,073) / 2,940 | 1m 35s | $0.027 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 3/13 | 4/4 (80%–100%) | — | turns | 80 | 2,205,958 (2,185,475) / 4,927 | 3m 03s | $0.026 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 6/13 | 6/6 (86%–100%) | — | done | 63 | 1,656,792 (1,639,665) / 3,321 | 1m 28s | $0.020 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low · 2 lanes | judge | c1786bc817 | 6/13 | 7/7 (88%–100%) | — | done | 80 | 2,240,643 (2,217,815) / 20,329 | 6m 40s | $0.035 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 2/13 | 2/2 (100%) | — | turns | 18 | 450,239 (422,802) / 864 | 45s | $0.007 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 2/13 | 2/2 (67%–100%) | — | turns | 18 | 445,291 (417,994) / 885 | 53s | $0.007 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 3/13 | 3/3 (100%) | — | turns | 18 | 443,643 (438,786) / 1,123 | 45s | $0.005 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 2/13 | 2/2 (100%) | — | turns | 18 | 444,939 (439,844) / 1,332 | 1m 15s | $0.006 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 1/13 | 2/2 (67%–100%) | — | turns | 18 | 440,837 (436,382) / 811 | 1m 06s | $0.005 |
| 2026-10-07 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 0/13 | 0/0 (—) | — | done | 12 | 283,535 (280,643) / 407 | 35s | $0.003 |
| 2026-10-09 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 3/13 | 3/3 (75%–100%) | — | turns | 18 | 437,701 (410,551) / 921 | 52s | $0.007 |
| 2026-10-09 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 1/13 | 1/1 (100%) | — | turns | 18 | 438,297 (411,768) / 862 | 1m 11s | $0.007 |
| 2026-10-09 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 0/13 | 0/0 (—) | — | turns | 18 | 434,600 (409,308) / 502 | 49s | $0.007 |
| 2026-10-09 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 3/13 | 3/3 (75%–100%) | — | turns | 18 | 567,914 (526,558) / 16,847 | 2m 38s | $0.018 |
| 2026-10-09 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 0/13 | 0/0 (—) | — | turns | 18 | 431,279 (427,659) / 503 | 54s | $0.005 |
| 2026-10-09 | demo | 3.20.2 | dispatched | openai · gpt-6-luna · low | judge | c1786bc817 | 1/13 | 1/1 (50%–100%) | — | turns | 18 | 429,063 (425,976) / 592 | 48s | $0.005 |
| 2026-10-05 | demo | 3.19.2 | scheduled | openai · gpt-6-luna · low | judge | c1786bc817 | 4/13 | 4/4 (80%–100%) | — | done | 35 | 883,537 (852,278) / 1,492 | 1m 31s | $0.012 |
| 2026-10-05 | holdout | 3.19.2 | scheduled | openai · gpt-6-luna · low | judge | b5a7933f32 | 0/10 | 0/2 (0%–33%) | — | done | 33 | 863,556 (832,225) / 1,559 | 1m 16s | $0.012 |

<!-- ci-results:end -->

**Turn cap, 40 to 80 (ci-turns-1).** One change against ci-run-2, which ended
at the 40-turn cap: the same model and effort (gpt-6-luna, medium) with
`max-turns` 80 and `max-tokens` 3,000,000 (both doubled; the time cap stayed
20 minutes), dispatched through the benchmark workflow's new inputs. The
engine moved from `7280e29` to `e13193a` between the two, with no change to
`scenescout ci`'s loop or prompt. The run ended by itself at 65 turns, so 80
was not binding. Recall 3/13 to 4/13: gained the scheduled-reports dead end
and the sticky bar covering Save, lost the double submit. Precision 5/5, up
from 3/3. Tokens and cost rose by about 1.9 times ($0.013 to $0.023). **Not
adopted:** a net one-defect gain from one run is within the run-to-run spread
(ci-run-1 and ci-run-2 differ by two on an effort change), and ci-run-1 found
5/13 in 36 turns at low effort, so more turns do not yet explain a gap. The
CLI's default cap stays 40; the workflow inputs stay, so a later experiment
can set the caps without editing the workflow.

### Lanes: one loop against four (task 40)

`scenescout ci --lanes 4` splits the app between four model loops that share
the run's caps ([ADR 20](adr/0020-an-unattended-run-may-split-into-lanes-that-share-its-caps.md)).
One layer changed: the shape of the run. Held fixed: the engine at commit
`eba7aea` (with `--lanes` built in, so both sides ran the same code),
gpt-6-luna at effort `low`, ci-run-1's caps (the defaults: 40 turns,
1,500,000 tokens, 20 minutes), `read-only`, level `medium`, and a fresh app and
project per run, dispatched through the benchmark workflow's `lanes` input.
The rows are the `ci-lanes-*` archives in the table above. Per-lane turns and
what each lane opened come from the runs' `ci.json` and logs, in workflow runs
36952225081, 36952230314 (lanes), 36952235854, 36952240780 (one loop),
36953212250 and 36952251577 (held-out) and 36953334977 (raised caps); the
archives keep the findings.

**The noise floor first.** Single-loop runs of one engine agree closely: the
four low-effort demo rows from 3.12.0 to 3.13.1 above all read 5/13, and the
two single-loop runs here both read 3/13. Between releases the gap is wider:
the scheduled run of v3.14.1 found 2/13 on the demo and 1/10 on the held-out
app, where the dispatched run of v3.13.1 a day earlier found 5/13 and 3/10,
with the same model, effort and caps. That 2/13 run lists the
scheduled-reports dead end in other words ("renders with no usable controls"),
which the key may not match; a person should check the phrasing against the
key. To be safe, each configuration compared here was run twice on the demo,
and a difference within ±3, the gap between those two releases, is read as
noise.

| | Demo recall | Held-out recall | Turns | Wall | Cost per run |
|---|---:|---:|---|---|---:|
| One loop | 3/13, 3/13 | 1/10 | 29, 29; 27, each ended by itself | 1m 05s to 1m 19s | $0.007 to $0.009 |
| 4 lanes, the caps shared | 3/13, 3/13 | 2/10 | 40, the turn cap | 32s to 33s | $0.010 to $0.014 |
| 4 lanes, caps raised to 160 turns and 6,000,000 tokens (one run) | 8/13 | not run | 95, every lane ended by itself | 1m 29s | $0.026 |

**Item by item.** Every demo run found the chart image's 404 and the badge
covering a dashboard button, both on the landing page. With the caps shared,
the lanes also found the export crash on the reports page (run 1) or the
sticky bar covering Save (run 2), and missed the scheduled-reports dead end
that the single loop found both times: each lanes run gained one item and lost
one.
On the held-out app both configurations found the notices page stuck after a
500, and the lanes run also found the overdue loans' contrast, which is within
the noise. Labelled precision was 3/3 per lanes run against 4/4 per
single-loop run on the demo, and 2/4 against 1/4 on the held-out app. Six of
the seven runs left one finding unlabelled (a page with no visually dominant
next action, the new-order form accepting zero items, a link with no test id),
and the seventh set one aside; they are listed for a person to judge, and the
key was not changed.

**Why sharing the caps found no more.** The four lanes split the same 40 turns,
about ten each, and spent them all in 33 seconds, while the single loop ended
by itself at 29 turns, so the cap never bound it. A lane spent its ten turns on
its first route: the lane that owned the landing page clicked through the
dashboard and never opened its other two routes, one of which holds the dead
end. Sharing the caps keeps the run's ceiling where it was, the lanes spending
all of it, and leaves each lane a quarter of a budget the single loop does not
use in full.

**Raised caps, direction only.** With the caps raised to about a single loop's
budget per lane, four lanes found 8/13, and all 9 labelled findings were
correct: the two landing-page items, plus the double submit, the new-order
hint's contrast, the e-mail field with no label, the export crash, the
scheduled-reports dead end and the sticky bar, and one correct finding the
key lists beyond its expected ones (a customer name rendered as markup in the
orders list). Every lane ended by itself, after 16 to 36 turns, the level's
contract was met, and the run used about 2.0 million tokens, about 3.4 times a
single loop's. +5 is beyond the noise
floor, but it is one run, with the caps raised. The single loop was not re-run
at 160 turns: at this effort it ends by itself near 30 turns, well inside 40.

**Decision: the default stays one loop.** At the run's own caps, four lanes
found as many expected defects as one loop on the demo (3/13 in each of two
runs, though not the same ones) and one more on the held-out app (2/10 against
1/10, within the noise), in half the wall time and with about 1.3 times the
tokens. Lanes stay as an option, documented with what this measured, because
the raised-cap run points at the budget per lane, not the split, as what binds.
Two more demo runs and a held-out run at those caps would show whether lanes
with a per-lane budget beat one loop reliably; that is the next experiment,
before any default changes.

**Settling the raised caps: four more runs and a control.** The spend cap was
raised to twelve, with no more than two runs in flight. Each run below used
160 turns and 6,000,000 tokens, on the engine at `0b709b2` (this branch merged
with main, with no change to `scenescout ci`):

| | Demo recall | Held-out recall | Turns | Wall | Cost |
|---|---:|---:|---|---|---:|
| One loop (the control, one run) | 5/13 | not run | 37, ended by itself | 1m 24s | $0.011 |
| 4 lanes (two scored runs, with the one above) | 8/13, 8/13 | 7/10 | 86 to 95, every lane ended by itself | 1m 13s to 1m 29s | $0.024 to $0.026 |

- **The control separates the caps from the split.** Given 160 turns, one loop
  still ended by itself, at 37 turns, and found 5/13. Four lanes found 8/13
  in both demo runs. They found the same five items as the control (the two
  landing-page items, the hint's contrast, the dead end, the sticky bar),
  plus the e-mail field with no label, the export crash, and the double submit
  or the inventory list sorted as text. So the raised caps alone do not
  explain the gain; the split uses a budget one loop leaves unspent.
- **The held-out app:** four lanes found 7/10, labelled precision 7/9 (50%–86%,
  with five findings unlabelled), against 1/10 to 3/10 for every single-loop
  run on record. One loop was not run there at the raised caps.
- **The rule, applied as agreed.** The default changes only if lanes at the
  raised caps beat one loop at the raised caps by more than three on the
  demo, and do not lose on the held-out app. On the demo the gain is +3
  (8 against 5), at the noise bound and not beyond it, from one control run.
  **The default stays one loop.** `--lanes 4 --max-turns 160 --max-tokens
  6000000` is documented as the configuration that found the most, with its
  cost.
- **Its cost.** About 1.8 to 2.0 million tokens and $0.025 a run, about 2.3
  times the control's, in about the same wall time.
- **Its limit.** That rate is close to one organisation's 2,000,000
  tokens-per-minute limit. The third demo lanes run, in flight beside the
  held-out lanes run, used 2.09 million tokens in 77 seconds. One of its lanes
  was refused (HTTP 429) after its retries, and the run ended
  `provider-error`. It is not scored. Running two such runs at once on one
  organisation's key is enough to reach that limit.
- **What would settle the default:** one-loop runs at the raised caps on both
  apps, enough of them to measure that configuration's own spread, beside
  more lanes runs.

**Spend and what was not run.** Twelve runs in all. The four above are one
lanes run on the demo and the control, then one lanes run on the demo and
one on the held-out app; the 429 cost the demo run, so two demo lanes runs at
these caps were scored, with the first one above. The first eight: the seven above, and a held-out
lanes run dispatched together with five others. One of its lanes had a model
call refused for the organisation's tokens-per-minute limit (HTTP 429) through
all its retries, so the run ended `provider-error` (exit 2), as a model API
failure in any lane does, and kept no artifact; it is not scored. Four lanes
sent about 1.4 million tokens a minute at this model, about 2.8 times one
loop's 0.5 million, so a per-minute limit is reached sooner; the one refusal
seen came with six runs in flight on one organisation's limit. [The lanes
section of the CI guide](ci.md#lanes) says so. Lanes
2 was not run: the eighth run went to the raised caps instead, the cause the
action logs pointed at.

### Choosing the defaults (issue 419)

Until this measurement `scenescout ci` defaulted to one loop, 40 turns and
1,500,000 tokens. The v3.18.0 rows above found 3 to 5 of 13 planted defects
with it on the demo app and 1 to 2 of 10 on the held-out app; the three
baseline runs below, of v3.19.2, found 2 to 4 of 13. The defaults are now **two lanes sharing 80
turns and 3,000,000 tokens** (the time cap stays 20 minutes).

**What was held fixed.** Release v3.19.2 (commit `1a5a903`, which is also the
base of this change), gpt-6-luna at effort `low`, `read-only`, level `medium`,
dedup `judge`, a fresh app and project per run. Every run was dispatched
through the [benchmark workflow](../.github/workflows/ci-benchmark.yml), at
most two in flight, and the two-lane runs one at a time. Only the turn and
token caps and the lane count changed. The token cap was scaled with the turn
cap (37,500 tokens a turn), so the turn cap stayed the cap that could bind:
the runs used about 27,000 tokens a turn. They are the fifteen rows of
2026-10-06 in the table above, archived as `ci-caps-<app>-<arm>-<n>`.

**Three runs a configuration on the demo app.** Recall pools the three runs'
39 defect-runs, with a 95% Wilson interval; the interval treats each
defect-run as independent, which they are not, so read it as a lower bound on
the uncertainty. pass@3 is the defects found in at least one of the three
runs; pass^3 is those found in all three.

| | Recall per run | Pooled recall (95%) | pass@3 | pass^3 | Labelled precision, pooled | Turns used, how it ended | Wall | Cost per run |
|---|---|---:|---:|---:|---:|---|---|---:|
| One loop, 40 turns (the old default) | 3, 4, 2 of 13 | 9/39, 23% (13–38%) | 5 | 1 | 10/11 | 30, 31, 24, each ended by itself | 1m 01s to 1m 18s | $0.009 to $0.012 |
| One loop, 80 turns | 5, 4, 5 | 14/39, 36% (23–52%) | 8 | 2 | 16/17 | 64, 56, 75, each ended by itself | 1m 52s to 2m 52s | $0.019 to $0.027 |
| One loop, 120 turns | 6, 2, 4 | 12/39, 31% (19–46%) | 6 | 1 | 12/12 | 41, 30, 39, each ended by itself | 1m 05s to 1m 35s | $0.009 to $0.014 |
| **Two lanes, 80 turns shared** (the new default) | **7, 6, 5** | **18/39, 46% (32–61%)** | 7 | **4** | 19/20 | 80 each, the turn cap | 1m 51s to 3m 37s | $0.027 to $0.029 |

- **The arm for the lanes.** One loop at 80 turns had the best single-loop
  mean (4.7 against 4.0 at 120) and pass@3, so the lanes arm used its total:
  80 turns and 3,000,000 tokens, shared by two lanes, about 40 turns each.
- **One loop does not use a bigger budget reliably.** At 40 turns every run
  ended by itself before the cap. At 80 it worked longer (56 to 75 turns) and
  found more; at 120 it stopped at 30 to 41 turns again, and found 2 to 6.
  The 80 and 120 rows overlap the 40 row; three runs cannot separate them.
- **Two lanes beat the old default in every run.** Their worst run (5) is
  above the old default's best (4); with three runs a side that ordering has a
  one-sided chance of 1 in 20 under no difference. The mean gain is +3.0, at
  the ±3 bound the [lanes section](#lanes-one-loop-against-four-task-40) set
  for gaps between releases, and the pooled intervals overlap, so this is a
  clear but not a large-sample result. The gain is consistency more than
  reach: pass^3 is 4 against 1, while pass@3 (7) is below one loop at 80
  turns (8). The four found every time are the chart image's 404, the badge
  covering a dashboard button, the export crash and the sticky bar covering
  Save.
- **The turn cap binds the lanes.** Every two-lane demo run ended at the
  80-turn cap, each lane after 38 to 42 turns, so more turns would likely
  find more, at proportionally more cost.
- **Wall time** rose from about a minute to 2 to 3.5 minutes: two of the
  three lanes runs took longer than any single-loop run.
- **Precision held:** 19 of 20 labelled findings correct for the lanes
  against 10 of 11 for the old default.
- **429s:** no run was refused (none ended `provider-error`). The engine
  retries a 429 without logging it, so retried refusals are not counted. Two
  lanes peaked at about 1.2 million tokens a minute (2.2 million in 111
  seconds), under the 2,000,000-a-minute limit four lanes approached before;
  two such runs at once on one key could reach it.

**The held-out app, run after the choice and not tuned on.** Three runs of
the chosen setting; its key was not read and nothing was changed after them.

| | Recall per run | Pooled recall (95%) | pass@3 | pass^3 | Labelled precision, pooled | Turns | Wall | Cost per run |
|---|---|---:|---:|---:|---:|---|---|---:|
| One loop, 40 turns (eight runs of v3.18.0, above) | 2, 2, 1, 1, 1, 1, 1, 2 of 10 | 11/80, 14% (8–23%) | — | — | 11/23 | 33 to 40 | 1m 20s to 1m 55s | $0.011 to $0.016 |
| Two lanes, 80 turns shared | 5, 4, 4 | 13/30, 43% (27–61%) | 6 | 3 | 14/18 | 75, 80, 69 | 1m 29s to 2m 22s | $0.022 to $0.026 |

The old default's held-out rows are of v3.18.0, not v3.19.2, so the
comparison crosses a release; the gap (every lanes run above every one of the
eight) is wider than the noise between releases recorded above. Precision on
the held-out app is lower than on the demo, as it has been for every
configuration: 4 of 18 labelled findings were wrong.

**Cost.** About $0.03 a run on gpt-6-luna, about 2.5 times the old default's
$0.011, and about 2.2 million tokens, nearly all of them cached input. The
spend for this measurement was $0.29 in all, by the runs' own estimates: twelve
demo runs and three held-out runs, none discarded.

**What the key missed.** The scores above use the keys unchanged. Eleven of
the twelve demo runs filed the new-order e-mail field's missing label; the key
matched it in two ("relies on placeholder for its label", "loses its
accessible name" and "placeholder-only label" do not match). One lanes run
filed the scheduled-reports dead end as "leaves users with no available
action", and three runs filed the settings page's "Saved." with no request
in words the key's real-but-not-expected entry does not match. Counted by a
person, recall would be about one higher in most runs of every configuration;
the comparison between configurations is not changed by it. The matches were
left for a person to extend, with a re-score of every archived run.

**For the seeded re-measure (issue 418).** In single-loop runs at the 40-turn
cap the cap was not what stopped the run: all three ended by themselves at 24
to 31 turns. The same loop given 80 turns worked to 56 to 75, so the budget
the prompt states may shape how long the model works, but at 120 it stopped at
30 to 41, so this is not settled. At the new default the turn cap does bind:
every two-lane demo run reached it.

### A seeded exploration schedule (issue 418)

`scenescout ci --seed` crawls first and tells the model to take the routes in
an order shuffled by the seed, the routes earlier seeded runs on the project
started with last. One layer changed: the seed. Held fixed: the engine at
commit `3acef27` (the seed built in, so both arms ran the same code),
gpt-6-luna at effort `low`, the default caps (40 turns, 1,500,000 tokens, 20
minutes), `read-only`, level `medium`, the dedup judge, and a fresh app and
project per run, dispatched through the benchmark workflow's new `seed` input.
The seeds were chosen before any run: `b418a` to `b418c` on the demo,
`h418a` to `h418c` on the held-out app. Three runs per arm per app; pass@3 is
the expected defects found by at least one of the three runs, pass^3 those
found by all three. The rows are the `ci-seed-*` archives in the table above.

| | Recall per run | pass@3 | pass^3 | Labelled precision | Turns | Cost (3 runs) |
|---|---|---:|---:|---:|---|---:|
| Demo, unseeded | 3, 3, 4 of 13 | 5 | 2 | 10/10 (3 unlabelled) | 39, 31, 40 | $0.039 |
| Demo, seeded | 1, 5, 4 of 13 | 6 | 0 | 10/10 (5 unlabelled) | 40, 40, 40 (the cap) | $0.039 |
| Held-out, unseeded | 3, 1, 1 of 10 | 3 | 1 | 5/8 (4 unlabelled) | 40, 30, 32 | $0.032 |
| Held-out, seeded | 2, 1, 3 of 10 | 5 | 0 | 6/7 (2 unlabelled) | 40, 40, 40 (the cap) | $0.038 |

- **pass@3 rose a little, within the noise.** +1 on the demo (the seeded runs
  found the badge covering a dashboard button, the export crash and the
  sticky bar covering Save, which no unseeded run did, and missed the double
  submit and the e-mail field with no label) and +2 on the held-out app.
  Both are inside the ±3 the [lanes comparison](#lanes-one-loop-against-four-task-40)
  takes as one configuration's spread, from three runs an arm.
- **pass^3 fell on both apps,** from 2 to 0 on the demo and from 1 to 0 on
  the held-out app. Every unseeded demo run found the chart image's 404 and
  the scheduled-reports dead end; no defect was found by all three seeded
  runs. The issue's condition, that pass^k must not fall, is not met.
- **Why, as far as the runs show.** An unseeded run starts on the landing
  page, where several planted defects are, and every run meets them. A
  seeded run is sent first to the head of its order: `b418a` started with the
  orders list, the sign-in page and the inventory, and found 1 of 13. Every
  seeded run also ended at the 40-turn cap, where two of three unseeded runs
  per app ended by themselves: following an order of twelve routes spends the
  budget moving between them.
- **Precision held.** No labelled false positive on the demo in either arm;
  6/7 seeded against 5/8 unseeded on the held-out app. Unlabelled findings are
  left for a person to judge and the key was not changed. One unseeded demo
  run filed "Optional email field has no persistent accessible label", which
  may be the key's `new-order-email-no-label` in other words; it was not
  counted.
- **Cost.** The same: about $0.012 a run in both arms, about 1.0 to 1.1
  million tokens. Twelve runs cost $0.148 in all.
- **What this did not measure.** Every run had a fresh project, so no run
  had an earlier seeded run's choices to move to the back: the exclusion
  across runs never engaged, and is covered by the table tests in `ci-test`
  and `brief-test` only. Measuring it needs k seeded runs sharing one
  project's memory, scored by what each run added.

**Decision at the old defaults: not met.** The re-measure below, at the
defaults [issue 419](#choosing-the-defaults-issue-419) chose, replaces it.

#### Re-measured at the two-lane default, with memory carried over

The first measurement ran one loop at 40 turns, and every run had a fresh
project, so the exclusion across runs never engaged. This one changes both.

**What was held fixed.** The engine at commit `ac3c1fa` (this branch merged
with main, so both arms ran the same code), gpt-6-luna at effort `low`, the
new defaults (two lanes sharing 80 turns, 3,000,000 tokens and 20 minutes),
`read-only`, level `medium`, the dedup judge, and a fresh demo app per run.
Runs were dispatched one at a time, alternating the arms (unseeded, seeded,
unseeded, ...). They are the `ci-seed2-demo-*` rows of 2026-10-07 in the table
above.

- **Unseeded arm:** three runs, each with a fresh project.
- **Seeded arm, carried over:** seeds `c418a`, `c418b` and `c418c`, chosen
  before any run. The first run had a fresh project. Each later run's memory
  started with the `schedules` of the seeded run before it, through the
  benchmark workflow's dispatch-only `seed-history` input, so the exclusion
  applied. Only the schedules were carried, not the findings: bench scores
  everything in a run's memory, so carrying earlier findings would credit a
  run with what an earlier run found.

The exclusion worked as designed. `c418a`'s lanes started on six of the
twelve routes, and `c418b`'s lanes started on exactly the other six. By the
third run every route had been a start once, so `c418c` ordered all twelve by
its own shuffle.

| | Recall per run | Pooled recall | pass@3 | pass^3 | Labelled precision | Turns, how it ended | Cost (3 runs) |
|---|---|---:|---:|---:|---:|---|---:|
| Unseeded | 3, 6, 5 of 13 | 14/39 | 7 | 3 | 15/16 (8 unlabelled) | 68 done, 80 cap, 80 cap | $0.073 |
| Seeded, carried over | 5, 5, 5 of 13 | 15/39 | 7 | 3 | 17/17 (4 unlabelled) | 71, 68, 67, each done | $0.067 |

- **pass@3 is unchanged, and so is the set it counts.** Both arms found the
  same seven defects between them: the chart image's 404, the badge covering
  a dashboard button, the hint text's contrast, the e-mail field with no
  label, the export crash, the scheduled-reports dead end and the sticky bar
  covering Save. Spreading where the lanes start reached no defect the
  unseeded runs missed.
- **pass^3 is unchanged in count (3 against 3) but not in content.** Every
  unseeded run found the 404, the export crash and the sticky bar. Every
  seeded run found the 404, the badge and the dead end.
- **The seeded runs varied less**: 5, 5 and 5 against 3, 6 and 5. All three
  seeded runs ended by themselves, at 67 to 71 turns. Two of the three
  unseeded runs hit the 80-turn cap. Three runs per arm cannot tell this
  apart from noise.
- **Why the order does not matter here.** At the two-lane default the demo's
  twelve routes are split six and six, and each lane gets about 40 turns, so
  each lane visits all its routes whatever the order. The six defects no run
  found need depth on one page rather than a different starting page: an
  empty submit, a double submit, a sort, an empty list behind a refused read,
  a role check on an endpoint and a delete that claims success. Starting
  elsewhere does not reach them.
- **Precision held.** No labelled false positive in the seeded arm, and one
  in the unseeded arm. The key was not changed.
- **Cost.** About $0.022 a run in both arms. Six runs cost $0.140 in all, by
  the runs' own estimates. None was discarded.
- **The held-out app was not run.** The demo result was not positive, and
  the held-out app is only run to confirm a gain.

**Decision: rejected against the issue's criteria.** The issue asks for
pass@k up and pass^k not down. pass@3 did not rise, at either the old or the
new defaults, and pass^3 fell at the old ones. Seeding stays off by default;
see the [rejected list](#rejected-and-not-yet-tried) for what would be worth
trying instead.

### Starting from an earlier run (issue 418)

The seeded schedule above was reworked into `--from-run`: a run reads an
earlier run's record and, in `continue` mode, takes first the routes it never
worked on, then the routes it left work on (told exactly which controls, forms
and options to take first), then the rest. Only `continue` was measured;
`replay` is held to repeating its input's order by `brief-test` and `ci-test`.

**What was held fixed.** The engine at commit `4ebc18b`, gpt-6-luna at effort
`low`, the defaults (two lanes sharing 80 turns, 3,000,000 tokens and 20
minutes), `read-only`, level `medium`, the dedup judge, a fresh demo app and a
fresh project per run, dispatched one at a time through the benchmark
workflow and alternating the arms. The rows are the `ci-fromrun-demo-*`
archives of 2026-10-07 in the table above.

- **Independent arm (`u1`–`u3`):** three runs, nothing carried over.
- **Continued arm (`c1`–`c3`):** `c1` continued from `u1`'s record, `c2` from
  `c1`'s and `c3` from `c2`'s, each through the workflow's dispatch-only
  `from-run-record` input. Only the record was carried, never the memory, so
  each run is scored on its own findings.

| | Recall per run | Pooled recall | pass@3 | pass^3 | Labelled precision | Turns, how it ended | Cost (3 runs) |
|---|---|---:|---:|---:|---:|---|---:|
| Independent | 6, 5, 6 of 13 | 17/39 | 7 | 4 | 18/18 (7 unlabelled) | 73 done, 80 cap, 80 cap | $0.078 |
| Continued | 3, 6, 6 of 13 | 15/39 | 8 | 1 | 17/17 (2 unlabelled) | 80 cap, 63 done, 80 done | $0.081 |

- **pass@3 rose by one.** The continued arm found the one defect no
  independent run found: the approve endpoint accepting a clerk (`c1`). That
  is one of the defects that needs work inside a visited page, which is what
  `continue` points the run at. One defect in three runs is within the noise.
- **pass^3 fell from 4 to 1.** Every independent run found the chart image's
  404, the badge covering a dashboard button, the export crash and the
  scheduled-reports dead end; only the dead end was found by all three
  continued runs. `c1` found 3: told to start on the 28 controls `u1` left, it
  spent its turns there and never filed the dashboard's or the export's
  defects, which every fresh run finds in passing.
- **It did the work it was pointed at.** The runs continued from a record with
  work left (`c1` from `u1`, `c3` from `c2`) left 9 controls unexercised,
  against 24 to 28 for the others. Exercising them did not turn into findings
  on this app.
- **The arms are not independent of each other.** `c1` continued `u1`, so the
  continued arm had one more run's knowledge than the other; that favours it,
  and it still did not pass.
- **Precision held** at 100% labelled in both arms. The key was not changed:
  the unlabelled findings (a shell link styled as body text, an optional
  e-mail field's label) are left for a person to judge.
- **Cost.** $0.159 for the six runs by their own estimates, about $0.026 a
  run in both arms. None was discarded.
- **The held-out app was not run.** The demo result was not positive, and
  the held-out app is only run to confirm a gain.

**Decision at the time: rejected against the issue's criteria** (pass@3 up
and pass^3 not down): pass@3 rose by one, inside the noise, and pass^3 fell by
three.

**Correction: pass^3 was the wrong gate for this mode.** `continue` is built
not to repeat what the run before it covered, so a defect every fresh run finds
in passing is one a continued run is told to leave until last. The numbers
above stand; what they measure is pass@3, which rose by one, inside the noise.
The measurement below uses pass@3 as the gate.

**Correction: the continued arm was counted without the run it started from.**
A chain is one fresh run and the runs that continue it, so its three runs are
`u1`, `c1` and `c2`, compared with the fresh arm's `u1`, `u2` and `u3`. The
table's arm rows are kept as measured. Counted as unions of three runs, the
fresh arm finds **7** distinct defects and the chain **8** (`u1`'s six, plus the
approve endpoint and the empty list behind a refused read from `c1`).

#### Re-measured at a small budget, with the path to each page

At the default budget every demo run reaches all twelve routes, so there is
nothing left for a continued run to pick up. This measurement cuts the budget
on purpose, to stand in for an app larger than one run covers. **It is a
simulation on a small app, not evidence about a large one.** The engine now
also takes the earlier run's path to a continued run's first page when that
run reached it by acting on another page (the path prefix).

**What was held fixed.** The engine at commit `2904a3c`, gpt-6-luna at effort
`low`, **one lane and 18 turns** per run (one lane, since two would leave each
lane nine), 3,000,000 tokens and 20 minutes, `read-only`, level `medium`, the
dedup judge, a fresh demo app and project per run, dispatched one at a time and
alternating the arms. A continued run also makes the planning crawl a fresh
one-loop run does not; it costs no model turn. The rows are the
`ci-fromrun-small-demo-*` archives.

- **Fresh arm (`u1`–`u3`):** three runs, nothing carried over.
- **Continued arm (`c1`–`c3`):** `c1` continued from `u1`'s record, `c2` from
  `c1`'s and `c3` from `c2`'s.

| | Recall per run | pass@3 | pass^3 | Labelled precision | Pages each run worked on | Turns, how it ended | Cost (3 runs) |
|---|---|---:|---:|---:|---|---|---:|
| Fresh | 2, 2, 3 of 13 | 4 | 1 | 7/7 (1 unlabelled) | 6, 5, 4 | 18 cap, 18 cap, 18 cap | $0.020 |
| Continued | 2, 1, 0 of 13 | 3 | 0 | 4/4 (1 unlabelled) | 11, 4, 4 | 18 cap, 18 cap, 12 done | $0.014 |

- **pass@3 fell by one** (3 against 4). The fresh arm found the chart image's
  404, the badge, the sticky bar and the dead end. The continued arm found the
  sticky bar, the empty list behind a refused read (which no fresh run found)
  and the hint text's contrast.
- **The continued runs covered more and filed less.** `c1` worked on eleven
  pages in 18 turns, against four to six for a fresh run, and filed two
  defects. `c3` was told the earlier runs had covered every page, ended by
  itself at 12 turns and filed nothing.
- **The path prefix ran once and worked.** `c2`'s first page was an order's
  detail page, which `c1` had reached from the orders list; `c2` took the
  same two steps and landed there. The other continued runs started on a page
  the earlier run had opened by its address, so they needed no path.
- **Precision held** at 100% labelled in both arms; the key was not changed.
- **Cost.** $0.034 for the six runs by their own estimates.
- **The held-out app was not run.** The demo result was not positive.

**Decision at the time: not shown to help, even where it should** (3 against
4).

**Correction: the same counting fault as above.** Counted as the chain it is,
`u1` with `c1` and `c2`, the continued arm finds **4** distinct defects (the
chart image's 404 and the sticky bar from `u1`, the empty list behind a refused
read from `c1`, the hint text's contrast from `c2`), the same as the fresh
arm's 4. Also, `c3` stopped early because it was told every page was covered
when its record still listed work on all nine pages it had: "covered" meant
visited. That is fixed below.

#### Re-measured with depth: a page is worked through only when nothing is left

**What changed (one layer: the continue order).** A visited page now counts as
worked through only when its record lists no control, form or option left
(`EXHAUSTED_AT` is 0). Pages are ordered by the work left, the most first.
Every message ends by telling the run to keep exploring until the budget is
spent, and a record with nothing left anywhere makes a fresh-style run
(`continuedFresh` in the record). Engine at commit `c70db35`; everything else
as in the small-budget measurement above (one lane, 18 turns, demo app,
gpt-6-luna at effort `low`). One fresh run `f1`, then `d1` continuing `f1` and
`d2` continuing `d1`, dispatched one at a time. They are the
`ci-fromrun-depth-demo-*` archives of 2026-10-09. This is still a simulation of
a larger app on a small one.

| Run | Recall | Labelled precision | Pages it worked on | Turns, how it ended | Cost |
|---|---|---:|---:|---|---:|
| `f1` (fresh) | 3 of 13 | 3/3 (1 unlabelled) | 2 | 18 cap | $0.007 |
| `d1` (continues `f1`) | 1 of 13 | 1/1 | 12 | 18 cap | $0.007 |
| `d2` (continues `d1`) | 0 of 13 | none filed | 4 | 18 cap | $0.007 |

| Counted as unions of three runs | pass@3 | pass^3 |
|---|---:|---:|
| Fresh arm (`u1`, `u2`, `u3`, above) | 4 | 1 |
| Depth chain (`f1`, `d1`, `d2`) | 3 | 0 |

- **pass@3 is 3 against 4.** Every defect the chain found, `f1` found
  first: the chart image's 404, the badge and the hint text's contrast. `d1`
  and `d2` added none.
- **The fix did what it was for.** Neither continued run stopped early: both
  used all 18 turns, and neither record needed the fresh fallback, since the
  earlier record always had work left.
- **The continued runs spread thin again.** `d1` worked on all twelve pages in
  18 turns, against two for `f1`, and filed one defect.
- **No path was taken.** Each continued run's first page had been opened by
  its address, so there was nothing to replay.
- **Precision held**; the key was not changed. **Cost:** $0.021 for the three
  runs.
- **The held-out app was not run.** The demo result was not positive.

**Decision: not shown to help.** With "covered" meaning worked through, and
counted fairly, continued runs still did not add defects at this budget; one
chain of three runs is noisy, so a difference of one defect is not evidence
either way. The option stays off by default.

#### Re-measured with a page cap

**What changed (one layer).** A continued run now takes on only as many pages
as its budget allows: its turns over `--from-run-turns-per-page`, default 7,
so 2 pages at 18 turns. It is told to work those deeply and not to spread out,
then to take the next pages in order; the pages it was given are kept in its
record (`assigned`) so the next run takes the ones after. Engine at commit
`a9b0e2a`, otherwise as above (one lane, 18 turns, demo app, gpt-6-luna at
effort `low`). Fresh `g1`, then `k1` continuing `g1` and `k2` continuing `k1`,
one at a time: the `ci-fromrun-cap-demo-*` archives of 2026-10-09.

| Run | Recall | Labelled precision | Pages given | Pages it worked on | Cost |
|---|---|---:|---|---:|---:|
| `g1` (fresh) | 3 of 13 | 3/3 (1 unlabelled) | — | 4 | $0.018 |
| `k1` (continues `g1`) | 0 of 13 | none filed | `/approvals.html`, `/audit.html` | 8 | $0.005 |
| `k2` (continues `k1`) | 1 of 13 | 1/1 (1 unlabelled) | `/reports.html`, `/settings.html` | 4 | $0.005 |

| Counted as unions of three runs | pass@3 | pass^3 |
|---|---:|---:|
| Fresh arm (`u1`, `u2`, `u3`) | 4 | 1 |
| Capped chain (`g1`, `k1`, `k2`) | 4 | 0 |

- **pass@3 is 4 against 4.** `k2` found the export crash on `/reports.html`,
  one of its two pages, which no other small-budget run found; `g1` found the
  other three.
- **The cap moved the chain on as intended:** `k2` was given the two pages
  after `k1`'s. `k1` still worked on eight pages, so the instruction not to
  spread out was not always followed.
- **Precision held**; the key was not changed. **Cost:** $0.028 for the three
  runs.
- **The held-out app was not run.**

**Decision: not shown to help, not shown to hurt.** Equal at 4 distinct
defects in one chain of three runs; the option stays off by default.

### Labelling the unmatched findings (issue 420)

By 2026-10-10 the archived runs held 118 distinct findings that matched no
entry of their app's key: 76 on the demo and 42 on the held-out app, the 21
from the dedup runs of task 15 among them. Every run that had filed one carried it as
unlabelled, so its precision was a bound rather than a number. The keys are
now `f915c444a2` (demo) and `fe4c9a65a6` (held out).

**How they were labelled.** The maintainer asked for the labels to come from
three independent model judges instead of a person. Each judge read both apps'
source and keys, and gave every finding one verdict: a rewording of an
existing entry, a new genuine defect, not a defect, or a defect only under a
convention, with the source evidence. The three agreed on 117 of 118. The
one disagreement, a rapid double-click on Place hold, was settled by a fourth
reading of `book.html`: the button stays enabled, the second request is
refused with 409 and that error replaces "Hold placed", the same shape as the
key's existing double-click on Drop. So it is a new also-real entry, not the
existing "a second hold is refused" non-defect, which is about a deliberate
second hold. These labels are model judgements checked against source, not
a person's; a label that turns out wrong is corrected the same way as any
other key entry.

**What changed in the keys.**

| Verdict | Demo | Held out | Change |
|---|---:|---:|---|
| Rewording of an existing entry | 62 | 8 | Patterns widened on 11 demo and 5 held-out entries, each finding added as an example |
| New genuine defect | 1 | 3 | Also-real: the dashboard's stat tiles are fixed in the page; a failed reviews request reads "No reviews yet."; the Place hold double-click above |
| Not a defect | 13 | 17 | "No visually dominant action" (12 demo, 14 held out) is now a non-defect on any page, as it already was on the demo's reports page; the book page with no id saying "Book not found"; an empty review the server refuses with its message shown; a placeholder a run filed instead of a finding |
| Defect only under a convention | 0 | 14 | The held-out key gets the demo's `spacing-off-grid` contextual entry: neither app declares a spacing scale |

Two findings that already matched an entry changed:

- A run's "Email field has only a placeholder for its label", whose evidence
  also gives the hint text's 1.73:1 contrast, would have matched both
  entries. The widened email patterns skip text that mentions contrast, so it
  keeps its earlier credit for the contrast defect.
- "Account page lacks a visually dominant next action" in
  `ci-caps-holdout-l2t80-2` was credited to the clipped Download my data
  link only because its evidence names the `account-export` link's colour.
  It now also matches the non-defect, so it is ambiguous and scored as
  neither. That run's recall stays 4/10; its precision is 4/8 instead of 5/6.

**What moved.** Unlabelled findings across all 101 archived runs went from
101 to 5. The five left are findings that report two planted defects in one
title and evidence, which the scorer counts for neither, and the account-page
finding above. 62 rows changed, all but runs 2 and 3 unattended
`scenescout ci` rows. Recall rose where a run had reported a planted defect in
words the key did not know: most often the email field labelled only by its
placeholder, the Settings save that sends nothing, and the scheduled-reports
dead end. Precision fell where runs filed "no visually dominant action"
notes, which are now false positives rather than unlabelled.

The numbers in the earlier unattended sections are as they were recorded, under the old keys.
Re-scored, none of the decisions they support changes:

| Comparison | Mean recall, old key | Mean recall, new key | Decision |
|---|---|---|---|
| [Defaults](#choosing-the-defaults-issue-419), demo: 40 / 80 / 120 turns / 2 lanes × 80 | 3.0 / 4.7 / 4.0 / 6.0 | 3.7 / 5.7 / 5.0 / 6.7 | 2 lanes × 80 still leads; it stays the default |
| [Seeded schedule](#a-seeded-exploration-schedule-issue-418), demo: seeded / unseeded | 3.3 / 3.3 | 4.0 / 4.3 | Still no gain; still rejected |
| [Continue](#starting-from-an-earlier-run-issue-418), demo: continued / fresh | 5.0 / 5.7 | 5.7 / 6.3 | Still level within noise; still off unless asked for |
| [Dedup judge runs](#judge-run-3-out-of-sample-the-lead-holds), demo / held out | 4.2 / 1.4 | 5.2 / 1.6 | Recall only; the judge's accuracy and Brier are scored on labelled pairs and did not move |

Three runs per configuration, so a difference of one defect is within the
noise these sections already describe.

## Finding dedup as a measured decision (task 15)

The store decides whether a newly filed finding is one it already records
(`isDuplicateFinding` in `src/engine/memory.ts`). `npm run dedup-bench` scores
that decision on pairs built from the archived runs, and can score a
model-backed judge beside it.

**How the pairs are made.** Within one app, across all its archived runs, every
two findings whose key entries share a page (the entry's `route` or `alsoOn`)
form a pair. The label comes from the key: both findings classified to one
entry is "same", to two entries is "different". Findings with identical
category, title and evidence are collapsed first. Findings the key does not
name, names ambiguously, or calls a known non-defect (which has no page) are
left out and counted. The rule is given both findings on the shared page, the
earlier as the stored one; it states no probability, so it is scored as 1 or 0.

**The labels are derived from the key, not judged by a person.** A key entry
can be broader than one fix: two "same" pairs here are the off-grid spacing on
two different pages, and on the held-out app the rule's two "wrong merges"
are one finding the key classifies as the double submit which also describes
the renew button offered at its limit. Pairs also cluster: on the demo, one
entry (invalid input accepted by the orders API) supplies 378 of the 2,113
"same" pairs, so the pairs are not independent and no bootstrap interval is
given. Brier and accuracy weigh a missed merge and a wrong merge equally,
which the store does not: a wrong merge loses a finding, a missed one shows a
duplicate ([ADR 4](adr/0004-dedup-on-machine-signals-not-prose.md) accepts the duplicate). Read the two error counts, not only
the totals.

Keys `c1786bc817` (demo) and `b5a7933f32` (held-out); 17 archives (14 demo, 3
held-out); one pass, and the rule is deterministic, so it has no run-to-run
noise. 380 findings placed on a page by the key; left out: 14 identical text, 2 unmatched, 0
ambiguous, 23 known non-defect. The demo's pairs include the two unattended
runs, ci-run-1 and ci-run-2 (see [Unattended runs](#unattended-runs-scenescout-ci)):
547 of its 9,055 pairs have a finding from one of them, 141 of those "same".
Without them the demo had 8,508 pairs (1,972 same), accuracy 81.1%, Brier 0.189
(−0.06) and 1,604 missed merges; the held-out figures are unchanged.

| App | Pairs | Same / different | Decider | Accuracy | Brier (skill vs base rate) | ECE [equal-count buckets] | Wrong merges | Missed merges |
|---|---:|---|---|---:|---|---|---:|---:|
| Demo, all pairs | 9,055 | 2,113 / 6,942 | current rule | 80.8% | 0.192 (−0.07) | 0.192 [n=8,682 stated 0 actual 0.20; n=373 stated 1 actual 1.00] | 0 | 1,740 |
| Held-out, all pairs | 181 | 49 / 132 | current rule | 86.2% | 0.138 (0.30) | 0.138 [n=153 stated 0 actual 0.15; n=28 stated 1 actual 0.93] | 2 | 23 |
| Demo, sample | 100 | 21 / 79 | current rule | 81.0% | 0.190 (−0.15) | 0.190 [n=98 / n=2] | 0 | 19 |
| Held-out, sample | 100 | 30 / 70 | current rule | 86.0% | 0.140 (0.33) | 0.140 [n=82 / n=18] | 1 | 13 |
| Both samples | 200 | | model judge, efforts none and low | see [judge run 1](#judge-run-1-refused-parse-no-usable-comparison) and [run 2](#judge-run-2-the-judge-beats-the-rule-on-both-apps) | | | | |

The rule almost never merges wrongly and leaves most same-entry pairs apart.
On the demo its Brier is slightly worse than always stating the base rate
(skill −0.07): its 0/1 answers carry less than the base rate does, because it
says "different" to four in five of the pairs the key calls "same". For a 0/1
decider ECE equals Brier equals the error rate, so the two buckets are the
useful part: stated 0 is right 80% of the time on the demo.

**The model judge is measured, not used.** `npm run dedup-bench -- --judge
--efforts none,low` asks a model about each of the 200 sampled pairs (cap split
evenly between the apps) through the `scenescout ci` provider adapters, one
tool call per pair returning `same`/`different`/`unsure` and its confidence
in that verdict, from which `p_same` is derived (same at confidence c is c,
different is 1 − c; run 1 asked for `p_same` directly); unsure
answers are counted and left out of the figures, and a failed call falls back
to the rule and is counted as failed. It needs `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`: the Messages API has no effort `none`, so on Anthropic only
`low` runs. Cost is one call per pair per effort, a few hundred input tokens
each, printed at the end of a run. The `dedup-bench` workflow (dispatched by
hand) runs the judge with the repository's `OPENAI_API_KEY` secret and puts the
scorecard in its job summary and an artifact. The judge is not wired into the
store: it replaces the rule only if its Brier beats the rule's on these pairs,
at a pair count and on both apps, and until then the rule is the only thing
that dedups.

### Judge run 1: refused-parse, no usable comparison

One dispatch of the `dedup-bench` workflow on 2026-09-27, OpenAI `gpt-6-luna`
at efforts `none` and `low`, on the 200 sampled pairs. Keys `c1786bc817` (demo)
and `b5a7933f32` (held-out), unchanged; 22 archives (19 demo, 3 held-out), so
the pair set is larger than in the table above: 407 findings placed on a page
(left out: 15 identical text, 7 unmatched, 0 ambiguous, 25 known non-defect).
The rule rows below are from the same run and the same sample, the only
comparison the judge rows may be read against. One run per effort: no noise
floor is measured.

| App | Pairs | Same / different | Decider | Scored | Unsure | Failed | Accuracy | Brier (skill vs base rate) | ECE [equal-count buckets over p_same] | Wrong merges | Missed merges |
|---|---:|---|---|---:|---:|---:|---:|---|---|---:|---:|
| Demo, all pairs | 10,327 | 2,427 / 7,900 | current rule | 10,327 | 0 | 0 | 80.4% | 0.196 (−0.09) | 0.196 [n=9,925 stated 0 actual 0.20; n=402 stated 1 actual 1.00] | 0 | 2,025 |
| Held-out, all pairs | 213 | 61 / 152 | current rule | 213 | 0 | 0 | 85.9% | 0.141 (0.31) | 0.141 [n=178 stated 0 actual 0.16; n=35 stated 1 actual 0.94] | 2 | 28 |
| Demo, sample | 100 | 21 / 79 | current rule | 100 | 0 | 0 | 82.0% | 0.180 (−0.08) | 0.180 [n=97 stated 0 actual 0.19; n=3 stated 1 actual 1.00] | 0 | 18 |
| Held-out, sample | 100 | 32 / 68 | current rule | 100 | 0 | 0 | 86.0% | 0.140 (0.36) | 0.140 [n=82 stated 0 actual 0.17; n=18 stated 1 actual 1.00] | 0 | 14 |
| Demo, sample | 100 | 21 / 79 | judge, effort none | 39 (18 same) | 0 | 61 | 100.0% of 39 | 0.000 of 39 | 0.010 [n=8 stated 0.00 actual 0.00; n=12 stated 0.01 actual 0.00; n=19 stated 0.93 actual 0.95] | | |
| Held-out, sample | 100 | 32 / 68 | judge, effort none | 52 (31 same) | 0 | 48 | 100.0% of 52 | 0.000 of 52 | 0.005 [n=13 stated 0.00 actual 0.00; n=11 stated 0.27 actual 0.27; n=25 stated 0.99 actual 1.00; n=3 stated 1.00 actual 1.00] | | |
| Demo, sample | 100 | 21 / 79 | judge, effort low | 37 (19 same) | 0 | 63 | 100.0% of 37 | 0.000 of 37 | 0.011 [n=8 stated 0.00 actual 0.00; n=10 stated 0.01 actual 0.00; n=18 stated 0.98 actual 1.00; n=1 stated 1.00 actual 1.00] | | |
| Held-out, sample | 100 | 32 / 68 | judge, effort low | 50 (31 same) | 0 | 50 | 100.0% of 50 | 0.000 of 50 | 0.008 [n=16 stated 0.00 actual 0.00; n=10 stated 0.68 actual 0.70; n=22 stated 0.99 actual 1.00; n=2 stated 1.00 actual 1.00] | | |

**Most of the judge's answers could not be read, so its figures are not
comparable to the rule's.** Of 400 calls, 222 were refused by the parser, and
220 of those for one reason: the verdict `different` with `p_same` between
0.84 and 0.999 (the other two were tool arguments that were not valid JSON,
over 30,000 characters long). The judge's accuracy and Brier are therefore
over the 37 to 52 pairs per app whose answers were coherent, a subset the
judge selected itself. The subset leans towards "same" pairs (31 of 52 on the
held-out sample against 32 of 100 in the sample), because the refused answers
were all "different". A Brier of 0.000 on that subset says the coherent
answers were right and confident, not that the judge beats the rule on these
pairs: the rule's 0.140 and 0.180 are over all 100. The run also printed
identical token totals at both efforts (66,397 input, none cached, and 21,373
output). The accounting was checked against a stand-in API and counts each
effort apart; the likely reading is that neither effort produced reasoning
tokens, each usable answer cost the same few output tokens, and at each
effort one call ran to the 16,000-token output cap (the two replies whose
arguments were cut-off JSON): 16,000 + 199 × 27 = 21,373. That is inferred,
not shown; run 2 prints each call's output tokens. No cost is given for run 1.

**Decision: the judge is not wired in, and the rule stays.** The rule of
[#185](https://github.com/brunoboto96/SceneScout/pull/185) asks for the judge's
Brier to beat the rule's on these pairs, on both apps. This run has no Brier for
the judge on these pairs: over half of each sample is missing, and not at
random. This records a negative result for this configuration of the judge.
It does not show that a model judge cannot beat the rule.

**What the run suggested.** The refused answers look like `p_same` read as
confidence in the stated verdict, not the probability of "same". One bounded
edit, to the judge's tool contract only, is made for run 2: the judge states
the verdict and its confidence in it, `p_same` is derived from the two, a
confidence below 0.5 is still refused and counted as a contradiction, and each
pair's judgement, the rule's verdict, the key's label and the call's output
tokens are written to a per-pair file (ids only), so the judge and the rule
can be compared pair by pair.

### Judge run 2: the judge beats the rule on both apps

One dispatch of the `dedup-bench` workflow on 2026-09-27 after the contract
change above, same model, efforts, keys, archives and 200 sampled pairs as run
1, so the rule's rows in run 1's table are this run's rule rows too. Every
answer was usable: 0 unsure, 0 failed, 0 contradictions at either effort, so
the judge is scored on all 100 pairs per app, the same pairs as the rule.

| App | Decider | Scored | Unsure | Failed | Accuracy | Brier (skill vs base rate) | ECE [equal-count buckets over p_same] | Wrong merges | Missed merges |
|---|---|---:|---:|---:|---:|---|---|---:|---:|
| Demo, sample (21 / 79) | current rule | 100 | 0 | 0 | 82.0% | 0.180 (−0.08) | 0.180 [n=97 stated 0 actual 0.19; n=3 stated 1 actual 1.00] | 0 | 18 |
| Demo, sample | judge, effort none | 100 | 0 | 0 | 98.0% | 0.019 (0.88) | 0.024 [n=58 stated 0.01 actual 0.00; n=20 stated 0.03 actual 0.10; n=20 stated 0.82 actual 0.85; n=2 stated 1.00 actual 1.00] | 0 | 2 |
| Demo, sample | judge, effort low | 100 | 0 | 0 | 98.0% | 0.019 (0.88) | 0.025 [n=60 stated 0.01 actual 0.00; n=20 stated 0.04 actual 0.10; n=20 stated 0.91 actual 0.95] | 0 | 2 |
| Held-out, sample (32 / 68) | current rule | 100 | 0 | 0 | 86.0% | 0.140 (0.36) | 0.140 [n=82 stated 0 actual 0.17; n=18 stated 1 actual 1.00] | 0 | 14 |
| Held-out, sample | judge, effort none | 100 | 0 | 0 | 99.0% | 0.007 (0.97) | 0.012 [n=56 stated 0.01 actual 0.00; n=23 stated 0.45 actual 0.48; n=21 stated 0.99 actual 1.00] | 0 | 1 |
| Held-out, sample | judge, effort low | 100 | 0 | 0 | 99.0% | 0.010 (0.95) | 0.010 [n=52 stated 0.01 actual 0.00; n=20 stated 0.18 actual 0.20; n=25 stated 0.99 actual 1.00; n=3 stated 1.00 actual 1.00] | 0 | 1 |

**Pair by pair**, from the per-pair file: at each effort the judge is right
on 16 demo pairs and 13 held-out pairs where the rule is wrong, and wrong on
none where the rule is right. All 29 are missed merges the judge makes; the
judge makes no wrong merge. Its three errors are the same three pairs at
both efforts, each a "same" pair it calls different: two findings of
off-grid spacing (the key entry spans pages, see above), two of invalid input
accepted by the orders API, and two of a fine waived without confirmation on
the held-out app. No pair's verdict differs between effort none and low.

**Tokens.** 75,597 input (none cached) at each effort; 5,160 output at none
and 5,172 at low. Every call's output was 24 to 26 tokens at both efforts, so
effort low produced no more output than none: no reasoning tokens at either.
That fits run 1's reading: 199 answers at about 27 tokens (its `p_same`
values ran to three decimals) and one call per effort at the 16,000-token cap
give 21,373. Run 1 kept no per-call counts, so this is consistent, not proven.
No price is given; the per-call figure is what a cost estimate would use.

**Decision: the judge passes #185's rule.** Its Brier beats the rule's on
these pairs, at 100 pairs per app, on both apps and at both efforts (demo
0.019 against 0.180, held-out 0.007 and 0.010 against 0.140), and in the
paired comparison it never loses a pair the rule wins. Effort none is enough:
low changed no verdict. The limits: one run per effort, so no run-to-run
noise is measured; the pairs cluster by key entry, so 29 flips are fewer
independent facts than 29; the labels come from the key, not a person; and
the contract change was made after run 1, which covered both apps, so the
held-out pairs were seen once before this run (their failures shaped the
edit, not their labels).

**Wiring it in is a separate change.** The store's dedup runs in the MCP
server, which holds no model key, on every finding filed. A model judge
there means a provider call per candidate duplicate, a key, and finding text
sent to the provider. Where it belongs (the `scenescout ci` run, which already
has a model, or an opt-in setting for the store with the rule as the default
and the fallback) is a design decision for its own change. Until then the
rule still decides in the store.

**Wired in ([#229](https://github.com/brunoboto96/SceneScout/issues/229),
[ADR 17](adr/0017-a-model-judges-only-the-merges-the-rule-misses.md)).** The
store now asks the judge about a filing the rule keeps apart, against the open
findings on the same page (at most three calls per filing), and merges on a
"same"; the rule's merges are never put to it, because every pair the judge
won above was a merge the rule missed. `scenescout ci` judges by default with
the run's model at the lowest effort its API takes (`--dedup rule` turns it
off); the MCP server judges only when `SCENESCOUT_DEDUP=judge` or
`scout_attach {dedup: "judge"}` asks for it. Measured out of sample in
[judge run 3](#judge-run-3-out-of-sample-the-lead-holds).

**A literal in one title and the other's detail
([#318](https://github.com/brunoboto96/SceneScout/issues/318)).** When both
findings carry evidence, the quoted literal that bridges them must now be in
the other finding's title or evidence, not only in its detail. Re-scored on
2026-10-02 over the current archives (451 findings placed on a page): demo
12,299 pairs and held-out 331, every figure the same before and after (demo
accuracy 79.6%, Brier 0.204, 440 merges; held-out 85.8%, Brier 0.142, 66
merges). The archives keep no finding's detail, so the pairs cannot see this
rule either way; `memory-test` holds it with a contrastive pair. A variant
that also stopped a title literal matching the other's evidence lost 4
correct demo merges (440 to 436, no wrong merge avoided) and was not taken.

### Judge run 3: out of sample, the lead holds

The check #229 asked for: the judge against the rule on pairs from runs made
after the judge was wired in, none of whose findings either run 1 or run 2
saw. Fourteen `scenescout ci` runs were dispatched on 2026-10-03 with the
`ci-benchmark` workflow at main 498dbdf (3.18.0), gpt-6-luna at effort low,
default caps, dedup by the judge (the `ci` default): six of the demo
(`ci-dedup-demo-1` to `-6`) and eight of the held-out app (`ci-dedup-holdout-1`
to `-8`), more of the held-out app because it gives fewer pairs per run. Their
rows are in the [unattended table](#unattended-runs-scenescout-ci). The
`dedup-bench` workflow then judged every pair from those runs alone
(`--since 2026-10-03`, a new option that filters the archives before pairing,
so no pair joins a new finding to an old one) at effort none, the effort `ci`
uses. Keys `c1786bc817` and `b5a7933f32`, unchanged. 41 findings placed on a
page; left out: 4 identical text, 21 unmatched, 0 ambiguous, 12 known
non-defect. Every pair fits under the cap, so the sample is every pair.

| App | Pairs (same / different) | Decider | Accuracy [95% interval] | Brier [95% interval] | ECE [equal-count buckets over p_same] | Wrong merges | Missed merges |
|---|---|---|---|---|---|---:|---:|
| Demo | 82 (41 / 41) | current rule | 56.1% [46–66%] | 0.439 [0.341–0.537] (skill −0.76) | 0.439 [n=77 stated 0 actual 0.47; n=5 stated 1 actual 1.00] | 0 | 36 |
| Demo | 82 | judge, effort none | 93.9% [88–98%] | 0.055 [0.019–0.108] (skill 0.78) | 0.064 [n=38 stated 0.01 actual 0.00; n=41 stated 0.80 actual 0.93; n=3 stated 1.00 actual 1.00] | 0 | 5 |
| Held-out | 56 (28 / 28) | current rule | 82.1% [71–91%] | 0.179 [0.089–0.286] (skill 0.29) | 0.179 [n=38 stated 0 actual 0.26; n=18 stated 1 actual 1.00] | 0 | 10 |
| Held-out | 56 | judge, effort none | 100.0% [100–100%] | 0.000 [0.000–0.000] (skill 1.00) | 0.011 [n=28 stated 0.01 actual 0.00; n=24 stated 0.98 actual 1.00; n=4 stated 1.00 actual 1.00] | 0 | 0 |

The intervals are a bootstrap over pairs (4,000 resamples), computed from
the per-pair file; the judge's ECE interval under four equal-count buckets
is 0.024–0.117 on the demo and 0.007–0.012 held-out. **Read them as too
narrow.** The pairs cluster by the two key entries they join: the demo's 82
come from 10 such clusters, the largest 18 pairs, and the held-out app's 56
from 4, the largest 28. Resampling whole clusters instead widens the
rule-minus-judge Brier difference to 0.11–0.73 on the demo, still above
zero, and to 0.00–0.71 held-out, which touches zero: four clusters are too
few to rule out that the held-out gap is one or two entries' doing. Held-out
Brier is 0.000 to three places, not exactly 0: the judge stated 0.01 or less
on every "different" pair and 0.98 or more on every "same".

**Pair by pair**, from the per-pair file: the judge is right on 31 demo pairs
and 10 held-out pairs where the rule is wrong, all of them merges the rule
missed, and wrong on none where the rule is right. Neither decider merged
wrongly. The judge's five errors are all on the demo and all one key entry:
pairs of findings about the low-contrast hint on the new-order form that it
calls different (p_same 0.02 to 0.12), which looks like run 2's off-grid
spacing case, a key entry broader than one finding's wording.

**Against the in-sample figures.** The judge's demo Brier is 0.055 here
against 0.019 in run 2, and its accuracy 93.9% against 98.0%; held-out it is
0.000 against 0.007. The rule did worse here than in sample on the demo
(0.439 against 0.180), because these pairs are half "same" where run 2's
sample was a fifth: the rule's errors are nearly all missed merges, so a
pair set with more "same" pairs costs it more. The comparison that matters
is within this table, on the same pairs: the judge's lead holds on both apps.

**Limits.** One judge pass, so no run-to-run noise is measured (in run 2 the
judge changed no verdict between efforts). 21 findings are unmatched (the
key does not recognise them) and are in no pair; they are listed by
`npm run bench -- --all` as unlabelled and await a person's judgement before
they go in a key. Within-run pairs (8 demo, 4 held-out) passed through the
store's judge already, which kept them apart; over cross-run pairs alone
the figures move little (demo judge 0.048 against rule 0.459, 74 pairs;
held-out 0.000 against 0.192, 52 pairs). The labels come from the key, not a person.

**Decision: the judge stays the default in `scenescout ci`.** Its Brier beats
the rule's on new pairs on both apps, it never loses a pair the rule wins,
and it made no wrong merge. The held-out gain rests on four clusters of
pairs, so it is a direction there, not a measured size. Cost in these runs:
the store's judge made 0 to 7 calls per run (40 in all, about 360 input and
26 output tokens each), inside each run's usage; scoring the 138 pairs cost
49,514 input and 3,562 output tokens, about $0.007 at the table price. The
fourteen runs together cost about $0.18 by their own estimates.

## Rejected and not-yet-tried

Edits considered and not kept, so they are not retried blind:

- **A seeded exploration schedule as a way to find more across runs (issue
  418).** Rejected twice on the demo app. At one loop and 40 turns, pass@3
  rose within the noise and pass^3 fell. At two lanes and 80 turns, with the
  exclusion across runs applied, pass@3 and pass^3 were both unchanged, and
  both arms found the same seven defects. On an app small enough for the
  default budget to visit every route, the starting order changes nothing that
  is scored. It could still matter on an app with more routes than the budget
  covers, which neither benchmark app has.
- **Continuing from an earlier run's record (`--from-run`, issue 418).**
  Rejected as a way to find more across runs on the demo app at the two-lane
  default: pass@3 rose by one (the approve endpoint accepting a clerk) and
  pass^3 fell from 4 to 1. A run told to work the controls the last one left
  does so and stops finding the page-load defects every fresh run finds in
  passing. That gate (pass^3) was the wrong one for a mode built not to repeat
  coverage, and the first counts left out the fresh run each chain started
  from; counted as unions of three runs, the chain found 8 against 7 at the
  default budget and 4 against 4 at a budget cut to 18 turns on one lane. With
  depth ordering (a page is worked through only when nothing is left), one
  chain found 3 against 4. Continued runs reach more pages and file less.
  Worth trying instead:
  continue only the routes with forms or options left, after the run's own
  first pass, rather than in place of it.
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
  runs that used the same words. The rule stays as it was, for runs archived
  without lane routes. The follow-up, deciding by each lane's archived routes
  and the matched entry's pages, is done: see
  [Ownership by route](#ownership-by-route-task-29).
