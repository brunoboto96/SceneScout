---
"scenescout": patch
---

The wait after an action now keeps its quiet window after the browser cancels a request the page had open. WebKit cancels a page's open requests as soon as a navigation starts and reports the navigation's own request a moment later; in that gap the wait saw nothing in flight and returned, so a redirect the page started on a request's answer (a sign-in check answering 401, say) was read as a page that stayed put, and on WebKit a scroll could miss a redirect to sign-in that landed while it ran. The extra wait applies in every browser, only after a cancellation, at most 120 ms, and never past the wait's 2-second cap.
