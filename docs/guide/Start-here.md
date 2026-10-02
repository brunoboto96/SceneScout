# Start here

## A first look, with nothing set up

All it takes is Node 20 or newer and the address of an app you are allowed to test, on your machine or deployed:

```bash
npx -y scenescout http://localhost:3000
```

No model, no API key, no MCP client and no setup step:

1. **The browser, if it is missing.** It downloads the headless Chromium build once (about 200 MB) and changes nothing else on the machine: no skill, no MCP server registration, no command on your PATH.
2. **A look that sends nothing.** It runs in `observe` mode, so nothing but reads leaves the page, signing in and refreshing a token apart. It visits the start page and the pages it finds by following links, up to 20 pages and starting none after 3 minutes, and measures each one by the [check rules](Configuration-reference.md#check-rules): failed requests, uncaught errors, dead ends, controls covered or out of reach, fields with no label, contrast and more. It fills in no form and reads nothing from the folder it runs in.
3. **A report.** It writes `scenescout-report/report.md` (and `check.json`) in the current folder, then prints a summary that opens with the three issues to look at first. It writes only into a `scenescout-report/` that is new, empty or an earlier first look's; any other folder of that name is left alone, and `--out` names another. On the demo app below:

```text
Look at these first:
  1. [medium] Request failed with a client error: GET /img/weekly-chart.png → HTTP 404 (on /)
  2. [medium] Dead end: /reports-scheduled.html: 0 controls (on /reports-scheduled.html)
  3. [medium] Control covered by pinned chrome: button "Save notes" is COVERED by pinned chrome [order-stickybar] at this scroll position — a click aimed at it lands on that element instead (on /order.html?id=1042)

12 pages looked at in 12 s in observe mode: 0 high · 6 medium · 2 low · 5 worth a look, never counted.
Report: scenescout-report/report.md
```

The three are chosen by severity, then by how many pages show the issue, and one failure seen several ways takes one of the three places: a missing image is a failed request, a broken image and the browser's console line about it. The counts and the report list every issue, the pages it looked at and what it found but did not reach. It exits 0 whatever it finds, because it is a look and not a gate, and 2 when the address cannot be reached or the report cannot be written. After the address, `--max-routes` and `--max-minutes` raise the limits, and `--mode read-only` lets through the plain POSTs a page sends as it loads ([its options](Configuration-reference.md#scenescout-url)).

A first look only opens pages. Everything below is the full setup: your coding agent drives SceneScout to click, fill forms, compare roles and remember what it learned, and [`scenescout check`](Ways-to-use-it.md#scenescout-check-a-gate-in-ci) gates pull requests with the same measurements.

## What SceneScout is

SceneScout tests a running web app the way an exploratory tester does: it opens pages, clicks, fills forms, compares roles and writes down what is wrong. It does this as an MCP server, so the thinking is done by the coding agent you already use and pay for. The engine itself contains no language model.

```text
your agent  ──MCP──▶  SceneScout engine  ──▶  a real browser on your app
(intent, judgement)   (tools, checks, memory, report)
```

What the engine adds to an agent with a browser:

- **A structured view instead of screenshots.** A snapshot lists every element with its role, name, state (pressed, selected, checked, expanded) and layout box, what the page announces in its alert and status regions, and a line on what the main area holds. Overlapping controls, a button pushed off-screen or an image that failed to load are computed from the page, not guessed from pixels.
- **Checks after every action.** Console errors, uncaught exceptions, failed requests and HTTP errors are reported with each tool result, along with checks for a page that contradicts the server (an empty list after a refused request, "Saved" after a refused save).
- **A write policy on the network.** By default nothing existing is changed or deleted, whatever the agent clicks. See the [safety model](Safety-model.md).
- **Memory across runs.** Pages, findings and notes are kept in `.scenescout/` in the project, so the next run starts from what the last one learned.
- **A report that says what was not tested.** Its gap ledger lists routes never visited, forms never submitted and pages never audited, and at the `extensive` level the report refuses to finish while any remain.

It finds defects (crashes, dead ends, permission leaks, double submits) and it also reports on quality: contrast, focus, spacing, how many steps a task takes and where users would backtrack.

## Install

You need Node 20 or newer, an MCP client, and a web app you are allowed to test.

### With npm (any client)

```bash
npx -y scenescout install                     # Claude Code: skill, MCP server and Chromium
npx -y scenescout install --client cursor     # or vscode, codex, gemini, copilot, windsurf; comma-separated for several
```

`install` downloads the browser (Chromium by default, about 550 MB, once), registers the server with the client you named and puts the `scenescout` command on your PATH. Claude Code also receives the testing method as the `/scenescout` skill; every other client receives the same text from the server through the `scout_playbook` tool and the `explore` prompt. Steps can be skipped with `--no-register`, `--skip-browser` or `--no-command`, and `--browsers` chooses what to download (see [choosing browsers](Configuration-reference.md#scenescout-install)).

### As a Claude Code plugin

```text
/plugin marketplace add brunoboto96/SceneScout
/plugin install scenescout@scenescout-marketplace
```

Then download the browser once with `npx -y scenescout install --browser-only`, and start a new chat to use SceneScout. The command becomes `/scenescout:scenescout`.

### As a Claude Desktop extension

Download `scenescout-X.Y.Z.mcpb` from the [latest release](https://github.com/brunoboto96/SceneScout/releases/latest) and open it, or in Claude Desktop choose Settings > Extensions > Advanced settings > Install Extension and pick the file. It is ready as soon as it is installed: start a new chat and ask *"Use SceneScout to test http://localhost:3000"*. Tell it which folder to keep its notes and report in, for example a new folder in Documents.

The extension carries the engine; the browser it drives is downloaded once, from a terminal, with `npx -y scenescout install --browser-only`. If the browser is missing, SceneScout says so on the first test and gives that command. `npx -y scenescout doctor` recognises the extension and checks it.

### A client that `install` does not know

Run `npx -y scenescout install --browser-only`, then add a stdio server to the client's configuration whose command is `npx -y scenescout serve`. Most clients accept this shape:

```json
{
  "mcpServers": {
    "scenescout": { "command": "npx", "args": ["-y", "scenescout", "serve"] }
  }
}
```

### Check the setup

```bash
npx -y scenescout doctor            # Claude Code: node, build, browser, skill, registration
npx -y scenescout doctor --engine   # any other client: node, build, browser
```

Every line should be a tick; any other line prints the command that fixes it. With the Claude Desktop extension installed, `doctor` also checks the extension, and does not ask for the Claude Code skill or registration unless you have set those up too. Then start a new chat in your client.

## A first run against the demo app

The repository ships a small order-desk app with defects planted on purpose. It needs no dependencies:

```bash
git clone https://github.com/brunoboto96/SceneScout.git
cd SceneScout
npm run demo:serve         # http://127.0.0.1:4173
```

It has three roles, picked on its sign-in page: a clerk who takes orders, a manager who approves them and an auditor who only reads. The [demo app's README](../../demo-app/README.md) lists every planted defect; read it after your run if you want to see what was missed.

In a second terminal, open your agent in the cloned folder and ask:

```text
Use SceneScout to test http://127.0.0.1:4173 at medium level
```

In Claude Code the skill also gives a command:

```text
/scenescout --level medium --url http://127.0.0.1:4173
```

What happens next, in order:

1. **Scan.** `scout_scan` reads the project: framework, routes found in the source, saved logins. The demo is plain HTML, so it finds no framework and the route list is built from links instead.
2. **Attach.** `scout_attach` opens a browser in a write mode (`read-only` for a local app). Its result has a `Live view:` line with an address; the agent passes it on to you.
3. **Crawl.** `scout_crawl` visits every known route in one call and reports each one's status, element count and problems. A route that landed on another page is marked `REDIRECTED`, and a path crawled by name that answers as a page joins the route list.
4. **Investigate.** The agent follows up on what the crawl flagged: it navigates, snapshots, reproduces, and files each defect with `scout_finding`.
5. **Measure.** `scout_design_audit` scores representative pages; `scout_journey` measures how many steps a task takes, how long it took while being worked on (pauses over 30 seconds are left out and counted), and whether the user had to backtrack.
6. **Report.** `scout_report` checks the level's contract and writes `.scenescout/report.md`.

A `medium` run is sized at around 150 actions. On the demo it typically finds the 500 behind the Archived filter, the badge covering a button, the double-click that creates two orders and the approve endpoint that accepts a clerk, among others; how many of the planted defects a run finds varies from run to run, which is what [Measuring it](Measuring-it.md) is about.

## Levels

The level is a contract that `scout_report` enforces for what the engine can see, and the gap ledger discloses the rest.

| Level | What it asks for |
|---|---|
| `minimal` | Every route visited, at least one design audit, the main journeys walked, problems from the crawl triaged |
| `medium` (default) | minimal, plus design audits across several routes, every kind of control exercised and every form submitted valid and invalid |
| `extensive` | medium, plus fuzzing, back and refresh resilience, a keyboard-only pass, a journey per module, two or more roles compared and the signed-out pages walked. The report refuses to finish while the gap ledger has entries |

## Reading the report

`.scenescout/report.md` is written worst first:

- **Summary**: open findings, route coverage, design audits, oracle violations, and how many errors the write policy itself caused (these are not counted as the app's).
- **Page quality scores**: 0 to 100 per audited route, for accessibility, craft, consistency and task clarity, worst first.
- **Gap ledger**: what was not tested. Treat it as the honest limit of the run, not as noise.
- **Findings**: each with a severity, category, the evidence as a machine signature (`GET /api/orders?status=archived → HTTP 500`), where it happened, a repro trace of the last actions and a Playwright regression-test skeleton.
- **Worth a look**: observations that are defects only under a convention the run cannot see, such as a 4px spacing scale. They are listed and never counted as defects.
- **Role capability matrix**: which role could reach what, on a run with more than one role.
- **Pace and lane calibration**: on a parallel run, how the time was spent and whether each lane's stated confidence matched what was filed.

[examples/report.md](../../examples/report.md) is a complete report from the demo app.

Each finding is filed with a picture of what it is about: the element the agent names, with a margin around it, or the page as it was. The picture is kept in `.scenescout/recordings/`, shown under the finding in `.scenescout/report.html`, and returned with the agent's `scout_finding` result, so a chat client shows the evidence as it is filed. Pictures are held to 800 pixels on their longer side and 200 KB, and a session returns the first 10 in the conversation; later ones are kept and in the report. `scout_attach {evidence: "file"}` keeps them out of the conversation, `{evidence: "off"}` takes none, and a CI job keeps them on file by default. The [configuration reference](Configuration-reference.md#environment-variables) has the settings. A picture shows whatever the page showed, and the engine's secret redaction reads text, not pixels: on a page that displays secrets, turn pictures off.

Findings stay in `.scenescout/memory.json`. The next run skips states already covered, deduplicates findings on their evidence and lists older findings as an index; `scout_report {history: "full"}` prints every one in full. `.scenescout/` writes its own `.gitignore`, so a `git add -A` in the project does not pick it up.

## The live view

Every attach starts a small local page that shows each session: the tool it is running and for how long, the page it is on as a thumbnail, and a feed of what it just did. A call stuck past its time budget turns its card red. The report button shows the report as it stands mid-run.

```bash
scenescout watch            # open the live view for the project in this folder
scenescout status           # the same information as text
```

The page is served on `127.0.0.1` only, behind a token that changes on each start, and answers `GET` and nothing else. No frame it shows is written to disk. `SCENESCOUT_LIVE=off` in the server's environment keeps it closed.

To keep a copy of the whole run, ask for a recording (`Use SceneScout to test … and record the run`, or `scout_attach {record: true}`). The engine then keeps a frame after every action, and `.scenescout/report.html`, the self-contained page `scout_report` writes beside the report, shows the screenshots around each finding and each session's trail. Recording is off by default because frames are pictures of the app, which the engine's secret redaction cannot read. A team that wants every QA run recorded sets `SCENESCOUT_RECORD=on` in the server's environment once.

## Next

- Test your own app: [Ways to use it](Ways-to-use-it.md), then the [recipe](Recipes.md) closest to your project.
- If your app needs a sign-in: [Signing in](Signing-in.md).
- Before pointing it at anything with real data: [Safety model](Safety-model.md).
