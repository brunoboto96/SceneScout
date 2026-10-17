---
"scenescout": patch
---

`scenescout doctor` now checks that the version an npx registration pins exists on npm, and says so when it does not (an answer of "no such version" only; no npm or no network says nothing). A registration pinned to a pre-release (`scenescout@3.26.0-beta.1`) is recognised as this package's launcher, so `install` replaces it instead of reporting it as something else.
