---
"scenescout": patch
---

A flow in `scenescout check` now waits for the write policy's verdict on what the page sends as the flow leaves it (a beacon on pagehide) before it hands back. A refusal the policy reported late was discarded at the hand-back, so the flow listed no background request even though the beacon was refused. A refusal reported during the hand-back is now added to the flow's list instead of dropped.
