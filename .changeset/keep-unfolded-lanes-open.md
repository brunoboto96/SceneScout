---
"scenescout": patch
---

`scout_close` no longer closes a lane of a parallel run whose report has not been accepted yet, since folding the report needs the lane's session attached. A session counts as a lane once `scout_lane_brief` or `scout_lane_report` has named it (a brief lane sharing the name of a session already live does not count), until the run's last session closes; a refused report does not count as folded. The refusal says to fold the lane with `scout_lane_report`, and `scout_close {all: true}` names every such lane, offers the other sessions to close by name, and closes nothing. Pass `force: true` to close anyway, which loses that lane's decisions. A session no lane tool has named closes as before.
