---
"scenescout": minor
---

`scenescout ci` and its GitHub Action now default to two lanes sharing 80 model turns and 3,000,000 tokens (from one loop, 40 turns and 1,500,000 tokens). On the benchmark's demo app the new defaults found 5 to 7 of 13 planted defects in three runs, against 2 to 4 for the old ones, and 4 to 5 of 10 on the held-out app, at about $0.03 a run on `gpt-6-luna` instead of about $0.011. Without `--lanes`, a run with `--show` or with `--max-turns 1` runs as one loop. `--lanes 1 --max-turns 40 --max-tokens 1500000` restores the old behaviour.
