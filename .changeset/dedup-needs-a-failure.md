---
"scenescout": patch
---

Two findings that name the same endpoint no longer merge unless both name a failure status for it. A double submit and an accepted bad value can both mention `POST /api/orders` and are two bugs; the second one filed used to be absorbed into the first without a trace.
