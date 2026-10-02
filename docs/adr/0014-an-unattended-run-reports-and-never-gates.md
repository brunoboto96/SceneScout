# 14. An unattended run reports and never gates

Status: accepted. The "one agent, not lanes" point is revisited by [ADR 20](0020-an-unattended-run-may-split-into-lanes-that-share-its-caps.md), which adds `--lanes`.

## Context

Until now an exploratory run needed a coding agent with a person behind it:
Claude Code, Cursor or another MCP client, driven by someone who asked for the
run. CI had only `scenescout check`, which involves no model (ADR 11) and so
finds only what a page load shows. Teams asked for the exploratory side in CI
as well: a scheduled or per-merge run that clicks through the app, files what
it finds and leaves the report, with no person present.

That needs a model reached through its API, an agent loop to drive the tools,
and answers to questions the interactive run never had to ask: what the run
may spend, what ends it, what it may write to the target, where the API key
may appear, and what its exit code means.

## Decision

- **`scenescout ci <url>` reports and never gates.** Exit 0 when the run ran
  and the report is written, whether the model finished or a cap ended it;
  exit 2 when it could not run or could not finish for a reason the workflow
  must fix (no key, a key the API refused, an app that never answered). No
  finding, at any severity, changes the exit code. Two runs of the same app
  explore differently and find different things, so gating on one would fail
  or pass a pull request by chance, and a gate that does that gets switched
  off. ADR 11's deterministic check stays the gate; a flow worth gating on is
  saved and replayed by it (ADR 12).
- **The model drives the MCP server as a client, in a child process.** The run
  starts the same server every coding agent uses and talks to it over stdio.
  The model therefore gets exactly an agent's tools, schemas, watchdog and
  network-level write policy (ADR 2), and the server, which keeps module-wide
  state, needs no second way to start. The alternative, calling the tool
  handlers in-process, would have meant restructuring the server for one
  caller. The child's environment has no API key in it.
- **The method is the system prompt.** The model is given the same text as
  `scout_playbook`, followed by the rules of an unattended run: nobody to ask,
  the session is attached already, the level to report at, and to end with a
  reply that calls no tool.
- **An allowlist of tools.** The model gets the tools a single agent uses to
  explore, find and report. It does not get `scout_attach`, `scout_close` or
  `scout_session` (the run attaches once, to the URL and in the mode it was
  given, and closes itself), `scout_playbook` (already the prompt),
  `scout_screenshot` (the loop is text-only), `scout_resolve` (re-tests go
  through `scout_verify`) or the lane tools. A tool added to the server later
  reaches an unattended model only when someone adds it to the list.
- **One agent, not lanes.** A parallel run splits the app between lanes and
  folds their reports (ADR 10); that needs a planner and several model
  conversations at once, multiplying the tokens a run spends before anyone has
  measured whether it finds more in CI. A single loop is enough to measure the
  exploratory run's value in CI, and the lane report and calibration remain
  available to a later version that uses lanes.
- **Two providers, by which key is set.** The Anthropic Messages API and the
  OpenAI Responses API, reached with plain `fetch` (neither SDK is a
  dependency), with a timeout on every call and at most three retries with
  capped, jittered backoff that honours `retry-after`. A status no retry can
  change (401, 400) is not retried. With both keys set the provider is never
  guessed: `--provider` must name it. `--base-url` reaches other endpoints
  that implement the same API, over https or to this machine only.
- **Keys come from the environment and go nowhere.** There is no option or
  action input for a key. Every line printed or written is passed through a
  redaction of the key values and of key-shaped strings, including an API
  error that echoes the key back, and the suite checks that no key reaches the
  output or the files.
- **Caps, all overridable: 40 turns, 1,500,000 tokens, 20 minutes.** Checked
  before each model call. No model call, retry, backoff wait or tool call runs
  past the time cap: each gets only the time left, and a tool call reached
  after it is answered as not run, as is any beyond 16 from one reply. An
  attempt at a model call slower than three minutes is retried while time
  remains; the cap arriving during a call or a backoff ends the run as `time`,
  not as a provider failure. The first cap reached ends the exploration
  cleanly; the report is then written and the browser closed within a shared
  three-minute budget, so the command ends at most about four minutes after
  the time cap, and the summary and `ci.json` name the cap. A report that could not
  meet its level's contract is generated with its gap ledger, which is what a
  forced report does.
- **Read-only by default; `destructive` only with a second option.** The
  defaults follow ADR 12's rule: they serve unconfigured and agent-driven use,
  so an unconfigured run does the least harm on an app it knows nothing about,
  and what CI may do is the developer's decision. `observe` and `safe-write`
  are one option away. `destructive`, in which the model may delete or change
  records the run did not create, takes `--mode destructive` together with
  `--allow-destructive` (an action input too); the mode alone exits 2 naming
  the switch, so a mode value copied from elsewhere or chosen by an agent never
  enables it.
- **The output is the ordinary report plus CI files.** `report.md` and
  `report.html` as an agent's run writes them; `summary.md` (and the job
  summary), `ci.json` and `ci.sarif` for this run's findings; a usage line with
  turns, tokens, time and a cost estimated from the provider's token counts
  where the model's price is known. The project's memory is written as in any
  run, so later runs and the check's re-tests build on it.

## Consequences

- An exploratory run costs money per run, and its findings vary between runs.
  Both are stated where the command is documented, and neither can fail a
  build.
- Each turn resends the conversation, so tokens grow with the run: the method
  and the tool descriptions alone are around 20,000 tokens. At the defaults the
  token cap or the time cap usually ends a run before the turn cap. On
  `gpt-6-luna` a run at the token cap costs about $0.05 to $0.15 with prompt
  caching, and at most about $0.18 with none.
- The default level is `medium`. A run that a cap ends before its contract is
  met still writes the report, with the gap ledger listing what was left.
- A tool result longer than 16,000 characters is cut before the model sees it.
  The report keeps everything; the model may have to ask again more narrowly.
- The GitHub Action is a second composite action in `ci/`, beside the check's,
  with inputs named after the command's options and held equal to them by
  `ci-test`. It shares the check action's install and cache steps.
- A pull request from a fork gets no secrets, so the action exits 2 there.
  Under `pull_request_target`, a fork's code runs with the repository's
  secrets; a job that sets the key and checks out and starts a fork's app
  gives that code the key and makes its pages the text the model reads.
- The model's API is called with redirects refused: a redirect would carry the
  request, and a key sent as `x-api-key`, which `fetch` does not strip across
  origins, with it. A 3xx is a provider error naming only its status.
- `scout_scan` is limited to the run's own project directory.

## Failure direction

When a run could either stop early or spend past what the workflow allowed,
it stops early and writes what it has. When a finding could either fail a
build or be read, it is read.
