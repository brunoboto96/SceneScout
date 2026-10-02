---
"scenescout": minor
---

Finding dedup can ask a model. When the dedup rule keeps a newly filed finding apart from everything recorded, a model judge is asked whether it is the same defect as one of the open findings on the same page (the three most alike, at most), and a "same" merges it; the merged filing's title, category, severity and evidence are kept under the finding and shown in the report with the judge's probability. Any failure, unsure answer or slow call leaves the rule's decision and is logged once per kind; three failed calls in a row switch the judge off for the run.

`scenescout ci` judges by default with the run's model at the lowest effort its API takes, sending each asked pair's titles, categories and evidence, and the page's path; the calls count in the run's usage, and `--dedup rule` (or the action's `dedup` input) turns it off. The MCP server judges only when `SCENESCOUT_DEDUP=judge` or `scout_attach {dedup: "judge"}` asks for it, with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in its environment (`SCENESCOUT_DEDUP_PROVIDER` picks one when both are set).
