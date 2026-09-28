---
"scenescout": minor
---

`scenescout login` now says how long the saved sign-in will last, read from its cookies' expiry dates and the `exp` of any JWT in a cookie or in localStorage (decoded for that claim only, never verified or printed). `scout_lane_brief` checks the planner's saved role before splitting the app: it takes `runMinutes` (default 60) and `expiryMarginMinutes` (default 10), refuses when every credential in the profile is dated, none was set for another host, and the last ends before the run does, and names the `scenescout login` command to run again. A profile whose first credential expires inside the run, or that has no expiry in it at all, is a warning at the top of the brief rather than a refusal.
