---
"scenescout": patch
---

Make the design audit agree with the page it measures:

- A filter panel is no longer judged as a form. With no `<form>` on the page, the form-burden lines ("NONE marked required", "no obvious submit") count only the fields a user types into, and fields in a panel that names itself a filter or facet (its test id, id, label or legend) are left out wherever they are. Six text fields with no `<form>` and no submit are still flagged.
- The shadow census counts the layers a box-shadow draws. Empty ring layers (no offset, blur or spread) and transparent layers are dropped, so utility-CSS rings are no longer counted as elevations, and each example shows the layer that sets it apart instead of a truncated value.
- Tinted grays (a slate, a warm stone) are counted as grays: any colour with no hue family is one. Grays within a few units of each other count as one step of the scale.
- Elements are named in audit lines by their accessible name, computed as the snapshot computes it, so an icon button with `aria-label="Dismiss"` reads as "Dismiss" rather than "(no text)". The focus-indicator line names tab stops the same way.
- A new NAMES section lists controls with no accessible name and fields labelled only by their placeholder, and both now lower the a11y subscore, which before measured contrast, focus visibility and target size only. Page scores on pages with such controls go down.
