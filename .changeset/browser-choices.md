---
"scenescout": minor
---

`scenescout install --browsers <list>` chooses what to download: `chromium` (the default, unchanged), `chromium-headless-shell` for the smallest working setup, `firefox`, `webkit`, or `all`. `scout_attach` takes a `browser` option, and `SCENESCOUT_BROWSER` sets the default. In Firefox and WebKit the engine keeps service workers from registering, because a request issued by one cannot be intercepted there and would pass the write policy. The missing-browser message and `doctor` now name the build that is actually missing, and the sizes quoted are the sizes on disk.

Hover no longer reports text that was already on the page and only moved to a new line, and the keyboard focus audit uses Option+Tab in WebKit on macOS, where plain Tab skips buttons and links.
