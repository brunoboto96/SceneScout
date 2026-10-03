---
"scenescout": minor
---

Saved flows have a `repeat` step: run a few click, type, select or press steps until an `expect-text`, `expect-element` or `expect-url` step holds, at most `max` times. It is for gates a fixed script cannot walk, such as paging through a document until its Continue button is enabled. The condition is checked first, so a page already in that state runs nothing, and a failure names what never held and how many rounds were tried.
