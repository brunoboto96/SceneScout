# Configuration reference

> **Who this is for:** anyone who needs the exact name or default of a setting.
>
> **What you will be able to do:** look up any command, option, environment variable, action input or MCP setting, with its default.

| Section | What is in it |
|---|---|
| [Commands](#commands) | Every `scenescout` command and its options, and the check's rules |
| [The config file](#the-config-file) | What a team commits to cap what an agent, or a command, may do |
| [Environment variables](#environment-variables) | What the server and each command read from the environment |
| [GitHub Action inputs](#github-action-inputs) | The inputs and outputs of the check, ci and qa actions |
| [Repository variables and secrets](#repository-variables-and-secrets-for-scenescout-qa) | What the `/scenescout qa` workflows read |
| [`scout_login`](#scout_login-options) and [`scout_attach`](#scout_attach-options) options | What an agent can pass when it signs in or attaches |
| [MCP prompts](#mcp-prompts) and [mod settings](#claude-code-mod-settings) | The prompts a client lists, and the optional Claude Code mod's settings |

Every config key, command-line option, environment variable, GitHub Action input, `/scenescout qa` repository setting, `scout_attach` option and MCP prompt, with its default. A test (`guide-test`, and `mcp-check` for `scout_attach`, `scout_login` and the MCP prompts) compares these tables with the code, so an option added or removed in one place and not the other fails the build. `scenescout --help` prints the same options in short.

An option takes its value after a space or an equals sign: `--fail-on high` or `--fail-on=high`. Relative paths are resolved from the directory the command runs in.

## Commands

| Command | What it does |
|---|---|
| `scenescout <url>` | A first look with no setup: the check's measurements in observe mode, capped, opening with the three issues to look at first; exit 0 it looked, 2 could not run |
| `scenescout install` | Installs the skill, downloads the browser, registers the MCP server and puts `scenescout` on your PATH |
| `scenescout doctor` | Checks the setup and prints the fix for anything missing |
| `scenescout serve` | Runs the MCP server on stdio; this is what a client starts |
| `scenescout scan <path>` | Prints what the project scan finds: framework, routes, saved logins |
| `scenescout check <url>` | The deterministic check; exit 0 passed, 1 failed the gate, 2 could not run, 3 passed on what loaded while the network kept part of the app from loading |
| `scenescout ci <url>` | An unattended exploratory run driven by a model's API; exit 0 ran, 2 could not run |
| `scenescout login <url> --role <name>` | Saves a sign-in as a role's profile; exit 0 saved, 1 not |
| `scenescout export --to <tracker>` | Files the project's open findings, or a `check.json` or `ci.json` (`--from`), as GitHub or Jira issues, each once; a dry run unless `--yes`; exit 0 done, 2 could not export |
| `scenescout preflight <url>` | Whether this machine can reach what a run needs, with no browser: the app (DNS, connection, timeout, TLS, HTTP status, bot challenge), a saved sign-in's expiry and, when asked, the model's API; exit 0 ready, 2 could not run, 10 to 17 one per cause |
| `scenescout policy explain <METHOD> <URL>` | Whether the write policy would let one request out in each mode, and the rule that decided; sends nothing; exit 0 explained, 2 could not |
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
| `--ignore-path` | none | Paths to exempt, comma-separated. A path starting with `/` drops every rule on that route; `rule:/path` drops that one rule there. Matched exactly, so a page meant to answer HTTP 500 can be exempted while a 500 on another path still fails the gate |
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
| `--baseline` | `off` | `compare` pictures each page or element listed in the baselines' `targets.json` and files `visual-change` when one no longer looks like its baseline; `update` writes new baselines ([visual baselines](Ways-to-use-it.md#visual-baselines)) |
| `--baselines` | `<project>/.scenescout/baselines` | The folder holding `targets.json` and the baselines. The default is ignored by git; name a folder the project commits to share them |
| `--baseline-threshold` | `0.1` | The percentage of a picture's pixels that may change before its baseline is not met, 0 to 100; `update` rewrites the baselines past it (and any taken on another operating system). Not 0 by default, so anti-aliasing noise between machines and browser builds does not fail the gate; `0` counts every changed pixel (a colour channel off by more than 8 in 255). A change of size always counts |
| `--sarif-file-anchor` | the running workflow's file, else `package.json`, else `README.md` | The repository file, relative to the repository root, that a `check.sarif` result points at when no saved flow raised it. See [SARIF locations](Ways-to-use-it.md#sarif-locations) |
| `--record` | `SCENESCOUT_RECORD`, else off | Keep a frame after each route visit and each saved-flow step, and write `replay.html` (role → journey → step) beside the report, with the frames in `replay-frames/`. Given alone it means `on`; `--record off` wins over the variable |
| `--video` | off | Record a WebM of each saved flow, and only of the flows, into `replay-videos/`, played on `replay.html` beside the journey's steps. Given alone it means `on` |
| `--template` | none | A report template (JSON). On a recorded check, also write a test report laid out as the template says (`report.html`, or the file the template names) beside `replay.html`: each saved flow's steps with their expected and actual results, the deviations, and a SHA-256 manifest of the evidence. Needs `--record` ([test reports](../ci.md#a-test-report-from-a-template)) |

### `scenescout ci`

| Option | Default | |
|---|---|---|
| `--provider` | the one whose key is set | `anthropic` or `openai`. Required when both keys are set |
| `--model` | `claude-sonnet-5` or `gpt-6-luna` | The model id |
| `--effort` | `low` | `none` (OpenAI only), `low`, `medium`, `high`, `xhigh` or `max` |
| `--base-url` | the provider's own API | Another endpoint implementing the same API. Must be https, or plain http to `127.0.0.1` or `localhost`, with no credentials, query or fragment |
| `--max-turns` | `80` | The most model calls |
| `--max-tokens` | `3000000` | The most tokens, input and output, over the run |
| `--max-minutes` | `20` | The most minutes of exploration; the report is written after |
| `--lanes` | `2` | Model loops that explore at once, each in its own browser and part of the app, sharing the three caps above; at most `8`. Without `--lanes`, a run with `--show` or a `--max-turns` of 1 is one loop |
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
| `--from-run` | `SCENESCOUT_FROM_RUN`, else none | Start from an earlier run's record: its `ci.json`, or a project directory whose memory holds it. Unset, the run starts fresh ([how to use it](Ways-to-use-it.md#starting-from-an-earlier-run)) |
| `--from-run-mode` | `SCENESCOUT_FROM_RUN_MODE`, else `continue` | With `--from-run`: `continue` takes first the routes the earlier run never worked on, then the ones it left work on (told which controls, forms and options to take first), then the rest; `replay` follows its routes and steps in order, one lane per session it had |
| `--from-run-turns-per-page` | `SCENESCOUT_FROM_RUN_TURNS_PER_PAGE`, else `7` | With `--from-run` in `continue` mode: model turns budgeted per page. A run takes on its turns divided by this many pages (each lane its share), at least one: 18 turns take 2 pages |
| `--storage-state` | none | A Playwright storage-state file, to explore while signed in |
| `--browser` | `chromium` | `chromium`, `firefox` or `webkit` |
| `--action-timeout-ms` | `5000` | As for `check` |
| `--nav-timeout-ms` | `20000` | As for `check` |
| `--project` | the current directory | The project whose `.scenescout/` holds the memory |
| `--out` | `<project>/.scenescout/ci` | Where the files go |
| `--sarif-file-anchor` | as for `check` | The repository file each `ci.sarif` result points at |

The API key has no option: it is read from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` only.

### `scenescout login`

| Option | Default | |
|---|---|---|
| `--role` | (required) | The role's name; the profile is saved as `.scenescout/auth/<role>.json` |
| `--project` | the current directory | The project to save into |
| `--browser` | `chromium` | `chromium`, `firefox` or `webkit` |
| `--save` | `auto` | The window: `auto` saves once it sees the sign-in finish, or on Enter; `enter` saves on Enter only. Not with `--script` |
| `--script` | off | Sign in headless from the environment instead of in a visible window (for CI) |
| `--success-url` | none | What the URL's path contains once signed in, or an absolute URL it starts with. In the window, it replaces looking for a new session |
| `--success-selector` | none | With `--script`: a CSS selector visible only when signed in |
| `--username-selector` | found by the rules | With `--script`: the username field |
| `--password-selector` | found by the rules | With `--script`: the password field |
| `--otp-selector` | found by the rules | With `--script`: the one-time-code field |
| `--submit-selector` | found by the rules | With `--script`: the button that moves the form on |
| `--timeout` | `60` | With `--script`: seconds the whole sign-in may take, 5 to 600 |

Each `--script` option can also come from an environment variable, below; the option wins. The window reads `--success-url` from the option only.

### `scenescout export`

| Option | Default | |
|---|---|---|
| `--to` | (required) | `github` or `jira` |
| `--repo` | (required for `github`) | The repository the issues go to, as `owner/name` |
| `--jira-url` | `JIRA_BASE_URL` | The Jira Cloud site, such as `https://your-site.atlassian.net`. Must be https, or plain http to `127.0.0.1`, `localhost` or `[::1]`, with no credentials, query or fragment |
| `--jira-project` | `JIRA_PROJECT_KEY` | The Jira project's key, such as `QA` |
| `--jira-issue-type` | `Bug` | The Jira issue type to create; also from `JIRA_ISSUE_TYPE` |
| `--jira-link-type` | `Relates` | The issue link type from a Jira issue to each ticket whose acceptance criterion the finding fails (`scout_criterion`), when the ticket's id is a Jira key. `none` links nothing; also from `JIRA_LINK_TYPE` |
| `--jira-update` | `on` | `on` brings each open Jira issue filed earlier up to date: its summary and description while nobody has edited them in Jira since, and the picture, frames and ticket links it lacks. `off` only lists it |
| `--project` | the current directory | The project whose `.scenescout/memory.json` holds the findings, and whose `.scenescout/exported.json` records the issues filed |
| `--from` | the project's memory | A `check.json` from `scenescout check` or a `ci.json` from `scenescout ci` to export instead. Their issues carry no screenshots |
| `--min-severity` | `low` | The least severe finding to file: `high`, `medium` or `low` |
| `--only` | every finding the other options let through | Only these finding ids, comma-separated |
| `--max-issues` | `20` | The most issues one export files, 1 to 100. The next export files the rest |
| `--severity-map` | labels `severity: high`, `severity: medium` and `severity: low` on GitHub; priorities `High`, `Medium` and `Low` in Jira | What each severity becomes, as `high=…,medium=…,low=…`. A severity left out keeps its default, an empty name sets none, and `none` sets none at all |
| `--labels` | none | Labels added to every issue, comma-separated, at most 10. Jira labels cannot hold a space |
| `--screenshots` | `on` | `off` leaves the finding's picture and the run's frames out: Jira attaches them, GitHub names them |
| `--refile-closed` | off | File a finding again when the issue carrying its marker is closed. Off, an issue open or closed counts as filed, so a won't-fix is not filed again |
| `--include-worth-a-look` | off | Export worth-a-look findings as well as defects |
| `--dry-run` | on, unless `--yes` | List what would be filed and send nothing but reads. Given only to say so |
| `--yes` | off | File the issues |

Every issue carries the `scenescout` label, which a later export lists issues by, and a marker with the finding's id. Credentials have no option: they are read from `GH_TOKEN` or `GITHUB_TOKEN`, or from `JIRA_EMAIL` and `JIRA_API_TOKEN`, only.

### `scenescout policy`

`scenescout policy explain <METHOD> <URL>` prints, for each mode, whether the [write policy](Safety-model.md) would let that request out and the rule that decided, with the function that holds it: `allowed`, `refused`, or `depends`, which means it goes out only when it addresses a record a `safe-write` session in the same server created (a change in `safe-write`, or a destructive-looking `POST` in `read-only` or `safe-write`). It sends nothing. The verdicts come from the functions the running engine judges requests with, and it reads `SCENESCOUT_STRICT_WRITES`, `SCENESCOUT_REFUSE_DESTRUCTIVE_GETS`, `SCENESCOUT_READ_POSTS` and `SCENESCOUT_AUTH_POSTS` from its own environment, as the server does, so run it with the values the server has, and applies the `readPosts`, `writeClassifier`, `refuseDestructiveGets` and `authPosts` of a [config file](#the-config-file) in the directory it runs in (or the one `SCENESCOUT_CONFIG` names) as the other commands do. It prints the address without a user name, password or token. It assumes the app's own page sent the request; a write sent from another site's embedded frame is judged by the [embed rules](Safety-model.md#embedded-third-party-frames) instead. A `GET` is judged as a page load. Exit 0 explained, 2 could not (a bad argument, a body file it could not read, a setting or config file the server would refuse too).

```bash
npx -y scenescout policy explain POST https://app.example.com/api/things/3/delete
npx -y scenescout policy explain POST https://app.example.com/api/things/3 --header "X-HTTP-Method-Override: DELETE" --mode read-only
```

| Option | Default | |
|---|---|---|
| `--mode` | every mode | `observe`, `read-only`, `safe-write` or `destructive`: explain that mode only |
| `--body` | no body | A file holding the request body, read as text, at most 1 MB |
| `--header` | none | A request header, `"Name: value"`, such as a method override. Repeat it for more |
| `--app` | the request's origin | The address the server is attached to. A read `POST` or sign-in entry written as a path (`POST /api/search`) means this origin |

### `scenescout preflight`

`scenescout preflight <url>` makes one `GET` of the URL, following redirects, and needs no browser, so it can run before anything is downloaded. It judges a saved sign-in by its own dates when one is named, and, with `--model-api`, asks the model's API for its list of models with the key. Every check runs, and the exit code is the first failure's: 0 ready, 2 could not run, 10 DNS, 11 connection refused or dropped, 12 timeout, 13 TLS, 14 HTTP 4xx or 5xx, 15 bot challenge, 16 sign-in missing or expired, 17 model API. [Network requirements](Network-requirements.md#check-it-first-scenescout-preflight) says what each looks like and what the preflight does not check.

```bash
npx -y scenescout preflight https://staging.example.com --role admin
npx -y scenescout preflight https://staging.example.com --model-api --base-url https://gateway.example.com/v1
```

| Option | Default | |
|---|---|---|
| `--role` | none | Also check that this role's saved sign-in (from `scenescout login`) exists and has not expired. It reads the profile's dates and sends nothing from it |
| `--storage-state` | none | The same, for a storage-state file you name; not with `--role` |
| `--project` | the current directory | Where `.scenescout/auth/` and the project's config file are |
| `--model-api` | off | Also ask the model's API for its models, with the key from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. The request carries the key and nothing of the app, and spends no tokens. Refused when the config's `egress` is `none` |
| `--provider` | the one whose key is set | `anthropic` or `openai`, needed only when both keys are set; with `--model-api` |
| `--base-url` | the provider's API | Another endpoint that implements the same API, as for `ci`; with `--model-api` |
| `--timeout-ms` | `10000` | The most each request may take, 1000 to 120000 |

### `scenescout watch`

| Option | Default | |
|---|---|---|
| `--no-open` | off | Print the live view's address without opening a browser |

The address is always printed. A browser is not opened in CI, over SSH or where no display server is running; the command says why, and the address can be opened by hand.

`scenescout scan`, `scenescout status` and `scenescout serve` take no options.

### Check rules

What `scenescout check` measures, with each rule's severity. `--ignore` takes these ids, and `--ignore-path` takes one as `rule:/path`.

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
| `touching-containers` | low | Containers touching |
| `flow-step-failed` | high | Saved flow broke |
| `visual-change` | high | Differs from its visual baseline (only with `--baseline`) |
| `off-grid-spacing` | worth a look | Spacing off a 4px grid |
| `indistinct-link` | worth a look | Link styled like body text |
| `scrolled-out-controls` | worth a look | Controls scrolled out of view sideways |

`refused-empty` is reported at medium instead when the empty state names something that no request on the page was for, since it may be about another section (see how-it-works).

## The config file

A JSON file a team commits to set what SceneScout may do, which no agent can loosen. Over MCP the agent chooses `scout_attach`'s arguments, and an argument wins over the environment; the config file is the one setting that wins over both. With no file, everything behaves as it always has ([Safety model](Safety-model.md#the-config-file-sets-the-limits-an-agent-cannot-loosen)).

**Where it is read from.** The file `SCENESCOUT_CONFIG` names, else `.scenescout/config.json` in the directory the server or command was started in: for the MCP server, the folder the client starts it in (Claude Code starts it in the project you opened), and for `check`, `ci` and a first look (`scenescout <url>`), the directory they run in. The server reads it once, as it starts, so a change takes a restart. The project's own `.scenescout/config.json` (the attach's `projectPath`, or `--project`) is read too, and may only tighten what the first file allows: the agent chooses that folder, so a file there cannot be the lock on its own. `.scenescout/`'s own `.gitignore` leaves `config.json` out of what it ignores, so it is committed like saved flows.

**What wins.** The file, then the environment, then an argument, where each may only tighten what came before:

- An argument that asks for more than the file allows is refused, and the refusal names the file and the key. An attach is refused before any browser starts; `check`, `ci` and a first look exit 2.
- A value from the environment, or a default, above the file's limit is lowered to it, and the attach or the command says so.
- A key the file leaves out is as it is without a file.

**A file that is not valid stops the server, or the command, as it starts,** naming the file and the key: an unknown key (a misspelt lock would look like a lock and do nothing), a key set twice (a reader would take the first value, and the second would apply), a value outside the ones below, or a list entry that is not one an argument could take. A file that is there but cannot be read, such as a directory or a link to a file that is missing, stops it too rather than counting as no file.

```json
{ "preset": "strict", "maxMode": "read-only" }
```

| Key | Values | Unset | What it does |
|---|---|---|---|
| `preset` | `strict` | none | Starts from a preset (below). A key set beside it replaces the preset's value for that key |
| `maxMode` | `observe`, `read-only`, `safe-write`, `destructive` | no limit | The loosest write mode any attach, `check`, `ci` or first look may run in. An attach or `--mode` above it is refused; an attach that names no mode, and a command with no `--mode`, start in it when the default `read-only` is above it. The guided intake form and the chat's guided prompts offer no care level above it, and `scout_guided_plan` refuses one |
| `requireGuidedPlan` | `true`, `false` | `false` | Holds the guided gate from the server's start: an attach above `observe` needs an accepted guided plan's `planId`, and `readPosts` or `trustedEmbeds` from an attach are refused, as when a plan has been built ([Safety model](Safety-model.md#care-levels-in-a-guided-check)). `ci` has no person to accept a plan, so it runs in `observe`: `--mode` above it stops `ci` before it starts, and with no `--mode` it starts in `observe` and says so. `check` and a first look, which a person runs, are not held by it |
| `readPosts` | a list of `"POST /path"` or `"POST https://host/path"` entries, at most 20 | no limit | The only POST endpoints an attach may name as reads, and the ones it gets when it names none. `[]` allows none. `SCENESCOUT_READ_POSTS` may narrow it; entries it names outside the list are left out. `check`, `ci` and a first look get the same list |
| `trustedEmbeds` | a list of `https://host` origins, at most 10 | no limit | The only embedded-frame origins an attach may trust, and the ones it gets when it names none. `[]` allows none |
| `dedup` | `rule`, `judge` | no limit | The most the dedup setting may be. `rule` keeps the model judge off: `dedup: "judge"` and `--dedup judge` are refused, and `SCENESCOUT_DEDUP=judge` and `ci`'s default are turned down to `rule` |
| `evidence` | `inline`, `file`, `off` | no limit | The most a finding's picture may do. `file` keeps pictures out of the conversation; `off` takes none. An attach's `evidence` above it is refused, and a default above it is lowered. `file` and `off` also refuse `scout_screenshot` and `scout_cards`' inline pictures, which would return a picture into the conversation; `scout_capture`, which saves to a file, still runs |
| `uploads` | `fixtures`, `project` | `project` | What `scout_upload` may send. `fixtures` sends only the files it generates: a `filePath`, and a run plan's upload step naming a file, are refused before anything runs, whatever `SCENESCOUT_UPLOAD_ALLOW` lists. `project` leaves it to the [upload fence](Safety-model.md#what-is-written-to-disk), as without a file |
| `egress` | `none`, `model-only`, `all` | `all` | What SceneScout itself may send off the machine ([What leaves the machine](What-leaves-the-machine.md#the-egress-setting)). `model-only` refuses `export`, the ticket tools and `/scenescout qa`; `none` refuses `ci` as well, turns the dedup judge off and keeps a finding's picture to a file, as `dedup: "rule"` and `evidence: "file"` would, and refuses `scout_screenshot` and `scout_cards`' inline pictures. No preset sets it. It cannot stop the coding agent from sending what it reads to its own model |
| `projectsRoot` | an absolute folder | no limit | The folder every project folder must sit inside, by its real path, so a link inside it that leads out is outside it: an attach's `projectPath` (or the folder it would choose when none is given), `scout_login`'s and `scout_scan`'s, `--project` for `check` and `ci`, and the folder a first look runs in. One outside it is refused, naming the folder. Read from the operator's file only: a project's own file that sets it is refused, since the project folder is what it limits |
| `writeClassifier` | `standard`, `strict` | `standard` | Which classifier judges whether a write is destructive. `strict` turns the strict classifier on for every attach, `check` and first look whatever `SCENESCOUT_STRICT_WRITES` says; `standard` lets the environment turn it on ([Safety model](Safety-model.md#stricter-judgement-of-destructive-writes)) |
| `refuseDestructiveGets` | `true`, `false` | `false` | `true` refuses, in `observe` and `read-only`, a page load whose address is a destructive command, whatever `SCENESCOUT_REFUSE_DESTRUCTIVE_GETS` says; `false` lets the environment turn it on |
| `authPosts` | a list of `"POST /path"` or `"POST https://host/path"` entries, at most 20 | no list | The only POSTs that count as signing in, in every mode, in place of the path rule. `[]` lets none count. `SCENESCOUT_AUTH_POSTS` may narrow it; entries it names outside the list are left out, and said so. While a guided plan is open, or when only a project's own file sets the list, a listed POST must also look like a sign-in by its path ([Safety model](Safety-model.md#what-counts-as-signing-in-in-observe)) |

The presets:

| Key | `strict` |
|---|---|
| `maxMode` | `"observe"` |
| `requireGuidedPlan` | `true` |
| `readPosts` | `[]` |
| `trustedEmbeds` | `[]` |
| `dedup` | `"rule"` |
| `evidence` | `"file"` |
| `uploads` | `"fixtures"` |
| `refuseDestructiveGets` | `true` |

`strict` is the one-line answer for a team that wants every agent to look only, with nothing named by an argument, no file from disk uploaded, no link that reads as a delete followed, and nothing sent to a model but the agent's own conversation. A team that needs form submissions sets `"maxMode": "read-only"` beside it. No preset sets `writeClassifier`, `authPosts`, `egress` or `projectsRoot`: the strict classifier refuses writes the standard one lets out, and the others name one app's endpoints, one machine's folders or a team's own trackers.

**Where each lock shows.** The attach result's `🔒 CONFIG:` line, and the `Config:` line `check`, `ci` and a first look print, name the file and each lock it applied: a mode or default it lowered, entries it left out of an environment list, and `writeClassifier`, `refuseDestructiveGets` and `authPosts` when the file sets them. The session's own lines name where each write-judgement setting came from (the config or the environment variable). `scenescout policy explain` judges a request with the same settings, and its last line names them.

## Environment variables

| Variable | Read by | |
|---|---|---|
| `SCENESCOUT_CONFIG` | the server, `check`, `ci`, a first look | The absolute path of the [config file](#the-config-file), read instead of `.scenescout/config.json` in the directory the server or command starts in. A path that is relative or not there stops the server or the command as it starts |
| `SCENESCOUT_BROWSER` | the server, `check`, `ci`, `login`, `doctor` | The default browser: `chromium` (default), `firefox` or `webkit` |
| `SCENESCOUT_BROWSER_DOWNLOAD` | the server | Whether an attach downloads the browser build it needs when it is missing: `auto` (default) downloads it once, except in CI, where `CI` or `GITHUB_ACTIONS` is set; `on` downloads in CI too; `off` never downloads and names the command to run instead |
| `SCENESCOUT_ACTION_TIMEOUT_MS` | the server, `check`, `ci`, `login`, a first look | How long one action may take, 1000 to 120000 (default 5000). An option wins over it |
| `SCENESCOUT_NAV_TIMEOUT_MS` | the server, `check`, `ci`, `login`, a first look | How long a page may take to load, 1000 to 300000 (default 20000; 15000 per crawled route). An option wins over it |
| `SCENESCOUT_RETRY_NETWORK` | the server, `check`, `ci`, a first look | `on` tries a page load once more when it failed on the network (a name that did not resolve, a refused or dropped connection, a network timeout, a failed TLS handshake), after a 2-second pause and within the load's own limit; `off` (default) reports it as it is. An HTTP answer is never retried. Any other value stops the attach. Each retry is listed in the report ([Network requirements](Network-requirements.md#failures-on-the-network-are-not-the-apps)) |
| `SCENESCOUT_PROXY` | the server, `check`, `ci`, `login`, `export`, `preflight`, a first look | A proxy URL (`http://host:port`, credentials allowed) for the browser and SceneScout's own requests, used instead of `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, which are read otherwise (lower case first). `off` reaches everything directly whatever those say. A URL that is not a proxy's stops the command ([Network requirements](Network-requirements.md#behind-a-proxy)) |
| `SCENESCOUT_APP_HEADER` | the server, `check`, `ci`, `login`, `preflight`, a first look | `Name: value`: a header sent with every request to the app's own origin, and never to another, for a firewall that lets CI traffic through by a header. Its value is never printed. Chromium and Firefox only: on WebKit the attach stops. A name such as `Cookie`, `Authorization` or `Host`, or a malformed value, stops the attach or command ([Network requirements](Network-requirements.md#an-allowlist-header-for-a-firewall)) |
| `SCENESCOUT_WATCHDOG_MS` | the server | A cap on how long any tool call may run before the server answers that it timed out, in milliseconds, at least 100. Unset, each tool keeps its own limit (a minute for most, raised with the time limits above). A value that is not a whole number of at least 100 stops the server at start |
| `SCENESCOUT_LIVE` | the server | `off` keeps the live view closed |
| `SCENESCOUT_OPEN` | the server | What opens in the default browser: `live` (the live view, on attach), `report` (`report.html`, when `scout_report` writes it), `both` or `none`. Unset: `both` on a local desktop session, headed or headless; `none` in CI, over SSH, or on Linux with no display. `none` for a developer who wants no tabs. Set, it is also an explicit choice in CI, over SSH or with no display. A `scout_attach` `open` may ask for less than it allows, never more: what it leaves out stays shut (`none` shuts both), and with it unset an `open` is refused in CI, over SSH or with no display; the attach result names what was not opened and why. `ci` runs its server with `none` unless this is set |
| `SSH_CONNECTION` | the server | Set by SSH; nothing opens in a browser by default over SSH |
| `SSH_TTY` | the server | Set by SSH, as `SSH_CONNECTION` |
| `DISPLAY` | the server | On Linux and other Unix systems, with neither this nor `WAYLAND_DISPLAY` set there is no display, and nothing opens in a browser by default |
| `WAYLAND_DISPLAY` | the server | As `DISPLAY` |
| `SCENESCOUT_REFRESH_BROKER` | the server | `off` turns off the refresh broker for role sessions |
| `SCENESCOUT_EVIDENCE` | the server | What happens to the picture each finding is filed with: `inline` (kept, in `report.html`, and returned in the `scout_finding` result), `file` (kept and in the report only) or `off`. Default `inline`, or `file` in a CI job. A `scout_attach` `evidence` wins over it |
| `SCENESCOUT_EVIDENCE_MAX_PX` | the server | The longest side of a finding's picture, in pixels, 160 to 2000 (default 800). A larger picture is shrunk to fit |
| `SCENESCOUT_EVIDENCE_MAX_KB` | the server | The most a finding's picture may take, in kilobytes, 16 to 2048 (default 200). A larger one is shrunk until it fits |
| `SCENESCOUT_EVIDENCE_INLINE` | the server | How many pictures one session returns in its `scout_finding` results, 0 to 500 (default 10). Later ones are still kept and in the report |
| `SCENESCOUT_RECORD` | the server, `check` | `on` keeps a frame after every action in every session, for teams that want each QA run recorded, and records every `check` (`replay.html`); `off` (default) does not. A `scout_attach` `record`, and `check --record`, win over it |
| `CI` | the server | Set by CI services. When it is set (and not empty, `false` or `0`), finding pictures default to `file`, nothing opens in a browser by default, and an attach does not download a missing browser unless `SCENESCOUT_BROWSER_DOWNLOAD=on` |
| `GITHUB_ACTIONS` | the server | Set by GitHub Actions. `true` counts as a CI job, as `CI` does |
| `SCENESCOUT_READ_POSTS` | the server, `check`, `ci`, a first look | POST endpoints that only read, let out in `observe`: entries such as `POST /api/search`, separated by commas or new lines. Unset: none. A `scout_attach` `readPosts` wins over it. Not read while a guided plan is open in the server |
| `SCENESCOUT_STRICT_WRITES` | the server, `check`, `ci`, a first look, `policy explain` | `1` judges whether a write is destructive with the strict classifier: identifiers split into words (`/api/deleteUser`, `UserService.DeleteUser`, `productDelete`), the query's command keys (`?action=delete`), the whole body, and more verbs (cancel, refund, terminate, disable, trash, erase). Unset or `0`: the standard classifier. Any other value stops the attach with an error. It refuses far more than the standard classifier, lets out three of its false alarms, and is read while a guided plan is open. The config's `writeClassifier: "strict"` turns it on whatever this says ([Safety model](Safety-model.md#stricter-judgement-of-destructive-writes)) |
| `SCENESCOUT_REFUSE_DESTRUCTIVE_GETS` | the server, `check`, `ci`, a first look, `policy explain` | `1` refuses, in `observe` and `read-only`, a page load whose address is a destructive command (`/items/3/delete`, `/orders/3/cancel`, `?action=delete`). Unset or `0`: such a link is followed like any other, unless the config's `refuseDestructiveGets` is `true`. Any other value stops the attach with an error ([Safety model](Safety-model.md#stricter-judgement-of-destructive-writes)) |
| `SCENESCOUT_AUTH_POSTS` | the server, `check`, `ci`, a first look, `policy explain` | The only POSTs that count as signing in, in every mode: entries such as `POST /api/login` or `POST https://idp.example.com/oauth/token`, separated by commas or new lines, written as `SCENESCOUT_READ_POSTS` entries are. Unset or empty: sign-in is recognised by its path. A listed endpoint is still refused when it looks destructive (to the strict classifier when `SCENESCOUT_STRICT_WRITES` is on) or carries a method override naming another method. When the config sets `authPosts`, only entries that list also names are kept. While a guided plan is open, a listed POST must also look like a sign-in by its path ([Safety model](Safety-model.md#what-counts-as-signing-in-in-observe)) |
| `SCENESCOUT_PROJECTS_DIR` | the server | The absolute folder that holds one folder per tested site, for an attach with no `projectPath` and a client with no workspace folder. Default: `SceneScout` in the documents folder (`~/Documents` on macOS, `%USERPROFILE%\Documents` on Windows, `XDG_DOCUMENTS_DIR` else `~/Documents` on Linux). `off` makes `projectPath` required. A `scout_attach` `projectPath` wins over it |
| `USERPROFILE` | the server | Windows: the folder whose `Documents` holds the default `SceneScout` folder |
| `XDG_DOCUMENTS_DIR` | the server | Linux: the documents folder that holds the default `SceneScout` folder, read before `~/.config/user-dirs.dirs` |
| `SCENESCOUT_TICKET_DIRS` | the server | Folders outside the project that `scout_tickets` may read a ticket file from, as absolute paths separated as in `PATH` (`:`, or `;` on Windows). Unset: a ticket file is read only from inside the project folder. An entry that is relative or starts with `~` stops the server as it starts, with a message naming it; a folder that is not there is named in a warning as the server starts, and no ticket is read from it until it is; an empty entry is skipped ([Safety model](Safety-model.md#the-project-folder-is-the-trust-boundary)) |
| `SCENESCOUT_UPLOAD_ALLOW` | the server | Files `scout_upload` may send although they look like credentials (a dotfile, `.env*`, a key, anything under `.ssh`, `.aws` and the like), as exact absolute paths separated as in `PATH`. Unset: none is sent. Only the files named, never a folder; each must still be inside the project. A relative entry or one starting with `~` stops the server as it starts ([Safety model](Safety-model.md#what-is-written-to-disk)) |
| `SCENESCOUT_STORAGE_STATE_ALLOW` | the server | Storage-state files `scout_attach` `storageStatePath` may read from outside the project, as exact absolute paths separated as in `PATH`. Unset: only files inside the project are read. `ci` adds the file `--storage-state` names for its own server. A relative entry or one starting with `~` stops the server as it starts |
| `SCENESCOUT_DEDUP` | the server | `judge` asks a model, with a key below, whether a filing the dedup rule keeps apart from everything recorded is one of the open findings on its page; `rule` (default) does not. A `scout_attach` `dedup: "rule"` wins over it; `dedup: "judge"` from a tool call does not switch the judge on unless this variable already says `judge` |
| `SCENESCOUT_DEDUP_PROVIDER` | the server | `anthropic` or `openai`: which key the dedup judge uses when both are set |
| `SCENESCOUT_DEDUP_BASE_URL` | the server | The API root the dedup judge sends its key and questions to, for a private endpoint that speaks the chosen provider's API (the same rules as `ci --base-url`: https, or plain http only to `127.0.0.1` or `localhost`, no credentials, query or fragment in the URL, and a redirect is never followed). Unset or blank: the provider's own API. A value that breaks a rule stops the judge's setup with a message naming the variable |
| `SCENESCOUT_FROM_RUN` | the server, `ci` | An earlier run's `ci.json` or project directory, for every `ci` run and `scout_lane_brief` that does not name its own: the run starts from that run's record. Unset (default): a fresh run. `--from-run` and the brief's `fromRun` win over it |
| `SCENESCOUT_FROM_RUN_MODE` | the server, `ci` | `continue` (default) or `replay`: how a run that starts from an earlier one uses its record. `--from-run-mode` and the brief's `fromRunMode` win over it |
| `SCENESCOUT_FROM_RUN_TURNS_PER_PAGE` | the server, `ci` | A whole number from 1 to 200 (default 7): turns a continued `ci` run budgets per page, which caps how many pages it takes on. `--from-run-turns-per-page` wins over it |
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
| `GH_TOKEN` | `export --to github`, the server's ticket tools | The GitHub token, read before `GITHUB_TOKEN`. It must be able to create issues in the repository, and its account to set labels there |
| `GITHUB_TOKEN` | `export --to github`, the server's ticket tools | The GitHub token, when `GH_TOKEN` is not set |
| `GITHUB_API_URL` | `export --to github`, the server's ticket tools | The GitHub API's address, for GitHub Enterprise Server (such as `https://github.example.com/api/v3`). Default `https://api.github.com`; GitHub Actions sets it. The same rules as `--jira-url` |
| `JIRA_EMAIL` | `export --to jira`, the server's ticket tools | The email address of the Atlassian account the API token belongs to |
| `JIRA_API_TOKEN` | `export --to jira`, the server's ticket tools | The Atlassian API token. The only way to give one |
| `JIRA_BASE_URL` | `export --to jira`, the server's ticket tools | As `--jira-url` |
| `JIRA_PROJECT_KEY` | `export --to jira` | As `--jira-project` |
| `JIRA_ISSUE_TYPE` | `export --to jira`, the server's ticket tools | As `--jira-issue-type` |
| `JIRA_LINK_TYPE` | `export --to jira`, the server's ticket tools | As `--jira-link-type` |
| `CLAUDE_CONFIG_DIR` | `install`, `doctor` | Where Claude Code keeps its configuration; the skill goes into its `skills/` folder. Default `~/.claude` |
| `APPDATA` | `doctor` | On Windows, where Claude Desktop keeps its installed extensions (`Claude\Claude Extensions` inside it). Set by Windows |
| `LOCALAPPDATA` | `doctor` | On Windows, where the Microsoft Store build of Claude Desktop keeps its data (`Packages\Claude_…`). Set by Windows |
| `PATHEXT` | `install`, `doctor` | On Windows, the extensions searched when a client command has none of its own, so an npm-installed client is found. Set by Windows |
| `XDG_CONFIG_HOME` | `doctor` | On Linux, the configuration folder searched for Claude Desktop's extensions. Default `~/.config` |
| `GITHUB_STEP_SUMMARY` | `check`, `ci` | Set by GitHub Actions; the report or summary is appended to it |
| `GITHUB_WORKFLOW_REF` | `check`, `ci` | Set by GitHub Actions; with no `--sarif-file-anchor`, its workflow file is the file SARIF results point at |
| `GITHUB_WORKSPACE` | `check`, `ci` | Set by GitHub Actions; the repository root that SARIF file paths are relative to |
| `GITHUB_SHA` | `check` | Set by GitHub Actions; the commit a recorded check's `replay.html` names in its header |

Variables the server reads belong in the MCP client's configuration for the server (an `env` entry), not only in your shell.

## GitHub Action inputs

A default of "empty" means the input is passed on only when set, so the CLI's own default applies.

### Action: check

`uses: brunoboto96/SceneScout@v3`. Outputs: `passed`, `exit-code`, `failing`, `retests-failing`, `could-not-run`, `worth-a-look`, `high`, `medium`, `low`, `report`, `json`, `sarif`, `replay`, `test-report`, `artifact-name`.

| Input | Default | |
|---|---|---|
| `url` | (required) | The address of the running app |
| `fail-on` | `high` | As `--fail-on` |
| `mode` | `read-only` | As `--mode` |
| `max-routes` | empty | As `--max-routes` |
| `paths` | empty | As `--paths` |
| `ignore` | empty | As `--ignore` |
| `ignore-path` | empty | As `--ignore-path` |
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
| `baseline` | empty | As `--baseline` |
| `baselines` | empty | As `--baselines`, relative to `working-directory` |
| `baseline-threshold` | empty | As `--baseline-threshold` |
| `sarif-file-anchor` | empty | As `--sarif-file-anchor`, relative to the repository root; empty means the workflow file that is running |
| `record` | empty | As `--record` (`on` or `off`); empty means `SCENESCOUT_RECORD`, else off. The replay page and its frames go in the artifact |
| `video` | empty | As `--video` (`on` or `off`); empty means off. The journey videos go in the artifact |
| `template` | empty | As `--template`, relative to `working-directory`; needs `record: on`. The test report goes in the artifact |
| `working-directory` | `.` | Where the check runs; other relative paths are resolved from here |
| `version` | empty | The scenescout npm version to run; empty means the version of the action's ref, installed with `npm ci` from that release's lockfile. A version other than that release installs with its dependencies resolved at run time, with a warning |
| `cli` | empty | A built `dist/cli.js` to run instead of the npm package, for testing the action itself |
| `node-version` | `24` | Installed only when the runner has no Node 20 or newer |
| `install-deps` | `true` | On Linux, install the browser's system libraries with `sudo` |
| `upload-artifact` | `true` | Keep the three files as an artifact, with the pictures of any visual baseline not met, and `replay.html` with its frames and videos on a recorded check |
| `artifact-name` | empty | Empty means `scenescout-check-<job id>`; give each matrix cell its own |
| `artifact-retention-days` | empty | Days to keep the artifact, 1 to 90; empty keeps the repository's setting |
| `preflight` | `false` | Run `scenescout preflight` on `url`, with `storage-state` when set, before the browser is installed, and stop the job with its cause ([network requirements](Network-requirements.md#check-it-first-scenescout-preflight)) |
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
| `from-run` | empty | As `--from-run`, relative to `working-directory`; empty means `SCENESCOUT_FROM_RUN`, else a fresh run |
| `from-run-mode` | empty | As `--from-run-mode`; empty means `continue` |
| `from-run-turns-per-page` | empty | As `--from-run-turns-per-page`; empty means `7` |
| `sarif-file-anchor` | empty | As `--sarif-file-anchor`, relative to the repository root; empty means the workflow file that is running |
| `storage-state` | empty | As `--storage-state`, relative to `working-directory` |
| `browser` | `chromium` | As `--browser` |
| `action-timeout-ms` | empty | As `--action-timeout-ms` |
| `nav-timeout-ms` | empty | As `--nav-timeout-ms` |
| `project` | empty | As `--project`; empty means `working-directory` |
| `out` | empty | As `--out` |
| `working-directory` | `.` | Where the run happens |
| `version` | empty | The scenescout npm version to run; empty means the version of the action's ref, installed with `npm ci` from that release's lockfile. A version other than that release installs with its dependencies resolved at run time, with a warning |
| `cli` | empty | A built `dist/cli.js` to run instead, for testing the action itself |
| `node-version` | `24` | Installed only when the runner has no Node 20 or newer |
| `install-deps` | `true` | On Linux, install the browser's system libraries with `sudo` |
| `upload-artifact` | `true` | Keep `report.md`, `report.html`, `summary.md`, `ci.json`, `ci.sarif` and the pictures in `shots/` as an artifact; nothing else in the output folder is uploaded |
| `artifact-name` | empty | Empty means `scenescout-ci-<job id>` |
| `artifact-retention-days` | empty | Days to keep the artifact, 1 to 90; empty keeps the repository's setting |
| `cache` | `true` | Keep the browser in the actions cache; `false` for a job that checks out a ref chosen by an input |
| `upload-sarif` | `false` | Upload `ci.sarif` to code scanning under the category `scenescout-ci` |

### Action: qa

`uses: brunoboto96/SceneScout/qa@<exact tag>`, called by the [`/scenescout qa` workflow](../../examples/workflows/scenescout-qa.yml) in four stages. You normally configure it through the repository variables below rather than editing these inputs. Outputs: `run`, `pr`, `sha`, `url`, `focus`, `login`, `show`, `base`, `check`, `ref`, `check-workflow`, `pushed`.

| Input | Default | |
|---|---|---|
| `stage` | (required) | `gate`, `shots`, `report` or `check` |
| `github-token` | `${{ github.token }}` | The token for the GitHub API |
| `allowed` | empty | (gate) Logins that may start a run |
| `allowed-roles` | empty | (gate) Author associations that may start a run |
| `allowed-teams` | empty | (gate) Teams whose active members may start a run |
| `team-token` | empty | (gate) A token that can read the organization's team membership |
| `allow-forks` | empty | (gate) `true` runs on pull requests from forks |
| `preview-url` | empty | (gate) A template for the preview's URL |
| `environment` | empty | (gate) Only deployments to this environment count |
| `base-url` | empty | (gate) What `compare` compares the preview with |
| `check-workflow` | empty | (gate, check) The project's workflow `/scenescout qa check` dispatches |
| `ref` | empty | (check) The pull request's head branch, from the gate |
| `focus` | empty | (check) The words after `check`, passed to the workflow |
| `wait-minutes` | empty | (check) How long to wait for the dispatched run; empty means 30 |
| `result` | empty | (report) The result of the job that ran the model |
| `artifact-name` | empty | (shots, report, check) The name the results were uploaded under; for a check, empty means `scenescout-check` |
| `pr` | empty | (report, check) The pull request's number |
| `sha` | empty | (report, check) The head commit the gate saw |
| `url` | empty | (report) The preview URL the run tested |
| `login` | empty | (report, check) Who asked for the run |
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
| `SCENESCOUT_QA_CHECK_WORKFLOW` | variable | none | The project's workflow `/scenescout qa check` dispatches, by file name (e.g. `browser-tests.yml`); unset, the command replies saying how to set it up |
| `SCENESCOUT_QA_CHECK_ARTIFACT` | variable | `scenescout-check` | The artifact that workflow uploads its check's output folder as |
| `SCENESCOUT_QA_TEAM_TOKEN` | secret | none | Reads team membership; passed to the gate job only |
| `OPENAI_API_KEY` | secret | (required) | The model key, in the template; use `ANTHROPIC_API_KEY` in the `qa` job instead for Anthropic |

## `scout_login` options

What an agent passes to open a sign-in window from the conversation ([Signing in](Signing-in.md#from-a-conversation)).

| Option | Default | |
|---|---|---|
| `url` | (required) | Where to sign in: the app's address or its sign-in page |
| `role` | (required) | The name the sign-in is saved under |
| `projectPath` | as for `scout_attach` | The project's absolute path; the sign-in is saved in its `.scenescout/auth/`. Left out, the folder an attach with no `projectPath` uses for the same site, named in the result, so a login and the attach after it agree |
| `browser` | `SCENESCOUT_BROWSER`, else `chromium` | `chromium`, `firefox` or `webkit` |
| `successUrl` | none | As `--success-url` |
| `waitSeconds` | `120` | How long one call waits before returning with the window still open, 1 to 600 |

## `scout_attach` options

What an agent can pass when it attaches a session. You rarely set these by hand; ask for the behaviour in words and the agent passes them.

| Option | Default | |
|---|---|---|
| `url` | (required) | The app's base URL |
| `projectPath` | the client's workspace folder, else a folder for the site | The project's absolute path; `.scenescout/` lives here. Given, it always wins. Left out, a client that offers a workspace folder gets that; otherwise each tested site gets its own folder under `SCENESCOUT_PROJECTS_DIR`, by default `Documents/SceneScout/<host>/` (`localhost-3000` for `http://localhost:3000`), created on first use and named in the attach's result. That default is refused when it would sit inside a git repository below your home folder; a home folder that is itself a repository does not count |
| `role` | none | Sign in with the login saved for this role. Not with `storageStatePath` |
| `storageStatePath` | none | A Playwright storage-state file inside the project, or one `SCENESCOUT_STORAGE_STATE_ALLOW` lists. Not with `role` |
| `mode` | `read-only`, or the config's `maxMode` when that is stricter | `observe`, `read-only`, `safe-write` or `destructive` ([Safety model](Safety-model.md)). Above the [config file](#the-config-file)'s `maxMode`, the attach is refused |
| `session` | `default` | The session's name, for several roles or lanes at once |
| `browser` | `SCENESCOUT_BROWSER`, else `chromium` | `chromium`, `firefox` or `webkit` |
| `headed` | `false` | Show the browser window |
| `viewportWidth` | `1280` | 320 to 3840 |
| `viewportHeight` | `900` | 480 to 2400 |
| `objective` | none | The session's whole remit, shown in the live view |
| `task` | a placeholder | What the session is doing right now |
| `paceMs` | `0` | A floor between actions, 0 to 60000 |
| `trustedEmbeds` | none | Origins of embedded frames whose writes may go out, in `safe-write` only |
| `record` | `SCENESCOUT_RECORD`, else `false` | Keep a frame after every action and show it beside each step in `report.html` |
| `evidence` | `SCENESCOUT_EVIDENCE`, else `inline` (`file` in a CI job) | What happens to the picture each finding is filed with: `inline` keeps it, shows it in `report.html` and returns it in the `scout_finding` result; `file` keeps it and shows it in the report; `off` takes none |
| `readPosts` | `SCENESCOUT_READ_POSTS`, else none | POST endpoints that only read (`"POST /api/search"`, `"POST https://api.example.com/query"`), let out in `observe` only. Exact paths, `*` for one path segment, at most 20 ([Safety model](Safety-model.md#post-endpoints-that-only-read)) |
| `actionTimeoutMs` | `SCENESCOUT_ACTION_TIMEOUT_MS`, else `5000` | 1000 to 120000 |
| `navTimeoutMs` | `SCENESCOUT_NAV_TIMEOUT_MS`, else `20000` | 1000 to 300000 |
| `dedup` | `SCENESCOUT_DEDUP`, else `rule` | `judge` asks a model, only when `SCENESCOUT_DEDUP=judge` is in the server's environment (the argument alone is refused with a note); it asks whether a filing the rule keeps apart from everything recorded is one of the open findings on its page; it needs a key in the server's environment and sends the findings' titles, categories and evidence, and the page's path, to the provider. For the whole run |
| `planId` | none | The guided plan this attach carries out (`gp-…`). Once any guided plan is built in the server, an attach above `observe` needs an accepted plan's id, in no mode above the plan's and on the plan's site. While a plan is open, an attach passing `readPosts` or `trustedEmbeds` is refused, and a plan no session carries any more must be confirmed again ([Safety model](Safety-model.md#care-levels-in-a-guided-check)) |
| `open` | `SCENESCOUT_OPEN`, else by context | `live`, `report`, `both` or `none`: ask to open the live view on this attach and `report.html` when `scout_report` writes it. It may ask for less than `SCENESCOUT_OPEN` allows, never more, and with that unset CI, SSH and no display refuse it; the attach result names what was not opened and why. Unset, both open on a local desktop session, headed or headless, and nothing opens in CI, over SSH, or on Linux with no display |

## MCP prompts

Clients that list the server's prompts offer these as commands, beside `scout_playbook` and the tools. None of them takes a password or any other credential. `mcp-check` holds this table to the prompts the server lists.

| Prompt | Arguments | What it asks the agent to do |
|---|---|---|
| `explore` | `url` (optional), `level` (optional), `focus` (optional) | Start an exploratory session: load the method, and use whatever of the address, level and focus was given. With no arguments, ask the plain questions first |
| `live` | none | Return the loopback live-view URL for the current session. Where the host can open a URL, it may open that address |
| `login` | `role` (required), `url` (optional) | Call `scout_login` for that role and wait the way that tool waits. The person signs in in the window it opens. `url` is the app's address when you have it |
| `check-my-site` | `url` (optional) | Shown as *Check my site*. Call `scout_intake` (with the address when given), follow the guided plan it returns, show progress with `scout_status`, and end with `scout_cards` and the follow-up prompts. Never choose a care level for the person. An address with a user name, password or token in it, or with a space, line break or hidden character, is refused without being repeated |
| `recheck` | none | Shown as *Re-check after a fix*. Call `scout_recheck_plan` and follow the plan it returns: it attaches in the care level the findings were found in, never a looser one, with its own `planId` (confirmed again by the person where it writes), lists them with `scout_verify`, re-tests each and records its verdict, then shows the cards that changed |
| `team-report` | none | Shown as *Make a team report*. Call `scout_team_report` and say where `team-report.html` and its evidence folder are; nothing is sent anywhere |
| `file-tickets` | `to` (optional) | Shown as *File problems as tickets*. `to` is `github` or `jira`. Show the cards and ask which to file and where, preview them with `scout_ticket_preview`, then call `scout_ticket_file`, which files only once the person says yes in the server's own form. Where the form cannot be shown, give the `scenescout export` command instead. Never ask for a token |
| `is-it-safe` | none | Shown as *Is it safe to run on my live site?*. Reply with the guided safety explainer word for word, calling no tool |

## Desktop extension settings

Claude Desktop asks for these in the extension's settings, and keeps the two marked secret itself. They are only needed to file problems as tickets from the chat (`scout_ticket_preview` and `scout_ticket_file`), they are all optional, and each reaches the server as the environment variable `scenescout export` reads. A setting left empty is no setting. None of them is ever asked for in the chat, shown in a tool's result or written to the project.

| Setting | Secret | Reaches the server as | What it is |
|---|---|---|---|
| GitHub token | yes | `GH_TOKEN` | A token that can create issues in the repository the person files into |
| Jira site address | no | `JIRA_BASE_URL` | Such as `https://your-site.atlassian.net` |
| Jira account email | no | `JIRA_EMAIL` | The email of the Atlassian account the API token belongs to |
| Jira API token | yes | `JIRA_API_TOKEN` | An Atlassian API token |

With the plugin in Claude Code, set the same variables in the environment Claude Code starts in.

## Claude Code mod settings

The optional `scenescout-mod` plugin ([The Claude Code mod](Ways-to-use-it.md#the-claude-code-mod)) asks for these when it is installed, and `/plugin configure scenescout-mod@scenescout-marketplace` or its `/config` rows change them. `lane_model` and `mcp_server` are empty by default, `game` is `off`, and none is a credential. `guide-test` holds this table to the mod's manifest.

| Setting | Default | What it does |
|---|---|---|
| `lane_model` | empty: subagents are left alone | The model a SceneScout lane agent starts on, as an alias (`sonnet`, `haiku`, `opus`) or a full model id. A subagent counts as a lane when its prompt names `scout_attach` or `scout_lane_report`; a fork keeps its parent's model |
| `mcp_server` | empty: tries `scenescout`, then `plugin:scenescout:scenescout` | The SceneScout server's name as `/mcp` lists it, tried first when the pane polls |
| `game` | `off` | `on` draws a bestiary of the open problems in the guided panel, defeated by a re-check that finds one gone, with its count under the end-of-check card. It changes no word on a card, the report or a ticket, and is never in the saved card or anything else shared |
