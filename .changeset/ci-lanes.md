---
"scenescout": minor
---

`scenescout ci --lanes <n>` (and the ci action's `lanes` input) splits an unattended run between up to 8 model loops that explore at once, each in its own browser session and its own modules of the app. A crawl plans the split with no model call, the lanes share the run's turn, token and time caps rather than getting them each, and their findings fold into one report; the summary and `ci.json` list each lane. The default stays one loop: at the default caps, four lanes found no more than one loop on the benchmark's demo app, so raise `--max-turns` and `--max-tokens` with `--lanes`; `--lanes 4 --max-turns 160 --max-tokens 6000000` found the most, at about 2.3 times one loop's cost.
