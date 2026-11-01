---
"scenescout": patch
---

A forced click (used when something painted over a control, such as a switch's own thumb, keeps the strict click waiting) now scrolls the control to the middle of the viewport first. On WebKit with overlay scrollbars (as on macOS), a page wider than the window could leave the control at the bottom edge under the horizontal scrollbar the strict click's scrolling had just shown, and the press went to the scrollbar: the click was reported as landed when the page never received it.
