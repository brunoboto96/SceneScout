# Network requirements

> **Who this is for:** whoever runs SceneScout in CI or on a locked-down network: the person whose job fails with "could not run", the team that maintains a firewall allowlist, or anyone setting up a self-hosted runner.
>
> **What you will be able to do:** list every host each command needs, check in seconds that a runner can reach them with `scenescout preflight`, remove downloads with caches and mirrors, and run SceneScout on a runner inside your own network.

This page covers reaching hosts. Which data goes to them, and how to turn each path off, is in [What leaves the machine](What-leaves-the-machine.md).

## Check it first: `scenescout preflight`

`scenescout preflight <url>` asks, with no browser and in seconds, whether this machine can reach what a run needs. Run it as the first step of a CI job, before anything is downloaded:

```bash
npx -y scenescout preflight https://staging.example.com
npx -y scenescout preflight https://staging.example.com --role admin --model-api
```

It makes one `GET` of the URL, following redirects, and judges the answer. A saved sign-in (`--role` or `--storage-state`) is judged by its own expiry dates. With `--model-api`, it also asks the model's API for its list of models with the key, as `scenescout ci` would reach it. Every check runs, so one run names every cause. The exit code is the first failure's, and each failure line names its cause and what to do.

| Exit code | Cause | What it looked like |
|---|---|---|
| 0 | Ready | Every check passed. A line starting `!` is something to know, not a failure |
| 2 | Could not run | A bad argument, or a [config file](Configuration-reference.md#the-config-file) that refuses it, such as `egress` `none` with `--model-api` |
| 10 | DNS | The runner's resolver has no address for the host: a typo, or a private name the runner cannot see |
| 11 | Connection | The connection was refused or dropped: nothing listens on that port, or a firewall rejects the runner. Also a port that browsers refuse to load (6000, 6667 and the other ports the Fetch standard blocks) |
| 12 | Timeout | No answer within `--timeout-ms` (default 10000): a firewall that drops packets, or an app still starting. Node gives up on a connection that is never set up after 10 seconds, whatever `--timeout-ms` says, and the line says so |
| 13 | TLS | The certificate has expired, does not name the host, or is signed by an authority this machine does not trust |
| 14 | HTTP | The start page answered 4xx or 5xx, or redirected more than 20 times; the status is named, with the likely fix |
| 15 | Bot challenge | A bot protection answered in the app's place, by the same rule `check` stops on |
| 16 | Sign-in | No profile is saved for the role, the file is missing or unreadable, or every dated credential in it has ended |
| 17 | Model API | No key is set, the API refused the key (401 or 403), the API answered 5xx or a redirect, or it could not be reached (the line names the network cause) |

What it does not do:

- **It is not a browser.** Its request is a plain HTTP client's, sent with the user agent `scenescout-preflight`. A protection that judges the client can treat it differently from the browser a check drives. If `check` gets through where the preflight is challenged, or the other way round, the protection is judging the client.
- **It does not sign in.** It reads a profile's dates and sends nothing from it. A session the server has ended early still reads as unexpired.
- **It does not follow the model API's redirects.** The key is not sent to another address, so an API that redirects fails with exit 17, and the line names where it pointed. `scenescout ci` follows no redirect either. The app's own redirects are followed, up to 20; more than that is a redirect loop and fails with exit 14.
- **It does not judge the key's model.** An API that does not list models (404 or 405) is reported as reachable with the key unchecked, and a 429 is reported as reachable but rate-limited. The request carries the key and nothing of the app, and it spends no tokens.
- **Node's own trust store and settings apply.** A certificate signed by your own authority needs `NODE_EXTRA_CA_CERTS` for this check. Proxy settings are not read yet, so behind a proxy it reports what a run that bypasses the proxy would see.

The [check action](Configuration-reference.md#action-check) runs it with `preflight: "true"`, using the action's `url` and `storage-state`, before it installs the browser. Every option is in the [configuration reference](Configuration-reference.md#scenescout-preflight).

## Hosts each command needs

| What runs | Hosts it reaches | When |
|---|---|---|
| Any browser run: `scenescout <url>`, `check`, `ci`, `login`, and an agent's session over MCP | The app under test, and every host its pages load from: fonts, scripts, images, analytics, a sign-in provider | Every run. A third-party host the runner cannot reach makes a page's requests fail, and `check` reports them as findings (`request-failed`, `console-error`) |
| `npx scenescout` | The npm registry (`registry.npmjs.org`, or the registry your npm config names) | The first time a version is fetched; npm caches it |
| The [check action](Configuration-reference.md#action-check) and the [ci action](Configuration-reference.md#action-ci) | The npm registry, for `npm view` (the release's integrity) and `npm ci` (its locked dependencies). `actions/setup-node`'s download, only when the runner has no Node 20 or newer. GitHub's Actions cache, artifact and code-scanning services, for the browser cache, the results and `upload-sarif` | Every job, before the check runs |
| The browser download: `scenescout install --browser-only`, the first run, and an attach that finds no build | Playwright's download servers: `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`, or the mirror `PLAYWRIGHT_DOWNLOAD_HOST` names | Once per build; the headless Chromium build is about 200 MB. An attach downloads only when `SCENESCOUT_BROWSER_DOWNLOAD` allows it, and in CI only when it is `on` |
| The browser's system libraries (the actions' `install-deps`, `playwright install-deps`) | The Linux distribution's package mirrors, through `apt` with `sudo` | Each job on Linux, unless `install-deps` is `"false"` |
| `scenescout ci`, and `scenescout preflight --model-api` | `api.anthropic.com` or `api.openai.com`, or the endpoint `--base-url` names | Every call of the run; one request for the preflight |
| The dedup judge over MCP | The provider whose key is in the server's environment, or `SCENESCOUT_DEDUP_BASE_URL` | Only with `SCENESCOUT_DEDUP=judge` |
| `scenescout export --to github`, the ticket tools, `/scenescout qa` | `api.github.com`, or `GITHUB_API_URL` for GitHub Enterprise Server | On each export, ticket call or comment |
| `scenescout export --to jira` and the ticket tools for Jira | The Jira site `--jira-url` or `JIRA_BASE_URL` names | On each export or ticket call |

SceneScout has no telemetry and no update check, so nothing else is reached. The live view listens on `127.0.0.1` only.

## When a host cannot be reached

| Host | What you see |
|---|---|
| The app | `check` and the first run exit 2 ("could not run"); `ci` stops with `could-not-start`. The preflight names the cause (exit 10 to 15) |
| A host the app's pages load from | Findings on the pages that use it (`request-failed`, `console-error`), not a failed run |
| The npm registry | `npx` or the action's "Get SceneScout" step fails before SceneScout starts |
| Playwright's download servers | `scenescout install` prints `Browser download failed` with the command to retry; an attach refuses with the build it needs |
| Package mirrors | The action's step that installs the browser's system libraries fails; the browser then cannot start |
| The model's API | `ci` exits 2 when the API fails; the preflight exits 17 |
| GitHub or Jira | `export` exits 2 and lists what it filed before it stopped |

## Removing downloads

- **The browser.** The [check](Configuration-reference.md#action-check) and [ci](Configuration-reference.md#action-ci) actions cache the browser build under `PLAYWRIGHT_BROWSERS_PATH` and download it only on a cache miss. They save it even when the check fails. Elsewhere, keep Playwright's cache folder between jobs, or point `PLAYWRIGHT_BROWSERS_PATH` at a folder you keep.
- **The browser and its libraries together.** The Playwright container image, `mcr.microsoft.com/playwright:v1.63.0-noble`, already has the system libraries and the browsers of that Playwright version. Set `install-deps: "false"` on the actions in a job that runs in it. [Other CI systems](../ci.md#other-ci-systems) shows it in GitLab CI and CircleCI.
- **A mirror for the browser.** `PLAYWRIGHT_DOWNLOAD_HOST`, or `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST`, `PLAYWRIGHT_FIREFOX_DOWNLOAD_HOST` and `PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST` for one browser, sends Playwright's installer to a mirror your organisation runs. SceneScout passes its environment to the installer unchanged.
- **A mirror for npm.** npm reads its registry from `.npmrc` (`registry=https://npm.example.com/`) or `npm config set registry`. The actions' `npm view` and `npm ci` use the same configuration.
- **No download at all.** Set `SCENESCOUT_BROWSER_DOWNLOAD=off` so an attach never fetches a build. Then install the build with `scenescout install --browser-only` from a machine that may reach the download servers, and copy Playwright's cache folder across.

## On a self-hosted runner inside your network

When the app is only reachable inside a private network (a staging site behind a VPN, an internal hostname), run the job on a runner inside that network, with `runs-on: [self-hosted]` and the labels of your runner, instead of exposing the app to GitHub's hosted runners.

1. **Start with the preflight**, so a runner that cannot reach the app fails in seconds with the cause:

   ```yaml
   - uses: brunoboto96/SceneScout@v3
     with:
       url: https://staging.internal.example.com
       storage-state: .auth/admin.json
       preflight: "true"
   ```

2. **Open only what the job needs.** For `check`: the app and the hosts its pages load from, the npm registry or your mirror, the browser download or a cache, and GitHub's Actions services. For `ci`, the model's API as well. `check` needs no model API at all.
3. **Keep the browser on the runner.** A persistent runner keeps Playwright's cache folder between jobs, so the browser is downloaded once. A runner that already has the system libraries can set `install-deps: "false"`, so no package mirror is needed.
4. **Trust your own certificate authority.** The browser and Node each have their own trust store: add your authority to the runner's system store for the browser, and set `NODE_EXTRA_CA_CERTS` for SceneScout's own requests (the preflight, the model's API, GitHub and Jira).
5. **Decide what may leave.** A team that wants nothing sent to a model or a tracker commits `{"egress": "none"}` in `.scenescout/config.json` ([the `egress` setting](What-leaves-the-machine.md#the-egress-setting)). `check` is unaffected: it sends nothing off the machine but its report to the CI provider.

Keep a self-hosted runner for this job only: it should not also serve production traffic or hold production secrets. [Keys and forks in CI](Safety-model.md#keys-and-forks-in-ci) covers which events may use which keys.
