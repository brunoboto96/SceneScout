<div align="center">

# 🔭 SceneScout

**Exploratory UI testing, driven by an AI agent.**

[![test](https://github.com/brunoboto96/SceneScout/actions/workflows/test.yml/badge.svg)](https://github.com/brunoboto96/SceneScout/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >= 20](https://img.shields.io/badge/node-%E2%89%A5%2020-339933?logo=node.js&logoColor=white)
![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2)

[✨ Why](#-why-its-different) · [🎯 Two ways to use it](#-two-ways-to-use-it) · [🚀 Quickstart](#-quickstart) · [🧰 Toolbox](#-the-toolbox) · [🔒 Safety](#-safety-model) · [🩺 Troubleshooting](#-troubleshooting)

</div>

SceneScout is an [MCP](https://modelcontextprotocol.io) server that hands an agent a *structured view* of a running web app — every element, its geometry, and a set of always-on correctness oracles — and lets the agent explore it like a curious user. Claude Code is the brain; SceneScout is the hands, eyes, and memory.

```
┌─────────────────────┐   MCP (stdio)   ┌───────────────────────────────┐
│ Claude Code + skill │ ──────────────▶ │ SceneScout engine             │
│ (intent, judgment,  │ ◀────────────── │ Playwright · oracles · memory │
│  your subscription) │  tool results   │ findings · report — no LLM    │
└─────────────────────┘                 └───────────────────────────────┘
```

Scripted E2E suites answer one question — *"does this exact flow still work?"* — and say nothing about the 95% of the app they don't touch. SceneScout covers both gaps: it finds what's **broken** (crashes, dead ends, permission leaks) *and* reports how the product could be **better** (confusing flows, weak hierarchy, design-system drift), with concrete measurements.

---

## ✨ Why it's different

- 🧠 **Claude is the brain — no API key.** The engine contains no LLM. Exploration runs on your Claude Code subscription; SceneScout just gives it deterministic tools.
- 📐 **Structured scene, not pixels.** The agent reads element lists *with layout geometry*, not screenshots. Overlap and off-screen bugs are computed from boxes — deterministic, no vision guessing. (Screenshots exist only for pixel-native residue like broken images.)
- 🛡️ **Read-only by default, enforced on the wire.** Destructive actions are blocked at the network layer, not by asking the model nicely. Opt into writes only against disposable data.
- ✅ **Completion is a contract, not a vibe.** The engine knows the app's routes and *refuses* to file an "extensive" report while any known route is unvisited, unexercised, or un-audited. "Explored a bit and stopped" is structurally impossible.
- 🧭 **It remembers.** UI states are fingerprinted and stored in the project's `.scenescout/`. Run N+1 skips what run N already covered, and every run starts smarter than the last.

---

## 🎯 Two ways to use it

SceneScout needs only a URL. Give it the source code as well and it gets noticeably better.

| | 🏠 **Next to the codebase** *(recommended)* | 🌐 **Against a remote URL** |
|---|---|---|
| **You run it from** | the app's repository | any folder — an empty `qa/` directory is fine |
| **It plays the role of** | a developer-tester who can read the code | a black-box QA tester, like a person with a browser |
| **How it finds pages** | 📂 reads file-based routes from the source (Next.js, SvelteKit, Nuxt) **and** follows links. Code-routed apps fall back to links | 🔗 follows same-origin links only — pages nothing links to, or on another subdomain, stay unknown |
| **"Did we cover everything?"** | checked against the routes found in source *plus* discovered links — an unvisited one blocks the report | checked against the pages it managed to discover |
| **Setup it figures out** | framework, dev command, saved Playwright logins (`playwright/.auth/`), whether the app uses `data-testid` | none — you pass the URL, and the path to a login state if the app needs one |
| **What a finding looks like** | the symptom, **plus** the file behind it and a suggested fix | the symptom, a repro trace, and a regression-test skeleton |
| **Typical target** | `localhost` while you build | staging, a preview deploy, a client's site |

**Why the codebase helps.** The agent driving SceneScout is Claude Code, which can already read your repository. With the source at hand — and a file-routed framework — it knows the app's static routes before opening the browser, so coverage is measured against the real app instead of whatever happened to be linked. It can also check a suspicion against the code before reporting it: "there is no way to export this table" is a much stronger finding once the agent has confirmed no export handler exists. And when something breaks it can open the component or handler responsible and tell you *where* and *how* to fix it — "the save button does nothing" becomes "`OrderForm` swallows the rejected promise in `onSubmit`; surface the error and re-enable the button".

**Why it still works without it.** Everything SceneScout *observes* comes from the running page — elements, layout geometry, console and network errors, design-audit scores, task-ease measurements — and none of that needs source code. Point it at a URL you are allowed to test and it behaves like a thorough QA tester: it explores, reproduces, and files findings with evidence.

```
# next to the code — run inside the app's repository
/scenescout --url http://localhost:3000

# remote — run from any folder; memory and the report are kept there
/scenescout --url https://staging.example.com --role ./auth/qa.json
```

> [!IMPORTANT]
> Only test sites you own or are authorized to test. A remote environment is more likely to hold real data. The default **read-only** mode blocks `PUT`/`PATCH`/`DELETE` and destructive-looking requests, but an ordinary form submission (a plain `POST`: contact form, comment, order, signup) still reaches the server and can create a record. On a site with real data, tell the agent which forms not to submit. See the [safety model](#-safety-model).

---

## 🚀 Quickstart

### 📦 Prerequisites

| | |
|---|---|
| **Node** | ≥ 20 |
| **Claude Code** | installed and signed in ([get it here](https://claude.ai/code)) |
| **A web app to test** | SceneScout tests a *live* app: start yours locally first (e.g. `npm run dev`, `make dev-up`), or have the URL of a deployed one you're allowed to test |

### 1️⃣ Install

```bash
git clone https://github.com/brunoboto96/SceneScout.git scenescout && cd scenescout
npm install        # installs dependencies and builds
npm run setup      # skill + Chromium + MCP registration, in one step
```

`npm run setup` does three things, and tells you which ones it did:

1. links the `/scenescout` skill into `~/.claude/skills/` (or `$CLAUDE_CONFIG_DIR/skills/`) — a `scenescout` folder it didn't create is moved aside to a `.backup-…` copy, never deleted,
2. downloads the Chromium build SceneScout drives (one-time, ~150 MB — skipped if you already have it),
3. registers the MCP server with Claude Code at user scope, using an **absolute** node path so it works under nvm/fnm.

Re-run it any time: after moving the folder or switching node versions it refreshes the stored paths. It exits non-zero if any step failed, so `npm run setup && …` is safe to chain.

### 2️⃣ Check it

```bash
npm run doctor
```

Every line should be a ✓. Anything that isn't prints the exact command that fixes it. Then **start a fresh Claude Code session** so it picks up the new tools.

<details>
<summary>Registering the MCP server by hand</summary>

If `claude` isn't on the PATH of the shell you ran setup from, setup prints this command instead of running it:

```bash
claude mcp add --scope user scenescout -- "$(which node)" "$(pwd)/dist/mcp-server.js"
```

Opt out of individual steps with `npm run setup -- --no-register` or `-- --skip-browser`.

</details>

### 3️⃣ Run it

From Claude Code, inside the project you want to test (or, for a [remote URL](#-two-ways-to-use-it), any folder):

```
/scenescout --level medium --url http://localhost:3000 --role qa
```

The skill scans the project (if there is one), attaches read-only, explores, and writes findings to `.scenescout/report.md`. That's it.

**Common flags** — `--level minimal|medium|extensive` · `--url <app>` · `--role <name\|path>` (a Playwright storage-state to explore as: a name found by the scan, or a path to the JSON file) · `--safe-write` / `--allow-destructive`.

---

## 🔄 How a run works

One curiosity loop, repeated — breadth first, then judgment where it matters:

```
scan ──▶ attach ──▶ crawl ──▶ investigate ──▶ measure ──▶ report
 │         │          │            │              │           │
routes   browser   every route  reproduce &   journeys +   gap-checked
& auth   (r/o)     in ONE call   file findings  design audit  markdown
```

1. **Scan** the project — framework, routes, auth states.
2. **Attach** a browser (read-only unless you said otherwise).
3. **Crawl** every known route in a *single* call — per-route HTTP status, element counts, oracle violations, dead ends.
4. **Investigate** what the crawl flagged: navigate, snapshot, reproduce, file a structured finding.
5. **Measure** task ease (`scout_journey`) and design quality (`scout_design_audit`) on representative pages.
6. **Report** — the engine checks the gap ledger and writes `.scenescout/report.md`.

Snapshots are cheap: re-snapshotting a route returns only *what changed*, with stable refs (measured on a 130-element page: 10.7 kB → 0.7 kB).

---

## 🧰 The toolbox

24 deterministic tools. The agent picks; you rarely call these by hand.

| Phase | Tools | What they do |
|---|---|---|
| **Set up** | `scout_scan` `scout_attach` `scout_session` | Discover routes; launch a browser in a write-mode; keep several authenticated roles alive at once |
| **Explore** | `scout_crawl` `scout_coverage` | Sweep every route in one call; ask what's still untested |
| **Look** | `scout_snapshot` `scout_hover` `scout_screenshot` | Read the structured scene (diffed); reveal tooltips/hover cards; capture pixels only when needed |
| **Act** | `scout_click` `scout_type` `scout_select` `scout_upload` `scout_press` `scout_scroll` `scout_navigate` `scout_back` `scout_run_plan` | Drive the UI like a user; `scout_run_plan` batches a whole mechanical sequence into one call |
| **Assess** | `scout_design_audit` `scout_journey` | Score a page's craft/a11y/consistency; measure how hard a task is to complete |
| **Record** | `scout_note` `scout_finding` `scout_resolve` `scout_report` | Curate durable notes; file deduped findings; mark fixes; generate the report |
| **Close** | `scout_close` | Tear down one session or all |

A few that punch above their weight:

- **`scout_crawl`** — the entire breadth pass in one tool call. No visiting routes one-by-one.
- **`scout_run_plan`** — up to 20 actions (fill form → submit → check) with semantic targets (`testid=…`, `text=…`), aborting at the first anomaly.
- **`scout_journey`** — wraps one goal and reports interaction count, screens seen, and **backtracks**; an abandoned journey is a finding no passing E2E suite can produce.
- **`scout_upload`** — generates a *valid* in-memory fixture (real PDF/PNG, kind inferred from `accept`) so file-upload flows stop being a blind spot.
- **`scout_click {clicks: 2}`** — the impatient-user probe: states whether a double-click fired the same state-changing request twice (the classic double-submit bug).

---

## 📊 Test levels

Each level is an **enforced contract** — `scout_report` checks it before finalizing.

| Level | What it guarantees | Rough size |
|---|---|---|
| `minimal` | Every route visited, ≥1 design audit, key journeys as plans, crawl problems triaged. Remaining gaps **disclosed**. | ~40 actions |
| `medium` *(default)* | minimal + design audits across several routes + every element class exercised + every form submitted valid **and** invalid | ~150 actions |
| `extensive` | medium + fuzzing, back/refresh/deep-link resilience, keyboard-only pass, a journey per module, ≥2 roles compared, anonymous auth-surface walk. **Refuses to finalize while any gap remains.** | budget-capped |

That refusal *is* the guarantee: an extensive report can only exist when nothing known was left untested.

---

## 🔒 Safety model

- 🟢 **`read-only` by default.** Destructive-labeled elements (delete/revoke/archive/…) **and** all `PUT/PATCH/DELETE` + destructive `POST`s are blocked at the network layer — see [`src/engine/policy.ts`](src/engine/policy.ts). Non-destructive `POST`s are allowed, because submitting forms is how a tester finds validation bugs — so read-only means *nothing existing is changed or removed*, not *nothing is ever created*.
- 🟡 **`safe-write`** (`--safe-write`) lets the agent create data and edit/delete **only what it created** this run — never pre-existing records.
- 🔴 **`destructive`** (`--allow-destructive`) allows everything, and only ever when *you* confirm the environment is disposable. The skill will never choose this itself.
- 📂 Findings, memory, and reports live in a `.scenescout/` folder where you ran it. It ignores itself in git, so a stray `git add -A` never commits test data.

A `🛡 WRITE-POLICY blocked` notice is the safety net doing its job, not an app bug.

---

## 📋 What you get

`.scenescout/report.md` — a deduplicated, worst-first report with:

- 🐛 **Findings** with repro traces and generated Playwright regression-test skeletons.
- 💯 **Page scores** (0–100: a11y · craft · consistency · task-clarity), ranked worst-first, with stale scores from old runs marked as such.
- 👥 **A role capability matrix** — what each role could and couldn't reach.
- 🧾 **A gap ledger** — everything *not* done, so the report is honest about its own coverage.

👀 Watch a run live: `node dist/cli.js status <project-path>`.

---

## 🩺 Troubleshooting

Run `npm run doctor` first — it checks every setup item below (everything but the last row, which is about your app) and prints the fix.

| Symptom | Cause and fix |
|---|---|
| `/scenescout` isn't a known command | The skill isn't linked, or the session predates it. `npm run setup`, then start a **fresh** Claude Code session. |
| The `scout_*` tools don't appear | The MCP server isn't registered, or points at an old path. `npm run setup` re-registers it; `claude mcp list` should show `scenescout` as connected. |
| `npm install` fails at the build step | The build needs the dev dependencies (TypeScript). Don't pass `--omit=dev` or set `NODE_ENV=production` when installing from a clone. |
| *"Executable not found in $PATH"* | The server was registered with a bare `node`. `npm run setup` registers the absolute path. |
| *"Executable doesn't exist … chromium"* | The browser download was skipped or failed. `npx playwright install chromium` (on Linux add `--with-deps`). |
| Tools broke after moving the folder or changing node version | The registration stores absolute paths. `npm run setup` refreshes them. |
| Attach fails or every route lands on the login page | Your app isn't running at `--url`, or the `--role` storage state has expired — regenerate it the way your project's Playwright setup does. |

### ⬆️ Upgrading from an older version

- **Tools are now `scout_*`.** Up to v0.23 they were prefixed `ft_`. The rename happened before the first npm release, with no aliases, so an agent's context carries one tool list rather than two. Re-run `npm run setup` so the installed skill matches the server.
- **Earlier names.** This tool was previously called SceneCraft (and, before that, frontend-tester). `npm run setup` cleans up after both: it removes the old skill link and the old `scenecraft` MCP registration when they point at this install, and the first attach in a project moves its `.scenecraft/` memory folder to `.scenescout/` so earlier coverage and findings carry over.

### 🧹 Uninstall

```bash
claude mcp remove --scope user scenescout
rm -rf ~/.claude/skills/scenescout
```

Then delete the clone. Per-project memory lives in each tested project's `.scenescout/` folder; delete it there if you want it gone.

---

## 🔌 Using it standalone

The engine is client-agnostic — any MCP client can drive it over stdio:

```bash
node dist/mcp-server.js            # start the MCP server
node dist/cli.js scan <path>       # just run project discovery
node dist/cli.js status <path>     # live status of a running engine
```

---

## 📁 Project layout

```
src/
  mcp-server.ts     the 24 tools + per-session dispatch
  scan.ts           project discovery (framework, routes, auth)
  cli.ts            scan · serve · install · doctor · status
  installer.ts      setup logic (skill link, MCP registration, diagnostics)
  engine/
    browser.ts      the engine class: attach, snapshot, actions, crawl, plans
    probes.ts       in-page scroll + overlay + focus probes (needs a browser too)
    fingerprint.ts  route + element-set identity (state hashing)
    oracles.ts      console/page/network/HTTP error detection
    policy.ts       the write-policy safety net
    ownership.ts    safe-write: which records did this run create?
    uploads.ts      disk uploads, fenced to the project by real path
    journey.ts      task-ease measurement from the action log
    design.ts       the design audit + page scoring
    memory.ts       cross-run storage + finding dedup
    report.ts       the gap ledger + report generation
    …               collector · dispatch · fixtures · authloss · reaper
scripts/            the 11 test suites (smoke/ holds the real-browser ones)
test-app/           fixtures for the real-browser smoke tests
skill/scenescout/   the Claude Code skill (SKILL.md)
docs/adr/           why it's built this way
```

> Design principle: logic that *doesn't* need Playwright lives outside `browser.ts`, so it can be unit-tested without launching a browser. That's why `fingerprint`, `policy`, `memory`, `report`, etc. are their own modules.

---

## 🧠 Design decisions

The load-bearing choices are recorded as ADRs — read the relevant one before changing a rule it covers:

- [1 · Completion is an enforced contract, not a claim](docs/adr/0001-completion-is-a-contract-not-a-vibe.md)
- [2 · The write policy is enforced on the wire, not in the prompt](docs/adr/0002-enforce-the-write-policy-at-the-network-layer.md)
- [3 · A gap-ledger entry must be actionable, and suppression must be visible](docs/adr/0003-a-noisy-ledger-is-a-broken-ledger.md)
- [4 · Findings dedup on machine signals, and a merge must never lose a finding](docs/adr/0004-dedup-on-machine-signals-not-prose.md)
- [5 · Testable logic lives outside `browser.ts`](docs/adr/0005-keep-testable-logic-out-of-the-browser-module.md)
- [6 · Nothing in this repo names or is tuned for a tested app](docs/adr/0006-stay-project-agnostic.md)

---

## 🔧 Development

```bash
npm run build     # tsc
npm test          # build + 11 suites: scan, oracle, policy, fixture, dispatch, design,
                  #                     contract, memory, install, smoke, mcp-check
npm run dev       # run the CLI from source (tsx)
```

Contributing? Start with [VISION.md](VISION.md) (what is in scope) and [CONTRIBUTING.md](CONTRIBUTING.md) (how changes land), then see [CLAUDE.md](CLAUDE.md) for the house rules — chiefly: bug fixes need a regression test at the cheapest layer that can fail, keep the repo project-agnostic (ADR 6), and `npm run build && npm test` must pass before committing.

## 🔐 Security

Found a way past the write policy, or another security problem? Please report it privately — see [SECURITY.md](SECURITY.md).

## 📄 License

[MIT](LICENSE).

<details>
<summary><strong>Full capability list</strong> — every behavior, for the curious</summary>

- **Structured render-state, not pixels.** Element lists with geometry; screenshots reserved for pixel-native residue (broken images, canvas).
- **Diff snapshots with stable refs.** Re-snapshots return only what changed (10.7 kB → 0.7 kB on a 130-element page); old refs stay valid.
- **Geometry oracles.** Overlap and off-screen defects computed from layout boxes.
- **Oracles after every action.** Console errors, page errors, failed requests, HTTP 4xx/5xx drained into every tool result.
- **Multi-role, genuinely concurrent.** Commands to *different* sessions run in parallel; safe-write ownership is shared, so role A can create what role B approves. The report renders a role capability matrix.
- **Task ease, not just correctness.** `scout_journey` measures interaction cost, distinct screens, path, and backtracks.
- **Design audit with page scores.** Two tiers (⚠ measurable defects / → craft suggestions incl. AI-slop tells), per-page 0–100 score persisted per route, plus an automatic overlay/modal probe on every snapshot. Shared shell scored once, separately.
- **Scrolls like a user — and notices when it can't.** Reports `SCROLL LOCKED` for a leaked modal scroll-lock, finds the real inner scroll pane on app-shell layouts, and flags `UNREACHABLE` controls clipped inside `overflow:hidden`.
- **Uploads like a user.** Answers a styled file-chooser or sets a hidden input directly, with a valid in-memory fixture; `filePath` is fenced to the project under test; files violating `accept` are flagged at selection.
- **Auth via Playwright storage states.** Expired tokens caught at attach; repeated login-bounces raise `SESSION AUTH LOST`; a bounced route is recorded as *not* covered — a dead session can't certify routes it never reached.
- **A trustworthy gap ledger.** Entries must be actionable (a search box or wizard sub-step isn't "form filled but never submitted"); API/download URLs never enter the route contract.
- **Honest reporting.** Shared chrome counted once, stale scores marked, role matrix compares only roles that actually attempted a route.
- **Cross-run written knowledge.** `scout_note` curates `.scenescout/ASSUMPTIONS.md` — app model, personas, constraints, risks — in prose.
- **Daemon-grade robustness.** Per-tool watchdogs, orphaned-browser reaping, bounded teardown, live status via `scenescout status <project>`.

</details>
