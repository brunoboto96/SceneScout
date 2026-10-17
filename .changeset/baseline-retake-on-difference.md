---
"scenescout": patch
---

Visual baselines: a picture that differs from its baseline is now taken once more from a fresh page load, and only the second picture is judged. Chromium on a slow machine now and then draws a page's text a pixel off for the whole of one load; that picture holds still, so it was kept, and an unchanged target was reported as changed (or rewritten by `--baseline update`). A real change shows on both loads and is reported as before, from the second picture. The threshold is unchanged. When the second picture matches, the target's line in the report says how far the first was off.
