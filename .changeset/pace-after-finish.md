---
"scenescout": minor
---

The pace section now separates a lane's working time from the time it holds its browser after finishing. "Idle while working" is the share of each lane's working time spent in gaps over 30 seconds; "after finishing" is time waiting to be collected and closed, split at the moment the lane's report was folded. The latter grows with the number of lanes and the slowest one, so it is reported as planner overhead rather than summed into the lanes' idle time. `scout_lane_report` now logs the fold so the split can be made.
