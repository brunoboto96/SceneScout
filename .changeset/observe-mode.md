---
"scenescout": minor
---

New write mode `observe` (`--observe`): nothing but `GET`, `HEAD` and `OPTIONS` requests leaves the page, except logging in, logging out and refreshing a token. Signing up and password changes are blocked. WebSocket frames are not inspected, and the engine says so when the app opens one. `read-only` lets an ordinary form `POST` through, which on a target holding real data creates a record. The skill now attaches in `observe` for a remote URL with no source unless told that form submissions are acceptable. Forms that could not be submitted stay in the gap ledger, worded as the mode's doing.
