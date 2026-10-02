# Ways to use it

SceneScout has six ways in. They share one engine and one write policy, and all but the first share one project memory in `.scenescout/`, so what one finds, another can re-test.

| Way | Who drives it | Model needed | Fails a build | Use it for |
|---|---|---|---|---|
| [`scenescout <url>`](Start-here.md#a-first-look-with-nothing-set-up) | Nobody: deterministic | None | No | A first look at any app, with nothing set up first |
| [An interactive run](#an-interactive-run) | Your coding agent, with you watching | Your agent's | No | Exploring a feature while you build it; a pre-release pass |
| [Parallel lanes](#parallel-lanes) | Several agents, one per area or role | Your agent's | No | A large app, or a multi-role app, in less wall time |
| [`scenescout check`](#scenescout-check-a-gate-in-ci) | Nobody: deterministic | None | Yes | A pull-request gate |
| [`scenescout ci`](#scenescout-ci-an-unattended-exploratory-run) | A model through its API | An API key | No | Exploration on a schedule or on pushes |
| [`/scenescout qa`](#scenescout-qa-on-a-pull-request) | A model, started by a PR comment | An API key | No | An on-demand review of a PR's preview deployment |

After a run that files findings (any of these but `scenescout check`, which files none), `scenescout export` files them as GitHub or Jira issues, each once: [Filing findings as issues](#filing-findings-as-issues).

## An interactive run

Open your agent in the project and ask in plain words, or use the skill's flags in Claude Code:

```text
Use SceneScout to test http://localhost:3000 as the admin role, focusing on checkout
/scenescout --level medium --url http://localhost:3000 --role admin
```

| Flag | Meaning |
|---|---|
| `--level minimal`, `medium` or `extensive` | The completion contract ([levels](Start-here.md#levels)) |
| `--url <app>` | Where the app runs |
| `--role <name or path>` | Who to test as: a login saved with `scenescout login`, a storage state the scan found, or a path to a Playwright storage-state file ([Signing in](Signing-in.md)) |
| `--focus <text>` | What to check: a ticket or a sentence. It becomes the session's objective |
| `--observe`, `--read-only`, `--safe-write`, `--allow-destructive` | The write mode, in place of the one the agent would choose ([Safety model](Safety-model.md)) |

### Plain questions instead of flags

Invoke the skill with no flags (`/scenescout`, or the `explore` prompt with no arguments in another client) and the agent asks four questions before it starts:

1. What is the address of the site?
2. Do you need to sign in to use it? If so, how: Google or Microsoft single sign-on, an email and password, or a one-time code?
3. What should I check? Upload or paste the tickets, or describe it in a sentence. Say "everything" to look at the whole site.
4. Does the site hold real data, such as real customers, orders or records?

| Answer | What it sets |
|---|---|
| The address | The URL the session attaches to |
| A way of signing in | A browser window opens, you sign in as you normally would, and the session attaches with the saved login (role `user`). No sign-in: the session attaches signed out |
| Tickets or a description | The session's objective, and the area it keeps to. Tickets are also read for their acceptance criteria, and the report answers each one. "Everything" explores the whole site |
| Real data: yes, or not sure | `observe`: nothing but `GET` requests leave the page, so nothing is created or changed |
| Real data: no | `read-only`: ordinary forms are submitted, deletes and other destructive requests are blocked |

You are never asked to choose a write mode. `safe-write` and `destructive` are used only when you ask for them. Any flag skips the questions, and what the flags leave out takes its default.

### Next to the code, or against a URL

SceneScout needs only a URL, but it does better from inside the app's repository:

- **Next to the code** (recommended). `scout_scan` reads routes from the source: file-based routing (Next.js, SvelteKit, Nuxt) and router configuration written in code (React Router, Vue Router, Angular). Coverage is then measured against the app's real routes, not only what happened to be linked, and the agent can read the component behind a finding and name the file and the fix.
- **Against a remote URL**, from any folder (an empty `qa/` folder is fine; memory and the report are kept there). Routes come from same-origin links only. With no source to confirm the target is a development app, the method attaches in `observe` mode, where nothing but `GET` requests leave the page, unless you say form submissions are acceptable there.

### Things worth asking for

- **More than one role.** "Test as clerk and manager: the clerk submits an order and the manager approves it." One agent keeps both browsers signed in (`scout_attach {session: "clerk", role: "clerk"}`, then `session: "manager"`) and alternates between them. The report adds a role capability matrix. A button hidden from a role is checked against the server with `scout_request`, so "the clerk cannot approve" is proven by a refusal, not by a missing button.
- **Keep a flow.** "Save the checkout flow you just walked." The agent writes the steps it used as `.scenescout/flows/checkout.json`, and `scenescout check` replays it on every pull request (below).
- **Answer the tickets.** "Check these tickets" with the tickets pasted or uploaded. `scout_tickets` reads their acceptance criteria: Given/When/Then scenarios, checklists, numbered or `AC1:` criteria, and lists under an "Acceptance criteria" heading. A ticket with none of these is reported as having no recognisable criteria; nothing is guessed. The agent plans its journeys against the criteria and records each one with `scout_criterion` as passed, failed (naming the findings that show it) or not tested (`no-access`, `observe-blocked` or `out-of-scope`), with its confidence. Which findings show a criterion failing is the agent's judgement, not a match on words. The report answers each ticket in the plain section and lists every verdict with its confidence in the technical one.
- **Re-test earlier findings.** "The fixes for last week's findings have landed; re-test them." `scout_verify` lists open findings worst route first and records each as gone, still present or changed.
- **Why a page is empty.** "The list is empty after switching tabs, but the API has data." `scout_network` lists the fetch and XHR requests the page made since it loaded, with status and timing, so a request that failed, one still pending and one that never ran can be told apart. When a response is longer than the 2000 characters `scout_request` returns, `scout_request {select: "stats.open"}` returns one value of the JSON body, and `scout_request {offset: 2000}` the next part.
- **Show one element.** "Show me the new filter bar." `scout_capture` saves a PNG of that element; it shows, it does not judge.
- **Slow it down.** "Pause five seconds between actions so I can follow." That is `scout_attach {paceMs: 5000}`, or `scout_session {paceMs: 5000}` mid-run.
- **Another browser.** "Run the same pass in WebKit." `scout_attach {browser: "webkit"}`; the first such attach downloads WebKit, once.
- **A phone-sized viewport.** `scout_attach {viewportWidth: 390, viewportHeight: 844}`, then a design audit on the key pages.
- **Fewer duplicate findings.** "Ask a model whether two findings are the same defect." That is `scout_attach {dedup: "judge"}`, or `SCENESCOUT_DEDUP=judge` in the server's environment, with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` there too. A filing the rule keeps apart is then compared with the open findings on its page, and each pair's titles, categories and evidence, and the page's path, are sent to that provider. It is off by default.

## Parallel lanes

A lane is one agent with its own browser session and its own part of the app. Parallel lanes need an agent that can start subagents or run a workflow (Claude Code can).

```text
Use SceneScout to test http://127.0.0.1:4173 with four agents in parallel, one area each
```

The method the agent follows:

1. The planner attaches, crawls once so route knowledge is complete, and calls `scout_lane_brief {lanes: 4, goal: "…"}`. It splits the routes into whole modules (everything under `/orders` goes to one lane), balances them by route count, and returns for each lane a session name, an objective, the routes it owns, a landing route and the rules every lane follows.
2. Each lane agent attaches its own session when it starts, files defects with `scout_finding` as it judges them, and hands back one JSON object: the lane report. The instruction for that object comes from `scout_lane_report {lane}`. While other sessions share the project, `scout_coverage` shows a lane only the routes it reached, the controls on the pages it saw (not another role's on the same route) and the forms it saw this run; `scout_coverage {scope: "project"}` shows every lane's, tagged with who saw each. A lane that files the same finding again in the same run corrects its own convention and detail, and the "seen in N runs" count does not move. A filing merged into a finding from another page adds that page to the finding's "also seen on" list in the report. Each decision in the lane report can name the finding id `scout_finding` returned for it, so the fold's check for judged defects nobody filed matches it exactly rather than by its evidence.
3. The planner passes each reply to `scout_lane_report {lane, reply}`, which checks it and folds it, and only then closes that lane's session with `scout_close`. `scout_close` refuses to close a lane whose report has not been accepted, because the lane's decisions are kept against its session.
4. The planner writes the report. On a parallel run it adds how the run was paced and whether each lane's stated confidence matched what the project filed.

Practical limits:

- Run about as many lanes at once as your machine has cores, less two. Each one is a real browser.
- Let each lane attach when it starts. Opening every session up front leaves browsers idle while the machine runs out of memory for the lanes that are working.
- Lanes share one store per project: a record one lane created can be edited by another in `safe-write`, and markup typed by one lane is caught when another lane opens the page that renders it.
- A saved login serves any number of sessions of that role, each in its own browser.

[How it works](../how-it-works.md#5-a-run-split-across-parallel-lanes) has the sequence in a diagram.

## `scenescout check`: a gate in CI

`scenescout check` is the part of SceneScout with no model in it, so the same app always gets the same verdict. It visits the start URL, the scanned routes and every same-origin link it finds (up to `--max-routes`), measures each page, replays saved flows and re-tests open findings from the project's memory.

```bash
npx -y scenescout check http://127.0.0.1:3000 --fail-on high
```

| Exit code | Meaning |
|---|---|
| 0 | Passed the gate |
| 1 | Failed it: something at the `--fail-on` severity or worse |
| 2 | Could not run, or not all of it: a bad argument, an app that never answered, only the sign-in page reached, a saved flow that is not valid, or a flow step the write policy refused |

It writes `report.md`, `check.json` and `check.sarif` to `.scenescout/check/` (or `--out`), and on GitHub Actions appends the report to the job summary.

**What it measures.** HTTP and page errors, failed requests, a page that shows an empty list after a refused request or success after a refused save, layout geometry (covered, clipped, off-page and overlapping controls, blocking overlays, misplaced dialogs, and, as worth a look, controls held out of view in a sideways-scrolling container), broken images, unnamed controls, fields labelled only by a placeholder, contrast, focus indicators, small targets, sideways scrolling and dead ends. Each rule has a severity; the [configuration reference](Configuration-reference.md#check-rules) lists them.

**The gate.** By default (`--fail-on high`) it fails only on facts that mean a page is broken: a page that did not load, an uncaught exception, a 5xx, a failure shown as success, a saved flow that broke. `--fail-on medium` or `low` is stricter; `never` reports without failing. `--ignore <rule>` drops a rule.

**Worth a look.** Two rules measure something exactly that is a defect only under a convention the check cannot see: `off-grid-spacing` (a 4px spacing scale) and `indistinct-link` (links styled like body text). They are listed under "Worth a look", never counted and never fail the gate at any `--fail-on`, and appear in SARIF at level `note`.

**Saved flows.** Every `.scenescout/flows/*.json` is replayed after the crawl with no model involved. A flow is the steps `scout_run_plan` takes, plus assertions:

```json
{
  "name": "open an order",
  "steps": [
    { "action": "navigate", "target": "/orders" },
    { "action": "click", "target": "role=button[name=\"Open order\"]" },
    { "action": "expect-text", "text": "Order details" },
    { "action": "expect-request", "request": "GET /api/orders/*", "status": 200 }
  ]
}
```

A step that breaks fails the gate (`flow-step-failed`, high) naming the flow and the step. By default flows replay under observe's rule, so they send no HTTP write whatever `--mode` says; `--flow-writes allow` lets them submit forms under `--mode`. `flows/*.json` is the one part of `.scenescout/` that git does not ignore, so flows are committed with the project. The [flow format](../ci.md#saved-flows) lists every step and target.

**Re-tests.** Open findings in `.scenescout/memory.json` whose evidence is a failed `GET` are re-tested by loading their page, and reported as still reproducing, possibly fixed or not re-tested. By default a finding filed high that still reproduces fails the gate (`--gate-retests high`). The memory is ignored by git unless the project commits it, so re-tests happen where the memory lives.

**SARIF.** `check.sarif` is SARIF 2.1.0. With the GitHub Action, `upload-sarif: true` sends it to code scanning; the job then needs `security-events: write`.

### Visual baselines

A baseline is an approved picture of a page or of one element on it. With `--baseline compare` the check takes the same picture again and compares the two pixel by pixel; with `--baseline update` it writes new baselines. Nothing is pictured unless you ask for it.

1. List what to keep in `targets.json`, in the baselines folder (`.scenescout/baselines/` unless `--baselines` names another):

   ```json
   {
     "targets": [
       { "path": "/" },
       { "path": "/settings", "element": "testid=profile-card" },
       { "path": "/orders", "element": "role=button[name=\"New order\"]" }
     ]
   }
   ```

   `element` is `page`, the default (the window from the top of the page), or a target written the way a saved flow writes one: `testid=…`, `text=…`, `label=…` or `role=<role>[name="…"]`. An element's picture is its box and 8px around it.
2. Take the baselines once: `npx -y scenescout check http://127.0.0.1:3000 --baseline update`. Each baseline is a PNG with a JSON beside it that says how it was taken, under `<browser>/<route>/` in the folder.
3. Compare on every run with `--baseline compare`.

| What the check finds | What it reports | Gate |
|---|---|---|
| The same picture, or one within `--baseline-threshold` (default 0.1%) | It matches, with the share of pixels changed | Passes |
| More pixels changed than the threshold allows, or a change of size | `visual-change` (high), with the share changed; the baseline, the picture now and a diff with the changed pixels in red go under `visual/` beside the report | Fails at the default `--fail-on high` |
| The page or element could not be pictured | `visual-change` (high), saying why | Fails |
| A baseline it cannot use: half there, unreadable, or taken with other settings | `visual-change` (high), saying why; take it again with `--baseline update` | Fails |
| No baseline yet | Listed, and counted beside the verdict as not compared | Passes |

An intended change is approved by running the check with `--baseline update` and committing what it writes, on the same operating system the check runs on. Nothing else writes a baseline. An update rewrites what compare would not accept and leaves a baseline within `--baseline-threshold` exactly as it was, except one taken on another operating system, which it always replaces: run on a laptop, an update replaces every baseline taken on a Linux runner. Targets are pictured whatever `--paths` says, since each names its own page.

**Where baselines live.** `.scenescout/baselines/` is ignored by git, so baselines kept there stay on the machine that took them. To share them, name a folder the project commits: `--baselines tests/visual` (the action's `baselines` input).

**What keeps a picture repeatable.** Every picture is taken in a 1280×900 window at one picture pixel per CSS pixel, after a fresh page load from a blank page, with the page told to reduce motion, once its fonts have loaded, with CSS animations and transitions stopped before anything is measured and the text caret hidden. Baselines are kept per browser: Chromium's are never compared with WebKit's. An element larger than the window is pictured where it is inside the window, and the report says so.

**Why 0.1% and not 0.** Two pictures of an unchanged page taken by one browser build on one machine compare at 0%, but a run on another machine, or after a browser or font update, can anti-alias text and curved edges a pixel differently, and a gate that fails on that noise teaches a team to ignore it. 0.1% is 1,152 pixels of a 1280×900 page and 64 of a 320×200 picture, so a smaller change, such as a character of small text on a large element, passes unless you lower the threshold: `--baseline-threshold 0` counts every changed pixel (one whose colour differs by more than 8 in 255 on a channel), and a change of size always counts.

**What can still differ.** Each operating system draws text differently, so a baseline taken on a laptop seldom matches a picture taken on a Linux runner: take baselines where the check runs (the report says when one was taken on another system). Content that changes by itself, such as dates, counters, random images, video or animation driven by script, changes the picture: keep a baseline of a steadier element, or raise `--baseline-threshold`. [Running it in CI](../ci.md#visual-baselines) shows how to take baselines on the runner.

### SARIF locations

Code scanning keeps a result only when its location is a file in the repository, so the results in `check.sarif` and `ci.sarif` point at repository files, and the page each one was seen on goes beside the file: in the message, as a logical location of kind `resource`, and in `properties.routes` (`properties.route` in `ci.sarif`).

- An issue a saved flow raised points at that flow's file, relative to the repository root.
- Anything else points at the anchor: `--sarif-file-anchor <path>` (the action's `sarif-file-anchor` input) when given; else, on GitHub Actions, the workflow file that is running, read from `GITHUB_WORKFLOW_REF`; else `package.json` when the repository has one; else `README.md`.
- The repository root is `GITHUB_WORKSPACE` when it is set, and the project directory otherwise.
- The anchor must exist under the repository root. When the option's file or the workflow file is missing, one warning line names it and the next file in that order that exists is used. When none exists, the SARIF is still written, pointing at the first of them, and the warning says code scanning will drop its results. A missing file never stops the run.
- Alerts keep their identity across runs: the fingerprints come from the evidence, not the location.

### On GitHub Actions

```yaml
permissions:
  contents: read

jobs:
  ui-check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - name: Start the app
        run: |
          npm start > "$RUNNER_TEMP/app.log" 2>&1 &
          for _ in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:3000/ && exit 0; sleep 1; done
          cat "$RUNNER_TEMP/app.log"; exit 1
      - uses: brunoboto96/SceneScout@v3
        with:
          url: http://127.0.0.1:3000
          fail-on: high
```

`@v3` follows the latest 3.x release; pin an exact tag (`@v3.14.0`) or that release's commit SHA to make each upgrade a reviewed change. Every CLI option is an input of the same name; the action's own inputs and its outputs are in the [configuration reference](Configuration-reference.md#action-check). [Running it in CI](../ci.md) has GitLab CI, CircleCI and plain shell versions.

## `scenescout ci`: an unattended exploratory run

`scenescout ci` runs the exploratory method in a CI job with no person and no coding agent. A model reached through its API drives the same `scout_*` tools, and the run ends in the ordinary report.

```bash
export OPENAI_API_KEY=…            # or ANTHROPIC_API_KEY; read from the environment only
npx -y scenescout ci http://127.0.0.1:3000
```

- **It reports and never gates.** Exit 0 when the run ran, whatever it found; exit 2 when it could not run. Two runs find different things, so a finding is something to read. Gate with `scenescout check`.
- **Provider.** Chosen by which key is set: the Anthropic Messages API or the OpenAI Responses API. With both set, `--provider` decides. `--model`, `--effort` and `--base-url` (another endpoint implementing the same API) override the defaults.
- **Caps.** 40 model turns, 1,500,000 tokens and 20 minutes by default (`--max-turns`, `--max-tokens`, `--max-minutes`). The first cap reached ends the exploration; the report is still written and says which cap ended it. `--max-tokens` is the setting that bounds the cost.
- **Lanes.** `--lanes 4` splits the app between four model loops that explore at once, each in its own browser and its own modules, as [parallel lanes](#parallel-lanes) do. They share the caps above rather than getting them each, so raise `--max-turns` and `--max-tokens` with them: at the defaults each of four lanes gets about ten turns, which found no more than one loop on the benchmark's demo app, while `--lanes 4 --max-turns 160 --max-tokens 6000000` found the most (about 2.3 times one loop's cost; run one at a time per API key). Their findings go into one report.
- **Mode.** `read-only` by default. `--mode destructive` also needs `--allow-destructive`.
- **Duplicates.** By default the run's model is also asked, at its lowest effort, whether a finding the dedup rule keeps apart is one already open on the same page, and merges it when it says so. Each pair asked about sends the two findings' titles, categories and evidence, and the page's path, to the provider, and the calls count in the usage. `--dedup rule` turns it off.
- **Output.** `report.md`, `report.html`, `summary.md`, `ci.json` and `ci.sarif` in `.scenescout/ci/`, with a usage line: turns, tokens, time and an estimated cost. Each `ci.sarif` result points at the anchor file described under [SARIF locations](#sarif-locations).
- **One element instead of a run.** `--show "the Save button"` captures that element as a PNG and does not explore; `--compare-url <url>` captures it on a second deployment too and writes a diff picture.

The GitHub Action is `brunoboto96/SceneScout/ci`, with the key passed in the step's `env` from a secret:

```yaml
      - uses: brunoboto96/SceneScout/ci@v3
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          url: http://127.0.0.1:3000
          max-minutes: "20"
```

Give the job a `timeout-minutes` of at least `max-minutes` plus 5, plus the time of the steps before it. A pull request from a fork gets no secrets, so run this on pushes, on a schedule, or on pull requests from the same repository. [The full reference](../ci.md#an-unattended-exploratory-run) covers costs and output formats.

## `/scenescout qa` on a pull request

An allowed account comments `/scenescout qa` on a pull request, and an unattended run explores that pull request's **deployed preview** and replies with the results. The job that holds the model's key checks out nothing and runs SceneScout from an exact release tag, so the pull request's code never runs beside the key. A project without preview deployments cannot use this; use `scenescout ci` on pushes instead.

### Set it up

1. Copy [examples/workflows/scenescout-qa.yml](../../examples/workflows/scenescout-qa.yml) to `.github/workflows/`. It is pinned to the release it shipped with; keep both `brunoboto96/SceneScout/qa` and `brunoboto96/SceneScout/ci` on the same exact tag, never `@v3` or a branch.
2. Add the model key as a repository secret (`OPENAI_API_KEY` in the template; for Anthropic, rename it in the `qa` job's `env`).
3. Tell it where the preview is, if the deployments API does not already say: set the repository variable `SCENESCOUT_QA_PREVIEW_URL` to a template such as `https://pr-{pr}.preview.example.com`.

### The commands

```text
/scenescout qa [preview URL] [focus]
/scenescout qa [preview URL] show <element>
/scenescout qa [preview URL] compare <element>
```

Only the first line of a new comment is read. `show` replies with a picture of the element on the preview. `compare` also captures it on a base URL (`SCENESCOUT_QA_BASE_URL`, else the newest deployment of the base branch) and replies with both pictures, a diff with changed pixels in red and the share of pixels changed. The pictures are pushed to a `scenescout-shots` branch that holds nothing else, because a comment cannot carry files.

### Who may start a run

Three repository variables combine as a union; with all three unset, the repository's owners may.

| Variable | Allows |
|---|---|
| `SCENESCOUT_QA_ALLOWED` | These GitHub logins |
| `SCENESCOUT_QA_ALLOWED_ROLES` | Commenters whose author association is `OWNER`, `MEMBER` or `COLLABORATOR` |
| `SCENESCOUT_QA_ALLOWED_TEAMS` | Active members of these teams (`org/team-slug`), read with the `SCENESCOUT_QA_TEAM_TOKEN` secret, which only the gate job receives |

Setting any of them replaces the owners default, so include yourself. A commenter who is not allowed gets a 😕 reaction and nothing else.

### Forks

Pull requests from forks are refused by default, with a reply saying why. `SCENESCOUT_QA_ALLOW_FORKS=true` allows them; the key job still runs no fork code, but the preview's pages, which the fork's author wrote, are what the model reads. The run stays in `read-only` mode either way.

[The full reference](../ci.md#a-qa-review-from-a-pull-request-comment) covers the reactions and replies, the jobs and their permissions, and the costs. Why it is shaped this way: [ADR 15](../adr/0015-a-qa-comment-tests-a-preview-and-never-runs-the-pull-requests-code.md).

## Filing findings as issues

`scenescout export` turns the project's open findings into issues in GitHub or Jira, where the team already works. It reads `.scenescout/memory.json`, where an interactive run, parallel lanes and `scenescout ci` keep their findings (`scenescout check` only reads it).

```bash
export GH_TOKEN=…                  # or GITHUB_TOKEN; read from the environment only
npx -y scenescout export --to github --repo owner/app          # a dry run: lists what it would file
npx -y scenescout export --to github --repo owner/app --yes    # files it
```

```bash
export JIRA_EMAIL=you@example.com JIRA_API_TOKEN=…
npx -y scenescout export --to jira --jira-url https://your-site.atlassian.net --jira-project QA --yes
```

- **A dry run unless `--yes`.** Without it, the export lists each finding as "would file", "already filed" or "over the cap", and sends the tracker nothing but reads. With no credentials set, a dry run still lists the findings, without checking which are already filed.
- **Each finding once.** Every issue carries the `scenescout` label and a marker holding the finding's id: an HTML comment in a GitHub issue's description, a last line in a Jira one. Before filing, the export reads the issues with that label, open or closed, and skips each finding whose marker is on one, naming the issue, so a second export of the same run files only what the first left over the cap. A closed issue counts, so a finding closed as won't-fix is not filed again on every export; `--refile-closed` files a finding again when its issue is closed, so that a defect that comes back after its fix gets a new issue. Keep the label and the marker on filed issues: they are how the next export finds them.
- **The same finding in a later run.** The marker holds the finding's id, which the project's memory keeps from run to run, so a later run's export skips what an earlier one filed. On a CI runner the memory is gone after the job unless the workflow keeps `.scenescout/memory.json` (for example with `actions/cache`); a fresh memory gives the same defect a new id whenever a run words it differently, and so a new issue.
- **Jira's search can lag.** Jira finds the labelled issues through its search, which can take a little while to show a new issue. Leave a few minutes between two exports to the same Jira project. A create that Jira may have carried out before an error is never sent again in the same export: the next export finds the issue by its marker, or files it if it was not made. GitHub's issue list shows a new issue at once, so there the export looks again straight away.
- **What goes.** Open defects, worst first. `--min-severity` leaves out the less severe, `--only` names finding ids, and `--include-worth-a-look` adds the worth-a-look observations. One export files at most `--max-issues` (default 20); the next export files the rest.
- **What an issue says.** The finding's title and description, its severity, category, page and address, the steps that led to it, its machine evidence, and when it was last found. All of that comes from the run, and some of it from the app's own pages, so it is made inert: an `@mention`, a link, a `#123` reference, HTML or Markdown in it is shown as text and does nothing.
- **Severity.** A label on GitHub (`severity: high`, `severity: medium`, `severity: low`) and a priority in Jira (`High`, `Medium`, `Low`). `--severity-map high=P1,medium=P2,low=P3` renames them, and `--severity-map none` sets none. `--labels` adds labels to every issue.
- **Screenshots.** A run recorded with `scout_attach {record: true}` keeps a frame of each step. Jira gets as attachments the last three frames, from the session that filed the finding, in the ten minutes before it was last found. GitHub's API cannot upload a file to an issue, and SceneScout hosts nothing, so a GitHub issue names those frames in the run's `.scenescout/` folder instead. A frame that is missing, over 10 MB, outside the recordings folder, or rewritten since by a later run is left out. `--screenshots off` leaves them all out.
- **Credentials.** From the environment only, and never printed: `GH_TOKEN` or `GITHUB_TOKEN`, or `JIRA_EMAIL` and `JIRA_API_TOKEN` for Jira Cloud. A GitHub token's account must be able to set labels in the repository, since GitHub silently drops the labels of an issue created by an account that cannot; the export stops after such an issue rather than file more it could not find again.
- **Requests.** Each may take 20 seconds. A rate limit is waited out when it asks for a minute or less, and ends the export when it asks for longer. A read that fails with a server error, a dropped connection or a timeout is retried with backoff. A redirect is refused, so the credentials never go to another address.
- **Exit code.** 0 when the export filed what it set out to (findings over the cap wait for the next export) or, on a dry run, listed it. 2 when it could not finish, after saying what it filed before it stopped, or when a screenshot could not be attached to an issue it filed.

In a GitHub Actions job, run it as a step after `scenescout ci`, with the job's own token and `issues: write` in the job's `permissions`, and keep the memory between runs so later runs keep their findings' ids:

```yaml
      - run: npx -y scenescout export --to github --repo "$GITHUB_REPOSITORY" --yes
        env:
          GH_TOKEN: ${{ github.token }}
```

Every option and variable is in the [configuration reference](Configuration-reference.md#scenescout-export). Why it works this way: [ADR 18](../adr/0018-an-export-files-each-finding-once-and-only-when-asked.md).
