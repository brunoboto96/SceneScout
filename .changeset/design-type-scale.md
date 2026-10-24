---
"scenescout": minor
---

Design audit: font sizes are checked against a type scale. The scale is counted from the page's body size: sizes on a 2px step grid are on it, and so are steps of a ratio from 1.125 to 1.618 that the page's other sizes show. From three sizes off the scale in headings, controls or body text, the TYPOGRAPHY section names them and the score loses a suggestion's points, for example `-3 type sizes off the scale: 15, 17, 19px` (at most 4). Text under 12px, code, icon fonts and badges are left out, and so are sizes with a fraction of a pixel, which a fluid `clamp()` or `vw` size computes at the width audited; a rem scale under a root other than 16px is on its own grid.
