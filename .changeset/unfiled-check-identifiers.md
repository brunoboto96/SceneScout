---
"scenescout": patch
---

The lane-report fold's check for defects judged but never filed now recognises a filed finding when the lane reworded its evidence, matching on the identifiers that survive rewording — test ids and contrast ratios, two of them in common — or on near-identical wording. Replayed against three archived benchmark runs it raised 6 flags where it had raised 39, and still named every defect that was genuinely left unfiled. One shared test id is never enough, and API paths are not identifiers, so a missed defect on the same button or endpoint as a filed one is still named.
