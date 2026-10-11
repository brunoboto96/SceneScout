---
"scenescout": patch
---

`scenescout watch` now opens the live view the way the MCP server does: the opener starts detached and is not waited for, never through a shell, and on Windows through the URL protocol handler. It no longer waits up to ten seconds for an opener that keeps running. It says "Could not open a browser", with the reason, only when nothing was opened: in CI, over SSH or with no display, or when the opener could not start.
