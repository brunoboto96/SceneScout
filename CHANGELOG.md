# scenescout

## 1.0.0

### Major Changes

- First release on npm.
  
  SceneScout is an MCP server that lets an AI agent explore a running web app like a curious user and write a coverage-checked report. The engine contains no model and needs no API key: the agent supplies judgment, the engine supplies a structured view of the page, always-on correctness oracles, a write policy enforced at the network layer, cross-run memory and a report that lists what it did not test.
  
  - **Install** as a Claude Code plugin, with `npx -y scenescout install`, or from source. Any MCP client can drive it with `npx -y scenescout serve`.
  - **24 tools**, all prefixed `scout_`. Earlier pre-release builds used `ft_`; there are no aliases.
  - **Works with or without the source code.** Next to a codebase, routes are read from Next.js, SvelteKit and Nuxt projects. Against a remote URL, routes are discovered from same-origin links.
  - **Read-only by default.** `PUT`, `PATCH`, `DELETE` and destructive-looking requests are blocked on the wire. `safe-write` lets a run edit and delete only the records it created.
  - **A demo app and a sample report** are in the repository: `npm run demo:serve`, and `examples/report.md`.
