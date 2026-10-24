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
- **Node's own trust store applies.** A certificate signed by your own authority needs `NODE_EXTRA_CA_CERTS` for this check. It goes through the proxy the environment names ([Behind a proxy](#behind-a-proxy)), and its first line says which. With an [allowlist header](#an-allowlist-header-for-a-firewall) set, its request for the start page carries it, and its first lines name the header but never its value.

The [check action](Configuration-reference.md#action-check) runs it with `preflight: "true"`, using the action's `url` and `storage-state`, before it installs the browser. Every option is in the [configuration reference](Configuration-reference.md#scenescout-preflight).

## Hosts each command needs

| What runs | Hosts it reaches | When |
|---|---|---|
| Any browser run: `scenescout <url>`, `check`, `ci`, `login`, and an agent's session over MCP | The app under test, and every host its pages load from: fonts, scripts, images, analytics, a sign-in provider | Every run. A third-party host the runner cannot reach makes a page's requests fail, and `check` lists them as network failures, not findings |
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
| A host the app's pages load from | Not findings: `check` lists it under "Network failures" as another host's, and its exit code is unchanged ([below](#failures-on-the-network-are-not-the-apps)) |
| The npm registry | `npx` or the action's "Get SceneScout" step fails before SceneScout starts |
| Playwright's download servers | `scenescout install` prints `Browser download failed` with the command to retry; an attach refuses with the build it needs |
| Package mirrors | The action's step that installs the browser's system libraries fails; the browser then cannot start |
| The model's API | `ci` exits 2 when the API fails; the preflight exits 17 |
| GitHub or Jira | `export` exits 2 and lists what it filed before it stopped |

## Failures on the network are not the app's

A request that gets no HTTP answer at all failed on the network: the name did not resolve, the connection was refused or dropped, nothing answered in time, or the TLS handshake failed. SceneScout reads which from the browser's own error (Chromium's `net::ERR_NAME_NOT_RESOLVED`, Firefox's `NS_ERROR_UNKNOWN_HOST`, WebKit's sentences). An HTTP status, however bad, is an answer from the server and is never counted as one, and neither is a request the page or the write policy cancelled, a redirect loop, or a page that took longer than the page-load limit.

`scenescout check` files none of them as issues. Each is listed once under "Network failures" in `report.md` and under `network` in `check.json`, with its cause, the browser's code and the routes it was seen on:

- **One reaching the app's site** (a route that did not load, or a request to the app's host on any port or to a sibling subdomain such as `api.example.com` beside `app.example.com`) leaves what it kept from loading unmeasured. When it is at the gate's severity, counted as the issue it replaces (high for a route that did not load, medium for a request), a check whose gate otherwise passed exits **3**, and its verdict line starts **NETWORK FAILURES**. Below the gate's severity, or with `--fail-on never`, it is listed and the exit code is unchanged. A check that failed its gate still exits 1, since running it again would not pass it. The [check action](Configuration-reference.md#action-check) ends its step with 3 and an annotation saying so.
- **One reaching another host** (a CDN, a font, analytics the runner cannot reach) is the environment's: listed, and the exit code is unchanged. The browser's console line repeating the same failure ("Failed to load resource: net::ERR_NAME_NOT_RESOLVED") is not counted a second time.

The first page of a run names the cause too: a name that does not resolve, a certificate the browser refuses or a network timeout says so, instead of asking whether the app is running.

**One bounded retry.** With `SCENESCOUT_RETRY_NETWORK=on`, a page load that failed on the network is tried once more, after 2 seconds, within what is left of the load's own limit. It is off by default, because a retry would also hide a server that drops connections. Each retried load is listed under "Page loads retried" in the report, with the code it was retried after, and in `check.json` under `loadRetries`; a load that failed again says it was retried. A request a page makes (an API call, an image) is not retried. A load the machine refused a socket for (`net::ERR_NO_BUFFER_SPACE`) is always retried once, as before.

`scenescout ci` names the cause of a failed request to the model's API (for example `fetch failed: ECONNREFUSED`) rather than only "fetch failed".

## Behind a proxy

SceneScout reads the standard variables, `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (lower case first, as curl and Node read them), or `SCENESCOUT_PROXY`, which replaces them for SceneScout alone. `SCENESCOUT_PROXY=off` reaches everything directly whatever the standard variables say.

- **The browser** gets the proxy for the app's scheme on each session: `HTTPS_PROXY` for an https app (falling back to `HTTP_PROXY`), `HTTP_PROXY` for an http app. It uses that one proxy for every host its pages load from, with `NO_PROXY`'s entries as the hosts it reaches directly. A browser never sends its own machine's addresses (`localhost`, `127.0.0.1`) through a proxy.
- **SceneScout's own requests**: the preflight, the model's API for `ci` and the dedup judge, GitHub and Jira. They go through the proxy whenever one is set, with `NO_PROXY` honoured, by undici's `EnvHttpProxyAgent`. With no proxy set nothing changes.
- **Credentials** in the proxy URL (`http://user:password@proxy:3128`) are passed to the browser and the HTTP client and never printed: `scenescout preflight` names the proxy it used without them.
- **What may be sent is unchanged.** The [`egress` setting](What-leaves-the-machine.md#the-egress-setting) is applied before any request, and a proxy only changes the route a permitted request takes.
- **Browser downloads** are Playwright's: its installer reads `HTTPS_PROXY` itself.

## An allowlist header for a firewall

A team whose web application firewall lets CI traffic through by a shared header sets `SCENESCOUT_APP_HEADER` to `Name: value`, from a secret:

```yaml
      - uses: brunoboto96/SceneScout@v3
        with:
          url: https://staging.example.com
        env:
          SCENESCOUT_APP_HEADER: ${{ secrets.WAF_ALLOW_HEADER }}   # e.g. "X-CI-Allow: <token>"
```

- **Only the app's own origin gets it**, the scheme, host and port the run attached to: every page, script, image and API call there. No other host does, not a font, a CDN, a sign-in provider, the model's API or a tracker.
- **A redirect does not carry it away.** SceneScout sends each of the app's requests itself and hands the answer to the browser. A redirect within the app is followed with the header: a page load by a page that loads the next address itself, any other request by SceneScout. A redirect to another origin, or a 307 or 308 that would resend a body, is followed by the browser without the header. An event stream (`EventSource`) and a WebSocket go as the page sent them, without it. Each request is handed to the page once its answer has been read whole, so a streamed response arrives all at once, and each may take as long as the page-load limit (`SCENESCOUT_NAV_TIMEOUT_MS`); past it, the request fails as the app's slowness, not as a network failure. Each carries the cookies the browser would send: a request another site's page started (told by its `Referer`, so one sent with none carries every cookie for the address) goes without a `SameSite=Strict` cookie, and without a `Lax` one unless it is a top-level page load.
- **A file is the browser's.** Before a page load, SceneScout asks the app with a `HEAD` request (carrying the header, so the app sees one extra request per page load) whether the address, after any redirects within the app, answers with a page or a file. A file (an attachment, or anything but HTML: a PDF, a CSV) is handed back to the browser and fetched without the header, so a download or a file shown as it is behaves as it does with no header, and is never read whole first. A firewall that requires the header on file downloads too will block those. The `HEAD` carries the cookies the browser sends with the load, and on each redirect within the app the cookies the earlier hops set. An app that does not answer `HEAD` (405 or 501), or does not send its headers within 5 seconds for all its redirects together, has its page loads sent with the header as any other request, so a file it serves that way arrives whole before the browser sees it. Many frameworks (Express and other Node servers, Rails, Django, Flask) answer a `HEAD` by running the page's `GET` handler and dropping its body. On those, a page load whose address does something (a one-time sign-in link, a sign-out address, a `GET` that deletes) runs twice with the header set; `SCENESCOUT_REFUSE_DESTRUCTIVE_GETS` refuses the ones whose address names a destructive command, before any `HEAD` is sent. A Node server sends a `HEAD`'s headers only when that handler ends, so a file it streams for more than 5 seconds goes the slow way above.
- **Chromium and Firefox only.** WebKit cannot be handed a redirect that way, so an attach on WebKit with the header set stops with a message. In Chromium, a page handed over that way has no address of its own, so the session grants the app's origin, and no other, the Local Network Access permission; without it Chromium would block the app's requests to private addresses (another service on the staging network, an app on `localhost`).
- **Never printed.** No line names its value, and `ci` redacts it from every line it writes. A name that would change who the request is or how the write policy reads it (`Cookie`, `Authorization`, `Host`, `Origin`, `X-HTTP-Method-Override`, any `Sec-` or `Proxy-` header) is refused.
- **The preflight sends it too**, on its request for the start page, and follows redirects itself so that only the app's origin gets it.

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
