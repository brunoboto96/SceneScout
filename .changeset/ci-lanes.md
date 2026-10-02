---
"scenescout": minor
---

`scenescout ci --lanes <n>` (and the ci action's `lanes` input) splits an unattended run between up to 8 model loops that explore at once, each in its own browser session and its own modules of the app. A crawl plans the split with no model call, the lanes share the run's turn, token and time caps rather than getting them each, and their findings fold into one report; the summary and `ci.json` list each lane. The default stays one loop.
