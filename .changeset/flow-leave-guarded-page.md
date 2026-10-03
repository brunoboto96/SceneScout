---
"scenescout": patch
---

A saved flow that fails after typing into a form with an unsaved-changes guard no longer stops the flows after it. During a flow, a page asking to confirm leaving is left, as the flow's `navigate` and its hand-back mean, so the next flow's first `navigate` is not cancelled (`net::ERR_ABORTED`). The session's own answer is restored once the flow hands back.
