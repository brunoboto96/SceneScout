---
"scenescout": patch
---

The write policy's notices and label check are easier to work with, and refuse as much as before.

- A blocked endpoint is named and explained once per session; later blocks of it are counted on one line, so a page that beacons on every load no longer buries each tool result.
- A control is judged by its own label. A dropdown is judged by the option picked, so a filter that offers "Delete" can be set to "Create". A row or panel is judged by its own text, not by the buttons inside it, plus any control covering its centre. A pick whose label cannot be read is refused.
- "Discard changes" and similar labels, which drop only unsent input, are no longer refused. "Discard draft" or "Discard record" still is, and `discard` in a request path is now treated as destructive on the network.
- When a page asks to confirm leaving unsent input, the result says so by name instead of failing with `ERR_ABORTED`. `scout_navigate`, `scout_click` and `scout_back` take `leave`: observe and read-only stay unless it is `true`, and other modes leave unless it is `false`. Every native dialog the page opens is reported in the action's result.
