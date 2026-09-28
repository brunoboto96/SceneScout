---
"scenescout": minor
---

A session attached by role now answers its first `SESSION AUTH LOST` by re-attaching once from that role's latest saved profile, read from disk at that moment, and going back to the page it asked for. The tool result says `SESSION RE-ATTACHED` and lists the routes the loss bounced; a crawl visits them again itself. A second loss in the same session, or a profile that no longer signs in, is reported as before. A lane that re-attached is named when its report is folded. Sessions attached with a storage-state file or none behave as before.
