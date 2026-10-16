---
"scenescout": patch
---

The write policy now judges a request as the method it names. A `POST` carrying `X-HTTP-Method-Override`, `X-HTTP-Method` or `X-Method-Override`, or `_method` in its query or body, is judged as that method in every mode but `destructive`, whether a page, a beacon or `scout_request` sent it, so `POST` with `X-HTTP-Method-Override: DELETE` is refused in `read-only`. New and off by default: `SCENESCOUT_STRICT_WRITES=1` judges destructive writes with a stricter classifier (identifiers split into words, the query's `action`, the whole body, more verbs, and fewer false alarms on noun phrases), and `SCENESCOUT_REFUSE_DESTRUCTIVE_GETS=1` refuses page loads such as `/items/3/delete` in `observe` and `read-only`.
