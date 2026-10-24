---
"scenescout": patch
---

Where SceneScout reads where a page landed before judging sign-in (an attach with a saved sign-in, a navigation's sign-in verdict, the check after a submit-style click that sent nothing, and a crawl's wait on each route with a saved sign-in), it now waits up to 10 seconds, rather than 3, for a navigation the page has already started. A stale profile whose sign-in page takes a few seconds to answer is reported as `⚠ AUTH FAILED` whether that page's request began during the wait before the verdict or just after it; before, it passed as signed in when the request began after. A page with nothing on its way is read as quickly as before.
