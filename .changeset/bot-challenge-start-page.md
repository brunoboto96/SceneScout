---
"scenescout": patch
---

`scenescout check`, `scenescout ci` and a first run (`scenescout <url>`) no longer pass, or explore, a start page that bot protection answered in the app's place. A Cloudflare, Akamai, DataDome, PerimeterX/HUMAN, AWS WAF, Imperva or Sucuri challenge on the start page now ends the run with exit 2 and `could not run: blocked by bot protection (HTTP <status>)`, and any other 4xx on the start page ends it the same way, naming the status. A 403 on a route inside an app that loaded is still that route's finding. A route inside the app that the protection answered part-way through a crawl is listed under "Blocked by bot protection" (`blocked` in `check.json`) rather than filed as the app's error.
