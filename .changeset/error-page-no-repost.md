---
"scenescout": patch
---

In Chromium, leaving the browser's error page after a refused form no longer sends again the POST that loaded the page before it. Going back re-sent that POST without asking, so in safe-write the app made the record twice. When a POST loaded that page, or the session did not see how it was loaded (it went back onto the error page with `scout_back`, say), the engine now loads its address with a GET and says so; a click bounced back from another site does the same, in every browser. An error the app answers that GET with (a page only its form's POST can show) is named in the action's result as the answer to the engine's own GET, not reported as a violation of the page. The action's result lists any write that went out while leaving.
