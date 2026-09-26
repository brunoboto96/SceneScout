# Running `scenescout check` in CI

`scenescout check` visits every page of a running app and measures it, with no model involved, so the same app always gets the same verdict. That makes it a pull-request gate. Why its defaults are what they are: [ADR 11](adr/0011-a-gate-is-deterministic-and-fails-only-on-what-it-can-prove.md).

Whatever the CI system, the job has the same three parts: start the app, wait until it answers, run the check. The check never starts the app itself.

| Exit code | Meaning | What the job should do |
|---|---|---|
| 0 | Passed the gate | Pass |
| 1 | Failed it: something at the `--fail-on` severity or worse | Fail: the app has a defect |
| 2 | Could not run, or not all of it: a bad argument, an app that never answered, a saved session that no longer signs in, only the sign-in page reached, a saved flow that is not valid, or a flow step the write policy refused | Fail, and read it as a setup problem; with a refused flow step the report still has the rest's verdict |

## GitHub Actions

The repository is also a GitHub Action. It installs Node if the runner has none, installs SceneScout and the browser (cached between runs), runs the check, puts the report on the job's summary page and keeps `report.md`, `check.json` and `check.sarif` as an artifact.

```yaml
name: ui-check

on:
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run build

      # Start the app in the background and wait until it answers.
      - name: Start the app
        run: |
          npm start > "$RUNNER_TEMP/app.log" 2>&1 &
          for _ in $(seq 1 60); do
            if curl -sf -o /dev/null http://127.0.0.1:3000/; then exit 0; fi
            sleep 1
          done
          echo "The app did not start:"; cat "$RUNNER_TEMP/app.log"; exit 1

      - name: SceneScout check
        id: scenescout
        uses: brunoboto96/SceneScout@v3.10.0
        with:
          url: http://127.0.0.1:3000
          fail-on: high
```

`npm start` and port 3000 are placeholders for however your app starts. A `services:` container or a preview deployment's URL works the same way: the action only needs an address that answers.

### Which ref to use

- `@v3` follows the latest 3.x release: each release moves it, so you get fixes without editing the workflow, and a new major version never arrives unannounced.
- An exact release tag, such as `@v3.10.0`, never moves. Use it when you want every upgrade to be a reviewed change; the examples on this page use it for that reason.
- A full commit SHA also works, but only the SHA of a release commit (the one a `vX.Y.Z` tag points at). Pin a tag or a release SHA if your policy is to review every change to a third-party action.

The action runs the scenescout npm package of the same version as its ref, so `@v3.10.0` runs `scenescout@3.10.0`. At a commit between releases (a branch, or a SHA that no tag points at), the action installs the last published version instead, which can be older than the action; if that version has no `check` command, or does not accept one of the inputs, the step stops with an annotation that says so. The `version` input overrides the version in every case.

### Inputs

Every option of `scenescout check` is an input with the same name. `scenescout check --help` describes them.

| Input | Default | |
|---|---|---|
| `url` | (required) | The address of the running app |
| `fail-on` | `high` | `high`, `medium`, `low` or `never` |
| `mode` | `read-only` | `observe` or `read-only` |
| `max-routes` | 50 | 1 to 150 |
| `paths` | every route found | Comma-separated, each starting with `/` |
| `ignore` | none | Rules to drop, comma-separated |
| `storage-state` | none | A Playwright storage-state file, to check while signed in |
| `browser` | `chromium` | `chromium`, `firefox` or `webkit` |
| `project` | `working-directory` | The project directory |
| `out` | `<project>/.scenescout/check` | Where the three files go |
| `flows` | `<project>/.scenescout/flows`, when it exists | A directory of saved flows to replay, or `off` (below) |
| `retest` | `on` | `off` to skip re-testing the open findings in the project's memory (below) |
| `flow-writes` | `never` | `allow` replays flows under `mode` (below) |
| `on-refused-step` | `report` | `stop` ends the check at a refused flow step (below) |
| `gate-retests` | `high` | `never` or `all` (below) |

And the action's own:

| Input | Default | |
|---|---|---|
| `working-directory` | `.` | Where the check runs; relative paths above are resolved from here |
| `version` | the ref's release | The scenescout npm version to run |
| `node-version` | `24` | Installed only when the runner has no Node 20 or newer |
| `install-deps` | `true` | On Linux, install the browser's system libraries with `sudo`. Set `false` on a runner or container that has them |
| `upload-artifact` | `true` | Keep the three files as an artifact |
| `artifact-name` | `scenescout-check-<job id>` | A second use in the same job gets `-2`, a third `-3`. Jobs of a matrix share a job id, so give each cell its own name, e.g. `scenescout-check-${{ matrix.browser }}` |
| `upload-sarif` | `false` | Upload `check.sarif` to code scanning (below) |

### Outputs

`passed` (`true` or `false`, empty when the check could not run; with `could-not-run` above 0 it describes the rest of the check, so `true` can come with exit code 2), `exit-code`, `failing` (what fails the gate: issues at the gate's severity or worse, plus re-tested findings that `--gate-retests` gates), `could-not-run` (flows a refused step kept from running), `retests-failing` (of `failing`, the re-tested findings), `high`, `medium`, `low`, the paths `report`, `json` and `sarif`, and `artifact-name`.

A later step can read them, for example to comment on the pull request. To keep the job going after a failed gate, give the step `continue-on-error: true` and look at `steps.scenescout.outputs.exit-code`.

### Code scanning

With `upload-sarif: true` the issues appear under the repository's Security tab and on the pull request. The upload needs a permission the default token does not have:

```yaml
permissions:
  contents: read
  security-events: write # upload-sarif
  actions: read # upload-sarif, in a private repository
```

A pull request from a fork gets a read-only token, so the upload fails there; leave it off for those runs, or upload only on pushes to your main branch.

### Checking while signed in

Save a Playwright storage state in an earlier step (for example your own Playwright setup project) and pass its path:

```yaml
      - uses: brunoboto96/SceneScout@v3.10.0
        with:
          url: http://127.0.0.1:3000/dashboard
          storage-state: playwright/.auth/user.json
```

If the session no longer signs in, the check exits 2 rather than checking the sign-in page and calling it the app.

## Saved flows

A check can also replay the flows that matter to you, with no model involved: open a page, click a control, see the result. Each flow is a JSON file in `.scenescout/flows/` in the project, and every one is replayed after the crawl. A flow whose step breaks fails the gate (`flow-step-failed`, high) with the flow, the step and what happened instead:

```text
flow "show details" (details.json) step 4 of 6, expect text "Details loaded": no visible text "Details loaded" within 5s
```

A flow has a `name` (the file name when left out) and its `steps`. The first step is a `navigate`:

```json
{
  "name": "show details",
  "steps": [
    { "action": "navigate", "target": "/things" },
    { "action": "type", "target": "label=Filter", "value": "abc" },
    { "action": "click", "target": "role=button[name=\"Show details\"]" },
    { "action": "expect-text", "text": "Details loaded" },
    { "action": "expect-url", "pattern": "details=open$" },
    { "action": "expect-request", "request": "GET /api/things/*", "status": 200 }
  ]
}
```

| Step | Fields | |
|---|---|---|
| `navigate` | `target` | A path on the app, starting with `/` |
| `click` | `target` | |
| `type` | `target`, `value`, `pressEnter`?, `replace`? | Appends unless `replace` is true |
| `select` | `target`, `value` | |
| `press` | `value` | A key, e.g. `Escape` |
| `expect-text` | `text` | Visible on the page |
| `expect-url` | `pattern` | A regular expression, tested against path, query and hash (never the origin) |
| `expect-request` | `request`, `status` | A method and path (`*` is one segment) answered with that status, or a class such as `"2xx"`, since the last action |

A `target` is `testid=…`, `text=…`, `label=…` or `role=<role>[name="…"]`. Each step waits up to five seconds, and a click is never forced through something covering its control. These are the steps `scout_run_plan` takes, so a plan an agent used to walk a flow can be saved as it is, with `expect-*` steps added where the outcome shows. That is how flows are made: written by hand, or by an agent asked to keep a flow it just walked.

A flow file that is not valid stops the check before it starts, with exit 2 and the file and field named (`bad.json: steps[1].target is required`).

Flows run in the crawl's browser context, one after another in file-name order, so cookies, storage and a signed-in session carry from the crawl to each flow and from one flow to the next; each starts from the page its first step names.

A flow's result also lists the WebSocket connections its page opened: the write rule covers HTTP only, and messages sent over a socket are not inspected. In Chromium, a request a page sends with `keepalive` or `navigator.sendBeacon` while it is being left (on `pagehide`, or a beacon on a timer that fires during the unload) is never routed, so the write rule does not see it and it reaches the server in any mode; Firefox and WebKit route it and the rule refuses it.

Anything else in the flows directory (another file type, a subdirectory, a symbolic link that resolves outside it) is listed in the report as skipped, with the reason. A symbolic link to a file inside the directory is followed.

Which writes a flow may send, what happens when one is refused, and whether re-tested findings gate are settings, described under [What a check may do](#what-a-check-may-do).

`flows/*.json` is the one part of `.scenescout/` that git does not ignore: SceneScout's `.scenescout/.gitignore` ignores everything else in that folder. A `.gitignore` SceneScout wrote before saved flows existed ignores them too, and is never rewritten; add these two lines to it:

```text
!flows/
!flows/*.json
```

`--flows <dir>` replays another directory instead (the action's `flows` input, relative to `working-directory`), and `--flows off` replays none.

## Re-testing open findings

When the project's `.scenescout/memory.json` holds findings earlier exploratory runs left open, the check re-tests the ones a page load can reproduce: the evidence names only failed GET requests (`GET /api/x 500`), and nothing was done on the page but looking at it. The check loads each one's page, at the path it was filed on, and reports it as follows. A page loaded only for a re-test is measured for that alone: it is not added to the checked routes, no page rule is applied to it, it does not count towards `--max-routes`, its links are not added to the routes the check knows, it stays on the unvisited list if it was on it, and the report says how many there were.

- **still reproduces**: the same request failed with the same status;
- **possibly fixed**: the page loaded and it did not (possibly, because the page may not have asked for it this time);
- **not re-tested**: the page did not load, or sent the browser to sign-in.

Re-tests are reported in `report.md` and `check.json`. Whether one fails the gate is `--gate-retests` (below); "possibly fixed" and "not re-tested" never do. The check reads the memory and never writes it, so nothing is resolved; `scout_verify` in an exploratory run does that, and re-tests the findings that need an interaction. `--retest off` skips all of this. The memory is ignored by git unless a project commits it, so without that this applies to checks run where the memory lives.

## What a check may do

Three settings describe choices a project makes about what its check may do beyond visiting pages. Their defaults are only a starting point: they are what an unconfigured check does, whether a person tries it for the first time or an AI agent runs it unattended, and they follow one rule — an unconfigured check does the least harm on an unfamiliar project: it sends no HTTP write and never silently hides a result. Anything else is one flag away. The effective values are printed under the verdict in `report.md` (and so on the job summary) and in `check.json` under `settings`, so a reviewer can see what a green check was allowed to do.

| Setting | Values | Default | Effect |
|---|---|---|---|
| `--flow-writes` | `never`, `allow` | `never` | `never`: flows replay under observe's rule whatever `--mode` says, so no flow sends an HTTP request other than a GET (a sign-in excepted). A refused request sent with `navigator.sendBeacon` or an `<a ping>` is listed in the flow's result as a refused background request and charged to no step, whatever its origin. Every other refused write (a fetch, an XHR, a form post) is charged to the step it happened during, or to the last step when it lands within 750 ms after it, whatever its origin: an app's API on another port or subdomain counts as the step's write, and telemetry sent with fetch or XHR, to the app's origin or another, is charged to the step it lands in, so a page that posts a heartbeat on a timer makes the flow "could not run". `allow`: flows replay under the check's own `--mode`, so in `read-only` a flow's form submissions are sent to the target on every run, while PUT, PATCH, DELETE, destructive POSTs and destructive-labelled controls are still refused. The crawl always runs under `--mode`. |
| `--on-refused-step` | `report`, `stop` | `report` | `report`: a flow whose step was refused is marked "could not run" in the report, in `check.json` (`gate.couldNotRun`) and in the SARIF (as a tool notification, not a result about the app), naming the flow, the step and the request; every other page, flow and re-test keeps its verdict, and the check exits 2. `stop`: the check exits 2 at the refused step, replays no further flows and writes no results. |
| `--gate-retests` | `never`, `high`, `all` | `high` | Which re-tested findings that still reproduce fail the gate: `high`, those filed at high severity; `all`, every one; `never`, none. "possibly fixed" and "not re-tested" never do, and `--fail-on never` turns this gate off with the others. A gating re-test is also a SARIF result (`open-finding-reproduces`). A still-failing request is usually an issue on its page as well, under its own rule. |

With `--on-refused-step report`, exit code 2 means some of the run could not happen, not that nothing was measured: `report.md` says whether the rest passed or failed. The action's `passed` output then describes the rest, `could-not-run` counts the flows that did not run, `exit-code` is 2, and the step's annotation names the flow and step and says whether the rest passed or failed.

Why flows and re-tests work this way: [ADR 12](adr/0012-a-check-replays-saved-flows-and-reports-re-tests.md).

## Other CI systems

Anywhere Node 20 or newer runs, the check is one command. Install the browser first; on Linux add its system libraries unless the image already has them (the official Playwright images do).

### Plain shell

```bash
npx --yes scenescout@3 install --browser-only --browsers chromium-headless-shell
npx --yes playwright install-deps chromium   # Linux, as root, if the image lacks the libraries

npm start &                                          # your app
npx --yes wait-on http://127.0.0.1:3000 --timeout 60000

npx --yes scenescout@3 check http://127.0.0.1:3000 --fail-on high --out scenescout-check
# exit 0: passed · 1: the gate failed · 2: could not run
```

`scenescout-check/report.md` is the report, `check.json` the machine-readable verdict and `check.sarif` the SARIF 2.1.0 file that most code-quality dashboards import.

### GitLab CI

```yaml
ui-check:
  image: mcr.microsoft.com/playwright:v1.63.0-noble
  script:
    - npm ci && npm run build
    - npm start &
    - npx --yes wait-on http://127.0.0.1:3000 --timeout 60000
    - npx --yes scenescout@3 check http://127.0.0.1:3000 --out scenescout-check
  artifacts:
    when: always
    paths: [scenescout-check/]
```

The Playwright image already has the browsers' system libraries. If its Playwright version is not the one scenescout uses, the check says which browser build is missing; add `npx --yes scenescout@3 install --browser-only --browsers chromium-headless-shell` before it.

### CircleCI

```yaml
jobs:
  ui-check:
    docker:
      - image: mcr.microsoft.com/playwright:v1.63.0-noble
    steps:
      - checkout
      - run: npm ci && npm run build
      - run:
          command: npm start
          background: true
      - run: npx --yes wait-on http://127.0.0.1:3000 --timeout 60000
      - run: npx --yes scenescout@3 check http://127.0.0.1:3000 --out scenescout-check
      - store_artifacts:
          path: scenescout-check
```

In any system, treat exit code 2 differently from 1 if you can: 2 means the job never measured the app.
