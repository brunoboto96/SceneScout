---
"scenescout": minor
---

Move to Playwright 1.65, with Chromium 158, Firefox 159 and WebKit 27.2. The first run after updating downloads the new browser build. The Playwright container image named in the CI guide is now `v1.65.0-noble`, and it carries Node 26.

What a run sees changes in four ways:

- An inert control (inside an element with the `inert` attribute) is marked `inert` in a snapshot, and an action on it fails saying so. Typing into one used to report success, and appended text could land in the field holding the focus.
- The controls of a frame styled `visibility: hidden` are no longer listed, since no user sees them and no action reaches them.
- An app's `unload` handler no longer runs on Chromium unless the page opts in with `Permissions-Policy: unload=*`, so a beacon sent only there is not sent during a run. `pagehide` and `visibilitychange` are unchanged.
- A saved flow's `role=…[name="…"]` target matches only rendered text: text in a closed `<details>` or an unassigned slot is no longer part of a name.
