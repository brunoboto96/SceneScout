---
"scenescout": patch
---

`/scenescout qa check`: when the dispatch of the project's workflow is answered with a server error or a lost connection, the check job now looks for a run carrying its `dispatch-id` for about 30 seconds and follows it if one started, instead of failing the stage while the run goes on. With no such run, the original error is reported as before, and the dispatch is never sent twice.
