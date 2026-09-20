---
"scenescout": minor
---

Parallel lanes hand their results back as one typed lane report, not prose. A new `scout_lane_report` tool serves both halves: without a reply it returns the paragraph to put in a lane's prompt (verdict, severity and category from closed sets, a calibrated confidence per decision, a bounded evidence signature, routes covered, what blocked the lane), and with one it parses what the lane handed back and returns the one-line fold or the reason the reply was refused. The instruction is generated from the same constants the parser checks and states every limit the parser enforces. The finding categories now live in one list shared by `scout_finding`, the lane report and the skill text. The skill's parallel-agents section tells the planner to use the tool and to run lanes at medium effort, the pick from a benchmark under `scripts/bench/` that measured both reply shapes at every effort level the CLI accepts.
