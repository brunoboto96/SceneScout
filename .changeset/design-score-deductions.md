---
"scenescout": minor
---

The design audit now reports sibling cards drawn edge to edge with no gap between them (a border, a fill or a shadow, 0 to 2px apart, with a rounded corner where they meet), naming the parent container, and `scenescout check` files them as `touching-containers` (low). A page's score is now built from named deductions and the audit lists the three largest beside it (`why: -16 touching containers ×2 · -6 6 button heights · -5 11 grays`). A measured defect (a ⚠ line) costs its full points and a suggestion (a → line) half of them, and craft and consistency now cost points: each button height beyond three, button radius beyond two, shadow style beyond three and gray beyond six. Scores spread further as a result: a page with several visible defects lands below 80 instead of in the 90s, while well-made pages stay around 80 or above. Scores kept from earlier runs are on the old scale; re-audit a page before comparing it with one.
