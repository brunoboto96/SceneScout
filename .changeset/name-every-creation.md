---
"scenescout": patch
---

Every record a session creates is now named in the result of the action that created it (`created: /api/things id=44`), including the second and later ones on an endpoint. The state-changing-request notice reports each endpoint once per session, which in safe-write mode hid every creation after the first, so the agent could not tell from the result that it had just made one.
