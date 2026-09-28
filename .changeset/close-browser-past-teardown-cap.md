---
"scenescout": patch
---

Closing a session now always closes its browser. When closing took longer than the 8-second cap, the close returned and cleared its references before teardown had reached the browser, so the browser kept running under the process and could stop it from exiting. The browser is now closed past the cap as well, without waiting on a page or context that has not closed.
