# The lane-report benchmark

When several agents explore an app in parallel, each one hands what it found back to the agent that planned the split. This benchmark measures the cost of that hand-back in two shapes: a prose report the planner has to read, and the typed lane report served by `scout_lane_report` and defined in the engine's lane module, which the planner parses. The idea is borrowed from decision-only models: closed sets, a calibrated confidence on every answer, and a schema at the boundary instead of a reader.

Every lane gets the same input, the observation log in `lane-observations.md`, and the same judging task; only the reply shape differs. No tools are available, so what is measured is judging plus replying, not browsing.

## Running it

```bash
N=3 EFFORTS="low medium high xhigh max" OUT=/tmp/lane-runs scripts/bench/run-headless.sh   # needs a signed-in `claude`
npx tsx scripts/bench/summarize-headless.ts /tmp/lane-runs
scripts/bench/watch-lane.sh schema medium    # one lane, streamed to the terminal (needs jq)
```

`fold-lanes.ts` does the planner's half for replies saved as files, which is how the in-session rounds below were measured. The two `prompt-*.md` files are the prompts as they stood when the runs below were made; the instruction a real planner sends comes from `scout_lane_report` and has since gained the caps listed under "What went wrong on the way".

## Results

Sonnet 5 through headless Claude Code, `--tools ""`, three runs per cell, every effort level the CLI accepts plus one cell at the environment's default. Seconds and tokens are Claude Code's own figures for the run. Agreement is against the majority answer per observation across the 37 runs the summariser could read: whether each run reached the same verdict (defect, not a defect, unsure), and for the 14 majority defects the same severity and the same category. "Highs" is how many observations the run rated high; the majority rates four. A prose reply is read by the two layouts lanes have been seen to use; a reply in another layout is counted as unreadable, not as wrong.

| condition | readable | seconds | output tokens | thinking | verdict agrees | severity agrees | category agrees | highs | parsed first time |
|---|---|---|---|---|---|---|---|---|---|
| prose @ low | 2/3 | 22.5 | 2164 | 7 | 18/18 | 9.5/14 | 13.0/14 | 5.5 | needs a model pass |
| prose @ medium | 3/3 | 35.0 | 3384 | 1895 | 18/18 | 12.3/14 | 14/14 | 5.7 | needs a model pass |
| prose @ high | 3/3 | 51.3 | 5099 | 3327 | 18/18 | 11.0/14 | 13.7/14 | 3.7 | needs a model pass |
| prose @ xhigh | 3/3 | 72.6 | 7285 | 5221 | 18/18 | 12.7/14 | 14/14 | 4.7 | needs a model pass |
| prose @ max | 2/3 | 286.3 | 26206 | 23843 | 18/18 | 11.5/14 | 14/14 | 3.5 | needs a model pass |
| schema @ low | 3/3 | 12.1 | 1405 | 0 | 18/18 | 11.7/14 | 11.0/14 | 7.0 | 3/3 |
| **schema @ medium** | **3/3** | **23.6** | **2551** | **1140** | **18/18** | **12.3/14** | **13.7/14** | **4.0** | **3/3** |
| schema @ high | 3/3 | 30.6 | 3214 | 1689 | 18/18 | 12.0/14 | 13.0/14 | 5.0 | 3/3 |
| schema @ xhigh | 3/3 | 61.7 | 7048 | 5233 | 18/18 | 10.3/14 | 14/14 | 3.7 | 3/3 |
| schema @ max | 3/3 | 206.0 | 21046 | 19191 | 18/18 | 11.0/14 | 14/14 | 3.0 | 3/3 |

The default-effort cell (three prose, three typed; thinking on, in the range of high) is in the majority baseline but not in the table; its numbers sit between the medium and high rows.

**The pick is the typed reply at medium effort.** It agrees with the majority as well as any row, parses every time, and costs 24 s and 2.5k output tokens against 31 s at high and 62 s at xhigh. Low effort is twice as fast again but rates seven observations high where the majority rates four, and gets three categories wrong. Max effort is not a serious option: over three minutes per lane, 20k thinking tokens, and no better agreement than medium.

## What it says

- **Verdicts do not depend on the shape or the effort.** Every reply that could be read agreed on which observations are defects. The disagreement is in severity, two or three of fourteen in every condition, and it is the same in prose and typed replies at the same effort.
- **The reply shape is worth 30 to 46 % of the lane's time at the three efforts anyone would run** (low, medium, high), because a typed reply is shorter and the model deliberates less about how to say it; at xhigh it is 15 %.
- **Effort is worth more than shape.** Turning thinking off takes prose from 51 s to 22 s and the typed reply from 31 s to 12 s. Typed at low effort against prose at high effort, the pairing closest to a decision-only model against a chat model, is 4.2× faster with 3.6× fewer output tokens, but it pays in calibration (see the highs column), which is why medium is the pick and not low.
- **The planner's saving is the larger one and is not in the table.** A prose reply costs the planner a reading of ~1,200 tokens per lane and a re-typing of every verdict; the typed reply is folded by a function. Of the 18 prose replies, four carried values no schema would take (a severity of "Low-Medium", a verdict of "Not applicable", a confidence of "High") and two, from the same prompt as the rest, chose a layout with no verdict column at all. In prose those go into the report as written.
- **Compaction is not worth it.** A variant of the typed prompt asking for one line with no whitespace came back in 12.3 s with 1.3k output tokens, but the reply was only 3 % smaller: the saving came from every run skipping thinking, and agreement slid with it (severity 11.3/14, category 12.7/14, 5.7 highs). Three runs cannot prove the wording caused that, but the effect is in the wrong direction and the byte saving is nil, so the plain instruction stays.

## What went wrong on the way

Every one of these is now a rule in the instruction and a case in `lane-test`.

- **A cap the lane is not told refuses good replies.** Three of the first ten real replies were lost this way: an evidence signature over 160 characters, an observation id over 40, a blocked line over 200. The instruction now states every cap the parser enforces, the observation cap is 64, and the test asserts each cap is both stated and enforced.
- **The category list was a copy, and the copy was short.** The first version of the lane schema listed 12 categories where `scout_finding` accepts 17. A low-effort lane that answered `permission-leak` for the approve-endpoint observation was refused, and an earlier draft of this page called that an invented category. It was the right answer; the schema's list was wrong. The categories now live in one constant shared by the finding tool, the lane schema and the skill text, and the low-effort row above is recomputed with it (3/3 parsed).
- **The boundary has to cover the hand-back, not just the message.** In the first in-session round two of three typed lanes wrote the object and then handed back a prose summary of it. Saying "the object is your final report" fixed that in every later run, and the instruction says it.

## One real run

Four Sonnet lanes through the Agent tool, each driving its own browser against the demo app in read-only mode, each handing back the typed report; a planner that opened no browser of its own until the report.

| lane | tool calls | seconds | hand-back tokens | parsed on arrival |
|---|---|---|---|---|
| orders | 37 | 216 | ~550 | refused: observation id over the cap |
| reports | 34 | 195 | ~340 | yes |
| auditor | 39 | 250 | ~340 | yes |
| manager | 48 | 414 | ~400 | refused: blocked_by over the cap |

Launch to last hand-back was 7 min 39 s, and the planner folded the four reports in under 3 ms; the report came out with 16 findings across 12 of 12 routes. Asking the two refused lanes once for the corrected object took 45 s for both in parallel, with no browser reopened. The four hand-backs together were about 1,600 tokens; four prose reports would have been about 5,000 and would have needed reading.

The manager lane came back `partial` with a one-line `blocked_by`: the read-only write policy refused the Manager card on the sign-in page because its description mentions rejecting orders. That is a false positive in the destructive-label matcher, noted in the pull request that added this benchmark; the typed status is how the planner learned it without reading a paragraph.

## What it does not say

The lane's time here is judging and replying. In a real run the lane also drives a browser for minutes, and that part does not change with the reply shape. The gain is at the boundary: a smaller reply, a fold that costs nothing, and a refusal instead of a wrong value in the report.
