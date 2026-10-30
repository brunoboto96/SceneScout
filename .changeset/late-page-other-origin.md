---
"scenescout": patch
---

A page that a refused write leads to after the settle wait is no longer judged for a false success when it is on another origin than the app's, and the origin fence now takes the session back from it: before, the action reported the page it started on while the session stayed on the other site.
