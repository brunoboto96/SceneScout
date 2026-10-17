---
"scenescout": patch
---

Leaving Chromium's error page after a refused form, or a page on another site, no longer loads the page before it again with a GET when a POST (or a load the engine did not see) reached that page and its address reads as a destructive command (`/things/9/cancel`, `?action=delete`). That GET is the engine's own request and no write rule judges a GET in safe-write, so a server could act on it; the engine now sends nothing, leaves for `about:blank`, and says so in the action's result. The address is judged with the rule `SCENESCOUT_REFUSE_DESTRUCTIVE_GETS` uses, whether or not that setting is on.
