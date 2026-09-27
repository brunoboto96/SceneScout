---
"scenescout": patch
---

In Firefox, a page the engine closes (a popup of another site, or every page when a session ends) now waits until the write policy has answered what the page sent as it was left. A write refused by the policy, such as a delete sent by beacon on `pagehide`, could previously reach the server when the page closed first.
