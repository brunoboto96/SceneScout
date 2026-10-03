---
"scenescout": patch
---

A page that locks scrolling behind a modal opened inside a full-viewport frame is no longer reported as a leaked scroll lock. The overlay probe now counts a visible iframe that covers the viewport, is pinned itself or through a fixed ancestor, and is neither faded out nor click-through as an open overlay, provided that, when the frame is same-origin, a dialog or a dimming backdrop is showing inside it. A frame left mounted after its modal closed does not justify the lock, so that page is still reported at high severity.
