---
"scenescout": patch
---

With `SCENESCOUT_APP_HEADER` set, a page load is sent to the app once, with the header, and SceneScout decides from that answer whether the browser gets a page or a file, instead of asking with a `HEAD` first. An address that does something when opened now runs once, as it does with no header, and a file the app streams slowly no longer waits to be read whole. A streamed, long or compressed file, or any file reached through a redirect within the app, is still fetched by the browser without the header, after SceneScout's own request for it is closed unread; what that request's answer set with `Set-Cookie` is put in the browser's jar first.
