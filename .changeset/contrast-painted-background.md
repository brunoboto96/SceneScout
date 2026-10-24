---
"scenescout": patch
---

The design audit's contrast check now reads the background that is actually painted behind text. In Chromium and WebKit, colours written as `lab()`, `oklch()` or `color()` were read as no colour, so light text on a dark panel in those colours was reported at 1.00:1 and text coloured in them was not measured at all; all three browsers now read them alike. A panel drawn by a pseudo-element, a panel in a shadow root around slotted text, and the stops of a gradient now count. Where text may sit on more than one colour (a gradient, or a positioned box that is not its container), it fails only if it fails on all of them; if it passes on some, the audit lists it under `CONTRAST unsure` to check by eye, and it costs no points. Pages styled in those colours may score lower in Chromium than before, because contrast failures there are now measured.
