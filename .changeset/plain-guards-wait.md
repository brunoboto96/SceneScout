---
"scenescout": patch
---

Catch a client-side auth guard that redirects after the page has gone quiet.

Settling on the requests an action fired is faster than a fixed sleep and more patient with a slow page, but it cannot wait for something that has not been scheduled. A client-side auth guard issues no request until its timer fires, so the page goes quiet, the URL is read, and the gated route is recorded as reached — the bounce invisible, and a dead session along with it. The removed 400 ms sleep had been covering this by accident, and this project's own CI began failing intermittently on a 40 ms guard that a loaded runner delayed past the quiet window.

Where a bounce verdict is made — attach judging a storage state, navigate judging coverage — the URL is now watched until it has held still rather than read once. It is a window rather than a guarantee: a guard slower than it still lands after the verdict, and is caught on the next action. Only a session that was given credentials pays for it on every navigation, so an anonymous crawl keeps its full speed: navigate 179 ms and 470 ms per route, unchanged.
