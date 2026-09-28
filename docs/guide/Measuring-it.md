# Measuring it

An exploratory run is driven by a model, so two runs of the same app never find exactly the same things. This page is about how much to trust a run, and how SceneScout itself is measured so that a change to it is known to help rather than assumed to.

## Inside every report

Three sections of the report are there to calibrate your trust in the rest:

- **The gap ledger** lists what was not done: routes never visited, visited but never exercised, never design-audited, forms never submitted, a single role where permissions were not compared. A short findings list with a long ledger is a run that stopped early, not an app that is fine.
- **The level's contract** is enforced by `scout_report`. A `minimal` report discloses its gaps; an `extensive` one cannot be written while any gap remains. A report forced past its contract says so and still prints its gaps.
- **How well the lanes judged**, on a parallel run. Each lane states a confidence for every verdict it hands back. The report joins those verdicts to what the project filed and prints, per confidence bucket, how often the lane was right, with an expected calibration error. It measures agreement with the project's own bar over its history, not truth about the app, and it says what it could not join. Verdicts re-tested later with `scout_verify` are reported beside it, as the half that is about the app ([ADR 10](../adr/0010-a-confidence-is-checked-not-trusted.md)).

For a gate you can trust run to run, use `scenescout check`, which has no model in it: the same app gets the same verdict.

## The benchmark

The repository measures SceneScout against apps whose defects are known. This matters to you as a user in two ways: it is the evidence behind claims about what a run finds, and it is how you can measure a change of your own (to the skill, a lane brief, a model or effort setting) before relying on it.

### The demo app and its answer key

The [demo app](../../demo-app/README.md) has fourteen planted defects. Its [answer key](../../demo-app/answer-key.json) lists them as data: each entry has regular expressions tried against a finding's evidence and title, the severity the key's author judged, examples it must match and counter-examples it must not. Besides planted defects the key holds real defects runs found that nobody planted (`alsoReal`), known non-defects that runs have reported (with the reason they are not defects), and *contextual* entries: observations that are defects only under a convention, such as a 4px spacing scale.

### Running it

From a clone of the repository:

```bash
npm run demo:serve                                    # restart before each run: created records stay in memory
# run SceneScout against http://127.0.0.1:4173 with a fresh project directory, for example "$RUNNER_TEMP/bench/run-12"
npm run bench -- "$RUNNER_TEMP/bench/run-12"                        # score it (--level medium by default)
npm run bench -- --archive "$RUNNER_TEMP/bench/run-12" --run run-12 --note "what changed"
npm run bench -- --all                                # re-score every archived run against the current key
```

Use a fresh project directory for every run. A project's memory accumulates findings across runs, and scoring an accumulated one credits the run with what an earlier run found. Archive every run you intend to compare: when the key changes, `--all` re-scores old runs against the new key, and two scorecards from different keys are not comparable (each prints its key's hash).

### Reading a scorecard

| Number | What it means |
|---|---|
| **Recall** | Planted defects found and filed, out of those the key expects at the run's level. A defect only a fuzzing pass reaches is not a miss at `medium` |
| **Precision** | Findings matching a planted or also-real defect, out of every finding the key can label. Unlabelled findings are counted beside it, with the bounds: precision if every one were wrong, and if every one were right |
| **Judged, never filed** | A lane called something a defect in its report, and nobody filed it, so it never reached the report |
| **False positives** | Findings matching a known non-defect, with the reason |
| **Set aside** | Findings matching a contextual entry, or filed as worth a look. They are in neither recall nor precision |
| **Severity** | Each filed defect's severity against the key's |
| **Lane calibration** | Whether each lane's verdict was right according to the key, bucketed by stated confidence, with an expected calibration error (ECE) and a Brier score |

Brier is the number to compare between runs: it is the mean squared gap between stated confidence and being right, so it rewards both being right and saying so. ECE says which way a lane is off: a lane right more often than it claimed is underconfident, which raises ECE without being worse.

What a scorecard does not tell you:

- **One small app.** A skill tuned hard against it learns that app. The held-out app, below, is the check.
- **One run per configuration.** Runs are not deterministic, so a change of one finding between two runs can be noise. Repeat before acting on a small difference.
- **The key only knows what it has been told.** An unlabelled finding is not wrong; it needs a person to judge it, after which it belongs in the key.
- **A negated claim still matches.** "Export works, no error" is credited as the export defect: the key recognises what a finding is about, not whether it says the thing is broken.

### The held-out app

The [held-out app](../../holdout-app/) is a second small app, a library loans desk, with thirteen planted defects of the same kinds as the demo's but none of its particular bugs, and its own answer key. It answers one question the demo cannot: does what was learned on the demo generalise? A change that lifts the demo's recall and leaves the held-out app's flat taught the engine the demo.

```bash
npm run holdout:serve                                 # http://127.0.0.1:4180
npm run bench -- "$RUNNER_TEMP/bench/holdout-4" --app holdout
```

The rules that keep it held out: nothing is tuned against it; nobody writing lane briefs for it reads its key, its server or the spoilers in its README; nothing it serves names a defect (a test enforces that); and its planted defects stay planted.

### Scoring your own app

`npm run bench` accepts `--key <file>` for a key no benchmark app ships. A team can keep a staging build with known defects and a key for it in the same schema, then score runs of their own configuration against it. The same cautions apply: one app, few runs, and a key that knows only what it was told.

[The benchmark results](../benchmark.md#results) record every measured run of SceneScout, including the changes that did not help, and [its method](../benchmark.md) goes further into how the key decides what a piece of text is.

## Measuring unattended runs

`scenescout ci` writes `ci.json` with `stop` (what ended the run: `done`, `turns`, `tokens`, `time`, `provider-error` or `could-not-start`), `contractMet`, `usage` (turns, tokens, cached tokens, seconds and an estimated cost), `counts` and `findings`. Comparing those across runs of the same app, with the same caps, is the cheapest way to tell whether a model or effort change bought more findings or only more tokens. [Unattended runs](../benchmark.md#unattended-runs-scenescout-ci) in the benchmark log records how the repository's own runs compared.
