---
"scenescout": minor
---

New tool `scout_network` lists the fetch and XHR requests the current page made since it loaded, with method, path, status and time. Each request shows the route it was sent from, so requests after a client-side route change can be placed. A request that failed, one still pending and one that never ran can be told apart. The tool is read-only, query-string credentials are redacted, the list is bounded, and `scout_request`'s own calls are marked.

`scout_request` takes `select` (one value of a JSON body by dotted path, such as `stats.open` or `items.0.name`) and `offset`/`limit` (a window of characters), so a field past the 2000-character cut can be read. Without them the output is the same as before, except that the truncation line now names the options.

`scout_coverage` shows a session its own work when other sessions share the project: the routes it reached this run and the forms it saw. `scope: "project"` shows every session's coverage and tags each route and form with the sessions that saw it.

Smaller fixes:

- A form whose date or time field the app pre-fills, for example with the current time, counts as submitted empty when that value is left as the app set it and every other field is blank. A pre-filled text field still counts as filled, so saving an edit form unchanged is not taken for the empty submit.
- "Seen in N runs" counts runs, not filings. When the same session files a finding again in the same run, its newer convention and detail replace the earlier ones, and the result says which fields changed or which were kept.
- A path crawled by name that answers as a page joins the route list. A crawled path that ends on another route is marked `REDIRECTED → <route>`.
- A journey's time is active time. Gaps over 30 seconds between steps are left out, and the result says how many were left out.
