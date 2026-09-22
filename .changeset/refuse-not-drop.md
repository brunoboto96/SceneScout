---
"scenescout": minor
---

The write policy now answers a page's blocked `fetch` or XHR write with a `403` in the server's place instead of dropping it. The server is still never contacted, but the page's handling of a refusal really runs, so a page that reports a refused save or delete as a success is caught as a `false_success` (and says the refusal was the policy's stand-in). Blocked navigations are still dropped. The stand-in 403 is not reported as an HTTP error of the app.
