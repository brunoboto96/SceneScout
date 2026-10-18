---
"scenescout": patch
---

A crawl with a saved sign-in now waits for each route's address to have held still for a second since the route's page arrived before reading the route, so a route whose scripts send the visitor to sign-in a moment after load is marked `AUTH-REDIRECT` instead of healthy. This adds up to a second per route with a saved sign-in (less the time the page took to load), and nothing without one. A snapshot or a crawl whose page navigates while its controls are being read now reads the page it landed on instead of failing with "Execution context was destroyed".
