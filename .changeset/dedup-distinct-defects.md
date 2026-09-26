---
"scenescout": patch
---

Two different defects on one element now stay two findings. Finding dedup compares what is wrong as well as where: identical evidence, a shared quoted label or a reworded title merges two findings only when they are one kind of defect (the same category, or neighbouring categories of one family such as `page-error` and `console-error`). `visual`, `ux-polish`, `a11y` and `missing-testid` are each their own kind, so a link clipped out of view and the same link styled like body text are no longer merged. When `scout_finding` merges a filing it now names the category of the finding it joined and which categories the filing could have merged with.
