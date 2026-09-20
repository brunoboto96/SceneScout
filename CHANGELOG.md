# scenescout

## 3.0.0

### Major Changes

- c7c4811: **A session now says two things, and the second is required.** Its **objective** is the whole remit it was given, set once at `scout_attach {objective}` — "Admin lane: §2 registers, §7 plan gating". Its **task** is what it is doing right now, and every tool that acts on the app — `scout_navigate`, `scout_back`, `scout_click`, `scout_type`, `scout_select`, `scout_press`, `scout_upload`, `scout_run_plan` — takes one: a few words for the batch in front of it ("Filtering the documents register by status"). It stays set until a different one is passed, `scout_journey` sets it while a journey runs, and reading the page needs none. A call that acts with no task standing is refused, with what to pass and why.
  
  This exists because both were optional and therefore usually absent: someone watching a run saw sessions working through their app with nothing to say why, which is the one thing the live view is for. Stating a task also marks the action log, so the close-up's feed groups and tints the actions that follow it, as it already did for a journey's.
  
  Breaking, in two ways. An agent that never states a task now gets a refusal instead of a click. And the two names swapped to match what they mean: `scout_attach {task}` is now `scout_attach {objective}`, and the per-call `objective` of 2.0 is now `task`. Both old names are still accepted, so a caller written against 2.0 keeps working.

## 2.0.0

### Major Changes

- 74a45d6: **A tool that acts on the app now needs an objective.** `scout_navigate`, `scout_back`, `scout_click`, `scout_type`, `scout_select`, `scout_press`, `scout_upload` and `scout_run_plan` take an `objective`: one short sentence naming what the current batch of actions is for. It stays set until a different one is passed, so a batch costs one sentence rather than one per call, and `scout_journey` still sets it (and outranks it) while a journey runs. A call that acts with none standing is refused with what to pass and why.
  
  This is the breaking part: an agent that never states one now gets a refusal instead of a click. It exists because the objective was optional and therefore usually absent — someone watching a run saw sessions working through their app with nothing to say why, which is the one thing the live view is for. The objective now also appears on each card in the grid, not only in a session's close-up, and a session that has not said anything yet says so.

## 1.5.0

### Minor Changes

- 791b4d0: The live view now hands over the report when the run ends. Closing the last session used to take the report with it — the view served it from the live engine, so the moment the browsers went the page said there was nothing to report. The last rendering is now kept, and when the board empties the page says the run has finished, opens the report by itself, and names the file it belongs in: `saved at <path>` once `scout_report` has written it, or plainly that it is not on disk and this page holds the only copy. A **Save a copy** button downloads that copy through the viewer's own browser (nothing is asked of the engine, which still answers `GET` and nothing else), and closing the tab on a finished run whose report was never written asks for confirmation first.

## 1.4.0

### Minor Changes

- 01fe452: The engine now notices when a value it typed comes back as markup. Any markup-shaped value the agent types — `<script>…</script>`, `<img src=x onerror=…>`, a `<b>` — is remembered by shape, and every page seen afterwards is checked for an element of that shape. When one is found, a `dom_injection` violation (severity high) names the field it was typed into, the page it was typed on, the page it rendered on and the element it became: whoever opens that page runs the input, which is a stored or reflected XSS. The oracle never chooses what to type; the method asks for markup in the fuzzing pass, and the rest is the agent's judgment.

### Patch Changes

- 2deca2a: Two findings that name the same endpoint no longer merge unless both name a failure status for it. A double submit and an accepted bad value can both mention `POST /api/orders` and are two bugs; the second one filed used to be absorbed into the first without a trace.
- 4e10197: The live view's header keeps its two buttons together when it wraps on a narrow screen, numbers that tick every second (badges, feed times, the session counts) use tabular numerals so they no longer jitter, the feed's journey groups are marked by their tint with a hairline rather than a stripe, and the scrolling panels and text selection take the page's own palette.
- 978022a: Every record a session creates is now named in the result of the action that created it (`created: /api/things id=44`), including the second and later ones on an endpoint. The state-changing-request notice reports each endpoint once per session, which in safe-write mode hid every creation after the first, so the agent could not tell from the result that it had just made one.
- dd8927a: `scout_run_plan` now prints a type step's note about the field (such as "replaced existing content") on that step's own line. It used to appear under the previous step, so a reader concluded the wrong field was prefilled.

## 1.3.0

### Minor Changes

- a7c978a: `scenescout install` now puts the `scenescout` command on your PATH. Until now neither an `npx` run nor a source checkout left it there, so `scenescout status`, `scenescout doctor` and the other commands the tool itself tells you to run answered "command not found".
  
  Run through `npx`, install does `npm install -g` of the version you ran. From a checkout it does `npm link`, so the command always runs what you last built, and From a checkout it runs `npm link`, taking the name over from any other copy the way install already takes over the MCP registration. Run through `npx`, a command that is already there is left alone. On Windows the step prints the command to run by hand. If npm refuses, the step prints the command to run by hand and does not fail the setup. `--no-command` skips it.
- 195cb59: Watch a run live. `scout_attach` now returns a `Live view:` address, which the agent passes on to you, and `scenescout watch <project>` opens the same page from a terminal. It shows one card per session: the tool it is running, how long it has been there, the page it is on, a thumbnail of that page, a rolling feed of what it just did (each action, its target and how it turned out, read from the same action log a finding's repro trace uses), and a live stream you can switch on per session or for all of them. Opening a card's close-up shows a longer stretch of that feed beside the session's brief: the task the agent gave it at `scout_attach {task}`, and the goal of the journey it is on right now. Actions of one journey share a tint in the feed, and pointing at a group shows the goal those actions served. The Report button shows the run's report as it stands, rendered from the current state without writing it, so it can be read while the run is still going. It works for headless runs, and a session whose call is still running past its own tool's watchdog budget is marked as stuck.
  
  `status.json` now describes every session instead of the last one to write, and `scenescout status` prints a line for each.
  
  The live view is served on `127.0.0.1` only, behind a per-process token, answers GET and nothing else, and writes no frame to disk ([ADR 7](docs/adr/0007-the-live-view-is-local-read-only-and-leaves-nothing-behind.md)). A stream runs only while someone is watching it. Set `SCENESCOUT_LIVE=off` to keep the engine from opening the port. The engine now also shuts down, closing its browsers and removing the token file, when its client closes the connection instead of sending a signal.

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
