# SceneScout — contributor notes

The house rules for anyone changing this repository, person or AI coding agent. This is the one copy:
Codex, Cursor, Copilot, Gemini and others read `AGENTS.md`, and `CLAUDE.md` imports it for Claude Code,
so edit the rules here and nowhere else.

## Why it is built this way

Decisions with a cost behind them are recorded as ADRs in [docs/adr/](docs/adr/) —
read the relevant one before changing a rule it covers, and add a record when you
make a decision a future change would otherwise undo blindly. A pull request
that changes what a user can do or see updates the README and `docs/` in that
same pull request ([ADR 21](docs/adr/0021-update-the-docs-in-the-pull-request.md)).
A change with no user-facing surface does not.

## Stay project-agnostic

> Recorded as [ADR 6](docs/adr/0006-stay-project-agnostic.md). Grep before committing: this drift is invisible in review because the words are ordinary.

SceneScout is a **generic** exploratory-testing engine used against arbitrary web apps. Nothing in `src/`, `scripts/`, or `test-app/` may name, assume, or be tuned for a specific project under test.

- No project names, company names, or product names in code, comments, commit messages, or fixtures (not the app you tested, not its vendor, not its ticket ids — if a reader could tell which app inspired a line, rewrite the line).
- No project-specific route shapes, field names, or backend class names as anything other than genuinely illustrative examples — and even then, prefer made-up placeholders (`widget_id`, `/api/things/...`, `OrderService`) over a real tested app's actual naming, so the example reads as "REST APIs commonly do X" rather than "this one app does X".
- Regression fixtures in `test-app/` and `scripts/smoke/` should describe the *general shape* of a bug (e.g. "a create response naming its own id after the resource") rather than citing where it was found.
- If a real bug from testing some app inspires a fix, the fix and its test belong here in general form; the specifics of that app belong in that app's own bug tracker, not in this repo.

## Before committing

- `npm run format && npm test` must pass (`test` builds first, then type-checks `scripts/` against the build with `npm run typecheck:scripts`: tsx runs the suites without checking their types, so a test that passes a wrong shape fails here instead; where a test passes a bad value on purpose, type it as such rather than casting it away). The pure-logic suites import `src/` directly, so `npm run <suite>` tests your edit with no build; `smoke` and `mcp-check` need the compiled engine and rebuild on their own. `test` chains thirty-six suites:
  - scan-test
  - oracle-test
  - policy-test
  - fixture-test
  - dispatch-test
  - design-test
  - check-test
  - report-test
  - ci-test
  - qa-test
  - export-test
  - contract-test
  - guided-test
  - pace-test
  - limits-test
  - request-test
  - settle-test
  - claims-test
  - verify-test
  - brief-test
  - tickets-test
  - lane-test
  - calibration-test
  - bench-test
  - memory-test
  - install-test
  - profiles-test
  - refresh-test
  - scripted-login-test
  - live-test
  - demo-test
  - holdout-test
  - hygiene-test
  - guide-test
  - smoke
  - mcp-check
- Bug fixes need a regression test. Prefer the cheapest layer that can actually fail: pure logic goes in the matching `*-test.ts`, listed below, and anything needing a real browser goes in the matching suite under `scripts/smoke/` backed by a fixture in `test-app/`. Each smoke suite must take its own fresh snapshot rather than reuse refs from another suite — they run independently, so a crash in one does not hide the rest. Add a line for a new suite; don't extend another's line.
  - `policy-test` for the write policy, safe-write ownership, the auth-loss tracker, the route handler's decisions in `route-guard.ts` and the guided plan's gate on `scout_attach`, and the operator's config file (its schema, presets, where it is read from, and what an argument may still ask for), and `scenescout policy explain` (each verdict held equal to a route handler's on the same request)
  - `fixture-test` for synthetic upload files, accept-attribute logic and the disk-upload fence
  - `dispatch-test` for the per-session queue, the watchdog, orphan-browser selection, the bounded browser teardown, `bestEffort` (a probe of a page that may navigate or close) and the check that fails a smoke suite leaving a process, an open handle or a TCP socket of its own behind (and the machine's TCP table it logs after each suite)
  - `contract-test` for route identity, the gap ledger and the plain report (held word for word to `scripts/golden/plain-section.md`), and for snapshot collection (the hydration retry, refs kept across a re-snapshot, the kept snapshots a diff is against, and how a form is keyed)
  - `guided-test` for the guided assistant's start: the person's choices and their checks (a credential in them refused), every choice to its plan, when a care level needs the person's confirmation (each rule as a contrastive pair), what the person's answer to the confirmation form comes to (only their yes, with the code for test data, accepts a plan), the plans a server holds, the plan's text for the agent, the fixed plain wording in `guided-words.ts`, a finding as a plain card, the progress a guided check shows in `progress.ts` (its phase, each area's state, the narrator's fixed sentences and story, and the clicking-saved figure with its basis, kept out of reports, and the plain error screens: which failure of a guided check's call becomes which screen, read from the engine's own wording at the start of a failed call or its flag for a lost sign-in, never from a page's text), which cards `scout_cards` shows and what `scout_feedback`'s export lists, and the chat's guided prompts in `src/prompts.ts` (what each asks the agent to do, the care levels it may offer under a cap, and the arguments it refuses without repeating them), and that the credential check in `credential.ts` reads a crafted 1 MB text within a bound (#578), and saved checks in `saved-checks.ts` (the schema, which refuses any field it does not name and has none for a credential, the file's name, and that a check is kept owner-only and git-ignored)
  - `lane-test` for the lane report a parallel agent hands back (its schema, parser and the instruction that must state every rule the parser enforces)
  - `calibration-test` for whether a lane's stated confidence matched what the project went on to file
  - `bench-test` for scoring a run against an answer key, for scoring finding dedup on the pairs the key labels, for the model judge the store asks (which filings it is asked about, its cap, time limits and fallback to the rule, and the sampling request that carries it through a CI run), for choosing each app's key and for keeping the demo's and the held-out app's keys in step with their READMEs
  - `design-test` for the audit and journey measurement
  - `check-test` for how `scenescout check` turns what it measured into issues, its gate, its arguments and its SARIF (and which repository file a SARIF result of a check or a CI run points at), the saved-flow format and how a replay becomes issues, and which open findings a page load can re-test, visual baselines (the targets file, where their files go, what a baseline records, when two pictures may be compared, the verdict and how an unmet one becomes an issue), a start page that a bot challenge answered in the app's place, or that answered 4xx (`challenge.ts`'s vendor markers, each beside a near miss), which three issues a first run (`scenescout <url>`) leads with and what its summary and report say, and for the GitHub Action in `action.yml` (its inputs are held equal to the CLI's options, and its logic lives in `action/check-action.mjs` so it can be table-tested)
  - `report-test` for the test report a recorded check lays out from a template (`--template`): the template's schema and its errors, the flow metadata it reads (`id`, `requirements`, a step's `expected`), the page against a golden file in `scripts/golden/` (`UPDATE_GOLDEN=1` rewrites it after an intended change), its deviations, its evidence manifest and its escaping, and for the team report (`team-report.ts`: what it lists, its golden page, its manifest hashes and that it writes only inside `.scenescout/`)
  - `ci-test` for `scenescout ci`: its options, which provider a run uses, the caps that end it, key redaction, the tools the model is given, both APIs' message shapes and retries, the agent loop driven by a scripted model, the dedup judge asked through the run's own MCP client, its files, a run split into lanes (how the planning crawl is read, the split, the shared caps, what each lane is told, how the lanes' endings and findings merge, and a split run end to end against a stand-in server, driven by a scripted model and by the stand-in model API in `scripts/fake-model-api.mjs`), a run asked to show one element (the capture's rectangle and name, where the same page is on another deployment, the PNG reader and writer and the pixel diff), its GitHub Action in `ci/action.yml` (inputs held equal to the CLI's options, logic in `action/ci-action.mjs`), and the benchmark workflows: which jobs may hold the model's key, when the weekly run runs, and the results record in `scripts/bench/ci-results.ts`, and that every remote action a workflow or one of the three actions uses is pinned by full commit SHA with its release beside it
  - `qa-test` for the `/scenescout qa` comment: the command, the allowlist, the fork refusal, where the preview and base URLs come from, the inert reply and the only images it renders, every keyless stage (gate, shots, report, check) against a stand-in GitHub API, `/scenescout qa check` (which workflow it may dispatch, how its run is found, the wait, and the verdict reply read from `check.json`), and the shape of the workflows in `examples/workflows/scenescout-qa.yml` and `scenescout-qa-check.yml` (logic in `action/qa-action.mjs` and `action/qa-check.mjs`, and `action/zip.mjs`, which reads `check.json` from an artifact's zip without extracting it)
  - `export-test` for `scenescout export`: its options and where its credentials come from, which findings it files, the marker a later export finds an issue by and that quoted text cannot forge it, the inert issue body (held to the qa reply's escaping), which screenshots belong to a finding, the plan and the cap, and whole exports against a stand-in GitHub API and a stand-in Jira API over real HTTP (dedup on a second export, dry runs, rate limits, a create that failed after the tracker made the issue, redirects, the token never printed), and filing tickets from a guided surface (`scout_ticket_preview` and `scout_ticket_file`: a preview's id, its tracker target, what binds it to its findings, its ten minutes, the person's confirmation form and what their answer comes to, and preview then file against the same stand-ins, with an expired or altered preview, every ending of the form but a yes, and the token never printed), and reading filed tickets back (`scout_ticket_status`: the places a record names, a record written against another tracker address never read, the tickets newest first, the five-minute limit held across server processes by a kept read and a lock, a filing making a read due, and the token never printed)
  - `memory-test` for storage (`memory.ts`, and that a finding the person labels not a bug is kept and still dedups), finding dedup (`finding-dedup.ts`), merging two processes' memory (`memory-merge.ts`) and the memory directory (`memory-dir.ts`), and for what is masked or redacted before anything is written (`redact.ts` and `sensitive.ts`: which fields are secret, the mask their typed value gets, credential shapes, email addresses and card numbers), and the linear-time engine their patterns run on (`linear-regex.ts`: what it gives back for a lookaround, that those files and `credential.ts` use no JavaScript regular expression, and that each pattern reads a crafted 1 MB text within a bound, in a child process `scripts/linear-time-child.ts` stops at that bound; [ADR 28](docs/adr/0028-patterns-on-app-text-run-on-a-linear-time-engine.md); and the route, ticket, calibration and write-policy readers' patterns and those of the crawl, profile expiry, lane, finding dedup, postMessage and strict-write readers, written once as JavaScript source for `fromJs` in `js-regex.ts`, each held to a JavaScript `RegExp` of that source (and `statedRequests` and `leadsAway` to their old JavaScript forms), with no JavaScript regular expression in those files and the same 1 MB bound: [ADR 29](docs/adr/0029-more-readers-of-app-text-run-on-the-linear-time-engine.md))
  - `install-test` for the setup/doctor logic in `installer.ts`, for the plugin manifests (the optional mod's marketplace entry, version and settings, and which hooks its `register` adds for which settings), for what the README, the website, the skill and the desktop extension say each write mode lets out (no more than the policy enforces) and for the plugin's and extension's links to what each install reaches, for what a command line asks for before any command runs (`--help` on every subcommand, unknown flags, an address in place of a command), and for the first run's options, its write mode, caps, the check it runs, the one browser build it downloads, and where its report is written and which folders it may write into
  - `profiles-test` for the sign-in profiles `scenescout login` saves (role names, where a profile lives, its owner-only mode and git-ignoring, what may be printed about it, how sessionStorage is captured beside the storage state and put back by origin, how `scout_attach` turns `role` into the file it loads, and how long a profile lasts against a run: cookie dates, JWT `exp`, when a lane brief is refused, and a guided check's sign-in health before it starts)
  - `refresh-test` for the refresh broker: which profile values are refresh tokens, when a request carries one and which requests count as the refresh call (a cookie alone never does, a static asset never does), the endpoints it learns from a rotated cookie, whether a session holding the lock sends it or swaps it for the current one, when a rotation counts as stored, and the lock itself, with a check across real processes
  - `scripted-login-test` for `scenescout login --script`: its environment and flags (a fixed code or a TOTP secret, and no password for a passwordless sign-in), the RFC 6238 code, which field is the username, password or code (one field, or one box per character), which button moves the form on, when the form has signed in or been refused, and the credential redaction, and how the smoke suites find a credential left in a saved file
  - `live-test` for the per-session status board and the rules the live view's server keeps (loopback, token, read-only, one screencast per watched session), the status pane's data and page (a guided check's progress in it included), and for the optional Claude Code mod's pane and lane-model rules in `mods/scenescout-mod/hooks/pane.js`, run against the server's real status output, and its guided panel's rules in `mods/scenescout-mod/hooks/guided.js` (every panel state drawn on every surface's element table, what each button asks for, the question before Claude's own writing calls, and its words held equal to the engine's), and the run around it in `mods/scenescout-mod/hooks/run.js` (the band above the prompt and the status line, when the mod polls with the panel closed, the queue's order, that a queued check keeps its own care level and needs its own confirmation, that its start never moves the person nor changes the plan the results act on, Back on its preview, that a page's words reach no surface as terminal codes, the cost estimate before Start and the usage limit (from fixture usage with and without subscription windows), and when the filed tickets are polled; `claude plugin validate` and `claude plugin test mods/scenescout-mod` mount the same panel in Claude Code's own test kit, in the `mod-check` workflow)
  - `demo-test` for the demo app's server rules and its seeded defects, which the sample report depends on
  - `holdout-test` for the held-out benchmark app's server rules and planted defects, and that nothing it serves gives them away
  - `settle-test` for when a page counts as ready to read (the rule, and the waits after an action and before a bounce verdict, on a stand-in page)
  - `claims-test` for when a page contradicts the server (refused_empty, false_success)
  - `brief-test` for how the app is split between lanes and what each lane is told
  - `verify-test` for re-testing findings earlier runs left open, and for the guided re-check built on it (never above the care level a finding was found in, and never carrying over the original check's confirmation)
  - `tickets-test` for reading acceptance criteria from tickets (Given/When/Then, checklists, numbered and labelled criteria, a ticket with none), the checks on a verdict recorded against one, and the report's per-ticket section
  - `request-test` for what a replayed API call may be and where it may go
  - `pace-test` for how a run's time is measured
  - `limits-test` for how long an action and a page load may take (option over environment over default, the bounds, and what a timeout says, and what a scroll of a named target says when it could not run), and which failed page load is tried again, how long the retry has and what the result, a failure and the report say of it
  - `hygiene-test` for what may never be tracked: run output, saved logins, real email addresses, home-directory paths, credentials (and that every name a script imports from `src/` is exported there)
  - `guide-test` for the guide in `docs/guide/`: its configuration reference held equal to the CLI's options, the environment variables the code reads, the three actions' inputs, defaults and outputs, the `/scenescout qa` settings and the check's rules, every option, command and variable a page names, links and anchors, tables GitHub renders whole, no local paths, and the workflow and transform that publish it to the wiki (`mcp-check` holds the guide's `scout_*` tools and parameters, and its `scout_attach` table, to the live schemas)
- Keep logic that does not need Playwright OUT of `browser.ts` — it is the one file a test cannot reach without launching a browser. The modules below all exist because a rule living there can be table-tested; a rule living in `browser.ts` can only be smoke-tested. Add a line for a new module; don't extend another's line.
  - `fingerprint.ts`: route/element identity
  - `policy.ts`
  - `project-config.ts`: the operator's config file and what it lets an argument loosen
  - `route-guard.ts`: the write policy on the wire: the order the route handler applies its rules in, and when a write marks its page exercised
  - `policy-explain.ts`: `scenescout policy explain`, one request's verdict in each mode, from the route handler's own functions
  - `ownership.ts`
  - `uploads.ts`
  - `journey.ts`
  - `reaper.ts`
  - `dispatch.ts`
  - `fixtures.ts`
  - `authloss.ts`
  - `hover.ts`
  - `collector.ts` (the in-page collector) and the modules it re-exports (`page-sources.ts`, `collector-elements.ts`, `geometry.ts`, `page-content.ts`, `frames.ts`)
  - `lane.ts`: the lane report
  - `calibration.ts`: whether a lane's confidence held up
  - `bench.ts`: scoring a run against an answer key
  - `dedup.ts`: scoring finding dedup on pairs the key labels, and the model judge the store asks
  - `check.ts`: the deterministic check's rules and gate
  - `sarif.ts`: which repository file a SARIF result points at
  - `ci.ts` and `provider.ts`: an unattended run's rules and the model APIs' message shapes
  - `export.ts`: which findings an export files, what each issue says and the marker that dedups it
  - `ticket-preview.ts`: filing tickets from a guided surface: a preview's identity, expiry and binding to its findings, and the person's confirmation form
  - `ticket-status.ts`: reading filed tickets back: which places a record names, a project's tickets newest first, and the kept read that limits each project to one tracker read every five minutes
  - `recap.ts`: the end-of-check card: its figures from an ended guided check, the SVG drawn from them with every figure and the address escaped, and its save, only into a real `.scenescout/` folder and replacing a link at `recap.svg` rather than writing through it (report-test, against `scripts/golden/recap.svg`)
  - `mods/scenescout-mod/hooks/game.js`: the mod's optional game layer: off unless set to `on`, the bestiary from the cards, and drawn beside the cards without changing their words (live-test)
  - `ci-lanes.ts`: splitting an unattended run into lanes
  - `capture.ts` and `png.ts`: an element's picture and the pixel diff of two
  - `baseline.ts`: visual baselines: what is pictured, where it is kept and when it is met
  - `check-replay.ts`: a recorded check's replay page: steps to captions and results, the frame cap, redaction and the page
  - `check-report.ts`: the test report a template lays out from a recorded check: the template's schema, the page, its deviations and its evidence manifest
  - `film.ts`: filming a flow into a video, and what a failed start or stop leaves
  - `flow.ts`: the saved-flow format a check replays, and what counts as a match
  - `pace.ts`: how a run spent its time
  - `limits.ts`: how long an action and a page load may take, and which failed page load is tried again
  - `tcp-table.ts`: reading the machine's TCP table into one line for a log
  - `request.ts`: what a replayed API call may be and where it may go
  - `live.ts`: the live view, reached through a provider so it is tested over real HTTP with no browser
  - `settle.ts`: when a page is ready to read, and the waits that apply it
  - `snapshot-collect.ts`: reading the page's interactables into a snapshot: their refs and the snapshots kept for diffs
  - `guided.ts` and `guided-words.ts`: the guided assistant's choices, its plan, a re-check's plan, when a confirmation is needed, and every fixed sentence it shows
  - `saved-checks.ts`: a saved guided check's schema and its file
  - `progress.ts`: a guided check's progress, and which cards a person is shown
  - `claims.ts`: when the page contradicts the server
  - `challenge.ts`: when a bot-protection challenge answered in the app's place
  - `injection.ts`: typed markup coming back as an element
  - `csp.ts`: the Content-Security-Policy a saved page carries
  - `sensitive.ts`: which fields are secret, the mask their typed value gets, and the email, phone and card-number redaction
  - `linear-regex.ts`: the linear-time regular expressions redaction and the credential check run on, and how a lookaround is written for them
  - `credential.ts`: whether text a person wrote into the guided choices holds a credential
  - `memory-scrub.ts`: cleaning what an older engine kept in clear, once
  - `secret-pixels.ts`: which fields a picture paints over
  - `postmessage.ts`: a token posted with targetOrigin "*"
  - `brief.ts`: splitting the app between lanes
  - `verify.ts`: re-testing what earlier runs left open
  - `tickets.ts`: reading tickets' acceptance criteria and answering each
  - `profiles.ts`: the sign-in profiles a role attaches by
  - `refresh.ts`: the refresh broker's lock and decisions
  - `expiry.ts`: how long a saved profile will last
  - `scripted-login.ts`: a CI sign-in's rules: its configuration, TOTP or a fixed code, field choice and redaction
  - `unload.ts`: which writes a page sends as it is left the policy refuses
  - `strict-writes.ts`: the opt-in strict write classifier and destructive page loads
  - `crawl.ts`: whether a crawled path joins the route list, and its summary line
  - `teardown.ts`: closing a session's browser within a bound without losing it
  - `best-effort.ts`: reading a live page that may navigate or close under the read, and a bounded wait on work that may never finish
  - `src/commands.ts`: help and unknown flags, settled before a subcommand runs
  - `src/first-run.ts`: the first run's options, mode, caps and download, the folders it may write its report into, and the three issues it leads with
  - `src/browsers.ts`: which browsers exist and how each differs
- **An oracle needs a contrastive pair, not just a positive case.** Write two fixtures that are as nearly identical as you can make them and differ in the ONE fact that flips the verdict, then assert both directions. `test-app/contradiction.html` and `contradiction-honest.html` are the model: same refused request, same empty table, same affirmation words, and the only difference is whether the page admits the error. Half that suite's checks are on the honest page, because an oracle's false-positive rate is what decides whether anyone believes its findings, and a suite that only tests the positive case cannot measure it. This is worth the second fixture for anything filed at high severity.
- **A change meant to make runs better is measured, not asserted.** `npm run bench` scores a run of the demo app against [its answer key](demo-app/answer-key.json); record the before and after in [docs/benchmark.md](docs/benchmark.md), including changes that did not help. The [held-out app](holdout-app/) (`npm run bench -- --app holdout`) is the check that a gain generalises: report its runs, and never tune the engine, the skill or a lane brief against it, or read its key while writing briefs for it. A single run is noisy, so say so beside any small delta. When a run finds something real the key does not know, or reports something the key should call a non-defect, add it to the key in the same change — with an example it must match and, where a near miss exists, a counter-example it must not — then re-score every archived run with `npm run bench -- --all`, so the before and after rows share one key.
- Write the test so it FAILS against the old behaviour — revert the fix, watch it go red, put the fix back. A test that passes either way documents nothing.
- Releases are driven by Changesets: a user-visible change carries a changeset (`npx changeset`), and nobody edits the version or `CHANGELOG.md` by hand — the release workflow generates both. The commit style `vX.Y.Z: <summary>` is retired; describe the change instead.

## Pinned dependencies

- **typescript stays on 5.x.** TypeScript 7 was tried and reverted: it breaks this project's module resolution (`Cannot find name 'node:fs'` and cascading implicit-any errors). The caret range `^5.9.3` prevents an accidental jump, but `npm install typescript@latest` would still do it — re-test the build before changing that line.
- **zod stays on 4.x, at 4.6.6 or later.** Every 3.x and every 4.x before 4.6.6 builds one issue per bad element before it checks an array's `.max()`, so an oversized array can exhaust memory ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)); 4.6.6 checks the bound first. `@modelcontextprotocol/sdk` 1.x accepts zod `^3.25 || ^4.0` and turns a v4 schema into the tool's JSON Schema with zod's own `toJSONSchema`, which leaves `additionalProperties` off an object that strips unknown keys (3.x printed `false` there; what a call may carry is unchanged).
- **playwright stays on 1.63.** On 1.64 a click on a link whose navigation is answered with `204 No Content` never returns, so the engine's own click would hang ([#487](https://github.com/brunoboto96/SceneScout/issues/487)). The published range is therefore `~1.63.0`, which no install resolves to 1.64, and `.github/dependabot.yml` ignores 1.64.x; a bump to it is declined until a release fixes that. Then widen the range, drop this line and the ignore together (`install-test` holds the range to this line, so changing one alone fails; a later hold changes its `HELD_PLAYWRIGHT_MINOR`), and re-run the smoke suite on all three browsers.

## More than one browser

The engine drives Chromium, Firefox and WebKit. CI runs the browser suite on all three on every push to `main` and every release; a pull request runs Chromium on Linux and Windows only, unless it carries the `full-ci` label or changes `src/browsers.ts` or `src/engine/browser.ts` ([ADR 26](docs/adr/0026-a-pull-request-runs-the-cells-it-can-break-and-main-runs-them-all.md)). Add the label to a pull request whose behaviour may differ between engines. A rule that depends on the browser goes in `src/browsers.ts` as a function of the engine name, with a table test in `install-test`, and the smoke check reads `BROWSER` from the harness to assert the right thing for each. Run one locally with `SCENESCOUT_BROWSER=webkit npm run smoke` after `node dist/cli.js install --browser-only --browsers webkit`.
