---
"scenescout": patch
---

In Chromium, leaving the browser's error page after a refused form no longer sends again the POST that loaded the page before it. Going back re-sent that POST without asking, so in safe-write the app made the record twice. When a POST loaded that page, the engine now loads its address with a GET and says so; a click bounced back from another site does the same. The action's result lists any write that went out while leaving.
