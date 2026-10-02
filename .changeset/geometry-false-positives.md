---
"scenescout": patch
---

Stop the layout checks reporting intended layering as defects, while the defective form of each layout is still reported:

- A skip link parked off the page until it takes focus (a link to a place in the page, or any control a `:focus` rule moves) is no longer "outside the reachable page area", and once focused it is not reported as covering the header under it. A link parked off the page with nothing to bring it back, or a hash-route link, still is.
- A control inside a list that scrolls within an overflow-hidden card is no longer UNREACHABLE, nor is a slide of a viewer that a control naming it in `aria-controls`, or a next, previous or numbered control beside a row of slides, reveals. The same content with no scroller and no pager still is, and so is a column a card clips beside a "Next page" that pages rows.
- The overlap check skips a decorative overlay with `pointer-events: none` and a clear button or icon lying in the padding a text field reserves for it. A button over the field's text, an overlay that takes clicks, or a disabled control drawn over another still overlaps.
- The small-target rule measures a native input together with the label that wraps or touches it, and a visually hidden input as the label or drop zone that operates it, and applies the WCAG 2.5.8 spacing exception: a small target with nothing else inside its 24px circle passes.
