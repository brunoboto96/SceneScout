---
"scenescout": patch
---

A page load that fails with `net::ERR_NO_BUFFER_SPACE` (the machine refused the browser a socket) is tried once more. Before the retry the engine logs the machine's TCP socket counts; the action's result, the crawl line and the report's new "Page loads retried" section say "retried after ERR_NO_BUFFER_SPACE". No other error is retried, and a second refusal fails the load.
