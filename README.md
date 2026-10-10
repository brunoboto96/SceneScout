<div align="center">

# 🔭 SceneScout

**Your coding agent, turned into an exploratory QA tester for any web app.**

Works with Claude Code · Cursor · VS Code (Copilot) · Codex CLI · Gemini CLI · Copilot CLI · Windsurf · any [MCP](https://modelcontextprotocol.io) client

[![test](https://github.com/brunoboto96/SceneScout/actions/workflows/test.yml/badge.svg)](https://github.com/brunoboto96/SceneScout/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/scenescout.svg)](https://www.npmjs.com/package/scenescout)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >= 20](https://img.shields.io/badge/node-%E2%89%A5%2020-339933?logo=node.js&logoColor=white)

[📖 Guide](docs/guide/Home.md) · [🐛 What it catches](#-what-it-catches) · [🎬 QA with evidence](#-automated-qa-with-evidence) · [🚀 Get started](#-get-started) · [🚦 CI](#-in-ci) · [🔒 Safety](#-safe-by-default) · [📚 Docs](#-documentation)

</div>

Scripted end-to-end tests answer one question: *does this exact flow still work?* They say nothing about the rest of the app. SceneScout lets the agent you already use explore a running web app like a curious, thorough tester. It clicks, fills forms, switches roles and calls the API behind a hidden button, then writes a report of what is **broken** and what could be **better**, with a picture and evidence for every line.

Try it on any app you are allowed to test. No account, no API key, no setup:

```bash
npx -y scenescout http://localhost:3000
```

```mermaid
flowchart LR
  A["🧠 Your coding agent<br/>Claude Code, Cursor, Copilot…"] -- MCP --> S["🔭 SceneScout<br/>browser · checks · memory"]
  S --> App["🌐 Your running app"]
  S --> R["📋 Report<br/>plain words + pictures"]
  S --> E["🎬 Evidence<br/>replay, videos, test report"]
```

## 👥 Who it's for

| 🛠️ **Developers** | 🧑‍💼 **QA, product and non-technical teams** |
|---|---|
| Findings with the request that failed (`GET /api/orders?status=archived → 500`), the steps, and a Playwright regression-test skeleton | Each problem in plain words first: what was done, what was expected, what happened, and a picture of the page |
| Next to the source, the file behind the bug and a likely fix | Visible problems shown, not described: a covered button, a broken image, text too faint to read |
| A deterministic gate for pull requests, with SARIF for code scanning | Journeys recorded step by step, as frames and video, so a pass is something you can watch |
| Runs from your editor's agent, or unattended in CI | A test report laid out by **your** template, with expected and actual results, deviations and blank sign-off rows |

## 🐛 What it catches

A real run against the small demo app in this repository, which has bugs planted on purpose. The two you can see are outlined:

<p align="center"><img src="examples/screenshots/dashboard-annotated.png" alt="The demo app's dashboard with two defects outlined in red: 1, a yellow badge covering the All orders button; 2, the weekly chart image failing to load" width="760" /></p>

It filed twelve findings. A few from [the report](examples/report.md):

> **🔴 [HIGH] A double-click on Create order creates two orders**
> `2× click fired the same state-changing request 2× (POST /api/orders)`
>
> **🔴 [HIGH] A clerk can approve an order by calling the endpoint the page hides from them**
> `POST /api/orders/1037/approve 200 as clerk`: the button was hidden, the server did not agree.
>
> **🔴 [HIGH] Filtering orders by Archived fails, and the page shows an empty table instead of an error**
> `GET /api/orders?status=archived → HTTP 500`
>
> **🟠 [MEDIUM] The "New: bulk import" badge sits on top of the All orders button** *(callout 1)*
> `"All orders" overlaps "New: bulk import" (81%)`, measured from layout boxes, no screenshot needed.

What it looks for, on every page, after every action:

- 📐 **Broken layout, from geometry:** controls that overlap, sit off-screen, hide under a sticky bar or can never be scrolled into view. The CSS bugs a person spots at a glance, found without one.
- 🧨 **Real breakage:** console errors, crashes, failed requests, 4xx and 5xx responses, broken images, dead-end pages.
- 🔓 **Permission leaks:** it calls the app's own API as each role, so "the button is hidden" becomes "the server refuses it", or doesn't.
- 🤥 **Pages that lie:** "Saved!" after the server refused the save, or an empty table after the request failed.
- 👆 **Impatient users:** a double-click that sends the same order twice.
- ♿ **Accessibility and craft:** contrast, focus, labels, target sizes, spacing and type, with a 0 to 100 score per page.
- 🧭 **Friction:** how many steps a task takes, and where a user had to go back.
- 💉 **Security smells:** typed markup that comes back as an element, and tokens posted to any window.

[Everything it checks](docs/guide/What-it-checks.md).

## 🎬 Automated QA with evidence

Save the journeys that matter, the happy paths and the ones that must fail politely, and `scenescout check` replays them on every pull request with no model involved. Recorded, each run leaves proof you can watch and hand to someone who never opens a terminal.

```mermaid
flowchart LR
  PR["🔀 Pull request"] --> C["🚦 scenescout check<br/>--record --video --template"]
  F["📝 Saved journeys<br/>.scenescout/flows/*.json"] --> C
  C --> G["✅ / ❌ A gate on the pull request"]
  C --> RP["🖼️ replay.html<br/>every step, with frames"]
  C --> V["🎞️ A video per journey"]
  C --> TR["📄 Test report<br/>your template, SHA-256 manifest,<br/>blank sign-off rows"]
```

A journey is a few lines of JSON, written by hand or kept from a flow your agent just walked. This is [the demo's happy path](examples/flows/01-place-an-order.json):

```json
{
  "name": "place an order",
  "id": "TC-01",
  "requirements": ["REQ-ORD-1", "REQ-ORD-2"],
  "steps": [
    { "action": "navigate", "target": "/orders-new.html", "expected": "The new-order form is shown" },
    { "action": "type", "target": "testid=new-order-customer", "value": "Harbour Bakery", "expected": "The customer is filled in" },
    { "action": "type", "target": "testid=new-order-items", "value": "4", "replace": true, "expected": "The item count is 4" },
    { "action": "click", "target": "testid=new-order-submit", "expected": "The order is created" },
    { "action": "expect-request", "request": "POST /api/orders", "status": "2xx" },
    { "action": "expect-element", "target": "testid=new-order-created-link", "state": "visible", "expected": "A link to the new order is shown" }
  ]
}
```

Against the [demo app](demo-app/), with the three journeys in [examples/flows](examples/flows/) (one creates an order, so the check is allowed to send it):

```bash
npx scenescout check http://127.0.0.1:4173 --flows examples/flows --mode read-only --flow-writes allow \
  --record --video --template examples/report-template.json
```

**The journey, as it ran** (one of the videos it filmed):

<p align="center"><img src="examples/screenshots/journey-place-order.gif" alt="A recorded journey on the demo app: the new-order form is filled with a customer and four items, Create order is clicked, and the confirmation with a link to the new order appears" width="760" /></p>

**The replay page:** each journey with a pass or fail badge. A journey that broke opens at the step that broke, with the page as it was after every step:

<p align="center"><img src="examples/screenshots/check-replay.png" alt="The check's replay page: verdict FAILED, the app's address, start and end times, 24 frames and 3 videos; two journeys passed and one, see archived orders, failed at step 3" width="820" /></p>

<p align="center"><img src="examples/screenshots/check-replay-failed.png" alt="The failed journey opened: step 1 navigates to the orders page and passes, step 2 selects Archived and passes with an empty table, step 3 expected GET /api/orders to answer 200 and it answered 500, highlighted in red" width="760" /></p>

**The test report**, laid out by [a template](examples/report-template.json) you write once: test IDs, the requirements each covers, expected and actual results, a screenshot per step, every deviation listed again for the reviewer, and the SHA-256 of each piece of evidence. SceneScout signs nothing; the sign-off rows are for your people.

<p align="center"><img src="examples/screenshots/test-report-results.png" alt="The test report's results table: test TC-01, place an order, covering REQ-ORD-1 and REQ-ORD-2; each step with its expected result, actual result As expected, result Pass, and a screenshot of the page after the step" width="820" /></p>

<p align="center"><img src="examples/screenshots/test-report-deviations.png" alt="The test report's deviations: TC-03, see archived orders, step 3 expected GET /api/orders to answer 200, actual GET /api/orders answered 500, result Fail" width="820" /></p>

Everything is one self-contained HTML page per report, with no scripts, nothing loaded from the network, and a layout that prints. [Recording a check](docs/ci.md#recording-a-check) and [a test report from a template](docs/ci.md#a-test-report-from-a-template) have the details, including what to keep out of the pictures.

## 📺 Watch it work

Each exploratory run opens a live view on your machine, with one card per agent: what it is doing, the page it is on, and a feed of every action. Three agents are testing the demo app in parallel here:

<p align="center"><img src="examples/screenshots/live-view.png" alt="The live view during a run of three parallel agents against the demo app: one card per session, each with its role and objective, the task it is on, the tool it is running, the page it is on, a live thumbnail, and a feed of the actions it just took, tinted one colour per task" width="880" /></p>

You can read the report while the agents are still working, and scrub back through any session's timeline. Beside `report.md`, every run writes `report.html`, the whole run as one self-contained page; ask for a recorded run and it also keeps a frame after every action.

## ✨ Why it's different

- 🧠 **Your agent is the brain, so no extra API key.** The engine contains no model. It gives the agent you already pay for deterministic tools and the testing method to use them.
- 📐 **It reads structure, not pixels.** The agent sees every element with its role, state and layout box, so overlap and broken images are measured, not guessed from a screenshot.
- 🛡️ **Safety is enforced on the network, not requested in a prompt.** Nothing existing is changed unless you allow it, and a blocked write never reaches your server.
- ✅ **"Done" is a contract.** The report lists everything not tested, and at the `extensive` level refuses to finish while any known page is unvisited.
- 🧠 **It remembers.** Each run starts from what the last one learned, and re-tests the bugs earlier runs left open.
- 📊 **It is measured, not asserted.** Every change to how it explores is scored against an app with planted bugs and a held-out app it is never tuned on ([the log](docs/benchmark.md)):

```mermaid
xychart-beta
  title "Planted defects found per run, demo app (13 planted)"
  x-axis "Run" ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]
  y-axis "Found" 0 --> 13
  bar [11, 12, 9, 10, 11, 11, 10, 10, 11, 13, 11, 11, 12]
```

<sub>Each bar is one run of eight parallel agents, re-scored against today's answer key. One run is noisy: read the trend across runs, not a single bar.</sub>

## 🚀 Get started

**1. Install** for your agent (Node 20 or newer):

```bash
npx -y scenescout install                      # Claude Code: skill, MCP server and the test browser
npx -y scenescout install --client cursor      # or vscode, codex, gemini, copilot, windsurf
npx -y scenescout doctor                       # every line should be a ✓
```

<details>
<summary>Other ways to install: a Claude Code plugin, the Claude Desktop extension, or by hand</summary>

- **Claude Code plugin:** `/plugin marketplace add brunoboto96/SceneScout`, then `/plugin install scenescout@scenescout-marketplace`. The command becomes `/scenescout:scenescout`.
- **Claude Desktop:** download `scenescout-X.Y.Z.mcpb` from the [latest release](https://github.com/brunoboto96/SceneScout/releases/latest) and open it. No terminal needed.
- **Any other MCP client:** add a stdio server whose command is `npx -y scenescout serve`. [Each client's config](docs/guide/Start-here.md#a-client-that-install-does-not-know).

</details>

**2. Start your app**, then a fresh session of your agent, and ask:

```text
Use SceneScout to test http://localhost:3000
```

In Claude Code there is a command too: `/scenescout --url http://localhost:3000 --level medium`. On its own, `/scenescout` asks you four plain questions instead: where the app is, how you sign in, what to check, and whether it holds real data.

**3. Read the report** in `.scenescout/report.md`. It opens in plain words (each problem, its steps, what was expected and what happened), with the technical detail one click away. [A complete example](examples/report.md).

**No app handy?** Clone this repository and run `npm run demo:serve`: the [demo app](demo-app/) starts on `http://127.0.0.1:4173`, and its README lists every planted bug.

**Behind a sign-in?** Sign in once yourself, SSO and MFA included, and every session reuses it:

```bash
npx -y scenescout login http://localhost:3000 --role admin    # then: /scenescout --role admin
```

[Signing in](docs/guide/Signing-in.md) covers roles, expiry and scripted sign-in for CI.

## 🚦 In CI

| | What it does | Needs a model? |
|---|---|---|
| [`scenescout check`](docs/guide/Ways-to-use-it.md#scenescout-check-a-gate-in-ci) | A deterministic gate: measures every page, replays your saved journeys and visual baselines, fails only on what it can prove; recorded, it leaves the [evidence above](#-automated-qa-with-evidence) | No |
| [`scenescout ci`](docs/guide/Ways-to-use-it.md#scenescout-ci-an-unattended-exploratory-run) | An unattended exploratory run, driven by the Anthropic or OpenAI API. It reports and never fails the build | An API key |
| [`/scenescout qa`](docs/guide/Ways-to-use-it.md#scenescout-qa-on-a-pull-request) | A comment on a pull request that tests its preview deploy and replies with the results; `/scenescout qa check` runs your own check instead | An API key (`qa check`: none) |
| [`scenescout export`](docs/guide/Ways-to-use-it.md#filing-findings-as-issues) | Files the findings as GitHub or Jira issues, each once | No |

A gate on every pull request that keeps its evidence, as a GitHub Action:

```yaml
- uses: brunoboto96/SceneScout@v3
  with:
    url: http://127.0.0.1:3000
    record: on
    video: on
    template: tests/report-template.json
```

[docs/ci.md](docs/ci.md) has complete workflows, every option, and the same check on GitLab CI, CircleCI or any shell.

## 🔒 Safe by default

| Mode | What may leave the page |
|---|---|
| 🔵 `observe` | Reads only. The default for a first look, for `scenescout check`, and for an agent's run on a remote site with no source |
| 🟢 `read-only` | Reads and ordinary form posts; nothing existing is changed or deleted. The default for an agent's run on a local app |
| 🟡 `safe-write` | Creates records, and edits or deletes only the ones it created |
| 🔴 `destructive` | Everything. Only when you say the data is disposable; the agent never picks it |

The policy sits on the network, so a blocked request never reaches your server. The page gets a refusal instead, which is how SceneScout catches a page that claims success anyway. A saved journey that creates something, like the order above, runs only when the check is told `--flow-writes allow`, against a test environment. Findings, memory and reports stay in a `.scenescout/` folder that keeps itself out of git.

> [!IMPORTANT]
> Only test sites you own or are allowed to test. [Safety model](docs/guide/Safety-model.md).

## 📚 Documentation

| | |
|---|---|
| [Start here](docs/guide/Start-here.md) | A first look, install, a first run, reading the report, the live view |
| [Ways to use it](docs/guide/Ways-to-use-it.md) | Interactive runs, parallel agents, CI, pull-request QA, filing issues |
| [What it checks](docs/guide/What-it-checks.md) | Every check and every `scout_*` tool |
| [Signing in](docs/guide/Signing-in.md) · [Safety model](docs/guide/Safety-model.md) | Roles and saved logins; what each mode refuses and why |
| [Recipes](docs/guide/Recipes.md) | Setups for seven kinds of project |
| [Configuration reference](docs/guide/Configuration-reference.md) | Every option, environment variable and action input |
| [Troubleshooting](docs/guide/Troubleshooting.md) | Symptoms and fixes, upgrading and uninstalling |
| [Running it in CI](docs/ci.md) | Saved journeys, recording, test reports from templates, every workflow |
| [How it works](docs/how-it-works.md) | Diagrams of a run, an action, the write policy, lanes |
| [Benchmark](docs/benchmark.md) · [Validation](docs/validation.md) | How runs are scored against answer keys, and runs on public apps |
| [Design decisions](docs/adr/README.md) | Why the rules are what they are |

## 🔧 Contributing

Start with [VISION.md](VISION.md) (what is in scope) and [CONTRIBUTING.md](CONTRIBUTING.md) (local setup and how changes land). [AGENTS.md](AGENTS.md) holds the house rules for people and coding agents alike.

Found a way past the write policy, or another security problem? Report it privately: [SECURITY.md](SECURITY.md).

[MIT](LICENSE) licensed.
