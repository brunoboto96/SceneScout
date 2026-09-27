---
"scenescout": patch
---

The `ci` GitHub Action takes a `cache` input (default `true`). `cache: false` skips restoring and saving the browser in the actions cache, for a job that checks out a ref chosen by an input and must not write to the cache.
