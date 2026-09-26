---
"scenescout": patch
---

When a lane report is folded, a judged defect on a failing request now counts as filed when a finding names that request with its path written as a template: `GET /api/things/{id} 500` (or `:id`, or `*`) covers a lane's `GET /api/things/7 500`. A template stands only for one id segment (a number, a UUID or a long hex id), never for a word such as `me` or `export`. A defect naming several failing requests counts as filed only when every one of them is. On a request that did not fail, the lane's evidence, once the paths are aligned, must be the finding's, a restatement of part of it, or the finding's evidence followed only by the status the call should have returned, as in `… 200 as role=viewer (expected 403)`.
