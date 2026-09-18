---
"scenescout": minor
---

`scout_scan` now reads routes from source for React Router, Vue Router and Angular projects, including nested children, `<Route>` elements and Angular `loadChildren` files. These projects previously started with an empty route list and relied on link discovery alone, so a page nothing linked to was outside the completion contract. The reader is static and skips anything it cannot resolve: computed paths, spreads, identifiers, and relative paths whose parent is unknown.
