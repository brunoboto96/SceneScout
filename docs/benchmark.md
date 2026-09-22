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
| **Lane calibration** | Whether a lane's verdict was right *according to the key*, bucketed by the confidence it stated, with an expected calibration error. A "not a defect" whose reason is that the thing belongs to another lane is not scored: it is a verdict about ownership, not about whether the thing is broken. |

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
- **The key was written from runs 0 and 1.** 78 of its 108 examples are
  phrasings those two runs used, so their zero ambiguous and zero unlabelled
  findings are true by construction. Run 2 is the first run the key did not
  see. The rest of the examples are rewordings a reviewer wrote to break it.
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
key `a4b1bb6ce1`. The archived runs are in [`bench/runs/`](../bench/runs/).

| Run | Date | What changed | Recall | Precision (labelled) | All findings | Unlabelled | False pos. | Judged, not filed | Lane calibration | Cost | Kept? |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| 0 | 2026-09-22 | Baseline, 3.4.0, briefs as written on the day | 11/13 | 16/21 (76%) | 21 | 0 | 5 | 1 | 26/31 (84%), ECE 0.05 | ~725k tokens, 241 tool calls, longest lane 3m38s | — |
| 1 | 2026-09-22 | **Lane briefs only** (engine unchanged) — see below | 12/13 | 28/28 (100%) | 28 | 0 | 0 | 0 | 34/35 (97%), ECE 0.12 | ~698k tokens, 283 tool calls, longest lane 5m09s | Yes, into the skill |

**Read the calibration column as two numbers, not one.** Run 1's verdicts were
right more often (97% against 84%), and its expected calibration error is
*worse*, because the lanes were right more often than they said: every verdict
stated at 0.6–0.8 was right. Lower ECE is not the goal on its own; a lane that
is right and says so less loudly than it could is underconfident, not wrong.
The first version of this scorer counted the five "belongs to another lane"
dismissals as wrong verdicts, which gave ECE 0.09 → 0.04 and read as an
improvement; that one choice was enough to reverse the comparison.

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
- **A known non-defect that wins every match it takes part in.** Rejected
  after review: realistic rewordings of three planted defects — a delete that
  navigates away "anyway", a dead end that "says coming soon", an XSS "escaped
  on the detail page but executed on the list" — were scored as false
  positives. A non-defect now wins only over the defects it names in
  `overrides`.
