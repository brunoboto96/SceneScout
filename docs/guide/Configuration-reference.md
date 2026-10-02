# Configuration reference

Every command-line option, environment variable, GitHub Action input, `/scenescout qa` repository setting and `scout_attach` option, with its default. A test (`guide-test`, and `mcp-check` for `scout_attach`) compares these tables with the code, so an option added or removed in one place and not the other fails the build. `scenescout --help` prints the same options in short.

An option takes its value after a space or an equals sign: `--fail-on high` or `--fail-on=high`. Relative paths are resolved from the directory the command runs in.

## Commands

| Command | What it does |
|---|---|
| `scenescout <url>` | A first look with no setup: the check's measurements in observe mode, capped, opening with the three issues to look at first; exit 0 it looked, 2 could not run |
| `scenescout install` | Installs the skill, downloads the browser, registers the MCP server and puts `scenescout` on your PATH |
| `scenescout doctor` | Checks the setup and prints the fix for anything missing |
| `scenescout serve` | Runs the MCP server on stdio; this is what a client starts |
| `scenescout scan <path>` | Prints what the project scan finds: framework, routes, saved logins |
| `scenescout check <url>` | The deterministic check; exit 0 passed, 1 failed the gate, 2 could not run |
| `scenescout ci <url>` | An unattended exploratory run driven by a model's API; exit 0 ran, 2 could not run |
| `scenescout login <url> --role <name>` | Saves a sign-in as a role's profile; exit 0 saved, 1 not |
| `scenescout export --to <tracker>` | Files the project's open findings as GitHub or Jira issues, each once; a dry run unless `--yes`; exit 0 done, 2 could not export |
| `scenescout status [path]` | What every session of a running engine is doing, as text |
| `scenescout watch [path]` | Opens the live view in a browser |

`scenescout --version` prints the version, and `scenescout --help` the usage. Every command also prints the usage on `--help` or `-h` and exits 0 without doing anything else, so `scenescout install --help` installs nothing. `install`, `doctor`, `scan`, `status` and `watch` refuse an option or an extra argument they do not take, and exit 1 naming it.

### `scenescout <url>`

A first look: an address in place of a command, first on the line, as in `npx -y scenescout http://localhost:3000 --max-routes 10`. It runs the check's crawl and measurements in `observe` mode unless `--mode read-only` is given, and never gates. It writes `report.md` and `check.json` to `scenescout-report/` in the current directory, with a `.gitignore` that keeps that folder out of commits and a `.scenescout-first-look` marker, or to a temporary folder when that cannot be written. It writes only into a `scenescout-report/` that is new, empty or holds the marker: any other folder or file of that name is left as it is, and the run exits 2 before it starts, pointing at `--out`. In any folder, a `report.md` or `check.json` is replaced only when a first look wrote it, which its first line shows. When the headless Chromium build is missing it downloads that and nothing else: no skill, no MCP registration, nothing on the PATH. It always drives Chromium, whatever `SCENESCOUT_BROWSER` says, and reads nothing from the directory it runs in: no flows, no memory, no source routes. Exit 0 once it has looked, whatever it found; 2 when it could not run (the address could not be reached, a bad option, no browser) or could not write its report, whose summary it still prints.

| Option | Default | |
|---|---|---|
| `--max-routes` | `20` | The most pages to look at, 1 to 150 |
| `--max-minutes` | `3` | No page is started after this many minutes, 1 to 30. The start page is always looked at |
| `--mode` | `observe` | `observe`: nothing but `GET`, `HEAD` and `OPTIONS` requests leaves the page, signing in, signing out and refreshing a token apart. `read-only`: a plain `POST` the page sends goes through, while `PUT`, `PATCH`, `DELETE` and destructive-looking `POST`s are refused. See the [safety model](Safety-model.md) |
| `--out` | `./scenescout-report` | Where the report goes. A folder named here is used as given and created only once the address has answered, with no `.gitignore` added and never swapped for a temporary one. It may hold other files, but not a `report.md` or `check.json` a first look did not write. A file, a link, such a report, or a folder that cannot be written ends the run before it starts; a permission that check cannot see shows when the report is written, after the summary |

The address must be written in full, with `http://` or `https://`; one without its scheme is refused with the line to type. An option of `scenescout check` is refused with a pointer to `check`, which has it.

### `scenescout install`

| Option | Default | |
|---|---|---|
| `--client`, `--clients` | `claude-code` | Which MCP clients to set up, comma-separated: `claude-code`, `cursor`, `vscode`, `codex`, `gemini`, `copilot`, `windsurf`. Name `claude-code` as well to keep it |
| `--browsers` | `chromium` | What to download, comma-separated: `chromium` (the full browser and the headless shell, about 550 MB), `chromium-headless-shell` (about 200 MB; everything but headed runs), `firefox`, `webkit`, or `all` |
| `--browser-only` | off | Download the browser and do nothing else. For a plugin install, or a client registered by hand |
| `--skip-browser` | off | Skip the download |
| `--no-register` | off | Skip registering the MCP server |
| `--no-command` | off | Skip putting `scenescout` on the PATH |

`--browser` is refused here with a hint, since it is easily typed for `--browsers`.

### `scenescout doctor`

| Option | Default | |
|---|---|---|
| `--engine` | off | Check only node, the build and the browser: for plugin installs and clients other than Claude Code |

### `scenescout check`

| Option | Default | |
|---|---|---|
| `--fail-on` | `high` | The severity that fails the gate: `high`, `medium`, `low` or `never` |
| `--mode` | `read-only` | The write policy for the crawl, and for flows under `--flow-writes allow`: `observe` or `read-only` |
| `--max-routes` | `50` | The most routes to visit, 1 to 150 |
| `--paths` | every route found | Check only these paths, comma-separated, each starting with `/` |
| `--ignore` | none | Rules to drop, comma-separated (see [check rules](#check-rules)) |
| `--storage-state` | none | A Playwright storage-state file, to check while signed in |
| `--browser` | `chromium` | `chromium`, `firefox` or `webkit` |
| `--action-timeout-ms` | `5000` | How long one click, keystroke or pick may take, 1000 to 120000 |
| `--nav-timeout-ms` | `20000` | How long a page may take to load, 1000 to 300000. Unset, crawled routes get 15000 |
| `--project` | the current directory | The project whose `.scenescout/` holds flows and memory |
| `--out` | `<project>/.scenescout/check` | Where `report.md`, `check.json` and `check.sarif` go |
| `--flows` | `<project>/.scenescout/flows`, when it exists | A directory of saved flows to replay, or `off` |
| `--retest` | `on` | `off` skips re-testing open findings from the project's memory |
| `--flow-writes` | `never` | `never` replays flows under observe's rule; `allow` replays them under `--mode` |
| `--on-refused-step` | `report` | `report` marks a flow whose step was refused "could not run" and exits 2 with every other verdict kept; `stop` exits 2 at that step with no results |
| `--gate-retests` | `high` | Which still-reproducing re-tested findings fail the gate: `never`, `high` or `all` |

### `scenescout ci`

| Option | Default | |
|---|---|---|
| `--provider` | the one whose key is set | `anthropic` or `openai`. Required when both keys are set |
| `--model` | `claude-sonnet-5` or `gpt-6-luna` | The model id |
| `--effort` | `low` | `none` (OpenAI only), `low`, `medium`, `high`, `xhigh` or `max` |
| `--base-url` | the provider's own API | Another endpoint implementing the same API. Must be https, or plain http to `127.0.0.1` or `localhost` |
| `--max-turns` | `40` | The most model calls |
| `--max-tokens` | `1500000` | The most tokens, input and output, over the run |
| `--max-minutes` | `20` | The most minutes of exploration; the report is written after |
| `--lanes` | `1` | Model loops that explore at once, each in its own browser and part of the app, sharing the three caps above; at most `8` |
| `--price-in` | the built-in price | US dollars per million input tokens, for the cost estimate |
| `--price-cached-in` | the built-in price, else `--price-in` | US dollars per million cached input tokens |
| `--price-out` | the built-in price | US dollars per million output tokens |
| `--mode` | `read-only` | `observe`, `read-only`, `safe-write` or `destructive` |
| `--allow-destructive` | off | A switch, required with `--mode destructive` |
| `--level` | `medium` | `minimal`, `medium` or `extensive` |
| `--focus` | none | An area or flow to spend the run on, at most 300 characters |
| `--show` | none | Capture the element these words describe as a PNG instead of exploring, at most 200 characters |
| `--compare-url` | none | With `--show`, capture the same element on this URL too and write a diff picture |
| `--dedup` | `judge` | How a filed finding is told from one already recorded. `judge`: the rule, then, for a filing the rule keeps apart from everything recorded, the run's model at the lowest effort its API takes (`none` on OpenAI, `low` on Anthropic) is asked about the open findings on the same page, and a "same" merges them. Each asked pair's titles, categories and evidence, and the page's path, are sent to the provider, and the calls count in the usage. `rule`: the rule alone |
| `--storage-state` | none | A Playwright storage-state file, to explore while signed in |
| `--browser` | `chromium` | `chromium`, `firefox` or `webkit` |
| `--action-timeout-ms` | `5000` | As for `check` |
| `--nav-timeout-ms` | `20000` | As for `check` |
| `--project` | the current directory | The project whose `.scenescout/` holds the memory |
| `--out` | `<project>/.scenescout/ci` | Where the files go |

The API key has no option: it is read from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` only.

### `scenescout login`

| Option | Default | |
|---|---|---|
| `--role` | (required) | The role's name; the profile is saved as `.scenescout/auth/<role>.json` |
| `--project` | the current directory | The project to save into |
| `--browser` | `chromium` | `chromium`, `firefox` or `webkit` |
| `--script` | off | Sign in headless from the environment instead of in a visible window (for CI) |
| `--success-url` | none | With `--script`: what the URL's path contains once signed in, or an absolute URL it starts with |
| `--success-selector` | none | With `--script`: a CSS selector visible only when signed in |
| `--username-selector` | found by the rules | With `--script`: the username field |
| `--password-selector` | found by the rules | With `--script`: the password field |
| `--otp-selector` | found by the rules | With `--script`: the one-time-code field |
| `--submit-selector` | found by the rules | With `--script`: the button that moves the form on |
| `--timeout` | `60` | With `--script`: seconds the whole sign-in may take, 5 to 600 |

Each `--script` option can also come from an environment variable, below; the option wins.

### `scenescout export`

| Option | Default | |
|---|---|---|
| `--to` | (required) | `github` or `jira` |
| `--repo` | (required for `github`) | The repository the issues go to, as `owner/name` |
| `--jira-url` | `JIRA_BASE_URL` | The Jira Cloud site, such as `https://your-site.atlassian.net`. Must be https, or plain http to `127.0.0.1`, `localhost` or `[::1]`, with no credentials, query or fragment |
| `--jira-project` | `JIRA_PROJECT_KEY` | The Jira project's key, such as `QA` |
| `--jira-issue-type` | `Bug` | The Jira issue type to create; also from `JIRA_ISSUE_TYPE` |
| `--project` | the current directory | The project whose `.scenescout/memory.json` holds the findings |
| `--min-severity` | `low` | The least severe finding to file: `high`, `medium` or `low` |
| `--only` | every finding the other options let through | Only these finding ids, comma-separated |
| `--max-issues` | `20` | The most issues one export files, 1 to 100. The next export files the rest |
| `--severity-map` | labels `severity: high`, `severity: medium` and `severity: low` on GitHub; priorities `High`, `Medium` and `Low` in Jira | What each severity becomes, as `high=…,medium=…,low=…`. A severity left out keeps its default, an empty name sets none, and `none` sets none at all |
| `--labels` | none | Labels added to every issue, comma-separated, at most 10. Jira labels cannot hold a space |
| `--screenshots` | `on` | `off` leaves the run's frames out: Jira attaches them, GitHub names them |
| `--refile-closed` | off | File a finding again when the issue carrying its marker is closed. Off, an issue open or closed counts as filed, so a won't-fix is not filed again |
| `--include-worth-a-look` | off | Export worth-a-look findings as well as defects |
| `--dry-run` | on, unless `--yes` | List what would be filed and send nothing but reads. Given only to say so |
| `--yes` | off | File the issues |

Every issue carries the `scenescout` label, which a later export lists issues by, and a marker with the finding's id. Credentials have no option: they are read from `GH_TOKEN` or `GITHUB_TOKEN`, or from `JIRA_EMAIL` and `JIRA_API_TOKEN`, only.

### `scenescout watch`

| Option | Default | |
|---|---|---|
| `--no-open` | off | Print the live view's address without opening a browser |

`scenescout scan`, `scenescout status` and `scenescout serve` take no options.

### Check rules

What `scenescout check` measures, with each rule's severity. `--ignore` takes these ids.

| Rule | Severity | |
|---|---|---|
| `route-load-failed` | high | Page did not load |
| `route-server-error` | high | Page answered with a server error |
| `route-client-error` | medium | Page answered with a client error |
| `page-error` | high | Uncaught exception |
| `server-error` | high | Request failed with a server error |
| `client-error` | medium | Request failed with a client error |
| `request-failed` | medium | Request did not complete |
| `console-error` | medium | Console error |
| `refused-empty` | high | Failed request shown as an empty result |
| `false-success` | high | Success shown for a failed request |
| `dom-injection` | high | Markup rendered as an element |
| `postmessage-token` | high | Credential posted to any origin |
| `auth-redirect` | medium | Sent to sign-in |
| `dead-end` | medium | Dead end |
| `blocking-overlay` | high | Page blocked by an overlay |
| `dialog-layout` | medium | Dialog badly placed |
| `layout-issue` | low | Layout issue |
| `covered-control` | medium | Control covered by pinned chrome |
| `clipped-control` | medium | Control unreachable |
| `offpage-control` | medium | Control outside the page |
| `overlapping-controls` | low | Controls overlap |
| `broken-image` | medium | Broken image |
| `unnamed-control` | medium | Control with no accessible name |
| `placeholder-only-label` | medium | Field labelled only by its placeholder |
| `contrast` | low | Text contrast below WCAG |
| `focus-indicator` | low | No visible focus indicator |
| `horizontal-scroll` | medium | Page scrolls sideways |
| `tiny-target` | low | Small click target |
| `clipped-text` | low | Text clipped |
| `image-aspect` | low | Image distorted |
| `flow-step-failed` | high | Saved flow broke |
| `off-grid-spacing` | worth a look | Spacing off a 4px grid |
| `indistinct-link` | worth a look | Link styled like body text |
| `scrolled-out-controls` | worth a look | Controls scrolled out of view sideways |

## Environment variables

| Variable | Read by | |
|---|---|---|
| `SCENESCOUT_BROWSER` | the server, `check`, `ci`, `login`, `doctor` | The default browser: `chromium` (default), `firefox` or `webkit` |
| `SCENESCOUT_ACTION_TIMEOUT_MS` | the server, `check`, `ci`, `login`, a first look | How long one action may take, 1000 to 120000 (default 5000). An option wins over it |
| `SCENESCOUT_NAV_TIMEOUT_MS` | the server, `check`, `ci`, `login`, a first look | How long a page may take to load, 1000 to 300000 (default 20000; 15000 per crawled route). An option wins over it |
| `SCENESCOUT_LIVE` | the server | `off` keeps the live view closed |
| `SCENESCOUT_REFRESH_BROKER` | the server | `off` turns off the refresh broker for role sessions |
| `SCENESCOUT_DEDUP` | the server | `judge` asks a model, with a key below, whether a filing the dedup rule keeps apart from everything recorded is one of the open findings on its page; `rule` (default) does not. A `scout_attach` `dedup` wins over it |
| `SCENESCOUT_DEDUP_PROVIDER` | the server | `anthropic` or `openai`: which key the dedup judge uses when both are set |
| `ANTHROPIC_API_KEY` | `ci`; the server with the dedup judge on | The Anthropic key. The only way to give one |
| `OPENAI_API_KEY` | `ci`; the server with the dedup judge on | The OpenAI key. The only way to give one |
| `SCENESCOUT_LOGIN_USERNAME` | `login --script` | Required: the test user's username or email |
| `SCENESCOUT_LOGIN_PASSWORD` | `login --script` | The password. Required unless the sign-in is passwordless: then leave it unset and set a code below. Set but empty is refused |
| `SCENESCOUT_LOGIN_TOTP_SECRET` | `login --script` | The base32 TOTP secret or `otpauth://` URI, when the form asks for a code |
| `SCENESCOUT_LOGIN_OTP_CODE` | `login --script` | A fixed one-time code the test environment accepts (4 to 12 letters or digits), when the form asks for a code. Not with `SCENESCOUT_LOGIN_TOTP_SECRET` |
| `SCENESCOUT_LOGIN_SUCCESS_URL` | `login --script` | As `--success-url` |
| `SCENESCOUT_LOGIN_SUCCESS_SELECTOR` | `login --script` | As `--success-selector` |
| `SCENESCOUT_LOGIN_USERNAME_SELECTOR` | `login --script` | As `--username-selector` |
| `SCENESCOUT_LOGIN_PASSWORD_SELECTOR` | `login --script` | As `--password-selector` |
| `SCENESCOUT_LOGIN_OTP_SELECTOR` | `login --script` | As `--otp-selector` |
| `SCENESCOUT_LOGIN_SUBMIT_SELECTOR` | `login --script` | As `--submit-selector` |
| `GH_TOKEN` | `export --to github` | The GitHub token, read before `GITHUB_TOKEN`. It must be able to create issues in the repository, and its account to set labels there |
| `GITHUB_TOKEN` | `export --to github` | The GitHub token, when `GH_TOKEN` is not set |
| `GITHUB_API_URL` | `export --to github` | The GitHub API's address, for GitHub Enterprise Server (such as `https://github.example.com/api/v3`). Default `https://api.github.com`; GitHub Actions sets it. The same rules as `--jira-url` |
| `JIRA_EMAIL` | `export --to jira` | The email address of the Atlassian account the API token belongs to |
| `JIRA_API_TOKEN` | `export --to jira` | The Atlassian API token. The only way to give one |
| `JIRA_BASE_URL` | `export --to jira` | As `--jira-url` |
| `JIRA_PROJECT_KEY` | `export --to jira` | As `--jira-project` |
| `JIRA_ISSUE_TYPE` | `export --to jira` | As `--jira-issue-type` |
| `CLAUDE_CONFIG_DIR` | `install`, `doctor` | Where Claude Code keeps its configuration; the skill goes into its `skills/` folder. Default `~/.claude` |
| `GITHUB_STEP_SUMMARY` | `check`, `ci` | Set by GitHub Actions; the report or summary is appended to it |

Variables the server reads belong in the MCP client's configuration for the server (an `env` entry), not only in your shell.

## GitHub Action inputs

A default of "empty" means the input is passed on only when set, so the CLI's own default applies.

### Action: check

`uses: brunoboto96/SceneScout@v3`. Outputs: `passed`, `exit-code`, `failing`, `retests-failing`, `could-not-run`, `worth-a-look`, `high`, `medium`, `low`, `report`, `json`, `sarif`, `artifact-name`.

| Input | Default | |
|---|---|---|
| `url` | (required) | The address of the running app |
| `fail-on` | `high` | As `--fail-on` |
| `mode` | `read-only` | As `--mode` |
| `max-routes` | empty | As `--max-routes` |
| `paths` | empty | As `--paths` |
| `ignore` | empty | As `--ignore` |
| `storage-state` | empty | As `--storage-state`, relative to `working-directory` |
| `browser` | `chromium` | As `--browser` |
| `action-timeout-ms` | empty | As `--action-timeout-ms` |
| `nav-timeout-ms` | empty | As `--nav-timeout-ms` |
| `project` | empty | As `--project`; empty means `working-directory` |
| `out` | empty | As `--out` |
| `flows` | empty | As `--flows` |
| `retest` | empty | As `--retest` |
| `flow-writes` | empty | As `--flow-writes` |
| `on-refused-step` | empty | As `--on-refused-step` |
| `gate-retests` | empty | As `--gate-retests` |
| `working-directory` | `.` | Where the check runs; other relative paths are resolved from here |
| `version` | empty | The scenescout npm version to run; empty means the version of the action's ref |
| `cli` | empty | A built `dist/cli.js` to run instead of the npm package, for testing the action itself |
| `node-version` | `24` | Installed only when the runner has no Node 20 or newer |
| `install-deps` | `true` | On Linux, install the browser's system libraries with `sudo` |
| `upload-artifact` | `true` | Keep the three files as an artifact |
| `artifact-name` | empty | Empty means `scenescout-check-<job id>`; give each matrix cell its own |
| `upload-sarif` | `false` | Upload `check.sarif` to code scanning; needs `security-events: write` |

### Action: ci

`uses: brunoboto96/SceneScout/ci@v3`, with the key in the step's `env`. Outputs: `exit-code`, `stop`, `high`, `medium`, `low`, `worth-a-look`, `turns`, `tokens`, `estimated-cost`, `report`, `summary`, `json`, `sarif`, `artifact-name`.

| Input | Default | |
|---|---|---|
| `url` | (required) | The address of the running app |
| `provider` | empty | As `--provider` |
| `model` | empty | As `--model` |
| `effort` | empty | As `--effort` |
| `base-url` | empty | As `--base-url` |
| `max-turns` | empty | As `--max-turns` |
| `max-tokens` | empty | As `--max-tokens` |
| `max-minutes` | empty | As `--max-minutes` |
| `lanes` | empty | As `--lanes` |
| `price-in` | empty | As `--price-in` |
| `price-cached-in` | empty | As `--price-cached-in` |
| `price-out` | empty | As `--price-out` |
| `mode` | `read-only` | As `--mode` |
| `allow-destructive` | empty | `true` as `--allow-destructive` |
| `level` | empty | As `--level` |
| `focus` | empty | As `--focus` |
| `show` | empty | As `--show` |
| `compare-url` | empty | As `--compare-url` |
| `dedup` | empty | As `--dedup`; empty means `judge` |
| `storage-state` | empty | As `--storage-state`, relative to `working-directory` |
| `browser` | `chromium` | As `--browser` |
| `action-timeout-ms` | empty | As `--action-timeout-ms` |
| `nav-timeout-ms` | empty | As `--nav-timeout-ms` |
| `project` | empty | As `--project`; empty means `working-directory` |
| `out` | empty | As `--out` |
| `working-directory` | `.` | Where the run happens |
| `version` | empty | The scenescout npm version to run |
| `cli` | empty | A built `dist/cli.js` to run instead, for testing the action itself |
| `node-version` | `24` | Installed only when the runner has no Node 20 or newer |
| `install-deps` | `true` | On Linux, install the browser's system libraries with `sudo` |
| `upload-artifact` | `true` | Keep the output folder as an artifact |
| `artifact-name` | empty | Empty means `scenescout-ci-<job id>` |
| `cache` | `true` | Keep the browser in the actions cache; `false` for a job that checks out a ref chosen by an input |
| `upload-sarif` | `false` | Upload `ci.sarif` to code scanning under the category `scenescout-ci` |

### Action: qa

`uses: brunoboto96/SceneScout/qa@<exact tag>`, called by the [`/scenescout qa` workflow](../../examples/workflows/scenescout-qa.yml) in three stages. You normally configure it through the repository variables below rather than editing these inputs. Outputs: `run`, `pr`, `sha`, `url`, `focus`, `login`, `show`, `base`, `pushed`.

| Input | Default | |
|---|---|---|
| `stage` | (required) | `gate`, `shots` or `report` |
| `github-token` | `${{ github.token }}` | The token for the GitHub API |
| `allowed` | empty | (gate) Logins that may start a run |
| `allowed-roles` | empty | (gate) Author associations that may start a run |
| `allowed-teams` | empty | (gate) Teams whose active members may start a run |
| `team-token` | empty | (gate) A token that can read the organization's team membership |
| `allow-forks` | empty | (gate) `true` runs on pull requests from forks |
| `preview-url` | empty | (gate) A template for the preview's URL |
| `environment` | empty | (gate) Only deployments to this environment count |
| `base-url` | empty | (gate) What `compare` compares the preview with |
| `result` | empty | (report) The result of the job that ran the model |
| `artifact-name` | empty | (shots, report) The name the results were uploaded under |
| `pr` | empty | (report) The pull request's number |
| `sha` | empty | (report) The head commit the gate saw |
| `url` | empty | (report) The preview URL the run tested |
| `login` | empty | (report) Who asked for the run |
| `shots` | empty | (report) The pictures the shots stage pushed |

## Repository variables and secrets for `/scenescout qa`

Set under Settings → Secrets and variables → Actions. All optional.

| Name | Kind | Default | |
|---|---|---|---|
| `SCENESCOUT_QA_ALLOWED` | variable | the repository's owners | Logins that may start a run, separated by commas or spaces |
| `SCENESCOUT_QA_ALLOWED_ROLES` | variable | none | `OWNER`, `MEMBER`, `COLLABORATOR` |
| `SCENESCOUT_QA_ALLOWED_TEAMS` | variable | none | `org/team-slug` entries; needs `SCENESCOUT_QA_TEAM_TOKEN` |
| `SCENESCOUT_QA_PREVIEW_URL` | variable | the head commit's newest deployment | A template with `{pr}` and `{sha}` |
| `SCENESCOUT_QA_ENVIRONMENT` | variable | any | Limits which deployments count as the preview |
| `SCENESCOUT_QA_ALLOW_FORKS` | variable | off | `true` runs on pull requests from forks |
| `SCENESCOUT_QA_BASE_URL` | variable | the base branch's newest deployment | What `compare` compares with |
| `SCENESCOUT_QA_TEAM_TOKEN` | secret | none | Reads team membership; passed to the gate job only |
| `OPENAI_API_KEY` | secret | (required) | The model key, in the template; use `ANTHROPIC_API_KEY` in the `qa` job instead for Anthropic |

## `scout_attach` options

What an agent can pass when it attaches a session. You rarely set these by hand; ask for the behaviour in words and the agent passes them.

| Option | Default | |
|---|---|---|
| `url` | (required) | The app's base URL |
| `projectPath` | (required) | The project's absolute path; `.scenescout/` lives here |
| `role` | none | Sign in with the login saved for this role. Not with `storageStatePath` |
| `storageStatePath` | none | A Playwright storage-state file. Not with `role` |
| `mode` | `read-only` | `observe`, `read-only`, `safe-write` or `destructive` ([Safety model](Safety-model.md)) |
| `session` | `default` | The session's name, for several roles or lanes at once |
| `browser` | `SCENESCOUT_BROWSER`, else `chromium` | `chromium`, `firefox` or `webkit` |
| `headed` | `false` | Show the browser window |
| `viewportWidth` | `1280` | 320 to 3840 |
| `viewportHeight` | `900` | 480 to 2400 |
| `objective` | none | The session's whole remit, shown in the live view |
| `task` | a placeholder | What the session is doing right now |
| `paceMs` | `0` | A floor between actions, 0 to 60000 |
| `trustedEmbeds` | none | Origins of embedded frames whose writes may go out, in `safe-write` only |
| `record` | `false` | Keep a frame after every action and write `report.html` |
| `actionTimeoutMs` | `SCENESCOUT_ACTION_TIMEOUT_MS`, else `5000` | 1000 to 120000 |
| `navTimeoutMs` | `SCENESCOUT_NAV_TIMEOUT_MS`, else `20000` | 1000 to 300000 |
| `dedup` | `SCENESCOUT_DEDUP`, else `rule` | `judge` asks a model whether a filing the rule keeps apart from everything recorded is one of the open findings on its page; it needs a key in the server's environment and sends the findings' titles, categories and evidence, and the page's path, to the provider. For the whole run |
