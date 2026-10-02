---
"scenescout": patch
---

A path given to `scout_navigate`, `scout_crawl`, a plan or a replayed flow now resolves against the attached origin, as `scout_request` already did, so a session attached on a page below the root (`/things`) goes to `/widgets` for `/widgets` instead of `/things/widgets`, and a crawl given a full same-origin URL visits it as given. A crawled route whose main area holds only an alert or a loading placeholder is flagged `ERROR-VIEW` or `STILL-LOADING`, listed under problem routes, and no longer joins the route contract.
