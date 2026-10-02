---
"scenescout": patch
---

`false_success` no longer pairs a write sent as a clicked link loads the next page (the old page's save as it is left, the new page's beacon as it loads) with that page's static text, and it now reports, at medium, a refused write whose control or counter shows the change as kept with no error. Errors an HTTP client raises over the write policy's stand-in 403 ("Request failed with status code 403", "403 Forbidden") are attributed to the policy, an alert that appeared after a block is marked `(after a write-policy block)` in the snapshot, and the silent-submit note no longer fires when the click opened a dialog or client-side validation answered. Error-monitor tunnel and client-error endpoints count as infrastructure writes.
