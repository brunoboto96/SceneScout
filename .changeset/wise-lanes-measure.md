---
"scenescout": minor
---

Measure whether a lane's confidence means anything, and make one lane rubric serve a whole wave.

Every lane has been told its confidence must be calibrated — "0.5 means a coin flip, 0.95 means you would bet on it" — and the number was then averaged into one line and discarded. Nothing was stored, so nothing could ever be checked, and a confidence nobody checks is decoration.

Lane decisions are now kept, and the report carries a calibration section: how often a decision at a stated confidence matched a finding the project holds, bucketed, with an expected calibration error. It says plainly what the number is not — agreement between the lanes and the bar the project applies, over its whole history, not evidence that the app is broken — and names the two ways a lane is counted wrong through no fault of its own. A decision naming no failing endpoint cannot be looked up at all, so it is excluded and disclosed rather than scored as a miss. Below eight checkable decisions the figure is withheld, but the section says so rather than vanishing. Where findings have since been re-tested through `scout_verify`, those verdicts are reported beside it, because they *are* evidence about the app.

Separately, the lane name used to sit in the second sentence of the instruction every lane receives, so two lanes' prompts diverged almost immediately and shared no prefix. The rubric is now identical for every lane in a wave and the name is the last thing said, which makes it one cacheable prefix instead of one per lane.
