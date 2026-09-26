---
"scenescout": patch
---

A text field whose only label is its placeholder is no longer treated as labelled. The snapshot still shows the placeholder as the field's name and now flags it `no label: placeholder only`, the crawl counts it as unnamed, and `scenescout check` files it under a new medium rule, `placeholder-only-label`. A field named by nothing but its `name` attribute or type is flagged `no label` and filed as `unnamed-control`. A `<label>` (by `for` or wrapping the field), `aria-label`, `aria-labelledby` or `title` counts as a label. Element keys in project memory are unchanged.
