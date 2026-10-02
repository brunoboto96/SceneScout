---
"scenescout": minor
---

SceneScout installs in Claude Desktop as a desktop extension. Each release now carries `scenescout-X.Y.Z.mcpb`, a bundle in the MCPB manifest format (manifest version 0.3) holding the engine and its dependencies; opening it installs SceneScout with no new chat or restart needed for the install itself. `scenescout doctor` recognises the extension: it checks that the extension's server is in place, checks the Chromium build the extension launches when that differs from its own, with the command that downloads it, and it no longer asks a Claude Desktop-only user to set up the Claude Code skill and registration. After a plugin install, `scenescout install --browser-only` now ends with "Start a new chat to use SceneScout."
