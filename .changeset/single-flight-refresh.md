---
"scenescout": minor
---

Sessions attached by the same role no longer present the same refresh token. When a session's page is about to send a refresh token from the role's saved profile, it takes a lock beside the profile; holding it, it loads the profile again and, if another session has already rotated the token, sends the current one in place of the spent one. Once the page has stored the rotation it is written back over the profile. An app that revokes a whole token family on reuse keeps every session of the role signed in. Sessions in separate processes share the lock through the file. Token values are never printed or logged. `SCENESCOUT_REFRESH_BROKER=off` turns it off.
