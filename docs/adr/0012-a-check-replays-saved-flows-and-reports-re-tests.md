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
  crawl's rule come back. Every page in the context is left, a page a step opened a tab from
  included, and the flow's rule goes on judging for five seconds after the
  hand-back (`WriteRule`, ADR 2), so a write a page sent under the flow's rule
  is never judged under the crawl's because it was heard of late.
- **Flows share the browser.** Every flow runs in the crawl's browser context,
  one after another in file-name order, so cookies, storage and a signed-in
  session carry from the crawl to each flow and from one flow to the next.
  Each flow starts from the page its first step names.
- **Writes sent as a page is left are judged too.** A request a page sends
  with `keepalive` or `navigator.sendBeacon` while it is being left (on
  `pagehide`, or a beacon on a timer that fires during the unload) meets the
  flow's rule in every browser: Firefox and WebKit route it, and in Chromium,
  which never routes it, the engine judges it at the browser level by the same
  rules (ADR 2, `unloadWriteInterception` in `browsers.ts`). So it is refused
  under `never`, and a refused beacon is listed and charged to no step like any
  other. Until this was closed, Chromium sent it in every mode, observe
  included; the check smoke suite asserts the refusal on each engine.
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

## Amendment, 3 October 2026: expect-element

A fourth assertion, `expect-element`, takes a target and a state: `visible`,
`hidden`, `enabled`, `disabled`, `checked` or `unchecked`. Rewriting a scripted
browser journey as a flow showed the three assertions above cannot say that
something has gone (a dialog closed, a receipt never shown) or what state a
control is in (a submit button disabled until a box is ticked), and those are
often the point of the journey. `hidden` holds when nothing matches, because
"never shown" and "closed" are both the absence of a visible element. The rule
that turns what the page shows into a verdict is `elementStateMatches` in
`flow.ts`, table-tested in `check-test`; the browser only reads the facts.

## Amendment, 3 October 2026: repeat

A `repeat` step runs up to ten click, type, select or press steps until an
`expect-text`, `expect-element` or `expect-url` step holds, at most `max` times
(up to 100). It exists because a read-to-the-end gate (Continue enabled only
after paging through every page of a document) needs the same click an unknown
number of times, and a flow written with a fixed number of clicks breaks the
day the document changes length. The condition is checked first, so a page
already in the wanted state runs the actions no times. Each check waits up to
one second rather than the action limit, since the next round is what it waits
for. A repeat holds only single steps; it never nests, and `expect-request` is
not a condition, since what a round sent is not what the page shows. The steps
inside run through the same code as any other step, write policy included.

## Amendment, 3 October 2026: a flow can run as a role

A flow may name a `role`. It then runs in a browser of its own, attached with
the profile `scenescout login --role` saved in the project, the same profile
`scout_attach { role }` loads. Journeys that pass between people (one role
submits, another approves) were otherwise impossible to save, since a check
held one session. A browser per role, rather than re-attaching the check's
own, leaves the crawl's session and what it found untouched. Every role a
flow names is resolved before the check starts, so a missing profile fails in
seconds with the command that saves it, never after a full crawl. Flows still
run in file-name order and share nothing but the app's own data, so a later
flow finds what an earlier one created by what the page shows.

## Amendment, 3 October 2026: values from the environment

A `type` or `select` value may hold `${env:NAME}`, resolved from the
environment before the check starts; a name that is not set stops it with
exit 2, never mid-flow. Signing a record or confirming an action often needs a
one-time code or a password, and a flow file is committed. Substituting only
values keeps the rule small: an `expect-*` step matches its text as written,
so a flow cannot assert a secret onto the page. Every substituted value of
four characters or more is masked as `[$NAME]` across the whole result before
anything is written or printed, since a page can echo what was typed into an
address or an error. Shorter values are not masked: they would rewrite
ordinary words and numbers in the report.

