---
"scenescout": patch
---

The snapshot names a link or button whose only content is an image by that image: an `<img>`'s alt text, or an `<svg>`'s or `role="img"` element's aria-label or `<title>`, skipping anything under `aria-hidden="true"`. `<a href="/"><img alt="Home"></a>` is now listed as `link "Home"` rather than `link ""`, so the crawl, `scenescout check` and the a11y counts no longer report it as unnamed, and the read-only policy now judges an image button by the name it is announced with. Text still comes first: a control with both text and an image is named by its text, as before. The design audit reads this same name, so the audit and the snapshot use one rule.

The name is half of a control's coverage key, so such a control gets a new key (`button "Search"` instead of `button ""`), and two unnamed image buttons that shared one key now have one each. Memory written before this change carries over: each snapshot records the key a control had under the earlier rule, and coverage reads older states through it, so what was exercised stays exercised and the earlier key is not left as a gap. On a route this run does not reach, the earlier keys stay as they are until a snapshot there lists the controls under their new names.
