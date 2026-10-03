---
"scenescout": patch
---

A link or button with no text is now named by a descendant's `aria-label` (an icon element inside the link) and by an image's `title` when its alt text is empty, as the browser names it, so `unnamed-control` no longer reports those controls. Coverage recorded for them under their earlier keys carries over.
