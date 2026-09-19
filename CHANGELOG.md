# scenescout

## 1.2.0

### Minor Changes

- 2932164: `scenescout install --browsers <list>` chooses what to download: `chromium` (the default, unchanged), `chromium-headless-shell` for the smallest working setup, `firefox`, `webkit`, or `all`. `scout_attach` takes a `browser` option, and `SCENESCOUT_BROWSER` sets the default. In Firefox and WebKit the engine keeps service workers from registering, because a request issued by one cannot be intercepted there and would pass the write policy. The missing-browser message and `doctor` now name the build that is actually missing, and the sizes quoted are the sizes on disk.
  
  Pages are no longer given shared workers unless the mode is `destructive`. A request a shared worker sends cannot be intercepted in any browser, and a `DELETE` sent from one reached the server in read-only mode.
  
  Hover no longer reports text that was already on the page and only moved to a new line, and the keyboard focus audit uses Option+Tab in WebKit on macOS, where plain Tab skips buttons and links.
- ad0f31d: `scenescout install --client <list>` registers the server with clients other than Claude Code: `cursor`, `vscode`, `codex`, `gemini`, `copilot` and `windsurf`. Clients that have a command for adding a server are registered through it; Cursor and Windsurf get an entry added to their JSON server list, with every other entry kept and an unreadable file left untouched. For VS Code, a `code` command that belongs to another editor is not used. The skill is installed only when `claude-code` is among the clients.
- 5504c63: The testing method now reaches every MCP client, not only Claude Code. A new `scout_playbook` tool returns it, the server's instructions tell an agent to call that tool before its first attach, and an `explore` prompt loads the method together with the target URL for clients that list server prompts as commands. It is the same text Claude Code loads as a skill, read from the same file.

### Patch Changes

- d0aa6aa: The package description, keywords and README now present SceneScout as a tool for any MCP client, with Claude Code as one of them. `doctor --engine` ends with what to ask an agent instead of a Claude Code command.

## 1.1.0

### Minor Changes

- d3ebd73: Snapshots now list images that failed to load, under `BROKEN IMAGES`, read from the DOM. This catches an image whose URL answers 200 with something that is not an image, which the HTTP oracle cannot see because no request failed. Images that occupy no space (inside a closed panel, tracking pixels) are not reported.
  
  An `<img>` is now named by its alt text and listed with the role `image`; it previously appeared as `generic "(unnamed)"`. For the uncommon `<img>` that is collected without a `data-testid` (one with `onclick` or an explicit role), this changes its element key, so states containing it are seen as new once.
- 5706a55: `scout_scan` now reads routes from source for React Router, Vue Router and Angular projects, including nested children, `<Route>` elements and Angular `loadChildren` files. These projects previously started with an empty route list and relied on link discovery alone, so a page nothing linked to was outside the completion contract. The reader is static and skips anything it cannot resolve: computed paths, spreads, identifiers, and relative paths whose parent is unknown.
- 6b6b786: The geometry oracle now reports a pinned control that sits underneath other pinned chrome, for example a sticky Save row covered by a fixed bar. Box overlap cannot tell which of two pinned elements is on top, so that pair was skipped; the new check hit-tests the control's centre in the page. It stays quiet for controls inside a scrollable pane, for dialogs, and for overlays covering half the viewport.
- 0d320b1: New write mode `observe` (`--observe`): nothing but `GET`, `HEAD` and `OPTIONS` requests leaves the page, except logging in, logging out and refreshing a token. Signing up and password changes are blocked. WebSocket frames are not inspected, and the engine says so when the app opens one. `read-only` lets an ordinary form `POST` through, which on a target holding real data creates a record. The skill now attaches in `observe` for a remote URL with no source unless told that form submissions are acceptable. Forms that could not be submitted stay in the gap ledger, worded as the mode's doing.

### Patch Changes

- 0d320b1: The login exemption in the write policy no longer applies to destructive-looking requests in any mode. A path that merely contained a word such as `session` or `auth` previously carried a request like `POST /api/session/123/delete` through `read-only`. A form navigation blocked by the write policy is now reported as blocked; it was reported as an off-origin navigation, and the follow-up note blamed the app for discarding data.
- 4107696: `scenescout doctor` now suggests `npx -y scenescout install` when the tool was installed from npm. It previously suggested `npm run setup`, which exists only in a source checkout.

## 1.0.0

### Major Changes

- First release on npm.
  
  SceneScout is an MCP server that lets an AI agent explore a running web app like a curious user and write a coverage-checked report. The engine contains no model and needs no API key: the agent supplies judgment, the engine supplies a structured view of the page, always-on correctness oracles, a write policy enforced at the network layer, cross-run memory and a report that lists what it did not test.
  
  - **Install** as a Claude Code plugin, with `npx -y scenescout install`, or from source. Any MCP client can drive it with `npx -y scenescout serve`.
  - **24 tools**, all prefixed `scout_`. Earlier pre-release builds used `ft_`; there are no aliases.
  - **Works with or without the source code.** Next to a codebase, routes are read from Next.js, SvelteKit and Nuxt projects. Against a remote URL, routes are discovered from same-origin links.
  - **Read-only by default.** `PUT`, `PATCH`, `DELETE` and destructive-looking requests are blocked on the wire. `safe-write` lets a run edit and delete only the records it created.
  - **A demo app and a sample report** are in the repository: `npm run demo:serve`, and `examples/report.md`.
