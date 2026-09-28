# The SceneScout guide

SceneScout is an exploratory tester for web apps. It is an [MCP](https://modelcontextprotocol.io) server: the coding agent you already use (Claude Code, Cursor, VS Code with Copilot, Codex, Gemini CLI and others) drives a real browser through its `scout_*` tools, and SceneScout supplies what the agent cannot do reliably on its own: a structured view of every page, always-on checks for errors and broken layouts, a write policy enforced on the network, memory across runs and a report that states what was not tested.

This guide is for a developer who wants to use SceneScout on their own project. It starts from nothing and ends with CI.

| Page | What it covers |
|---|---|
| [Start here](Start-here.md) | Install, a first run against the demo app, reading the report and the live view |
| [Ways to use it](Ways-to-use-it.md) | An interactive run, parallel lanes, `scenescout check` as a CI gate, `scenescout ci` unattended, `/scenescout qa` on pull requests |
| [Signing in](Signing-in.md) | Saved logins per role, what a profile holds, expiry, re-attach, the refresh broker, scripted sign-in for CI |
| [Safety model](Safety-model.md) | The four write modes, what is refused and why, embedded third-party frames, keys and forks in CI |
| [Recipes](Recipes.md) | Setups for seven kinds of project, from a server-rendered app to a monorepo with preview deployments |
| [Configuration reference](Configuration-reference.md) | Every CLI option, environment variable, GitHub Action input and repository variable, with defaults |
| [Measuring it](Measuring-it.md) | The benchmark, answer keys, the held-out app, lane calibration and how to read a scorecard |
| [Troubleshooting](Troubleshooting.md) | Symptoms and fixes, and questions that come up often |

## The shortest path

```bash
npx -y scenescout install          # skill, MCP server registration and Chromium, for Claude Code
npx -y scenescout doctor           # every line should be a tick
```

Start a new agent session in your project, with your app running, and ask:

```text
Use SceneScout to test http://localhost:3000
```

The findings land in `.scenescout/report.md`.

## Where the rest lives

This guide explains how to use SceneScout. Deeper material stays in the repository, and the guide links to it where it helps:

- [How it works, stage by stage](../how-it-works.md): diagrams of a run, one action, the write policy, findings, lanes.
- [Running it in CI](../ci.md): the full reference for `scenescout check`, `scenescout ci` and `/scenescout qa`.
- [The architecture decision records](../adr/README.md): why the rules are what they are.
- [The testing method](../../skills/scenescout/SKILL.md): the text the agent follows.

These pages are kept in the repository under `docs/guide/` and published to the wiki on each release, so an edit made in the wiki is replaced at the next release. Propose changes as a pull request.
