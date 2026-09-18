---
"scenescout": minor
---

The geometry oracle now reports a pinned control that sits underneath other pinned chrome, for example a sticky Save row covered by a fixed bar. Box overlap cannot tell which of two pinned elements is on top, so that pair was skipped; the new check hit-tests the control's centre in the page. It stays quiet for controls inside a scrollable pane, for dialogs, and for overlays covering half the viewport.
