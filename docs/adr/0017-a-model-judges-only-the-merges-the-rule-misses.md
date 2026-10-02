# 17. A model judges only the merges the dedup rule misses, and only where it is asked for

Status: accepted

## Context

The store's dedup rule ([ADR 4](0004-dedup-on-machine-signals-not-prose.md))
merges two findings only on a machine signal: the same evidence, the same
failing request, a quoted message, or titles sharing at least half their
words. It almost never merges two different defects, and it misses many
merges: one defect described in other words stays two findings. On the answer
keys' labelled pairs it left
18 of 21 same-defect pairs apart on the demo sample and 14 of 32 on the
held-out sample ([docs/benchmark.md](../benchmark.md#judge-run-2-the-judge-beats-the-rule-on-both-apps)).

A model asked "same defect or not" through one tool call scored far better on
the same pairs, at effort `none`: Brier 0.019 against the rule's 0.180 on the
demo, and 0.007 (0.010 at effort `low`) against 0.140 on the held-out app.
Every pair it got right and the rule got wrong was a merge the rule missed; it
made no wrong merge. A model in the dedup path still costs something the rule does not: a
provider call per candidate pair, a key, the findings' text sent to a provider,
time inside `scout_finding`, and a new way to fail.

## Decision

- **The rule decides first.** The judge is asked only about a filing the rule
  keeps apart from everything recorded, and only against the open findings on
  the same page, the most alike title first: at most three calls, 15 seconds
  each and 40 seconds for the filing, which stays under `scout_finding`'s
  watchdog. "Same" merges; anything else (different, unsure, a contradiction, a
  failed or slow call) leaves the rule's decision. So the judge only adds
  merges, the direction it was measured to gain in, and never splits what the
  rule joined, which the rule would join again at the next load.
- **A merge the model makes is recorded, not silent.** The filing's title,
  category, severity and evidence are kept on the finding it joined
  (`judgedMerges`, with the judge's probability; the ten most recent), and the
  report shows them there, so a wrong merge can be seen and the filing refiled
  as its own defect: ADR 4's concern, a merge that leaves no trace, does not
  arise for the model's merges.
- **On by default only where a model already is.** `scenescout ci` sends pages
  to a model and holds a key, so it judges by default, with the run's model at
  the lowest effort its API takes; `--dedup rule` turns it off. The server asks
  for each call over its MCP connection (a sampling request, only to a client
  that declares it answers the judge), and the run makes the call, so the
  server's process still never holds the key
  ([ADR 14](0014-an-unattended-run-reports-and-never-gates.md)).
- **Off by default everywhere else.** An agent's run dedups by the rule unless
  `SCENESCOUT_DEDUP=judge` or `scout_attach {dedup: "judge"}` asks for the
  judge, which then needs a key in the server's environment. An agent's run
  sends nothing to a provider the user did not choose.
- **A judge that fails is the rule.** Each kind of fall-back is logged once,
  and three failed calls in a row switch the judge off for the rest of the run.

## Consequences

A CI run reports one entry where the rule alone would often have reported two,
for a few hundred input tokens and about 25 output tokens per pair asked about,
counted in the run's usage and its token cap. A filing can wait up to 40
seconds for the judge. The model can merge two different defects; when it does,
what was filed shows under the finding rather than vanishing (its detail is
not kept). The judge was measured with one model at one provider; with any
other it is unmeasured, and the measurement on pairs from runs made after this
change is still to be taken.
A server that is asked for the judge outside CI holds a model key.

## Failure direction

Where the model cannot answer, ADR 4's direction stands: a visible duplicate
over a silent merge. Where it answers "same", its merge is taken and the
filing recorded on the finding, so a wrong one costs a reader a moment to spot
and a refiling to undo.
