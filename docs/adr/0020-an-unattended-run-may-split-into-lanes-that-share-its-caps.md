# 20. An unattended run may split into lanes that share its caps

Status: accepted. Revisits the "one agent, not lanes" point of [ADR 14](0014-an-unattended-run-reports-and-never-gates.md).

## Context

ADR 14 kept `scenescout ci` to one model loop until someone measured whether
lanes find more in CI. The measurement since: one loop found at most 5 of the
demo app's 13 expected defects and at most 3 of the held-out app's 10, while
runs an agent split into eight lanes found 9 to 13 of the demo's (on a
different model and budget, so the two are not one comparison). Three changes
to the single loop (its prompt, its turn cap, asking for parallel tool calls)
did not move its recall. The difference that remained was the shape of the
run: a lane is handed a part of the app and works only that, where one loop
chooses its own path and declares itself done with much of the app unopened.

Splitting a CI run raises what an agent-driven split never had to answer:
where the split comes from with no planning agent, how a budget set for one
loop is spent by several, how several loops' findings become one report, and
what ended a run whose lanes ended differently.

## Decision

- **`--lanes <n>`, from 1 to 8, an option and an action input of the same
  name.** 1 is the single loop, unchanged. The bound is `scout_lane_brief`'s,
  since the split is the same one.
- **The plan involves no model.** The run attaches its first session as
  before, snapshots the landing page (attaching collects no links), and
  crawls up to three rounds. The routes found are split by `brief.ts`, the
  split `scout_lane_brief` makes: whole modules per lane, balanced by route
  count. A model choosing the split would spend turns and could split
  differently on every run; the crawl and the split are deterministic, and
  the crawl is navigation only, safe in every mode.
- **Each lane is a session and a conversation of its own.** It attaches on
  the run's target URL, as the first session did, because the engine resolves
  every path against the URL a session attached with: a lane attached on
  `/orders` would send `/orders/new` to `/orders/orders/new`. The run then
  opens the lane's first route by its full URL, on the target's origin; a
  route that does not open leaves the lane on the target. Its tool calls are
  sent to its session whatever the model names, since the server makes
  whichever session attached last the default. Every lane gets the same
  system prompt (the method, the CI rules, and `LANE_RULES`, the rules
  `scout_lane_brief` passes to an agent's lanes, from one list), so the
  provider caches it once; what differs is the lane's first message. A lane is
  not given `scout_report`.
- **The caps are the run's, shared, not multiplied.** Lanes draw turns from
  one budget. A turn is taken before its model call and counted while it is
  under way, so lanes that reach the last turn together cannot all start it:
  the lanes together never make more model calls than `--max-turns`. Time is
  one clock. Tokens are known only once a call returns, so each lane with a
  call under way can take the run one turn over `--max-tokens`, where a single
  loop can go one turn over. Dividing the caps between lanes instead was
  rejected: a lane that finished early would strand its share while another
  lane ran out, and the model would be told a budget it could not reallocate.
  Each lane is told the run's caps and its even share as a plan, not a limit.
- **One memory, one report.** Every session files into the project's one
  memory, whose dedup (ADR 4) folds a defect two lanes filed. The run writes
  the report once, from the session that planned, after every lane has ended,
  and names that session outright.
- **How a split run ends.** A model API failure in any lane is the run's
  (`provider-error`, exit 2): it is what the workflow must fix. So is a lane
  that broke after attaching (`could-not-start`, exit 2), with what the other
  lanes did still reported. Otherwise a cap ended the run if it stopped any
  lane, and the model finished it only if every lane finished by itself. A
  lane whose browser could not attach is listed with its reason and named in
  the stop's detail, and does not fail the run, unless none could attach.
- **The default is set by measurement, and stays one loop.** On the demo app
  at the default caps, four lanes found 3 of 13 expected defects in each of
  two runs, as one loop did in each of two (a difference within three was
  read as noise), in half the wall time and with about 1.3 times the
  tokens. With the caps raised to 160 turns and 6,000,000 tokens, four lanes
  found 8 of 13 in each of two runs and 7 of 10 on the held-out app, against
  5 of 13 for one loop given the same caps: +3, at the noise bound, so the
  default did not change (docs/benchmark.md, "Lanes: one loop against four").
- **Amended (2026-10-06): the default is two lanes sharing 80 turns.** Three
  runs a configuration on the demo app (issue 419): one loop found 2 to 4 of
  13 at 40 turns, 4 to 5 at 80 and 2 to 6 at 120, and two lanes sharing 80
  turns and 3,000,000 tokens found 5 to 7, the only configuration whose
  every run beat every run of the old default. On the held-out app two lanes
  found 4 to 5 of 10, against 1 to 2 for one loop at 40 turns. The cost is
  about $0.03 a run, about 2.5 times the old default's (docs/benchmark.md,
  "Choosing the defaults (issue 419)").

## Consequences

- Several browsers run at once. Their attaches are made one at a time by the
  server, so lanes start one after another. A lane that finishes closes its
  browser; the planning session stays open to write the report.
- Each lane resends the method and the tool descriptions on every turn, as one
  loop does, so a split run spends about as many tokens per turn as one loop,
  most of them cached; but its lanes spend them at once. Four lanes sent about
  1.4 million tokens a minute, about 2.8 times one loop's, so a provider's
  tokens-per-minute limit is reached sooner (the one refusal seen came with
  six runs in flight on one organisation's limit).
- Shared caps leave each lane a share of them: at the default caps, about ten
  turns each for four lanes, which in the runs measured kept the lanes on their
  first pages (the lane owning the landing page never opened its other
  routes). A run that splits needs its caps raised with it to use the split.
- A module is a route's first path segment. An app whose pages are all files
  at the root is one module per page, so related pages can land in different
  lanes; an app whose pages all sit under one path is one module, and splits
  into at most two lanes, one of them only the page the run started on.
- A defect two lanes filed is one finding whose run count says two, as when
  the same defect is filed twice in one agent-driven run.
- The report's oracle rollup is the planning session's, as in an agent-driven
  parallel run, where the planner reports.
- Lanes hand back no lane report, so a split CI run has no lane calibration
  and its Brier stays unreported.

## Failure direction

When a lane cannot start, the run goes on with the others and says so,
rather than failing; when nothing can be split, the run explores in one loop
and says why. Lanes never spend past the run's caps by more than the one turn
per lane that a returned call's tokens can add.
