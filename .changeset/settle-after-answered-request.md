---
"scenescout": patch
---

The wait after an action, and before a snapshot, keeps its 120 ms quiet window from the end of any request whose answer had arrived, finished or cancelled, not only a cancelled one. A page that redirects or sends a follow-up request on an answer does so after that request has ended, so the page was sometimes read on the address it was leaving: on Linux WebKit, which hands the page an answer only once its body has arrived, a redirect to sign-in during a scroll was reported a call late.
