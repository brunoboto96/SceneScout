---
"scenescout": patch
---

`refused-empty` now pairs an empty-state sentence with the refused read it is about (#413). A sentence that names what is missing ("No comments yet", "There are no orders") is reported at high when a refused read's path names the same thing, and not at all when a successful data read on the page fetched that thing instead: it is a genuinely empty section beside an unrelated refusal. A named sentence that matches neither is still reported, at medium, so `scenescout check` no longer fails a `--fail-on high` gate on it. Sentences that name nothing in particular ("No results", "Nothing to show") and empty rendered lists pair with any refused read at high, as before, and the finding names the refused read the sentence points at. Existing `refused-empty` fingerprints can change once on upgrade, because the evidence may now name a different read.
