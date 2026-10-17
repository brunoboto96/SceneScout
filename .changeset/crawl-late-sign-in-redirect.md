---
"scenescout": patch
---

A crawl with a saved sign-in now waits for each route's address to hold still before reading the route, so a route whose scripts send the visitor to sign-in a moment after load is marked `AUTH-REDIRECT` instead of healthy. This adds about 0.4 s per route with a saved sign-in, and nothing without one.
