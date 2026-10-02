---
"scenescout": patch
---

`scout_request` replays the Authorization header the page last sent to the app's own origin on any request, reads included. It used to replay the header of the page's last write, which went stale once the app rotated its access token and then only read, so a replay got 401 while the page's own calls got 200. A header sent to another origin is never replayed, nor is one a `scout_request` call chose for itself. When a replay still gets 401 while the page's latest authorised call succeeded, the result says the replayed credential may be stale.

The refresh broker's write-back keeps the profile's IndexedDB. It used to save the page's storage state without it, so an app keeping part of its sign-in in IndexedDB lost it from the role's profile at the first brokered refresh.

An action's result now says when the refresh broker acted during it: the token refreshed and stored, another session's rotated token loaded and sent, an endpoint learned, or a refresh that could not be brokered. Counts only, no token values.
