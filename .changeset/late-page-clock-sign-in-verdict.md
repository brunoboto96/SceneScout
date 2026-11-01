---
"scenescout": patch
---

With a saved login, the sign-in verdict of an attach, a crawled route and a navigation now also counts its watch on the page's own clock. A page whose scripts run late, because it is busy with its own work or the machine is loaded, is waited on until its timers due within the window have run, and until the navigation shows when one of them started to leave the page, for at most 5 seconds (10 while a navigation is on its way). A stale login on an app that sends a signed-out visitor to sign-in from a short timer is reported as `⚠ AUTH FAILED` even when the page runs that timer late; a page that keeps time is read within a few milliseconds of when it was before.
