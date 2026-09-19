---
"scenescout": minor
---

The testing method now reaches every MCP client, not only Claude Code. A new `scout_playbook` tool returns it, the server's instructions tell an agent to call that tool before its first attach, and an `explore` prompt loads the method together with the target URL for clients that list server prompts as commands. It is the same text Claude Code loads as a skill, read from the same file.
