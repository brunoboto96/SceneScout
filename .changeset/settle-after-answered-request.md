---
"scenescout": patch
---

The wait after an action, and before a snapshot, keeps its 120 ms quiet window from the end of a request that finished with a redirect or a sign-in refusal (301, 302, 303, 307, 308, 401, 403, 419, 440), as it already did from a request cancelled after its answer. A page that redirects on such an answer does so after that request has ended, so the page was sometimes read on the address it was leaving: on Linux WebKit, which hands the page an answer only once its body has arrived, a redirect to sign-in during a scroll was reported a call late. Other answers finishing, such as a status poll or an analytics beacon, do not extend the wait.
