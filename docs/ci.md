# Running `scenescout check` in CI

`scenescout check` visits every page of a running app and measures it, with no model involved, so the same app always gets the same verdict. That makes it a pull-request gate. Why its defaults are what they are: [ADR 11](adr/0011-a-gate-is-deterministic-and-fails-only-on-what-it-can-prove.md).

Whatever the CI system, the job has the same three parts: start the app, wait until it answers, run the check. The check never starts the app itself.

Checking or exploring the signed-in app needs a session in the job: [signing in from CI](#signing-in-from-ci) covers a scripted sign-in with a test user, and the rules for its credentials.

The exploratory side can run in CI too, with a model's API in place of a person or coding agent: [an unattended exploratory run](#an-unattended-exploratory-run), below. It reports and never gates. An allowed account can also start one on a pull request's preview by commenting `/scenescout qa`: [a QA review from a pull-request comment](#a-qa-review-from-a-pull-request-comment).

| Exit code | Meaning | What the job should do |
|---|---|---|
| 0 | Passed the gate | Pass |
| 1 | Failed it: something at the `--fail-on` severity or worse | Fail: the app has a defect |
| 2 | Could not run, or not all of it: a bad argument, an app that never answered, a saved session that no longer signs in, only the sign-in page reached, only a start page with at most one control reached (the app had not finished drawing), a saved flow that is not valid, or a flow step the write policy refused | Fail, and read it as a setup problem; with a refused flow step the report still has the rest's verdict |

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
| `baseline` | `off` | `compare` or `update` the visual baselines listed in `targets.json` (below) |
| `baselines` | `<project>/.scenescout/baselines` | The folder holding `targets.json` and the baselines; name one the repository commits (below) |
| `baseline-threshold` | 0.1 | The percentage of a picture's pixels that may change, 0 to 100 (below) |
| `sarif-file-anchor` | the workflow file that is running | The repository file a `check.sarif` result points at when no saved flow raised it, relative to the repository root (below) |
| `record` | `SCENESCOUT_RECORD`, else `off` | `on` keeps a frame after each route visit and each flow step and writes `replay.html` beside the report, kept in the artifact (below) |
| `video` | `off` | `on` records a WebM video of each saved flow, linked from `replay.html` beside its steps and kept in the artifact (below) |

And the action's own:

| Input | Default | |
|---|---|---|
| `working-directory` | `.` | Where the check runs; relative paths above are resolved from here |
| `version` | the ref's release | The scenescout npm version to run |
| `node-version` | `24` | Installed only when the runner has no Node 20 or newer |
| `install-deps` | `true` | On Linux, install the browser's system libraries with `sudo`. Set `false` on a runner or container that has them |
| `upload-artifact` | `true` | Keep the three files as an artifact, with the pictures of any visual baseline not met, and on a recorded check `replay.html` with its `replay-frames/` and `replay-videos/` folders |
| `artifact-name` | `scenescout-check-<job id>` | A second use in the same job gets `-2`, a third `-3`. Jobs of a matrix share a job id, so give each cell its own name, e.g. `scenescout-check-${{ matrix.browser }}` |
| `upload-sarif` | `false` | Upload `check.sarif` to code scanning (below) |

### Outputs

`passed` (`true` or `false`, empty when the check could not run; with `could-not-run` above 0 it describes the rest of the check, so `true` can come with exit code 2), `exit-code`, `failing` (what fails the gate: issues at the gate's severity or worse, plus re-tested findings that `--gate-retests` gates), `could-not-run` (flows a refused step kept from running), `retests-failing` (of `failing`, the re-tested findings), `high`, `medium`, `low`, `worth-a-look` (observations listed as worth a look, below; not in `high`, `medium` or `low`, and never in `failing`), the paths `report`, `json` and `sarif`, `replay` (the path of `replay.html` when `record` or `video` is on, else empty), and `artifact-name`.

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

Code scanning keeps a result only when its location is a file in the repository, so no result points at a page. An issue a saved flow raised points at that flow's file; every other result points at the anchor, which is the `sarif-file-anchor` input (`--sarif-file-anchor`) when it is set, else the workflow file that is running (from `GITHUB_WORKFLOW_REF`), else `package.json`, else `README.md`. Paths are relative to the repository root, which is `GITHUB_WORKSPACE` on Actions and the project directory elsewhere. The first of those that exists under the root is used; a missing option or workflow file is named in a warning line, and when none exists the SARIF is still written and the warning says code scanning will drop its results. The page each result was seen on is in its message, in a logical location of kind `resource` and in `properties.routes`. Fingerprints come from the evidence, so moving the anchor does not reopen alerts.

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

Missing or malformed configuration (a credential not set, a password set but empty, a TOTP secret that is not base32, a fixed code that is not 4 to 12 letters or digits, a fixed code and a TOTP secret both set, a timeout out of range) is reported before a browser starts, naming the variable and never its value; a selector that is not valid CSS is reported when the page is first read. The command exits 0 once signed in and saved, and 1 otherwise: a refused password or code, a field named or laid out as a code (one box per character) with no code or secret set, a password field with no password set, or a form it could not move on. A password or code counts as refused only once the page has answered it: it emptied the field, drew it again, or went to another page. While the field it was typed into is still there holding it (disabled while the app checks it, or waiting on a slow redirect), the command keeps waiting, and if that is still so when `--timeout` runs out it reports that the sign-in did not finish in time, not a refusal. An app that leaves a wrong password or code in its field, with an error beside it, therefore fails only when `--timeout` runs out, quoting that error; a shorter `--timeout` makes it fail sooner. A refused sign-in, or one that times out, quotes the error the page shows. Every credential value, as typed and URL-encoded, the username and a fixed code in any case, and each code typed, is replaced by `[redacted]` in everything it prints, including that quoted message, so a page that echoes what was typed does not put the password or the code in the job log.

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
| `upload` | `target`?, `fixture`?, `name`? | Attaches a small valid file generated on the spot (`pdf`, `png`, `txt`, `csv` or `json`; without `fixture`, the kind the input's `accept` asks for) to `target`, a file input or the control that opens its chooser, or to the page's only file input. Nothing is read from disk. Submitting it is a write, so it reaches the server only under `--flow-writes allow` |
| `expect-text` | `text` | Visible on the page |
| `expect-element` | `target`, `state` | The target is `visible`, `hidden` (also when nothing matches), `enabled`, `disabled`, `checked` or `unchecked`. A failure says what it is instead, e.g. `testid=receipt is visible, expected hidden` |
| `expect-url` | `pattern` | A regular expression, tested against path, query and hash (never the origin) |
| `expect-request` | `request`, `status` | A method and path (`*` is one segment) answered with that status, or a class such as `"2xx"`, since the last action |
| `repeat` | `steps`, `until`, `max` | Runs `steps` (up to 10 click, type, select or press steps) until `until` (an `expect-text`, `expect-element` or `expect-url` step) holds, checking it first and after each round, at most `max` times (up to 100). For a read-to-the-end gate: repeat a Next click until Continue is enabled. A failure names what never held and how often it tried |

A `target` is `testid=…`, `text=…`, `label=…` or `role=<role>[name="…"]`. Each step waits up to five seconds, and a click is never forced through something covering its control. A control that is shown but stays disabled (or, for `type`, read-only) for that long fails the step saying so first, for example `testid=save is visible but disabled after 5s`, followed by the action limit's hint, which helps when the app enables it later than that. These are the steps `scout_run_plan` takes, so a plan an agent used to walk a flow can be saved as it is, with `expect-*` steps added where the outcome shows. That is how flows are made: written by hand, or by an agent asked to keep a flow it just walked.

While a flow replays, a page that asks to confirm leaving (an unsaved-changes guard) is left, so a flow that fails half way through a form does not stop the next one navigating.

A flow file that is not valid stops the check before it starts, with exit 2 and the file and field named (`bad.json: steps[1].target is required`).

**A value can come from the environment.** Write `${env:NAME}` in a `type` or `select` step's `value` (whole or in part) and the check types the variable's value, so a one-time code or a password lives in the CI's secret store rather than in the flow file. A variable that is not set stops the check before it starts, with exit 2 and the flow and variable named. Wherever the page echoes a value of four or more characters (an address, an error), everything the check writes and prints shows `[$NAME]` instead. Only values are substituted: `expect-*` steps match their text as written.

**A flow can run as a role.** Give it `"role": "<name>"` and it runs in its own browser, signed in with the profile `scenescout login <url> --role <name> --project <dir>` saved in the project the check reads (`--project`). A flow with no `role` runs in the check's own session (`--storage-state`, or signed out). Flows run in file-name order, so a journey that needs two people is two flows: `01-submit.json` as one role, `02-approve.json` as another, the second finding by its visible text what the first created. A role with no saved profile stops the check before it starts, with exit 2 and the command that saves one; a profile that no longer signs in stops it the same way when the flow is reached.

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

Re-tests are reported in `report.md` and `check.json`. Whether one fails the gate is `--gate-retests` (below); "possibly fixed" and "not re-tested" never do. The check reads the memory and never writes it, so nothing is resolved; `scout_verify` in an exploratory run does that, and re-tests the findings that need an interaction. `--retest off` skips all of this. The memory is ignored by git unless a project commits it, so without that this applies to checks run where the memory lives. Checks that share one `--project` re-test the same open findings, so a later check can fail on a finding an earlier one recorded. Give each role its own `--project` when those findings should stay separate.

## Visual baselines

`--baseline compare` (the action's `baseline: compare`) pictures each page or element listed in the baselines folder's `targets.json` and compares it, pixel by pixel, with the baseline the project approved. `--baseline update` writes new baselines, and nothing else ever does. The [guide](guide/Ways-to-use-it.md#visual-baselines) describes `targets.json`, how each picture is taken and what each outcome means; this section is about running it in CI. Why it works this way: [ADR 19](adr/0019-a-visual-baseline-changes-only-when-asked.md).

**Commit the baselines.** The default folder, `.scenescout/baselines/`, is ignored by git, so a runner would start without it, `targets.json` included, and the check would stop with exit 2. Keep the baselines and `targets.json` in a folder the repository commits, and name it:

```yaml
      - uses: brunoboto96/SceneScout@v3
        with:
          url: http://127.0.0.1:3000
          baseline: compare
          baselines: tests/visual
```

**Take them on the runner.** Each operating system draws text differently, so baselines taken on a laptop seldom match pictures taken on a Linux runner, and the report says when a baseline was taken on another system. Take them where the check runs: a workflow started by hand that updates them and keeps the folder as an artifact, which you download and commit. An update replaces every baseline taken on another system, however close it came, so one run on the runner retakes them all.

```yaml
on:
  workflow_dispatch:

jobs:
  baselines:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # Start the app as the check job does.
      - uses: brunoboto96/SceneScout@v3
        with:
          url: http://127.0.0.1:3000
          baseline: update
          baselines: tests/visual
      # always(): the check step fails when a target could not be pictured, and the baselines it did write are still wanted.
      - if: always()
        uses: actions/upload-artifact@v7
        with:
          name: visual-baselines
          path: tests/visual
```

The check step fails if a target could not be pictured, since that target's baseline was not written. Targets are pictured whatever `paths` says: each names its own page. Baselines are kept per browser, under `chromium/`, `firefox/` or `webkit/`, so a matrix over browsers takes and compares each browser's own.

**What an unmet baseline leaves.** It is a `visual-change` issue, high, so it fails the default gate, as a broken saved flow does: both are expectations the project wrote down. Its evidence gives the share of pixels changed and the path of the diff picture. `report.md` lists every target and what became of it; `check.json` has the run under `baselines` (`mode`, `engine`, `threshold`, `dir`, and for each target its `path`, `element`, `status`, `detail`, `platformNote`, `partial`, `diff`, `baseline`, the PNG in the folder, and `files`, the pictures beside the report); in `check.sarif` it is a result at level `error` whose fingerprint is the target and the browser, so the same element changing by another amount is the same alert. The baseline, the picture now and the diff, with the changed pixels in red, are written under `visual/` beside the report, and the action keeps them in its artifact.

| Outcome | Status in `check.json` | An issue? |
|---|---|---|
| Within the threshold | `matches` | No |
| Past the threshold, or a change of size | `changed` | Yes |
| The page did not load, answered an HTTP error or sent the browser to sign-in; its fonts never finished loading; or the element was not visible or is outside the window | `not-captured` (with `detail` saying which) | Yes, in `compare` and in `update` |
| A baseline that is half there, cannot be read, belongs to another target, or was taken with other settings | `unusable` (with `detail` saying which) | Yes: a comparison that compared nothing must not pass |
| No baseline yet | `no-baseline` | No, and the verdict line counts it as not compared |
| Written by `update` | `updated` | No |

An element larger than the window is pictured where it is inside the window, and its result's `partial` says so: list smaller elements within it to hold the rest.

**Allowing small changes.** `baseline-threshold` (`--baseline-threshold`) is the percentage of a picture's pixels that may change before its baseline is not met. The default is 0.1, not 0: two pictures of an unchanged page taken by one browser build on one machine compare at 0%, but a run on another machine, or after a browser or font update, can anti-alias text and curved edges a pixel differently, and a gate that fails on that noise teaches a team to ignore it. 0.1% is 1,152 pixels of a 1280×900 page and 64 of a 320×200 picture, so a smaller change, such as a character of small text on a large element, passes; set `0` to count every changed pixel. A change of size always counts. `update` rewrites the baselines past the threshold, as compare would judge them, and leaves the rest alone, so noise under it leaves the folder untouched; a baseline taken on another operating system it always replaces. Each pixel is already allowed a difference of 8 in 255 on each colour channel, which absorbs a colour rounded one step differently. `fail-on: never` reports everything without failing the job, visual changes included.

## Recording a check

A green check says the gate passed; a recorded one also shows what passed. `--record` (the action's `record: on`, or `SCENESCOUT_RECORD=on` in the environment) keeps a frame of the page after each route the check visits and after each step of each saved flow, and writes `replay.html` beside `report.md`. It is off by default. `--record off` wins over the variable.

```yaml
- uses: brunoboto96/SceneScout@v3
  with:
    url: http://127.0.0.1:3000
    record: on
```

The page is organised role → journey → step. The check's own session comes first, with the routes it visited; then each role a saved flow ran as. Every journey (a saved flow) has a pass or fail badge, and each of its steps shows its caption (the action and its target), its result and the frame after it. A journey that broke is open, with the step that broke highlighted and linked from its heading; the steps after it are marked not run and have no frame. The header gives the verdict, the SceneScout version, the app's origin, when the check started and ended, and the commit when `GITHUB_SHA` names one.

**Video.** `--video` (the action's `video: on`) also records a WebM video of each saved flow, using Playwright's page screencast. Filming starts at the flow's first step and stops when the flow hands back, on the same page the flow would use unfilmed, so cookies, localStorage and sessionStorage are exactly what they would be without the video. Only the flows are filmed: the crawl, the re-tests and the baselines are not. A video is filmed at the page's own size, 1280×900. A flow whose video cannot be started or saved still runs and keeps its verdict; the check's log says why it has no video, and the next flow is filmed afresh. The replay page plays each video at the top of its journey, above the steps, with a link to open it. It works with or without `--record`: without it the page has the journeys and their videos, and no frames. Off by default, because videos are large.

```yaml
- uses: brunoboto96/SceneScout@v3
  with:
    url: http://127.0.0.1:3000
    record: on
    video: on
```

**What it writes.** `replay.html`, with a `replay-frames/` folder (`--record`) and a `replay-videos/` folder holding `journey-01-<flow>.webm`, `journey-02-<flow>.webm` and so on in the order the flows ran (`--video`), all in the output folder (`--out`, default `.scenescout/check`). The page has no scripts or event handlers and loads nothing from the network, so it opens from a downloaded artifact or from any static host, as long as the two folders travel with it. Every check removes the page, frames and videos an earlier run left there, so nothing stale is read as this run's. The page carries a `<meta name="generator" content="scenescout-check-replay">` mark, and only a `replay.html` with that mark is removed or replaced. A `replay.html` without it is the project's own: a check that is not recorded leaves it alone, and a recorded one (`--record` or `--video`) stops before it starts, exit code 2, naming the file, rather than overwrite it. Move or rename the file, or pass `--out` to write the check elsewhere. The action uploads them with the other results and publishes the page's path as the `replay` output.

**Size.** A frame is a JPEG of the viewport, usually tens of kilobytes. A check takes at most one per route (up to `--max-routes`) and one per flow step, and each browser session keeps at most 600 frames. A step or visit past that has no frame; the page says so beside it, and counts them in its note at the top. A video is usually several hundred kilobytes to a few megabytes for each minute of a journey, and encoding it adds a little time to each flow, so turn on `--video` for the runs where you will watch them. Record the runs you keep as evidence, such as the main branch or a release, rather than every push.

**Privacy.** The frames and videos are pictures of the app under test, and they show whatever the pages showed: names, addresses, anything a seeded account can see. Record against seeded or synthetic data, never production. Typed values never appear in the page's text, and secrets in addresses and reasons are redacted as they are in the report; a field's contents can still show in a frame or a video, as they did on screen (a password field shows dots).

**Publishing it.** The artifact keeps the page for the repository's artifact retention, readable by anyone who can read the workflow run. To share it more widely, publish the output folder to a static host behind your team's own access control (an internal pages site, a bucket behind single sign-on) rather than a public one.

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

`scenescout ci <url>` is an exploratory run with nobody present. A model reached through its API drives the same `scout_*` tools, by the same method a coding agent follows, and the run ends in the same report. It needs an API key and costs what the model's API charges; `scenescout check` needs neither. It starts its server with `SCENESCOUT_OPEN=none`, so it does not open the live view or the report in a browser; a `SCENESCOUT_OPEN` already set in the environment is kept. Why it works this way: [ADR 14](adr/0014-an-unattended-run-reports-and-never-gates.md).

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
| `--max-turns` | 80 | Model calls. Several tool calls in one reply are one turn. |
| `--max-tokens` | 3,000,000 | Input and output tokens over the whole run, cached input included. |
| `--max-minutes` | 20 | Wall time of the exploration. |

The caps are checked before each model call. No model call, retry or wait between retries runs past the time cap, and no tool call either: each is given only the time left, and a tool call reached after the cap is answered as not run. At most 16 tool calls are run from one model reply; any beyond are answered as not run. Attaching the browser counts towards the time cap. The first cap reached ends the exploration; then the report is written and the browser closed, which share a budget of three minutes, and the files are written, which takes seconds. So the command ends at most about `--max-minutes` plus 4 minutes after it starts. One turn's usage is known only after it, so a run can end up to one turn over the token cap (with `--lanes`, one turn per lane: see [Lanes](#lanes)). The summary, `ci.json` and the action's `stop` output name what ended the run: `done` (the model finished), `turns`, `tokens`, `time`, `provider-error` or `could-not-start`.

Each turn sends the conversation so far, so input tokens grow with every turn: the method and the tool descriptions alone are around 20,000 tokens, and each tool result adds to what every later turn sends. In [the benchmark](benchmark.md#choosing-the-defaults-issue-419), a run at the defaults used about 27,000 tokens a turn, so it reaches the turn cap, or ends by itself, well before the token or the time cap. Tool results longer than 16,000 characters are cut before they reach the model; the report keeps everything.

What a run costs follows from the token cap. At the defaults on `gpt-6-luna` ($0.10 per million input tokens, $0.01 cached, $0.50 output), the benchmark's runs used about 2.2 million tokens and cost about $0.03, since about 98% of each turn's input repeats the turn before and is read from the provider's cache; with nothing cached, a run that reaches the 3,000,000-token cap costs at most about $0.36. A run can end up to one turn over the cap, which adds a little. `--max-tokens` is the setting that bounds the cost.

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

The run attaches to the URL it is given, in the mode it is given (with `--compare-url`, the run itself attaches a second session there after the model is done; with `--lanes`, each lane attaches its own session on the same URL, in the same mode); the model cannot attach elsewhere or change the mode. It gets the scout_* tools a single agent uses to explore, find and report, and not those for attaching, closing, parallel lanes or screenshots. By default it is two model loops sharing the caps, each with its own part of the app; `--lanes 1` makes it one: see [Lanes](#lanes).

`--storage-state <file>` explores while signed in; a session that no longer signs in exits 2 before the model is called. `--browser`, `--action-timeout-ms`, `--nav-timeout-ms`, `--project` and `--out` are as for `check`.

### Lanes

`--lanes <n>` (1 to 8, default 2) splits the exploration between `n` model loops that run at once, each in its own browser session and its own part of the app, as the [parallel lanes](guide/Ways-to-use-it.md#parallel-lanes) of an agent-driven run do. Why it works this way: [ADR 20](adr/0020-an-unattended-run-may-split-into-lanes-that-share-its-caps.md).

1. **Plan.** The run attaches as usual, takes a snapshot of the page it landed on (which is what collects its links) and crawls, up to three rounds, each visiting the routes the pages of the round before linked to. No model is called; the time it takes counts towards `--max-minutes`. The routes found are split the way `scout_lane_brief` splits them: whole modules, a module being a route's first path segment, dealt to the lanes largest first so each lane has about as many routes as the others.
2. **Explore.** Each lane attaches its own session on the target URL, as the run's first session did (the engine resolves every path against the URL a session attached with), and the run opens the lane's first route in it; a route that does not open leaves the lane on the target. The lane then runs the model loop with a conversation of its own: the method, the rules every lane follows, and a first message naming its routes, what the crawl saw on them and its share of the budget. A lane is not given `scout_report`. A lane that finishes closes its browser.
3. **Merge.** Every session files into the project's one memory, whose dedup folds a defect two lanes filed into one finding. Once every lane has ended, the run writes one report from the session that planned, and the summary and `ci.json` list each lane: what it owned, its turns and tokens, and what ended it.

The caps are the run's, shared by the lanes rather than given to each. The lanes together make at most `--max-turns` model calls: a turn is taken before its call, so lanes that reach the last turn together cannot all start it. They stop at the same `--max-minutes`. Tokens are counted when a call returns, so a run can end up to one turn per lane over `--max-tokens`, where a single loop can end one turn over. A lane that finishes early leaves the turns it did not use to the lanes still running. `--lanes` must not exceed `--max-turns`, and `--show` takes no lanes. Without `--lanes`, a run with `--show`, or with a `--max-turns` below the default two, is one loop.

What ended a run in lanes: a model API failure in any lane ends it as `provider-error` (exit 2), since that is what the workflow must fix, and a lane that broke after attaching ends it as `could-not-start` (exit 2), with the report still written; otherwise a cap, if any lane was stopped by one; otherwise `done`. A lane whose browser could not attach is listed with the reason, and named in the stop's detail, and does not fail the run, unless no lane could attach.

With fewer than two modules there is nothing to split: the run explores in one loop, and the summary and `ci.json` say so, as they do when the planning crawl failed. Fewer modules than lanes gives fewer lanes. Pages that all sit under one path (`/app/…`) are one module, so such an app splits into at most two lanes, one of them only the page the run started on, or none when the target URL is itself under that path.

Each lane is a browser running at the same time as the others, and the run's first session keeps its browser open to write the report, so give the runner the memory for them all: as for agent-driven lanes, about as many lanes as the runner has cores, less two.

Lanes spend tokens faster: in [the benchmark](benchmark.md#lanes-one-loop-against-four-task-40), four lanes sent about 1.4 million tokens a minute, about 2.8 times one loop's, so a provider's tokens-per-minute limit is reached sooner, and a call still refused (HTTP 429) after its retries ends the run as `provider-error`.

What lanes find depends on the budget each lane gets. The default, two lanes sharing 80 turns and 3,000,000 tokens, was chosen by [measurement](benchmark.md#choosing-the-defaults-issue-419): on the demo app it found 5 to 7 of 13 planted defects in three runs, against 2 to 4 for the earlier default of one loop at 40 turns, and 4 to 5 of 10 on the held-out app, against 1 to 2 for one loop at 40 turns. A run cost about $0.03 on `gpt-6-luna` at effort `low`, about 2.5 times the earlier default's, and took about 1.5 to 3.5 minutes. One loop given 80 or 120 turns found fewer than two lanes did. With four lanes and the caps raised to 160 turns and 6,000,000 tokens, an earlier measurement found 8 of 13 on the demo app and 7 of 10 on the held-out app for about $0.025 a run, but its token rate is near a 2,000,000-tokens-a-minute limit, so run one such job at a time per API key, or the provider refuses calls and the run ends `provider-error`. Two lanes sent at most about 1.2 million tokens a minute (2.2 million in 111 seconds), and no run of them ended refused. On a small or slow app, `--lanes 1 --max-turns 40 --max-tokens 1500000` is the earlier, cheaper configuration.

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
- `ci.sarif`: the findings as SARIF 2.1.0, at `error`, `warning` or `note` by severity, and worth-a-look findings as notes. Each result points at the same anchor file as a check's (`--sarif-file-anchor`, see [Code scanning](#code-scanning)), with its page in the message, in a logical location and in `properties.route`.

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

**It tests a deployed preview, never the pull request's code.** The job that holds the model's key checks out nothing, builds nothing and runs only SceneScout, from an exact release tag. So the project must already deploy each pull request somewhere reachable over https (a preview environment, a review app, a per-branch deployment). A project without previews can use the [unattended run](#an-unattended-exploratory-run) on pushes or a schedule instead, or [`/scenescout qa check`](#the-projects-own-check-scenescout-qa-check), which runs the project's own recorded check and needs no preview and no model key.

### The workflow

Copy [examples/workflows/scenescout-qa.yml](../examples/workflows/scenescout-qa.yml) to `.github/workflows/` and add the key as a repository secret (`OPENAI_API_KEY` in the file; for Anthropic, change the name in the `qa` job's `env` to `ANTHROPIC_API_KEY`). It has five jobs:

| Job | Holds the key | Permissions | What it does |
|---|---|---|---|
| `gate` | no | `pull-requests: write`, `deployments: read` | Reads the comment and the pull request, checks the commenter and where the pull request comes from, finds the preview's URL, and reacts to the comment. The only job that may receive the optional team token (below). |
| `qa` | yes | `contents: read` | Runs only when the gate says so. Runs `brunoboto96/SceneScout/ci` at an exact release against the preview's URL, with the caps below, and keeps the results as an artifact. |
| `shots` | no | `contents: write` | Only after a `show` or `compare` run succeeded. Puts its pictures on the `scenescout-shots` branch so the reply can show them. |
| `report` | no | `pull-requests: write`, `actions: read` | Posts the results on the pull request, with a link to the artifact, or says the run could not run. |
| `check` | no | `actions: write`, `pull-requests: write` | Only for `/scenescout qa check`. Dispatches the project's own workflow, waits for its run, downloads its artifact and replies with the verdict. See [below](#the-projects-own-check-scenescout-qa-check). |

Pin both actions (`brunoboto96/SceneScout/qa` and `brunoboto96/SceneScout/ci`) to the same exact release tag, from the first release that has them, or to that release's commit SHA; never to `@v3` or a branch. `issue_comment` runs the workflow file as it is on the default branch, so a pull request cannot change it. SceneScout's own code comes from that release; its npm dependencies are resolved when the action installs it, within the ranges that release declares, since the package ships no lockfile.

### The command

```
/scenescout qa [preview URL] [focus]
/scenescout qa [preview URL] show <element>
/scenescout qa [preview URL] compare <element>
/scenescout qa check [focus]
```

Only the comment's first line is read, and the comment must begin with `/scenescout qa`, in any case, with nothing before it (the job's `startsWith` filter and the gate match it the same way). An optional https URL as the first word overrides where the preview is found; any other words become the run's `focus`, cut to 200 characters. Editing a comment starts nothing: only a new comment does.

When the words after the URL begin with `show` or `compare` (a word of its own, in any case), the rest describes one element, e.g. `/scenescout qa compare the Save button`. `show` replies with a picture of that element on the preview. `compare` also captures it on a base URL and replies with the two side by side, a diff picture with the changed pixels in red, and the share of pixels changed. The base URL is the variable `SCENESCOUT_QA_BASE_URL` when it is set (the production site, say), else the newest successful deployment of the pull request's base branch; it is held to the same rules as the preview's URL. What can be captured, and how, is [Showing one element](#showing-one-element).

When the first word after the command is `check` (a word of its own, in any case, with no URL before it), no model runs: the project's own check does, and the rest of the line is its focus. See [The project's own check](#the-projects-own-check-scenescout-qa-check). Before this mode existed, `/scenescout qa check …` was a preview run with `check …` as its focus; put the focus in other words for that.

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
| `/scenescout qa check` starts the project's check | 👀 | The verdict, when the check's run ends |
| `/scenescout qa check` with `SCENESCOUT_QA_CHECK_WORKFLOW` unset or not a workflow file name, or from a fork | 😕 | One line saying why no check started, and how to set it up |
| The check's workflow is unknown or disabled, GitHub refuses the dispatch, its run cannot be found, or it outlasts the wait | 👀 | One line saying which, with a link where there is a run |

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
| `SCENESCOUT_QA_CHECK_WORKFLOW` | none | The project's workflow that `/scenescout qa check` dispatches, by its file name in `.github/workflows/` (e.g. `browser-tests.yml`) or its id. Unset, the command replies saying how to set it up. |
| `SCENESCOUT_QA_CHECK_ARTIFACT` | `scenescout-check` | The name that workflow uploads its check's output folder under. |

And one optional repository secret (Settings → Secrets and variables → Actions → Secrets):

| Secret | |
|---|---|
| `SCENESCOUT_QA_TEAM_TOKEN` | Read only when `SCENESCOUT_QA_ALLOWED_TEAMS` is set: a token that can read the organization's team membership, either a GitHub App installation token with the organization's Members permission (read), or a personal access token with `read:org`. The workflow's own token cannot read team membership. The template passes it to the `gate` job only; never add it to the `qa` or `report` job. |

The preview's URL is chosen in this order: the URL in the comment, the template, the deployment. It must be `https` and carry no credentials. The run explores the preview signed out: the `qa` job checks out nothing, so it has no saved session to read.

### The project's own check: `/scenescout qa check`

A project that builds and starts its app inside a CI job, and has no preview deployments, can still answer a comment. `/scenescout qa check [focus]` runs the project's **own** workflow, which runs [`scenescout check`](#github-actions) with [recording](#recording-a-check) on, and replies with its verdict. No model is involved and no key is read anywhere in this mode. Why it still keeps [ADR 15](adr/0015-a-qa-comment-tests-a-preview-and-never-runs-the-pull-requests-code.md)'s rule: its amendment "The project's own check".

**Setting it up.**

1. Add a workflow to the project that a dispatch can start: [examples/workflows/scenescout-qa-check.yml](../examples/workflows/scenescout-qa-check.yml) is a minimal one. Replace its build and start steps with your app's. It must be on the default branch to be dispatched, and runs as it is on the pull request's branch.
2. Set the repository variable `SCENESCOUT_QA_CHECK_WORKFLOW` to its file name, e.g. `scenescout-qa-check.yml`.
3. If the workflow uploads its results under a name other than `scenescout-check`, set `SCENESCOUT_QA_CHECK_ARTIFACT` to that name. The example reads the same variable, so the two stay equal.

**The workflow's contract.** It has a `workflow_dispatch` trigger declaring three string inputs, `pr` (the pull request's number), `focus` (the words after `check`, possibly empty) and `dispatch-id` (set by the `check` job; put it in the workflow's `run-name`, as the example does, so the run can be told apart from others). GitHub refuses a dispatch carrying an input the workflow does not declare, so all three must be there. It runs `scenescout check --record --video` (the action's `record: on` and `video: on`) and uploads the output folder as an artifact, so `check.json` sits at the top of it, with `replay.html`, `replay-frames/` and `replay-videos/` beside it. The check action does that upload itself under its `artifact-name` input. What `focus` means is the workflow's choice: the example keeps the saved flows whose file name contains it. It is text from a comment, so read it through `env`, never paste `${{ inputs.focus }}` into a script. When a focus is given and the check ran no journeys, the reply says **No journeys ran** and never calls it a pass. The example also warns in its log when the focus matches no flow.

**One check per pull request.** Give the workflow's job a concurrency group on the `pr` input with `cancel-in-progress: true`, as the example does (`scenescout-qa-check-<repository>-<pr>`). A newer `/scenescout qa check` on the same pull request then cancels the older run, the older command's reply says it was cancelled, and the newer one replies with the verdict. Without it, both runs go to the end and each replies.

**What the `check` job does.**

1. Looks the workflow up (`GET /repos/{owner}/{repo}/actions/workflows/{file}`), then dispatches it on the pull request's head branch with the three inputs. The dispatch names the branch as `refs/heads/<branch>`, so a tag with the same name is never the one run. When GitHub refuses, the reply says why in its own words: the token lacks `actions: write` (403); the branch was deleted or renamed; the workflow, as it is on that branch, has no `workflow_dispatch` trigger or the file is missing there (a branch made before the workflow was added: merge the default branch into it); or the workflow does not declare the three inputs. GitHub's own message is quoted beneath in every case.
2. Finds the run. GitHub's dispatch call answers with the new run's id, and that is used when it is there. Otherwise the job lists the workflow's `workflow_dispatch` runs on that branch: first the one whose title carries the dispatch id, then, for a workflow whose `run-name` does not carry it, the oldest run of the pull request's head commit created since the dispatch. Two checks on the same commit at once can only be told apart by the dispatch id, so keep it in the `run-name`.
3. Waits for the run to complete, polling every 15 seconds, for at most `wait-minutes` (30 in the template; the job's `timeout-minutes` is 40). A run still going then gets a reply with its link, and is left to finish. A run that was cancelled gets a reply saying so; with the example's concurrency group that is a newer `/scenescout qa check` on the same pull request, which replies on its own.
4. Looks the artifact up by name through the API first. An artifact that is missing, expired, or over 1 GB (the zip's size as the API reports it) is not downloaded, and the reply says which. Otherwise it downloads it with `actions/download-artifact` (by run id) **as its zip, with `skip-decompress: true`**, so nothing from the archive is written to disk. The reply stage reads the zip's central directory itself, compares entry names only with fixed names (`check.json`, `replay.html`, `replay-videos/*.webm`), and inflates `check.json` alone, stopping at 10 MB. A name such as `../x` is never a path, and a zip bomb ends at the cap. (download-artifact's own extraction, at the pinned v8.0.1, rewrites `..` path segments and writes no symbolic links, but sets no size limit; keeping the zip whole avoids depending on either.) Nothing in the artifact is run.
5. Replies: the verdict (passed, failed with the number of issues that fail the gate, or partly ran), the findings by severity, each journey (a saved flow) with its role and its result, the first failing step with what it did and why it broke, up to 20 findings high first, the recording (the page, and each journey video by name), and links to the run and the artifact. Everything from `check.json` is escaped as the preview run's reply is: the pull request's code wrote it, so a journey's name cannot mention anyone, link anywhere or add HTML. A run with no verdict to read gets a reply saying which it was: the artifact could not be downloaded (expired, never uploaded, or under another name), it holds no `check.json`, the file is not valid JSON or larger than 10 MB, or it is not one `scenescout check` wrote; with the run's conclusion and link. Names (the workflow, the branch, the artifact) are shown as code, where nothing renders. The reply names the commit the run tested, and says so when the branch moved after the command.

**Permissions.** The `check` job has `actions: write`, which dispatching a workflow needs and which also covers reading the run and downloading its artifact (`actions: read`), and `pull-requests: write` to reply. Nothing else: no `contents`, no secrets. The gate keeps its own permissions; it only reads the variable and passes the checked workflow name and the head branch on.

**Who and where.** The same allowlist as every other form of the command. Pull requests from forks are always refused, whatever `SCENESCOUT_QA_ALLOW_FORKS` says: the dispatch runs the workflow on a branch of this repository, and a fork's branch is not one. The person who starts the run is the commenter: any allowed account, which may have no write access, can start the workflow, with the repository's secrets, on someone else's same-repository branch, as that branch's copy of the workflow defines it. If the workflow reads secrets, keep the allowlist to people you would trust to start it by hand.

**What the verdict is worth.** The branch's own copy of the workflow writes `check.json`, so the branch's author decides what it says, a pass included. Read the reply as that run's report, not as a certificate; a check a merge depends on belongs in the repository's required status checks.

### Who may start a run

`SCENESCOUT_QA_ALLOWED`, `SCENESCOUT_QA_ALLOWED_ROLES` and `SCENESCOUT_QA_ALLOWED_TEAMS` combine as a union: a commenter listed by login, whose author association is in the role list, or who is an active member of a listed team may start a run.

- **With all three unset**, the repository's owners may: the owner's login on a repository a user owns, and any commenter GitHub marks as `OWNER` (on a repository an organization owns, an owner of that organization).
- **With any of them set, it replaces that default.** Include yourself: add your login, or `OWNER` to the roles, if the owners should keep the command.
- **Roles** come from the comment's `author_association` in the event, so they need no API call. `OWNER`, `MEMBER` and `COLLABORATOR` are the values that may be listed. Any other value (a typo, or `CONTRIBUTOR`, `NONE` and the like, which describe people with no standing in the repository) fails the `gate` job with an error naming it, and no comment is acted on until it is fixed.
- **Teams** are read with `GET /orgs/{org}/teams/{team_slug}/memberships/{username}`, using `SCENESCOUT_QA_TEAM_TOKEN`, and only for a comment that is the command from someone the logins and roles have not already allowed. A membership counts only when its state is `active`. Every other outcome refuses and says why as an annotation on the `gate` job: no token, a 401 or 403 (the token cannot read the organization), a 404 (not a member, or the token cannot see the team), a pending invitation, or a call that fails after its retries. A team of an organization other than the repository's owner is never looked up, so the token is only ever used about the repository's own organization; the gate logs an error naming it. None of these falls back to allowing. An entry that is not `org/team-slug` fails the `gate` job, as an unknown role does.

A commenter who is not allowed, by any path, gets the 😕 reaction and nothing else: the pull request is not read.

### What it costs, and how much it runs

- One run per comment. A new `/scenescout qa` on the same pull request cancels the run already going there, and only the newer one replies. The report job tells that apart from a run cancelled by hand or by its timeout by looking for a later run whose title (the workflow's `run-name`) names the same pull request and whose `qa` job started; keep both as the template has them.
- The caps of [`scenescout ci`](#caps), set explicitly in the workflow: 80 turns, 3,000,000 tokens and 20 minutes, in `read-only` mode. Edit them there. The `qa` job's `timeout-minutes` must stay at least `max-minutes` plus 5, plus the install.
- A comment from an account that is not allowed still starts the `gate` job, which ends in seconds without reading the pull request or reaching the key.

### Forks

The workflow refuses pull requests from forks by default, and `SCENESCOUT_QA_ALLOW_FORKS` turns that off. Even then, the key job never runs a fork's code: what reaches the model is the preview's pages, which the fork's author wrote. With forks allowed, the allowed commenter decides which previews are worth a model's time, and the run stays in `read-only` mode. Never replace the preview with a job that checks out and starts the pull request's code beside the key: under `issue_comment`, as under `pull_request_target`, that code would run with the repository's secrets.

### This repository

SceneScout has no deployed preview, so it does not run this workflow on its own pull requests. Its test suite (`qa-test`) holds the template to the rules above: the key only in the `qa` job, the team token only in the `gate` job's `team-token` input, that job reached only through the gate, with read-only permissions and no checkout or script of its own, SceneScout from an exact release tag (one that ships `qa/` and the `shots` stage), one run per pull request, and the `shots` job the only one that writes contents, running only the shots stage with no branch of its own choosing. It also runs every keyless stage against a stand-in GitHub API, the `check` job's rules (no key, no checkout, `actions: write` and `pull-requests: write` only, the workflow and branch from the gate) and the example check workflow's shape (the three dispatch inputs, the dispatch id in its title, recording on, the artifact name from the variable, the focus never pasted into a script).
