---
"scenescout": patch
---

A forced click (used when something painted over a control, such as a switch's own thumb, keeps the strict click waiting) now scrolls the control to the middle of the viewport first, instantly even on a page that scrolls smoothly. On WebKit with overlay scrollbars (as on macOS), a page wider than the window could leave the control at the bottom edge under the horizontal scrollbar the strict click's scrolling had just shown, and the press went to the scrollbar: the click was reported as landed when the page never received it. A forced click the page releases but never receives as a click (a control in the last row of a box that scrolls sideways, where centring cannot lift it clear of the box's scrollbar) now fails and says so, instead of being reported as landed.
