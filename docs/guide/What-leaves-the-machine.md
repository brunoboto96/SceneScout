# What leaves the machine

> **Who this is for:** anyone who has to say where an app's data goes when SceneScout tests it: a security review, a data-protection question, a team setting the rules for its CI.
>
> **What you will be able to do:** name every path by which SceneScout sends data off the machine, say what each one carries and to whom, and turn each one off.

SceneScout has no telemetry and no update check. The browser it drives talks to the app under test, as any browser does; that traffic is the test itself and is governed by the [write mode](Safety-model.md), and by default a page may also reach every other host it loads from (a CDN, an analytics script, a sign-in provider). The config's `browserHosts` limits that to the app's host and a list ([below](#the-hosts-the-browser-may-reach)). Everything else that leaves the machine is listed below.

## Every path

| Path | What leaves | To whom | How to turn it off |
|---|---|---|---|
| **The agent's model** (an interactive run, over MCP) | What the `scout_*` tools return to the agent: the page's text and controls in each snapshot, unredacted unless the config's `redactPageText` is `pii` (below); API response bodies `scout_request` reads (the first 2,000 characters, up to 8,000 when the agent asks for a part); a finding's picture, which is returned into the conversation by default (`evidence` `inline`); a picture of the page from `scout_screenshot`; and the cards' pictures when `scout_cards` is asked for them `inline` | The coding agent you use, which sends what it reads to its own model provider. SceneScout does not choose that provider | Pictures: `evidence` `file` or `off`, in an attach, `SCENESCOUT_EVIDENCE` or the [config file](Configuration-reference.md#the-config-file); the config's `egress` `none` holds back every picture. Page text cannot be held back by SceneScout: it is what the agent tests with. The config's `redactPageText: "pii"` masks email addresses, phone numbers and card numbers in it ([below](#masking-personal-data-in-page-text)). Use an agent whose model you are allowed to send the app's data to, or a local one |
| **The dedup judge** | Two findings at a time: their titles, categories, evidence and the page's path | Over MCP: the model provider whose key is in the server's environment, or `SCENESCOUT_DEDUP_BASE_URL`. In `scenescout ci`: the run's own model | Off by default over MCP (`SCENESCOUT_DEDUP=judge` turns it on, and an agent cannot). On by default in `ci`: `--dedup rule` turns it off. The config's `dedup: "rule"` turns it off everywhere |
| **`scenescout ci`** | The run's conversation: snapshots, response bodies and tool results as text. No pictures: its model loop is text only. With OpenAI and Azure OpenAI, each call is sent with `store: false`, so the provider keeps no conversation between calls | The Anthropic or OpenAI API, or with `--provider` the cloud you name: Amazon Bedrock in your region, Google Vertex AI in your project, or your Azure OpenAI resource; or the endpoint `--base-url` names (one that speaks the same API, such as a gateway or a local model on `127.0.0.1`). The cloud's own data terms apply there | Do not run `ci`; or set the config's `egress` to `none` |
| **An allowlist header** (`SCENESCOUT_APP_HEADER`) | The header's name and value, on every request to the app's own origin, and on the preflight's request for its start page | The app under test, and whatever the operator's firewall in front of it reads it. Never another host, and not across a redirect | Leave `SCENESCOUT_APP_HEADER` unset (the default) ([Network requirements](Network-requirements.md#an-allowlist-header-for-a-firewall)) |
| **A proxy** (`HTTPS_PROXY`, `HTTP_PROXY`, `SCENESCOUT_PROXY`) | Nothing more than without one: the browser's traffic and SceneScout's own requests take the route through it. An https request is tunnelled, so the proxy sees its host, not its content; a plain-http request is readable to it | The proxy the operator names | Unset the variables, or `SCENESCOUT_PROXY=off` ([Network requirements](Network-requirements.md#behind-a-proxy)) |
| **`scenescout preflight --model-api`** | One request for the model's list of models, with the key. Nothing of the app | The Anthropic or OpenAI API, or the endpoint `--base-url` names | Leave out `--model-api`; the config's `egress` `none` refuses it |
| **`scenescout export`** and the ticket tools | Each finding's title and description, severity, category, page and address, the steps that led to it, its evidence, and any acceptance criterion it fails ([what an issue holds](Ways-to-use-it.md#what-an-issue-holds)). GitHub issues name the pictures but carry none; Jira issues have the picture and recorded frames attached. A dry run, `scout_ticket_preview` and `scout_ticket_status` send no findings, but they read the tracker with its token | GitHub's API (or `GITHUB_API_URL`), or the Jira site `JIRA_BASE_URL` names | Do not export; `scout_ticket_file` files only on your yes in its form. The config's `egress` `none` or `model-only` refuses all of them, dry runs included |
| **`/scenescout qa`** | A reply on the pull request with the run's findings, and, for `show` and `compare`, the pictures, pushed to the repository's `scenescout-shots` branch | GitHub: the same repository | Remove the workflow. The config's `egress` `none` or `model-only` on the default branch stops the gate from starting a run or a check (below) |
| **CI artifacts and summaries** | `check`'s and `ci`'s reports, JSON, SARIF and pictures as a workflow artifact; SARIF to code scanning when asked; the summary on the job's page | The CI provider that runs the job | The actions' `upload-artifact: "false"` and `upload-sarif: "false"`. The job summary is written whenever the job provides one |
| **npm and `npx`** | A request for the package | The npm registry, the first time `npx` fetches a version (npm caches it) | Install the package from a mirror your organisation runs, or use the desktop extension, which fetches nothing from npm |
| **The browser download** | A request for a browser build | Playwright's download servers, once per build | `SCENESCOUT_BROWSER_DOWNLOAD=off`, then install the build yourself with `scenescout install --browser-only` from a machine that may reach them |
| **The live view** | Nothing leaves the machine: it listens on `127.0.0.1` only, refuses a request whose Host header is not loopback, and needs a token on every path | Your own browser | `SCENESCOUT_LIVE=off` |

Saved pages (`report.html`, a replay) carry a Content-Security-Policy and load nothing from the network. The [website](https://brunoboto96.github.io/SceneScout/) serves its fonts from its own folder.

What each way of installing touches on your machine as well (ports, processes, files) is in [What it reaches](Ways-to-use-it.md#what-it-reaches). Every host each command must reach, how to check a runner reaches them, and how caches and mirrors remove some, is in [Network requirements](Network-requirements.md).

## The `egress` setting

A team sets what SceneScout itself may send off the machine with `egress` in the [config file](Configuration-reference.md#the-config-file), committed as `.scenescout/config.json`:

```json
{ "egress": "none" }
```

| `egress` | What SceneScout refuses |
|---|---|
| `all` (the default, and what no file means) | Nothing: every path above works as described |
| `model-only` | Everything but the model: `scenescout export`, `scout_ticket_preview`, `scout_ticket_file` and `scout_ticket_status`'s reads, and `/scenescout qa`. `scenescout ci` and the dedup judge still run |
| `none` | All of those, and `scenescout ci`, which stops before it reads a key. Over MCP the dedup judge is off and no picture of the app is returned into the conversation: a finding's picture is kept to a file, as if `dedup` were `rule` and `evidence` were `file`, and `scout_screenshot` and `scout_cards` with `pictures: "inline"` are refused |

Each refusal names the file and the setting, and says what was not run. `ci` and `export` exit 2. Like every key in the file, an argument or the environment can only ask for less: there is no variable or option that loosens `egress`, and a project's own file can only lower it. No preset sets it, so `"preset": "strict"` alone changes no path on this page; it does limit the browser's own requests (below).

`/scenescout qa` reads the setting from `.scenescout/config.json` on the repository's default branch, never from the pull request, which could loosen it. Its gate job needs `contents: read` to read the file (the [template](../../examples/workflows/scenescout-qa.yml) asks for it). With `egress` `none` or `model-only`, or a file the gate cannot read, the gate starts nothing and its only reply is one line saying why. GitHub answers a token that may not read a private repository's files as if the file were not there, so when the config is missing the gate also reads the repository's top folder; if it cannot, or GitHub refuses the token for a missing permission, it starts nothing and its reply names the job and the workflow file that need `contents: read` under `permissions:`. A workflow written before this needs that line added. The gate reads the file's `hosts` list there too: a preview URL, or a `compare` run's base URL, on a host the list does not name starts no run, and the reply names that host ([Configuration reference](Configuration-reference.md#the-config-file)).

### What `egress` does not cover

- **The coding agent's own model.** Over MCP, SceneScout answers the agent's tool calls, and the agent sends what it reads to its model. SceneScout cannot see or stop that, under any setting. `none` keeps pictures and the judge out of it; the page text and response bodies the agent works from still reach the agent. To keep an app's data from a hosted model, use an agent that runs a model you are allowed to use with it.
- **The app under test.** The browser's requests to the site are the test. The write mode decides which of them go through.
- **Downloads.** npm, and Playwright's download servers for a browser build, as in the table.
- **What a workflow does with the files.** The actions' artifact and SARIF uploads, and the job summary, are steps of the workflow, turned off by its inputs. `egress` `none` stops `ci` itself, so a `ci` job has nothing to upload; a `check` job, which sends nothing to any model, still uploads its own report unless `upload-artifact` is `"false"`.

## Masking personal data in page text

A team that may send an app's pages to the agent's model, but not the personal data on them, sets `redactPageText` in the [config file](Configuration-reference.md#the-config-file):

```json
{ "redactPageText": "pii" }
```

With `pii`, everything the `scout_*` tools return to the agent passes through one mask on its way out: the snapshot's text and element names, page titles, API response bodies from `scout_request`, the network and console lines, error messages, and the text of findings and cards. Three kinds of personal data are replaced by a marker that names what was there:

| On the page | What the agent reads |
|---|---|
| An email address (its @ written out or percent-encoded too) | `[email redacted]` |
| A phone number written after a word for one (`Phone: +44 20 7946 0958`, `Tel. 030 123 45 67`) | `Phone: [phone redacted]` |
| A card number a card network issues (its prefix and length) that passes the Luhn check | `[card number redacted]` |

These are the detectors and the markers SceneScout already uses for what it stores and publishes, so a finding's title the agent copies from masked text is the title the store keeps, and the two are counted as one finding. The markers keep the page's structure: the agent still sees that a row has an address, a phone and a card, and where.

`off`, the default and what no file means, returns the page as it is. Only the file sets it: no argument or variable names it, and a project's own file can turn it on but not off. One server that has sessions open on two projects masks every call while either project's file sets `pii`, since a result such as the session list can show both projects' pages. When it is on, the attach's `🔒 CONFIG` line, and the `Config:` line of `check`, `ci` and `scenescout policy explain`, say so. No preset sets it.

What it does not do:

- **It can hide a bug that is about the content.** An email shown on the wrong account, a phone number formatted wrongly, a card number shown in full where it should be masked, or one person's address on another person's page: the agent reads only the marker, so it cannot tell whose address it was or how it was written. The engine's own oracles (a page that contradicts the server, an echoed value, a secret in a page) read the page before it is masked, so they still find what they find; the agent's own judgement of the content does not. Leave it `off` when testing such a feature.
- **It does not mask pictures.** A finding's picture, `scout_screenshot` and the cards' pictures show the page as it is, except the secret fields the engine paints over. Keep pictures out of the conversation with `evidence` `file` or `off`, or `egress` `none`.
- **It masks what SceneScout returns, not what the agent reads elsewhere.** An agent that reads the app's database, its source, its logs or the page through another tool sends that to its model unmasked.
- **It masks only these three kinds.** Names, postal addresses, dates of birth, account numbers and other identifiers pass as written, and a phone number with no word for a phone before it is not recognised (a bare `+44 20 7946 0958` reads the same as an amount or an id).
- **A value the agent copies back is the marker.** An address in a link, or an option whose value is an address, cannot be followed or chosen by its text once masked, and a run plan's `text=` target or a saved flow's expected text written from masked text matches nothing on the page. The agent acts by element refs, which are not masked.
- **Reserved example addresses stay** (`@example.com`, `.test`, `.invalid`, `localhost`), as they do in reports.

## The hosts the browser may reach

The page SceneScout drives sends what any page sends: its own requests to the app, and requests to every other host it loads from. Those reach the third party as they would from a person's browser, with the page's address as the referrer. `browserHosts` in the [config file](Configuration-reference.md#the-config-file) names the only hosts the browser may reach besides the app's own:

```json
{ "browserHosts": ["cdn.example.net"] }
```

With a list set, a request to any other host is refused before it leaves the machine, in every write mode: a page load and the later hops of its redirects, a script, style, image, frame or download, fetch and XHR, and a WebSocket. `[]` is the app's host alone, and `"preset": "strict"` sets that. Shared workers, WebRTC peer connections and WebTransport, whose traffic no route handler sees, are taken from the page. A refused page load leaves the page where it was, and an attach whose start address redirects off the list is not attached. Each refusal is reported in a `BROWSER-HOSTS blocked` notice naming the host and path, never the query, so a tester notes what it stopped as untested rather than filing it as a bug. `SCENESCOUT_BROWSER_HOSTS` sets a list without a file, or narrows the file's; `scenescout policy explain` and `scenescout config explain` show it.

What it does not cover: in Firefox and WebKit, a redirect of a script's request or a frame's load is followed by the browser without SceneScout seeing the later hop (a top-level page load's redirect is judged there, since SceneScout sends that load itself). WebTransport is taken from the page but not from a worker the page starts. A sign-in window (`scout_login`, `scenescout login`) is not held by it, since signing in often passes through another host. A host's name may still be looked up, and a connection opened to it, when a page asks the browser to connect early (`<link rel="preconnect">`); no request is sent on it.
