---
"scenescout": patch
---

The login exemption in the write policy no longer applies to destructive-looking requests in any mode. A path that merely contained a word such as `session` or `auth` previously carried a request like `POST /api/session/123/delete` through `read-only`. A form navigation blocked by the write policy is now reported as blocked; it was reported as an off-origin navigation, and the follow-up note blamed the app for discarding data.
