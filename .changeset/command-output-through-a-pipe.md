---
"scenescout": patch
---

The output of `scenescout check`, `ci`, `export`, `login`, `doctor`, `preflight`, `policy explain`, `config explain` and a first run (`scenescout <url>`) read through a pipe now arrives whole. On macOS a command could exit before standard output and standard error had drained, so a long report piped to another program or a CI log could lose its end. The MCP server's start-up refusals wait for standard error in the same way.
