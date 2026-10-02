# Troubleshooting and FAQ

Run `npx -y scenescout doctor` first (`--engine` for clients other than Claude Code). It checks node, the build, the browser, the skill and the registration, and prints the command that fixes whatever is missing.

## Setup

| Symptom | Cause and fix |
|---|---|
| `/scenescout` is not a known command | The skill is not installed, or the session started before it was. Run `npx -y scenescout install`, then start a new Claude Code session |
| The `scout_*` tools do not appear | The server is not registered, or points at an old path. `npx -y scenescout install` registers it again; `claude mcp list` should show `scenescout` as connected. For other clients, restart the client after registering |
| "Executable not found in $PATH" | The server was registered with a bare `node` or `npx` the client cannot find, which happens under nvm or fnm. `npx -y scenescout install` registers absolute paths. A plugin install starts a bare `npx`: launch Claude Code from a terminal that has Node on its PATH, or use the npm install instead |
| `doctor` says the desktop extension's browser is not downloaded | The extension is a different SceneScout version from the one `doctor` ran as, and launches another Chromium build. An extension at least as new as `doctor` downloads it on first use, so that line is a tick; an older one fails it. Either way the command it prints downloads the build for the extension's version beforehand |
| "… build has not been downloaded yet" on attach | The browser was not downloaded, or the run asked for one you did not install. Run the command the message names, for example `npx -y scenescout install --browser-only --browsers firefox`. On Linux, system libraries may be missing too: `npx playwright install --with-deps chromium` |
| "Getting the test browser ready" on the first attach | The browser the test drives was not on this machine, so the server is downloading it, once. The attach carries on when it is done. To have it ready beforehand, run `npx -y scenescout install --browser-only`. On a machine where the server may download nothing, set `SCENESCOUT_BROWSER_DOWNLOAD=off` in its environment and put the browser there another way |
| "In CI SceneScout downloads a browser only when asked" | A CI job keeps its explicit install step: add `npx -y scenescout install --browser-only --browsers <build>` before the tests, or set `SCENESCOUT_BROWSER_DOWNLOAD=on` to let the attach download it |
| The tools broke after moving a folder or changing Node version | The registration stores absolute paths. Run `npx -y scenescout install` again |
| The agent starts clicking without the method | In a client with no skill, the server's instructions tell the agent to call `scout_playbook` first; how closely a model follows them varies. Tell it to call `scout_playbook`, or use the client's `explore` prompt |

## During a run

| Symptom | Cause and fix |
|---|---|
| `⚠ AUTH FAILED` on attach, or every route lands on the sign-in page | The saved login or storage state has expired, or the app is not running at the URL. Record the role again with `scenescout login <url> --role <name>`; regenerate a Playwright storage state the way your project does |
| `⚠ SESSION AUTH LOST` mid-run | The session was signed out after it started. A role session re-attaches once from the latest saved profile; record the login again and it can carry on. Pages reached while signed out are not counted as covered |
| `🛡 WRITE-POLICY blocked` in a tool result | The write mode refused a request. This is the policy working, not an app bug. If the flow matters, re-run in a mode that allows it, against data you can afford to change ([Safety model](Safety-model.md)) |
| `⚠ LEAVE CONFIRMATION` and the page did not change | The page asked to confirm leaving because it holds unsent input, and `observe` and `read-only` stay by default. Repeat the `scout_navigate`, `scout_click` or `scout_back` with `leave: true` to leave and discard that input ([Safety model](Safety-model.md#leaving-a-page-with-unsent-input)) |
| `ERROR-VIEW` or `STILL-LOADING` on a crawl line | The route answered 200, but after the page settled its main area held only an alert (the app's error or not-found view) or only a loading placeholder. It is listed under problem routes and does not join the route contract. Check the path is one the app has; if the page is only slow, raise the page limit below |
| A crawl or `scout_navigate` reaches the wrong page after attaching below the root | A path such as `/orders` names a page on the attached origin, whatever page the session attached on, as URL rules read it; it is never joined to the attach URL's path. Pass the full path, for example `/app/orders` for an app served under `/app/` |
| A timeout that names a limit | An action has 5 s and a page 20 s (15 s in a crawl). On a busy machine, raise them with `scout_attach {actionTimeoutMs, navTimeoutMs}`, the environment variables, or `--action-timeout-ms` and `--nav-timeout-ms`. A page that really takes 20 s to load is a finding |
| `⚠ AMBIGUOUS SESSION` | More than one session is live and a call named none, so it went to whichever attached last. The agent should pass `session` on every call in a multi-role run |
| The live view does not open | `scenescout watch` finds the engine through `.scenescout/` in the folder it runs in; pass the project path if it differs. `SCENESCOUT_LIVE=off` in the server's environment closes it |
| The report refuses to finish | The level's contract is not met, and `scout_report` lists what is missing. Work the list down, or choose a lower level. `force: true` writes it anyway, with the gaps printed |
| Parallel lanes slow the machine to a crawl | Each lane is a real browser. Run about as many as the machine has cores, less two, and let each lane attach when it starts |
| A closed session will not close | `scout_close` keeps a lane open until its report has been accepted by `scout_lane_report`, because the lane's decisions are kept against its session. Fold the report, then close |
| `⚠ DEDUP JUDGE OFF` on attach | The dedup judge was asked for (`SCENESCOUT_DEDUP=judge` or `scout_attach {dedup: "judge"}`) and the server has no key to ask it with, or has both keys and no `SCENESCOUT_DEDUP_PROVIDER`. The rule decides duplicates, as it does by default. Put the key in the server's environment, or leave the judge off |
| A finding says "Merged by the dedup judge" | A model read that filing as the same defect as the finding it sits under. Its title, category, severity and evidence are kept there; if the two are different defects, file it again with a title that says what differs |

## In CI

| Symptom | Cause and fix |
|---|---|
| `scenescout check` exits 2 | It could not run, or not all of it: the app never answered, only the sign-in page was reached, a saved flow is not valid (the file and field are named), a flow step was refused by the write policy, or `--baseline` found no `targets.json`, or one that is not valid, in the baselines folder. Read it as a setup problem, not a defect |
| A visual baseline fails on CI but passes locally | The baseline was taken on another operating system, which draws text differently (the report says so). Take baselines where the check runs ([visual baselines](Ways-to-use-it.md#visual-baselines)) |
| A visual baseline "cannot be used" | Its files are half there or unreadable, or it was taken with other settings, often by another version of SceneScout. Take it again with `--baseline update` |
| A flow is marked "could not run" | A step sent a write under `--flow-writes never`, often telemetry or a heartbeat landing during the step. Stop the telemetry in the test environment, or use `--flow-writes allow` |
| Timeouts only on the CI runner | The runner is loaded. Raise `action-timeout-ms` and `nav-timeout-ms` on the action |
| `scenescout ci` exits 2 on a fork's pull request | Forks get no secrets under `pull_request`, so there is no key. Run it on pushes, on a schedule, or on pull requests from the same repository |
| `scenescout ci` exits 2 with two keys set | Both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set; pass `--provider` |
| `upload-sarif` fails | The job needs `permissions: security-events: write` (and `actions: read` in a private repository). A fork's pull request gets a read-only token; upload only on pushes to your main branch |
| `/scenescout qa` gets 😕 and no reply | The commenter is not allowed. See [who may start a run](Ways-to-use-it.md#who-may-start-a-run); setting any allowlist replaces the owners default |
| `/scenescout qa` replies that there is no preview | Set `SCENESCOUT_QA_PREVIEW_URL`, or `SCENESCOUT_QA_ENVIRONMENT` if the deployments API lists several. The URL must be https |
| The guide's wiki is out of date | The wiki is published from `docs/guide/` on each release, and a maintainer can run the `guide-wiki` workflow by hand |

## FAQ

**Does SceneScout need an API key?**
No, for everything but `scenescout ci` and `/scenescout qa`. An interactive run uses the agent and subscription you already have; the engine contains no model. `scenescout check` needs no model at all.

**Can it change or delete my data?**
Not in the default `read-only` mode, which refuses `PUT`, `PATCH`, `DELETE` and destructive-looking requests on the network. Ordinary form submissions do go through and can create records; use `observe` where that is not acceptable. See the [Safety model](Safety-model.md).

**Does it replace my end-to-end tests?**
No. It finds what scripted tests do not cover and gives each finding a Playwright regression-test skeleton to promote. Saved flows replayed by `scenescout check` sit in between: a few important flows, checked on every pull request, with no model.

**Why did two runs find different things?**
The exploration is driven by a model, which chooses differently each time. The gap ledger says what each run covered. Memory makes the next run skip what was already covered, and `scout_verify` re-tests what earlier runs left open.

**Can I use it on a site I do not own?**
Only one you are authorised to test. For a remote URL with no source, the method starts in `observe` mode.

**Where does everything go?**
Into `.scenescout/` in the project folder (or the folder you ran from, for a remote URL): memory, notes, findings, reports, saved logins, flows. It ignores itself in git, except `flows/*.json`. Delete it to start from nothing.

**Which browsers does it drive?**
Chromium by default, and Firefox and WebKit once downloaded (`npx -y scenescout install --browser-only --browsers firefox,webkit`). Firefox and WebKit do not let service workers register, because the write policy can intercept a service worker's requests only in Chromium.

**How do I uninstall it?**
`claude mcp remove --scope user scenescout` and remove the `scenescout` folder from Claude Code's skills folder (for other clients, their own `mcp remove`, or delete the entry from the client's configuration). Delete each project's `.scenescout/` folder if you want its memory gone.
