# Running `scenescout check` in CI

`scenescout check` visits every page of a running app and measures it, with no model involved, so the same app always gets the same verdict. That makes it a pull-request gate. Why its defaults are what they are: [ADR 11](adr/0011-a-gate-is-deterministic-and-fails-only-on-what-it-can-prove.md).

Whatever the CI system, the job has the same three parts: start the app, wait until it answers, run the check. The check never starts the app itself.

Checking or exploring the signed-in app needs a session in the job: [signing in from CI](#signing-in-from-ci) covers a scripted sign-in with a test user, and the rules for its credentials.

The exploratory side can run in CI too, with a model's API in place of a person or coding agent: [an unattended exploratory run](#an-unattended-exploratory-run), below. It reports and never gates. An allowed account can also start one on a pull request's preview by commenting `/scenescout qa`: [a QA review from a pull-request comment](#a-qa-review-from-a-pull-request-comment).

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
| `action-timeout-ms` | 5000 | How long one click, keystroke or pick may take, 1000 to 120000 (below) |
| `nav-timeout-ms` | 20000; 15000 per crawled route | How long a page may take to load, 1000 to 300000 (below) |
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

`passed` (`true` or `false`, empty when the check could not run; with `could-not-run` above 0 it describes the rest of the check, so `true` can come with exit code 2), `exit-code`, `failing` (what fails the gate: issues at the gate's severity or worse, plus re-tested findings that `--gate-retests` gates), `could-not-run` (flows a refused step kept from running), `retests-failing` (of `failing`, the re-tested findings), `high`, `medium`, `low`, `worth-a-look` (observations listed as worth a look, below; not in `high`, `medium` or `low`, and never in `failing`), the paths `report`, `json` and `sarif`, and `artifact-name`.

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

If the session no longer signs in, the check exits 2 rather than checking the sign-in page and calling it the app. To sign in within the job instead of keeping a storage state around, see [signing in from CI](#signing-in-from-ci).

## Signing in from CI

A job that checks or explores the signed-in app needs a session, and a CI runner has no one to type a password or a one-time code. There are three ways to give it one. Whichever you choose, the rules at the end of this section apply.

### Ways to sign in

| Option | How | Trade-off |
|---|---|---|
| A test user on a test tenant (recommended) | `scenescout login <url> --role <name> --script` fills the sign-in form from environment variables, including a one-time code when the form asks for one, and saves the session as the role's profile | Tests the real sign-in on every run. Needs a test tenant where the test user's code comes from an authenticator-app secret you can store, or where the code the app would email or text is a fixed one the test environment accepts, and no CAPTCHA |
| A test-only sign-in endpoint | The app, in its test environments only, exposes a route that sets a session for a named test user; a Playwright setup step visits it and saves a storage state | Fast and immune to changes in the sign-in page, but it is code that signs anyone in, so it must be compiled out of, or refused by, every production build |
| A saved session as a secret | Record a session once with `scenescout login <url> --role <name>` on your machine, store the file's contents as an encrypted secret, and write it to a file at the start of the job | No credentials in CI at all, but the secret is a live session: it expires, and anyone who reads it is signed in until it does. Rotate it like a password |

### A scripted sign-in

```bash
SCENESCOUT_LOGIN_USERNAME=… SCENESCOUT_LOGIN_PASSWORD=… SCENESCOUT_LOGIN_TOTP_SECRET=… \
  npx --yes scenescout@3 login https://staging.example.com/signin --role member --script \
    --project "$RUNNER_TEMP/scenescout" --success-url /dashboard
```

It runs headless, opens the URL and signs in as a person would: it finds the username (or email), the password and the one-time-code fields by their `autocomplete`, their type and the words that label them, fills what the page shows, and presses the button that moves the form on (Sign in, Next, Continue, Verify, Send code), never one that leads to another provider, a password reset, a new code or another address. A form that asks for the password only after "Next", or for a code on a page of its own, is followed step by step. The saved profile is the same file the manual login writes, at `.scenescout/auth/<role>.json` under `--project`, owner-only, so `--storage-state` or `scout_attach { role }` loads it as it would any other.

The code goes into a field whose `autocomplete` is `one-time-code`, or whose name or label says code, OTP or verification; or, when a code is set and the username or the password has gone, a numeric field (`inputmode="numeric"`) sized for a code. A code split into one box per character, 4 to 10 boxes side by side that each take one character, is typed one character per box. After typing, the run reads the page again until it is clear how to go on: a button the page keeps disabled until the form is complete is waited for and then clicked, a page that takes the code itself once the last character is in (it moves on, or clears the code to say it was wrong) is not submitted again, and a field the typing revealed is filled first. Where a page offers both, a button that signs in or verifies is pressed rather than one that sends a code.

A passwordless sign-in (the email, a button that sends a code, then the code) needs no password: leave `SCENESCOUT_LOGIN_PASSWORD` unset and set the code. Test environments of apps that email or text a code commonly accept one fixed code for test users; give it as `SCENESCOUT_LOGIN_OTP_CODE`:

```bash
SCENESCOUT_LOGIN_USERNAME=… SCENESCOUT_LOGIN_OTP_CODE=… \
  npx --yes scenescout@3 login https://staging.example.com/signin --role member --script \
    --project "$RUNNER_TEMP/scenescout" --success-url /dashboard
```

While the app sends the code there may be no field on the page; after the username alone that is never taken for signed in. A password field that appears with no password set ends the run, naming `SCENESCOUT_LOGIN_PASSWORD`.

| Variable | |
|---|---|
| `SCENESCOUT_LOGIN_USERNAME` | Required. The test user's username or email |
| `SCENESCOUT_LOGIN_PASSWORD` | Required, except for a passwordless sign-in, where it is left unset and `SCENESCOUT_LOGIN_OTP_CODE` or `SCENESCOUT_LOGIN_TOTP_SECRET` is set instead. Set but empty is refused, since a CI secret that does not exist reads as empty. Used exactly as given |
| `SCENESCOUT_LOGIN_TOTP_SECRET` | When the sign-in asks for a code: the base32 secret an authenticator app is set up with, or the whole `otpauth://totp/…` URI its QR code holds (its algorithm, digits and period are honoured). The code is generated per RFC 6238, so the runner's clock must be right |
| `SCENESCOUT_LOGIN_OTP_CODE` | When the sign-in asks for a code and the test environment accepts a fixed one, as it may for a code it would otherwise email or text: 4 to 12 letters or digits, typed as given. Set this or `SCENESCOUT_LOGIN_TOTP_SECRET`, not both |
| `SCENESCOUT_LOGIN_SUCCESS_URL` / `--success-url` | What the URL's path contains once signed in (`/dashboard`; the query is not searched), or an absolute URL it starts with. Recommended: without it or the selector below, the sign-in counts as done when, once the password or the code has gone, no username, password or code field is left on the page, which an error page with no form also satisfies |
| `SCENESCOUT_LOGIN_SUCCESS_SELECTOR` / `--success-selector` | A CSS selector visible only when signed in. With both set, both must match |
| `SCENESCOUT_LOGIN_USERNAME_SELECTOR`, `_PASSWORD_SELECTOR`, `_OTP_SELECTOR`, `_SUBMIT_SELECTOR` (or `--username-selector` and so on) | A CSS selector for a field or button the rules above do not find. Each is used where it matches and the rules fill in the rest |

`--timeout <seconds>` bounds the whole sign-in (default 60, 5 to 600). Credentials have no flag, because a flag shows in the process list and the shell history.

Missing or malformed configuration (a credential not set, a password set but empty, a TOTP secret that is not base32, a fixed code that is not 4 to 12 letters or digits, a fixed code and a TOTP secret both set, a timeout out of range) is reported before a browser starts, naming the variable and never its value; a selector that is not valid CSS is reported when the page is first read. The command exits 0 once signed in and saved, and 1 otherwise: a refused password or code, a field named or laid out as a code (one box per character) with no code or secret set, a password field with no password set, or a form it could not move on. A refused sign-in, or one that times out, quotes the error the page shows. Every credential value, as typed and URL-encoded, the username and a fixed code in any case, and each code typed, is replaced by `[redacted]` in everything it prints, including that quoted message, so a page that echoes what was typed does not put the password or the code in the job log.

Not covered: a sign-in form inside an iframe, a code that is emailed or texted and different every time (the test environment has to accept a fixed one), a sign-in link sent by email, a CAPTCHA or other bot check, and push second factors. Use a test-only endpoint or a saved session for those.

In GitHub Actions:

```yaml
jobs:
  check-signed-in:
    # Never for a pull request from a fork: this job holds the test user's password.
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    environment: test-tenant # holds the secrets below; restrict it to protected branches if you can
    steps:
      - uses: actions/checkout@v4
      - run: npx --yes scenescout@3 install --browser-only --browsers chromium-headless-shell
      - name: Sign in as the test user
        env:
          SCENESCOUT_LOGIN_USERNAME: ${{ secrets.TEST_USER_USERNAME }}
          SCENESCOUT_LOGIN_PASSWORD: ${{ secrets.TEST_USER_PASSWORD }}
          SCENESCOUT_LOGIN_TOTP_SECRET: ${{ secrets.TEST_USER_TOTP_SECRET }}
          # A passwordless sign-in sets no password and, in place of the TOTP secret, the fixed code:
          # SCENESCOUT_LOGIN_OTP_CODE: ${{ secrets.TEST_USER_OTP_CODE }}
        run: >
          npx --yes scenescout@3 login https://staging.example.com/signin --role member --script
          --project "$RUNNER_TEMP/scenescout" --success-url /dashboard
      - uses: brunoboto96/SceneScout@v3.10.0
        with:
          url: https://staging.example.com/dashboard
          storage-state: ${{ runner.temp }}/scenescout/.scenescout/auth/member.json
```

The secrets are set on the sign-in step only, so no later step, the check included, has them in its environment.

### The rules

- **A test user on a test tenant, never production and never a real person's account.** The account exists to be signed into by a machine; if its password leaks, nothing real is exposed. Give it the least access the tests need.
- **Credentials come from the environment, filled from the CI system's secrets.** Never in the workflow file, a flag, a committed `.env` file or a script. GitHub also masks secret values in logs; the redaction above is a second layer, not a reason to skip the first.
- **No code from a fork's pull request runs with these secrets.** A fork's pull request gets no secrets under `pull_request`; under `pull_request_target` or `workflow_run` it can, so never check out and run a fork's code in a job that sets them.
- **The profile stays in the runner's temporary directory and is never uploaded.** `--project "$RUNNER_TEMP/scenescout"` keeps it out of the workspace, so no artifact upload, cache or `git add` picks it up. It is a live session for as long as the app lets it live.

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

A flow's result also lists the WebSocket connections its page opened: the write rule covers HTTP only, and messages sent over a socket are not inspected. A request a page sends with `keepalive` or `navigator.sendBeacon` while it is being left (on `pagehide`, or a beacon on a timer that fires during the unload, including as the flow leaves its page) is judged by the same rule in every browser and refused under `never`; a beacon is then listed as a background request, and a keepalive fetch is charged to the step, or to the last step, it lands in.

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

## Worth a look

Some rules measure something exactly that is a defect only under a convention of the project the check cannot see. SceneScout does not decide those conventions ([ADR 13](adr/0013-a-convention-is-the-projects-to-decide.md)), so these rules report into a tier of their own:

| Rule | What it measures | A defect only if the project uses |
|---|---|---|
| `off-grid-spacing` | more than a fifth of a page's paddings or vertical margins not a multiple of 4px | a 4px spacing scale |
| `indistinct-link` | links with no underline, in the page's body-text colour | a visible link style (an underline or a distinct colour) wherever links appear, navigation included |

Their effect on a check:

- They have no severity, are not in the counts, and never fail the gate, at any `--fail-on`.
- `report.md`, and so the job summary, lists them under **Worth a look** below the issues, each with the convention that would make it a defect.
- `check.json` lists them under `worthALook`, apart from `issues`, `counts` and `gate`, each with its `rule`, `evidence`, `routes`, `convention` and `fingerprint`.
- `check.sarif` has them as results at level `note`, with `properties.tier` set to `worth-a-look` and the convention in `properties.convention`; their rules carry the tag `worth-a-look`.
- The GitHub Action publishes their number as the `worth-a-look` output.
- `--ignore` removes them like any other rule.

A control smaller than 24×24px is not in this tier: WCAG 2.2 sets that minimum (2.5.8, level AA) for any pointer, so `tiny-target` stays a low issue.

### On a loaded runner

A check gives each action on a page 5 s and each crawled page 15 s to load. On a shared or busy runner these can run out while the app is fine, and the check then reports a timeout that belongs to the machine. When that happens the message names the limit that ran out and how to raise it: `--action-timeout-ms` and `--nav-timeout-ms` (the action's `action-timeout-ms` and `nav-timeout-ms`), or `SCENESCOUT_ACTION_TIMEOUT_MS` and `SCENESCOUT_NAV_TIMEOUT_MS` in the environment. A flag wins over the variable, and the variable over the default. A page-load limit that is set applies to every page the check opens, the start page, crawled routes and flow steps alike. A value outside the bounds stops the check with exit 2 before anything is measured. `scenescout ci` takes the same two flags.

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

## An unattended exploratory run

`scenescout ci <url>` is an exploratory run with nobody present. A model reached through its API drives the same `scout_*` tools, by the same method a coding agent follows, and the run ends in the same report. It needs an API key and costs what the model's API charges; `scenescout check` needs neither. Why it works this way: [ADR 14](adr/0014-an-unattended-run-reports-and-never-gates.md).

It reports and never gates:

| Exit code | Meaning |
|---|---|
| 0 | The run ran and the report is written, whether the model finished or a cap ended it. What it found does not change this. |
| 2 | It could not run: a bad argument, no key or two keys and no `--provider`, a key or request the API refused, an app that never answered, a saved session that no longer signs in, or results that could not be written. |

Two runs of the same app explore differently and find different things, so a finding from this run is something to read. To fail a pull request on something, use `scenescout check`, or a saved flow it replays.

### The model

The key is read from the environment and nowhere else: there is no option or action input for it.

| Key set | Provider | API | Default model |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `anthropic` | Messages API | `claude-sonnet-5` |
| `OPENAI_API_KEY` | `openai` | Responses API, with function calling | `gpt-6-luna` |
| both | the one `--provider` names; without it the run exits 2 | | |

- `--model <id>` runs another model of the same provider.
- `--effort none|low|medium|high|xhigh|max` sets the reasoning effort; the default is `low`. `none` exists only on the OpenAI API.
- `--base-url <url>` sends requests to another endpoint that implements the same API (for OpenAI, `POST <base>/responses`; for Anthropic, `POST <base>/messages`), for example a gateway or a self-hosted server. It must be `https`, or plain `http` to `127.0.0.1` or `localhost`, since the key is sent to it.
- A call that is throttled or meets a server error is retried up to three times, with a growing, jittered wait that honours `retry-after`; one the API refuses (a bad key, a bad request) is not retried and ends the run with exit 2.

Keys never reach the output. The browser and the MCP server run in a child process started without them, and every line the run prints or writes is passed through a redaction of the key values and of anything shaped like a provider key.

### Caps

| Option | Default | Counts |
|---|---|---|
| `--max-turns` | 40 | Model calls. Several tool calls in one reply are one turn. |
| `--max-tokens` | 1,500,000 | Input and output tokens over the whole run, cached input included. |
| `--max-minutes` | 20 | Wall time of the exploration. |

The caps are checked before each model call. No model call, retry or wait between retries runs past the time cap, and no tool call either: each is given only the time left, and a tool call reached after the cap is answered as not run. At most 16 tool calls are run from one model reply; any beyond are answered as not run. Attaching the browser counts towards the time cap. The first cap reached ends the exploration; then the report is written and the browser closed, which share a budget of three minutes, and the files are written, which takes seconds. So the command ends at most about `--max-minutes` plus 4 minutes after it starts. One turn's usage is known only after it, so a run can end up to one turn over the token cap (with `--lanes`, one turn per lane: see [Lanes](#lanes)). The summary, `ci.json` and the action's `stop` output name what ended the run: `done` (the model finished), `turns`, `tokens`, `time`, `provider-error` or `could-not-start`.

Each turn sends the conversation so far, so input tokens grow with every turn: the method and the tool descriptions alone are around 20,000 tokens, and each tool result adds to what every later turn sends. With the defaults a run usually reaches the token or the time cap before the turn cap. Tool results longer than 16,000 characters are cut before they reach the model; the report keeps everything.

What a run costs follows from the token cap. At the defaults on `gpt-6-luna` ($0.10 per million input tokens, $0.01 cached, $0.50 output), a run that reaches the 1,500,000-token cap costs about $0.05 to $0.15, since most of each turn's input repeats the turn before and is read from the provider's cache; with nothing cached, the most it can cost is about $0.18. A run can end up to one turn over the cap, which adds a little. `--max-tokens` is the setting that bounds the cost.

### What the run may do

| Option | Values | Default | |
|---|---|---|---|
| `--mode` | `observe`, `read-only`, `safe-write`, `destructive` | `read-only` | The write policy the browser runs under, enforced on the network as in any run. `observe` sends no request other than a GET; `read-only` lets ordinary form submissions through and refuses PUT, PATCH, DELETE and destructive POSTs; `safe-write` lets the run create records and change or delete only the ones it created; `destructive` refuses nothing. |
| `--allow-destructive` | a switch | off | Needed with `--mode destructive`, which without it exits 2. On its own it changes nothing. |
| `--level` | `minimal`, `medium`, `extensive` | `medium` | The completion contract the run works towards. When a cap ends the run first, the report is generated anyway and its gap ledger lists what was not done; the summary says whether the contract was met. |
| `--focus` | a few words | none | An area or flow to spend the run on. |
| `--show` | a few words, at most 200 characters | none | Instead of exploring, find the element these words describe and save a PNG of it. See [Showing one element](#showing-one-element). |
| `--compare-url` | an http(s) URL | none | With `--show`, capture the same element on this deployment too and compare the two pictures. |

In `destructive` mode the model may send any request the app accepts, including deleting or changing records the run did not create, with nobody watching; it takes two options together so that a mode value copied from another workflow, or chosen by an agent, never enables it. The defaults follow the same rule as the check's: an unconfigured run does the least harm on an app it knows nothing about, and anything more is an option away. Which mode a project's CI uses is the project's decision.

The run attaches to the URL it is given, in the mode it is given (with `--compare-url`, the run itself attaches a second session there after the model is done; with `--lanes`, each lane attaches its own session on the same URL, in the same mode); the model cannot attach elsewhere or change the mode. It gets the scout_* tools a single agent uses to explore, find and report, and not those for attaching, closing, parallel lanes or screenshots. Unless `--lanes` asks for more, it is one model loop: see [Lanes](#lanes).

`--storage-state <file>` explores while signed in; a session that no longer signs in exits 2 before the model is called. `--browser`, `--action-timeout-ms`, `--nav-timeout-ms`, `--project` and `--out` are as for `check`.

### Lanes

`--lanes <n>` (1 to 8, default 1) splits the exploration between `n` model loops that run at once, each in its own browser session and its own part of the app, as the [parallel lanes](guide/Ways-to-use-it.md#parallel-lanes) of an agent-driven run do. Why it works this way: [ADR 20](adr/0020-an-unattended-run-may-split-into-lanes-that-share-its-caps.md).

1. **Plan.** The run attaches as usual, takes a snapshot of the page it landed on (which is what collects its links) and crawls, up to three rounds, each visiting the routes the pages of the round before linked to. No model is called; the time it takes counts towards `--max-minutes`. The routes found are split the way `scout_lane_brief` splits them: whole modules, a module being a route's first path segment, dealt to the lanes largest first so each lane has about as many routes as the others.
2. **Explore.** Each lane attaches its own session on the target URL, as the run's first session did (the engine resolves every path against the URL a session attached with), and the run opens the lane's first route in it; a route that does not open leaves the lane on the target. The lane then runs the model loop with a conversation of its own: the method, the rules every lane follows, and a first message naming its routes, what the crawl saw on them and its share of the budget. A lane is not given `scout_report`. A lane that finishes closes its browser.
3. **Merge.** Every session files into the project's one memory, whose dedup folds a defect two lanes filed into one finding. Once every lane has ended, the run writes one report from the session that planned, and the summary and `ci.json` list each lane: what it owned, its turns and tokens, and what ended it.

The caps are the run's, shared by the lanes rather than given to each. The lanes together make at most `--max-turns` model calls: a turn is taken before its call, so lanes that reach the last turn together cannot all start it. They stop at the same `--max-minutes`. Tokens are counted when a call returns, so a run can end up to one turn per lane over `--max-tokens`, where a single loop can end one turn over. A lane that finishes early leaves the turns it did not use to the lanes still running. `--lanes` must not exceed `--max-turns`, and `--show` takes no lanes.

What ended a run in lanes: a model API failure in any lane ends it as `provider-error` (exit 2), since that is what the workflow must fix, and a lane that broke after attaching ends it as `could-not-start` (exit 2), with the report still written; otherwise a cap, if any lane was stopped by one; otherwise `done`. A lane whose browser could not attach is listed with the reason, and named in the stop's detail, and does not fail the run, unless no lane could attach.

With fewer than two modules there is nothing to split: the run explores in one loop, and the summary and `ci.json` say so, as they do when the planning crawl failed. Fewer modules than lanes gives fewer lanes. Pages that all sit under one path (`/app/…`) are one module, so such an app splits into at most two lanes, one of them only the page the run started on, or none when the target URL is itself under that path.

Each lane is a browser running at the same time as the others, and the run's first session keeps its browser open to write the report, so give the runner the memory for them all: as for agent-driven lanes, about as many lanes as the runner has cores, less two.

Lanes spend tokens faster: in [the benchmark](benchmark.md#lanes-one-loop-against-four-task-40), four lanes sent about 1.4 million tokens a minute, about 2.8 times one loop's, so a provider's tokens-per-minute limit is reached sooner, and a call still refused (HTTP 429) after its retries ends the run as `provider-error`.

What lanes find depends on the budget each lane gets. On the demo app at the default caps, four lanes found as many expected defects as one loop (3 of 13 in two runs each, not the same ones): ten turns a lane left each lane on its first page, while one loop ended by itself at 29 turns. With the caps raised to 160 turns and 6,000,000 tokens, four lanes found 8 of 13 in each of two runs on the demo app and 7 of 10 on the held-out app, while one loop given the same caps ended by itself at 37 turns with 5 of 13. That gain, +3, sits at the benchmark's noise bound, so the default stays one loop. The configuration that found the most is `--lanes 4 --max-turns 160 --max-tokens 6000000`: about 2 million tokens and $0.025 a run on `gpt-6-luna`, about 2.3 times one loop's cost, in about the same wall time. Its token rate is near a 2,000,000-tokens-a-minute limit, so run one such job at a time per API key, or the provider refuses calls and the run ends `provider-error`.

### Finding dedup

Two findings the model files about one defect should be one entry in the report. The store's rule merges them when they share a machine signal: the same evidence, the same failing request, a quoted message, or titles sharing at least half their words ([ADR 4](adr/0004-dedup-on-machine-signals-not-prose.md)). It almost never merges two different defects, and it misses many merges: two descriptions of one defect in different words stay two findings. On the answer keys' labelled pairs a model judge did far better (Brier 0.019 against the rule's 0.180 on the demo app, 0.007 against 0.140 on the held-out app at effort `none`, with no wrong merge), so a run asks one by default:

| `--dedup` | What happens to a filed finding |
|---|---|
| `judge` (default) | The rule decides first. When it keeps the filing apart from everything recorded, the run's model is asked, finding against finding, whether it is the same defect as one of the open findings on the same page: the three most alike by title, at most. A "same" merges the filing into that finding; the report shows it under the finding (its title, category, severity and evidence, with the judge's probability), so a wrong merge can be seen, and the filing refiled as its own defect. Anything else (different, unsure, an answer that contradicts itself, a call that fails or takes longer than 15 seconds) leaves the rule's decision. |
| `rule` | The rule alone, as before; nothing is sent. |

- **What is sent.** For each pair asked about: the page's path and the two findings' titles, categories and evidence, to the provider the run already uses. Not their detail, and nothing else. The run already sends that provider the pages it explores.
- **What it costs.** One call per pair, a few hundred input tokens and about 25 output tokens each, with the run's model at the lowest effort its API takes: `none` on OpenAI, `low` on Anthropic. The judge's tokens count in the run's usage and towards `--max-tokens`. The summary and `ci.json` (`dedup`) say how many calls were made and what they used.
- **When it fails.** A failed call, an unsure answer or one that contradicts itself is logged once and leaves that pair to the rule. No judge call runs past the time cap: one asked after it is not sent, and one asked before it gets only the time left. Three failed calls in a row switch the judge off for the rest of the run, with one line saying so. A filing with more open findings on its page than the judge asks about is logged once per page.
- **Where the key stays.** The judge's calls are made by the run, not by the MCP server: the server asks for each one over its MCP connection (a sampling request), so the server's process still never has the key.
- A rule merge is never put to the model, so the judge only adds merges and never splits what the rule joined. It was measured with OpenAI's `gpt-6-luna` at effort `none` ([docs/benchmark.md](benchmark.md#judge-run-2-the-judge-beats-the-rule-on-both-apps)); with another model or provider it has not been.

Outside CI the judge is off: an agent's run dedups by the rule unless `SCENESCOUT_DEDUP=judge` is in the MCP server's environment, or `scout_attach {dedup: "judge"}` asks for it, and then it needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the server's environment too ([configuration reference](guide/Configuration-reference.md#environment-variables)).

### Showing one element

`scenescout ci <url> --show "the Save button"` does not explore. The model is given only `scout_snapshot`, `scout_crawl`, `scout_navigate`, `scout_back`, `scout_scroll` and `scout_capture`, and is told to find the element the words describe and capture it; the words are passed as data, quoted. The picture is SceneScout's, not the model's: `scout_capture` scrolls the element into view and takes a browser screenshot of its bounds plus an 8-pixel margin, cut to the viewport. The model chooses which element by its ref and nothing else; the file's name is fixed. The picture is `shots/preview.png` in the output directory.

With `--compare-url <url>`, SceneScout then opens the same page on that URL (the page's path below the target URL, carried over to the other one) in a second browser session, finds the same element by its identity (its test id, else its role and name, as coverage keys it), and captures it the same way as `shots/base.png`. `shots/diff.png` is the new picture faded to grey with every changed pixel in red, and `ci.json` records the share of pixels changed. Two pictures of different sizes are laid over each other from the top-left corner, and pixels only one of them covers count as changed; the size change is reported as well. A channel difference of up to 8 out of 255 is not counted as a change.

What can be shown is limited on purpose. Only an element a snapshot lists (a control, a link, a field) on a page opened by its URL can be captured: nothing is clicked, so an element inside a closed menu, a tab or a dialog is out of reach, and a comparison has to be able to reach the same page on the other deployment by its URL alone. An element whose test id or accessible name changed between the two deployments is not found on the base, and the result says so. Neither run writes a report: `ci.json` and the job summary say what was captured, and a run whose model found nothing to capture still exits 0, saying so.

### What it writes

In `<project>/.scenescout/ci/`, or `--out`:

- `report.md` and `report.html`: the report, exactly as an agent's run writes it (it is also in `.scenescout/report.md`, with the run's memory);
- `summary.md`: how the run ended, what it spent, and the findings this run made or saw again. On GitHub Actions it is also appended to the job summary;
- `ci.json`: the same, for a script: `stop`, `contractMet`, `usage` (`turns`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `seconds`, `estimatedCostUsd`), `dedup` (`by`, and with the judge `effort`, `calls`, `failed`, `inputTokens`, `outputTokens` and `seconds`, already counted in `usage`), `counts` and `findings`, and with `--lanes` 2 or more, `lanes`: `asked`, `planned` (the lanes the split made), `ran` (those that attached), `oneLoop` (why the run explored in one loop, when it did) and `sessions`, each lane's `session`, `modules`, `routes`, `attached`, `stop`, `detail`, `turns` and tokens;
- `ci.sarif`: the findings as SARIF 2.1.0, at `error`, `warning` or `note` by severity, and worth-a-look findings as notes.

The usage line reads like `14 turn(s), 402,310 tokens in (301,200 cached), 18,400 out, 9m 12s, estimated cost $0.0223`. The cost is estimated from the token counts the API returns and the published price of the default models. `--price-in`, `--price-cached-in` and `--price-out` (US dollars per million tokens) replace those prices, or give one for any other model; cached input with no price of its own is charged at the input price. With neither a built-in price nor both `--price-in` and `--price-out`, the line says the cost was not estimated.

The project's `.scenescout/memory.json` is written as in any run, so a later run, or `scenescout check`'s re-tests, can build on what this one found. On a CI runner that memory is gone after the job unless the workflow keeps it, for example with `actions/cache` on `.scenescout/memory.json`.

### GitHub Actions

The action lives in the repository's `ci` folder. Its inputs are the command's options by name, as for the check's action, and the key is passed in the step's `env` from a secret:

```yaml
      - name: SceneScout CI run
        id: explore
        uses: brunoboto96/SceneScout/ci@v3 # or an exact tag, from the first release that has it
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          url: http://127.0.0.1:3000
          mode: read-only
          max-minutes: "20"
```

Put it after the steps that start the app and wait for it, as in the check's workflow above, and give the job a `timeout-minutes` of at least `max-minutes` plus 5, plus what the steps before it take (checkout, install, starting the app, and the browser download on a cold cache), so the job's timeout never stops the step before its files are written. The action installs Node when needed, SceneScout and the browser (cached), runs the command, puts the summary on the job summary and keeps the output folder as an artifact. Its step fails only on exit 2.

Its own inputs are the check action's: `working-directory`, `version`, `cli`, `node-version`, `install-deps`, `upload-artifact`, `artifact-name` (default `scenescout-ci-<job id>`) and `upload-sarif` (to code scanning under the category `scenescout-ci`), and `cache` (default `true`; `false` keeps the browser out of the actions cache, for a job that checks out a ref chosen by an input). Its outputs are `exit-code`, `stop`, `high`, `medium`, `low`, `worth-a-look`, `turns`, `tokens`, `estimated-cost`, and the paths `report`, `summary`, `json` and `sarif`.

A pull request from a fork gets no secrets, so the step exits 2 there for want of a key; run it on pushes, on a schedule, or on pull requests from the same repository. Under `pull_request_target`, a fork's code runs with the repository's secrets; a job that sets the key and checks out and starts a fork's app gives that code the key and makes its pages the text the model reads.

### Filing the findings as issues

`scenescout export` files the project's open findings as GitHub or Jira issues, each once, so a step after the run can put them where the team works. With the job's token and `issues: write` permission:

```yaml
      - run: npx -y scenescout@3 export --to github --repo "$GITHUB_REPOSITORY" --yes
        env:
          GH_TOKEN: ${{ github.token }}
```

Without `--yes` it is a dry run that lists what it would file. A later export skips every finding that already has an issue, open or closed, by the marker each issue carries (`--refile-closed` files one again when its issue is closed). That marker holds the finding's id from the project's memory, so keep `.scenescout/memory.json` between runs (with `actions/cache`, as above): a run that starts from an empty memory gives a defect it words differently a new id, and a new issue. The guide has [the details](guide/Ways-to-use-it.md#filing-findings-as-issues), and the [configuration reference](guide/Configuration-reference.md#scenescout-export) every option.

### Other CI systems

```bash
npx --yes scenescout@3 install --browser-only --browsers chromium-headless-shell
npm start &
npx --yes wait-on http://127.0.0.1:3000 --timeout 60000
npx --yes scenescout@3 ci http://127.0.0.1:3000 --out scenescout-ci
# exit 0: the run ran (read scenescout-ci/summary.md) · 2: it could not run
```

with `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` set from the CI system's secret store.

## A QA review from a pull-request comment

An account the repository allows comments `/scenescout qa` on a pull request and gets an unattended exploratory run of that pull request's preview, with the results posted as a reply. Why it is shaped this way: [ADR 15](adr/0015-a-qa-comment-tests-a-preview-and-never-runs-the-pull-requests-code.md).

**It tests a deployed preview, never the pull request's code.** The job that holds the model's key checks out nothing, builds nothing and runs only SceneScout, from an exact release tag. So the project must already deploy each pull request somewhere reachable over https (a preview environment, a review app, a per-branch deployment). A project without previews can use the [unattended run](#an-unattended-exploratory-run) on pushes or a schedule instead.

### The workflow

Copy [examples/workflows/scenescout-qa.yml](../examples/workflows/scenescout-qa.yml) to `.github/workflows/` and add the key as a repository secret (`OPENAI_API_KEY` in the file; for Anthropic, change the name in the `qa` job's `env` to `ANTHROPIC_API_KEY`). It has three jobs:

| Job | Holds the key | Permissions | What it does |
|---|---|---|---|
| `gate` | no | `pull-requests: write`, `deployments: read` | Reads the comment and the pull request, checks the commenter and where the pull request comes from, finds the preview's URL, and reacts to the comment. The only job that may receive the optional team token (below). |
| `qa` | yes | `contents: read` | Runs only when the gate says so. Runs `brunoboto96/SceneScout/ci` at an exact release against the preview's URL, with the caps below, and keeps the results as an artifact. |
| `shots` | no | `contents: write` | Only after a `show` or `compare` run succeeded. Puts its pictures on the `scenescout-shots` branch so the reply can show them. |
| `report` | no | `pull-requests: write`, `actions: read` | Posts the results on the pull request, with a link to the artifact, or says the run could not run. |

Pin both actions (`brunoboto96/SceneScout/qa` and `brunoboto96/SceneScout/ci`) to the same exact release tag, from the first release that has them, or to that release's commit SHA; never to `@v3` or a branch. `issue_comment` runs the workflow file as it is on the default branch, so a pull request cannot change it. SceneScout's own code comes from that release; its npm dependencies are resolved when the action installs it, within the ranges that release declares, since the package ships no lockfile.

### The command

```
/scenescout qa [preview URL] [focus]
/scenescout qa [preview URL] show <element>
/scenescout qa [preview URL] compare <element>
```

Only the comment's first line is read, and the comment must begin with `/scenescout qa`, in any case, with nothing before it (the job's `startsWith` filter and the gate match it the same way). An optional https URL as the first word overrides where the preview is found; any other words become the run's `focus`, cut to 200 characters. Editing a comment starts nothing: only a new comment does.

When the words after the URL begin with `show` or `compare` (a word of its own, in any case), the rest describes one element, e.g. `/scenescout qa compare the Save button`. `show` replies with a picture of that element on the preview. `compare` also captures it on a base URL and replies with the two side by side, a diff picture with the changed pixels in red, and the share of pixels changed. The base URL is the variable `SCENESCOUT_QA_BASE_URL` when it is set (the production site, say), else the newest successful deployment of the pull request's base branch; it is held to the same rules as the preview's URL. What can be captured, and how, is [Showing one element](#showing-one-element).

### The pictures in the reply

A comment cannot carry files, so the `shots` job pushes the pictures to the branch `scenescout-shots`, under a folder named after the workflow run, and the reply links them from there. The branch starts with no history of its own, so it never holds code, and the job pushes at most three files, by fixed names (`preview.png`, `base.png`, `diff.png`), each checked to be a PNG under 5 MB. It holds no model key, and refuses to run where one is set; it checks nothing out and runs nothing from the artifact. The branch name is fixed in the action, not an input. Two runs pushing at once do not force: the later one builds on the new tip.

The reply renders only images whose URLs the report stage builds itself, from the server, the repository, the run's id and those three names, and only for the files the `shots` job says it pushed. Everything else in the reply comes from `ci.json` and stays inert, so image syntax in a finding's title or in the element's description is shown as text. The images are served from the repository, so they show to whoever can read it. The pictures are also in the run's artifact. Deleting the `scenescout-shots` branch removes them; the replies that linked them then show broken images.

What the commenter sees:

| Situation | Reaction | Reply |
|---|---|---|
| A run starts | 👀 | The results, when the run ends |
| The commenter is not allowed | 😕 | None, so the command cannot make the workflow write on a pull request |
| The pull request is closed, comes from a fork, has no preview, or its preview URL is not https | 😕 | One line saying why no run started, and how to change it |
| `show` or `compare` with no element named, or `compare` with no https base URL | 😕 | One line saying why no run started, and how to change it |
| The run is cancelled by hand or reaches the job's timeout | 👀 | One line saying so, with a link to the run |
| A newer `/scenescout qa` on the same pull request cancels the run | 👀 | None from this run: the newer one replies |

The reply names the pull request's head commit when the run was asked for. The preview may have been deployed from an earlier commit, so that is not a claim about what was tested.

### What a project configures

All optional, as repository variables (Settings → Secrets and variables → Actions → Variables):

| Variable | Default | |
|---|---|---|
| `SCENESCOUT_QA_ALLOWED` | the repository's owners | The GitHub logins that may start a run, separated by commas or spaces. See [Who may start a run](#who-may-start-a-run). |
| `SCENESCOUT_QA_ALLOWED_ROLES` | none | Comment author associations that may start a run: `OWNER`, `MEMBER`, `COLLABORATOR`, separated by commas or spaces. |
| `SCENESCOUT_QA_ALLOWED_TEAMS` | none | Teams of the repository's organization whose active members may start a run, as `org/team-slug`, separated by commas or spaces. Needs the `SCENESCOUT_QA_TEAM_TOKEN` secret. |
| `SCENESCOUT_QA_PREVIEW_URL` | none | A template for the preview's URL, with `{pr}` (the pull request's number) and `{sha}` (its head commit) filled in, e.g. `https://pr-{pr}.preview.example.com`. |
| `SCENESCOUT_QA_ENVIRONMENT` | any | Without a template, the preview is the newest successful deployment of the head commit, as the deployments API reports it; this limits it to one environment's deployments. |
| `SCENESCOUT_QA_ALLOW_FORKS` | off | `true` runs on pull requests from forks. Off, a fork's pull request gets a reply saying why nothing ran. |
| `SCENESCOUT_QA_BASE_URL` | the base branch's deployment | What `compare` compares the preview with, e.g. `https://www.example.com`. Unset, the newest successful deployment of the pull request's base branch; with neither, `compare` replies saying so. |

And one optional repository secret (Settings → Secrets and variables → Actions → Secrets):

| Secret | |
|---|---|
| `SCENESCOUT_QA_TEAM_TOKEN` | Read only when `SCENESCOUT_QA_ALLOWED_TEAMS` is set: a token that can read the organization's team membership, either a GitHub App installation token with the organization's Members permission (read), or a personal access token with `read:org`. The workflow's own token cannot read team membership. The template passes it to the `gate` job only; never add it to the `qa` or `report` job. |

The preview's URL is chosen in this order: the URL in the comment, the template, the deployment. It must be `https` and carry no credentials. The run explores the preview signed out: the `qa` job checks out nothing, so it has no saved session to read.

### Who may start a run

`SCENESCOUT_QA_ALLOWED`, `SCENESCOUT_QA_ALLOWED_ROLES` and `SCENESCOUT_QA_ALLOWED_TEAMS` combine as a union: a commenter listed by login, whose author association is in the role list, or who is an active member of a listed team may start a run.

- **With all three unset**, the repository's owners may: the owner's login on a repository a user owns, and any commenter GitHub marks as `OWNER` (on a repository an organization owns, an owner of that organization).
- **With any of them set, it replaces that default.** Include yourself: add your login, or `OWNER` to the roles, if the owners should keep the command.
- **Roles** come from the comment's `author_association` in the event, so they need no API call. `OWNER`, `MEMBER` and `COLLABORATOR` are the values that may be listed. Any other value (a typo, or `CONTRIBUTOR`, `NONE` and the like, which describe people with no standing in the repository) fails the `gate` job with an error naming it, and no comment is acted on until it is fixed.
- **Teams** are read with `GET /orgs/{org}/teams/{team_slug}/memberships/{username}`, using `SCENESCOUT_QA_TEAM_TOKEN`, and only for a comment that is the command from someone the logins and roles have not already allowed. A membership counts only when its state is `active`. Every other outcome refuses and says why as an annotation on the `gate` job: no token, a 401 or 403 (the token cannot read the organization), a 404 (not a member, or the token cannot see the team), a pending invitation, or a call that fails after its retries. A team of an organization other than the repository's owner is never looked up, so the token is only ever used about the repository's own organization; the gate logs an error naming it. None of these falls back to allowing. An entry that is not `org/team-slug` fails the `gate` job, as an unknown role does.

A commenter who is not allowed, by any path, gets the 😕 reaction and nothing else: the pull request is not read.

### What it costs, and how much it runs

- One run per comment. A new `/scenescout qa` on the same pull request cancels the run already going there, and only the newer one replies. The report job tells that apart from a run cancelled by hand or by its timeout by looking for a later run whose title (the workflow's `run-name`) names the same pull request and whose `qa` job started; keep both as the template has them.
- The caps of [`scenescout ci`](#caps), set explicitly in the workflow: 40 turns, 1,500,000 tokens and 20 minutes, in `read-only` mode. Edit them there. The `qa` job's `timeout-minutes` must stay at least `max-minutes` plus 5, plus the install.
- A comment from an account that is not allowed still starts the `gate` job, which ends in seconds without reading the pull request or reaching the key.

### Forks

The workflow refuses pull requests from forks by default, and `SCENESCOUT_QA_ALLOW_FORKS` turns that off. Even then, the key job never runs a fork's code: what reaches the model is the preview's pages, which the fork's author wrote. With forks allowed, the allowed commenter decides which previews are worth a model's time, and the run stays in `read-only` mode. Never replace the preview with a job that checks out and starts the pull request's code beside the key: under `issue_comment`, as under `pull_request_target`, that code would run with the repository's secrets.

### This repository

SceneScout has no deployed preview, so it does not run this workflow on its own pull requests. Its test suite (`qa-test`) holds the template to the rules above: the key only in the `qa` job, the team token only in the `gate` job's `team-token` input, that job reached only through the gate, with read-only permissions and no checkout or script of its own, SceneScout from an exact release tag (one that ships `qa/` and the `shots` stage), one run per pull request, and the `shots` job the only one that writes contents, running only the shots stage with no branch of its own choosing. It also runs every keyless stage against a stand-in GitHub API.
