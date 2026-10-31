---
"scenescout": patch
---

With a saved sign-in, a page that goes to sign-in is now reported even when the browser is slow to report the move. A navigation answered with a page counts as on its way until the browser reports the new page, rather than for half a second after its answer arrived, so attaching with a sign-in that no longer works is AUTH FAILED, and navigate and crawl judge the page where it went. A call that reads the page (a scroll, a snapshot) and the note after an action wait for such a navigation before reading the address, so a page that went to sign-in during the call is reported by that call. Seen on Firefox and on a loaded Windows runner.
