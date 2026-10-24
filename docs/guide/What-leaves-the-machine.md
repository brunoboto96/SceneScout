# What leaves the machine

> **Who this is for:** anyone who has to say where an app's data goes when SceneScout tests it: a security review, a data-protection question, a team setting the rules for its CI.
>
> **What you will be able to do:** name every path by which SceneScout sends data off the machine, say what each one carries and to whom, and turn each one off.

SceneScout has no telemetry and no update check. The browser it drives talks to the app under test, as any browser does; that traffic is the test itself and is governed by the [write mode](Safety-model.md), not by this page. Everything else that leaves the machine is listed below.

## Every path

| Path | What leaves | To whom | How to turn it off |
|---|---|---|---|
| **The agent's model** (an interactive run, over MCP) | What the `scout_*` tools return to the agent: the page's text and controls in each snapshot, unredacted; API response bodies `scout_request` reads (the first 2,000 characters, up to 8,000 when the agent asks for a part); a finding's picture, which is returned into the conversation by default (`evidence` `inline`); a picture of the page from `scout_screenshot`; and the cards' pictures when `scout_cards` is asked for them `inline` | The coding agent you use, which sends what it reads to its own model provider. SceneScout does not choose that provider | Pictures: `evidence` `file` or `off`, in an attach, `SCENESCOUT_EVIDENCE` or the [config file](Configuration-reference.md#the-config-file); the config's `egress` `none` holds back every picture. Page text cannot be held back by SceneScout: it is what the agent tests with. Use an agent whose model you are allowed to send the app's data to, or a local one |
| **The dedup judge** | Two findings at a time: their titles, categories, evidence and the page's path | Over MCP: the model provider whose key is in the server's environment, or `SCENESCOUT_DEDUP_BASE_URL`. In `scenescout ci`: the run's own model | Off by default over MCP (`SCENESCOUT_DEDUP=judge` turns it on, and an agent cannot). On by default in `ci`: `--dedup rule` turns it off. The config's `dedup: "rule"` turns it off everywhere |
| **`scenescout ci`** | The run's conversation: snapshots, response bodies and tool results as text. No pictures: its model loop is text only. With OpenAI, each call is sent with `store: false`, so the provider keeps no conversation between calls | The Anthropic or OpenAI API, or the endpoint `--base-url` names (one that speaks the same API, such as a gateway or a local model on `127.0.0.1`) | Do not run `ci`; or set the config's `egress` to `none` |
| **`scenescout export`** and the ticket tools | Each finding's title and description, severity, category, page and address, the steps that led to it, its evidence, and any acceptance criterion it fails ([what an issue holds](Ways-to-use-it.md#what-an-issue-holds)). GitHub issues name the pictures but carry none; Jira issues have the picture and recorded frames attached. A dry run, `scout_ticket_preview` and `scout_ticket_status` send no findings, but they read the tracker with its token | GitHub's API (or `GITHUB_API_URL`), or the Jira site `JIRA_BASE_URL` names | Do not export; `scout_ticket_file` files only on your yes in its form. The config's `egress` `none` or `model-only` refuses all of them, dry runs included |
| **`/scenescout qa`** | A reply on the pull request with the run's findings, and, for `show` and `compare`, the pictures, pushed to the repository's `scenescout-shots` branch | GitHub: the same repository | Remove the workflow. The config's `egress` `none` or `model-only` on the default branch stops the gate from starting a run or a check (below) |
| **CI artifacts and summaries** | `check`'s and `ci`'s reports, JSON, SARIF and pictures as a workflow artifact; SARIF to code scanning when asked; the summary on the job's page | The CI provider that runs the job | The actions' `upload-artifact: "false"` and `upload-sarif: "false"`. The job summary is written whenever the job provides one |
| **npm and `npx`** | A request for the package | The npm registry, the first time `npx` fetches a version (npm caches it) | Install the package from a mirror your organisation runs, or use the desktop extension, which fetches nothing from npm |
| **The browser download** | A request for a browser build | Playwright's download servers, once per build | `SCENESCOUT_BROWSER_DOWNLOAD=off`, then install the build yourself with `scenescout install --browser-only` from a machine that may reach them |
| **The live view** | Nothing leaves the machine: it listens on `127.0.0.1` only, refuses a request whose Host header is not loopback, and needs a token on every path | Your own browser | `SCENESCOUT_LIVE=off` |

Saved pages (`report.html`, a replay) carry a Content-Security-Policy and load nothing from the network. The [website](https://brunoboto96.github.io/SceneScout/) serves its fonts from its own folder.

What each way of installing touches on your machine as well (ports, processes, files) is in [What it reaches](Ways-to-use-it.md#what-it-reaches).

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

Each refusal names the file and the setting, and says what was not run. `ci` and `export` exit 2. Like every key in the file, an argument or the environment can only ask for less: there is no variable or option that loosens `egress`, and a project's own file can only lower it. No preset sets it, so `"preset": "strict"` alone changes no path on this page.

`/scenescout qa` reads the setting from `.scenescout/config.json` on the repository's default branch, never from the pull request, which could loosen it. Its gate job needs `contents: read` to read the file (the [template](../../examples/workflows/scenescout-qa.yml) asks for it). With `egress` `none` or `model-only`, or a file the gate cannot read, the gate starts nothing and its only reply is one line saying why. GitHub answers a token that may not read a private repository's files as if the file were not there, so when the config is missing the gate also reads the repository's top folder; if it cannot, it starts nothing and says to give the gate job `contents: read`. A workflow written before this needs that line added.

### What `egress` does not cover

- **The coding agent's own model.** Over MCP, SceneScout answers the agent's tool calls, and the agent sends what it reads to its model. SceneScout cannot see or stop that, under any setting. `none` keeps pictures and the judge out of it; the page text and response bodies the agent works from still reach the agent. To keep an app's data from a hosted model, use an agent that runs a model you are allowed to use with it.
- **The app under test.** The browser's requests to the site are the test. The write mode decides which of them go through.
- **Downloads.** npm, and Playwright's download servers for a browser build, as in the table.
- **What a workflow does with the files.** The actions' artifact and SARIF uploads, and the job summary, are steps of the workflow, turned off by its inputs. `egress` `none` stops `ci` itself, so a `ci` job has nothing to upload; a `check` job, which sends nothing to any model, still uploads its own report unless `upload-artifact` is `"false"`.
