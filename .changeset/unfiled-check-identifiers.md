---
"scenescout": patch
---

The lane-report fold's check for defects judged but never filed now recognises a filed finding when the lane reworded its evidence, matching on the identifiers that survive rewording — test ids, API paths, contrast ratios — and on overall wording. Replayed against three archived benchmark runs it raised 4 flags where it had raised 39, and still named every defect that was genuinely left unfiled. One shared test id alone is not enough, so a missed defect on the same button as a filed one is still named.
