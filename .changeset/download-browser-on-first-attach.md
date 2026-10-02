---
"scenescout": minor
---

The first `scout_attach` on a machine without the browser build it needs downloads that build itself, once, saying "Getting the test browser ready" while it does, then carries on with the attach. A Claude Desktop extension or a plugin install needs no terminal step before the first test. CI keeps its explicit install step: there the attach names the command instead, unless `SCENESCOUT_BROWSER_DOWNLOAD=on`. `SCENESCOUT_BROWSER_DOWNLOAD=off` turns the download off for a machine where nothing may be fetched. A failed download names the command to run by hand.
