# 12. A check replays saved flows and re-tests open findings, within settings whose defaults do the least harm

Status: accepted

## Context

ADR 11 kept `scenescout check` to page visits: every rule it gates on is a
fact a page load proves. That leaves out the thing a pull-request gate is most
often asked for, "does this flow still work?". An exploratory run can answer it
but is driven by a model, so it cannot gate. Two things were missing:

- a way to write a flow down once, as data, and have the check replay it with
  no judgement involved;
- a way for the check to use what earlier runs found. The project's memory
  holds open findings, and some of them are reproduced by nothing more than
  loading a page, which a check already does.

## Decision

### Saved flows

- **The format is `scout_run_plan`'s steps**, saved as
  `.scenescout/flows/<name>.json`: `{ "name"?, "description"?, "steps": [...] }`.
  A plan that walked a flow in an exploratory run can be saved as it is.
  Targets are `testid=…`, `text=…`, `label=…` or `role=<role>[name="…"]`
  (role was added to plans at the same time, so the grammar has one home:
  `parseTarget` in `flow.ts`). Three assertions are added that a plan never
  needed: `expect-text`, `expect-url` (a regular expression tested against
  path, query and hash, never the origin, so the same flow passes on a laptop
  and a preview deployment) and `expect-request` (method, path with `*` for one
  segment, and a status or a class such as `2xx`, among the responses since the
  last action). Upload, hover and scroll are left out: none of them is a step a
  gate needs, and upload writes.
- **Validated before any browser starts.** The schema is zod and strict: an
  unknown field, an unknown action, a bad target, a bad pattern or a first step
  that is not `navigate` stops the check with exit 2, naming the file and the
  field (`bad.json: steps[1].target is required`). A flow that cannot be read
  would otherwise pass by never running.
- **Saved by hand, or by an agent writing the file.** There is no recording
  tool: the skill tells an agent to save the plan it used when the user wants a
  flow kept, and the person reviewing the pull request reads the JSON. The
  self-ignoring `.scenescout/.gitignore` re-includes `flows/*.json`, since flows
  are written to be committed; a `.gitignore` written before this is left as
  the user has it (`docs/ci.md` names the two lines to add).
- **A broken step is one `flow-step-failed` issue, high**, whose evidence names
  the flow, its file, the step's number and what it did, and what happened
  instead. The replay stops at that step. Anything the oracles catch while a
  flow runs goes through the page rules, so a 500 behind a click is a
  `server-error` issue like a 500 on load, and the same failure seen by both is
  one issue.
- **Stricter than a plan.** A click is never forced through something covering
  its target, because a user could not click it either; a step waits at most
  five seconds for its target, text, URL or request.

### Settings, and the rule their defaults follow

What a check may do beyond visiting pages is a project's choice, so each such
behaviour is a setting rather than one fixed rule. The defaults serve
unconfigured use: someone trying SceneScout for the first time, and AI agents,
which run it unattended against projects they know little about. They follow
one rule — **an unconfigured check does the least harm on an unfamiliar
project: it sends no HTTP write and never silently hides a result; anything
else is one flag away.** Each default below is chosen by that rule, not as a
recommendation about any project's practice; how a project configures its own
CI is that project's decision. The effective values are written under the
verdict in the report (so on the CI job summary) and in `check.json`, so a
reviewer sees what a green check was allowed to do.

- **`--flow-writes never|allow`, default `never`.** `never`: flows replay under
  observe's rule whatever `--mode` says (every request that is not a GET is
  refused, a sign-in excepted), so an unconfigured check sends no HTTP write,
  in a flow or anywhere else it chooses. The rule covers HTTP: messages sent
  over a WebSocket are not inspected, so a flow's result lists the sockets its
  page opened. `allow`: flows replay under the check's own
  `--mode` and the engine's network-layer policy (ADR 2), exactly as the crawl
  does; in `read-only` that sends a flow's ordinary form submissions to the
  target on every run, and still refuses PUT, PATCH, DELETE, destructive POSTs
  and clicks on destructive-labelled controls. The engine switches the policy
  for the length of the replay and back; the crawl always uses `--mode`.
- **`--on-refused-step report|stop`, default `report`.** A refused step is not
  an issue: the app did nothing wrong, the flow asked for something this check
  will not do. Nor is it skipped: a flow that silently did not run reads as a
  flow that passed. `report`: the flow is marked "could not run" in the report,
  in `check.json` (`gate.couldNotRun`) and in the SARIF, as a tool execution
  notification rather than a result about the app, naming the flow, the step
  and the request; every other page, flow and re-test keeps its verdict, and
  the check exits 2, because part of it did not run. `stop`: the check exits 2
  at the refused step, replays nothing after it and writes no results. `report`
  is the default because it hides nothing the check did measure.
- **`--gate-retests never|high|all`, default `high`.** Which re-tested findings
  that still reproduce fail the gate: those filed at high severity, every one,
  or none. "possibly fixed" and "not re-tested" never gate, and `--fail-on
  never` turns this gate off with the rest. `high` is the default because a
  finding someone judged high and the check has just watched fail again is a
  result, and leaving it out of the gate would hide it; `all` is one flag away
  and `never` restores a report-only re-test. The failed request is usually
  also an issue on its page under its own rule, so a gating re-test can count
  one failure twice; the re-test carries the finding's identity and the
  severity it was filed at, which the page rule does not.
- **Which refusals a step is charged with: by the request's kind, never its
  origin.** A refused request sent with `navigator.sendBeacon` or an `<a ping>`
  (the resource type is `ping` in Chromium and `beacon` in Firefox and WebKit,
  `beaconResourceType` in `browsers.ts`) is still refused, listed in the flow's
  result as a refused background request, and charged to no step, whatever its
  origin: a page sends beacons on its own schedule, and charging them made a
  flow's result depend on when a timer fired. Every other refused write (a
  fetch, an XHR, a form post, anything else, or one with no kind recorded) is
  charged to the step it happened during, whatever its origin. An earlier rule
  decided by origin instead; an app whose API is on another port or subdomain
  then had a step's own write either hidden, so the flow passed, or charged
  to the app. So telemetry sent with fetch or XHR, to the app's origin or any
  other, is charged to the step it lands in. A heartbeat the page fetches on a
  timer therefore makes a flow "could not run" under `never` every time, on
  whichever step it lands in; the check suite runs such a flow twice to show
  the result does not depend on the timing.
- **After the last step** the flow waits 750 ms, settles and looks
  at the refusals again, so a write the last step set off late (a debounced
  save) is charged to it rather than missed. The flow's page is then left for
  `about:blank` while the flow's rule still holds, and only then does the
  crawl's rule come back.
- **Flows share the browser.** Every flow runs in the crawl's browser context,
  one after another in file-name order, so cookies, storage and a signed-in
  session carry from the crawl to each flow and from one flow to the next.
  Each flow starts from the page its first step names.
- **A limit of the network-layer rule, in Chromium.** A request a page sends
  with `keepalive` or `navigator.sendBeacon` while it is being left (on
  `pagehide`, or a beacon on a timer that fires during the unload) is never
  routed in Chromium, so the write policy does not see it and it reaches the
  server in every mode, observe included. Firefox and WebKit route it, and the
  policy refuses it; as a beacon it is then listed and charged to no step.
  `unloadBeaconsEscapePolicy` in `browsers.ts` records which engine does
  which, and the check smoke suite asserts both directions per engine. This is
  the engine's rule (ADR 2), not something flows add; it applies to every
  navigation the engine makes, and needs its own fix.
- **Pages loaded only to re-test are measured, nothing else.** They are not
  checked routes, no page rule applies to them, they do not count towards
  `--max-routes`, their links are not harvested into the route list, and they
  stay on the unvisited list if they were on it.

### Re-testing open findings

- **Only what a page load reproduces.** A finding is re-tested when it is open,
  its evidence names only failed GETs (`GET /api/x 500`), and its repro shows
  nothing done on its page but looking (navigate, crawl, snapshot, audit). Any
  other step, an action the list does not know, or no repro at all leaves it to
  an exploratory run's `scout_verify`. Order and cap are the campaign's
  (`verifyWorklist`, 25).
- The page each one was filed on is loaded, at its exact path and query, when
  the crawl did not load it already (not with `--paths`, which keeps the check
  on the paths given). The verdict is `reproduces` when one of its failed
  requests fails again with the same status, `possibly-fixed` when the page
  loaded and none did, and `not-reached` when the page did not load or sent the
  browser to sign-in.
- **Gating follows `--gate-retests`** (above). A possibly-fixed finding can
  fail nothing, and a gating re-test is a SARIF result of its own
  (`open-finding-reproduces`).
- **The memory is read, never written.** ADR 11's throwaway memory stays for
  the crawl. `.scenescout/memory.json` is read to find what to re-test and left
  byte for byte as it was: resolving a finding is a person's or an agent's
  decision (`scout_verify`, `scout_resolve`), and "possibly" is not enough to
  make it. `--retest off` skips all of it; an unreadable memory file is exit 2
  with that option named.

## Consequences

- A team can gate on the handful of flows that matter without writing a test
  suite, and a flow an agent walked once can become a check in one file.
- Unconfigured, a flow that submits a form is refused and the check exits 2
  with the rest of its verdict written. `--flow-writes allow` replays it, and
  the submission is then sent on every run. The skill tells agents to save
  flows that read, so an agent's flow runs under the defaults.
- Exit code 2 now covers a partly-run check as well as one that measured
  nothing. The report says which, and with `report` the rest's verdict is in
  the files; the GitHub Action's `passed` output describes that rest.
- The re-test covers the narrow class of findings a load reproduces. Most
  findings need an interaction and are counted, not re-tested; the report says
  how many.
- Findings are ordinary JSON that someone may have edited. An entry missing a
  field the rules read is left out (`wellFormedFindings`) rather than failing a
  check that only ever reports re-tests.

## Failure direction

A step that is not done within five seconds fails, and is never retried. ADR
11 prefers passing to failing on noise, and a retry would look like that
preference; it is not, because a retry turns a flow that works one time in two
into a pass, which is the one thing a saved flow exists to catch. If five
seconds proves too short for real apps, the timeout is what changes. A
re-test that cannot tell says `not-reached` rather than `possibly-fixed`: a
finding reported as fixed that is not costs more than one reported as unknown.
