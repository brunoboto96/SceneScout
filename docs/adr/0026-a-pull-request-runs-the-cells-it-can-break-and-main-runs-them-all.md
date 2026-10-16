# 26. A pull request runs the cells it can break, and main runs them all

Status: accepted

## Context

Every run of `.github/workflows/test.yml` was the same 21 jobs: the suite on
four platforms (Linux on Node 20 and 24, macOS and Windows on Node 24) in
three shards each, the browser suite on Firefox and WebKit in three shards
each, the two action jobs and the `test` check that sums them up. That is
about 174 runner-minutes per run. The longest job takes about 14 minutes, but
a run took about 48 minutes of wall time, most of it waiting for a runner,
because several pull requests were pushing at once and each push asked for
21 more.

Most of those cells cannot fail on most pull requests. A change to a report
section does not behave differently on Node 20, on macOS or in WebKit. A
pull request that only edits documentation cannot change what any browser
suite cell tests at all.

## Decision

`scripts/test-plan.mjs` decides what a run needs, in a first job called
`plan`, and every other job runs on its decision.

| Run | Jobs |
| --- | --- |
| Push to `main`, and a dispatched run (the release dispatches one on the Version Packages branch) | Every cell: the suite on all four platforms, Firefox and WebKit, both action jobs |
| Pull request that changes code | The suite on Linux and Windows, Node 24, three shards each; both action jobs |
| Pull request with the `full-ci` label, or that changes `src/browsers.ts`, `src/engine/browser.ts`, `package.json`, `package-lock.json`, `test.yml` or the plan script | Every cell, as on `main` |
| Pull request that changes only documentation | One `docs` job: formatting, the build, every pure-logic suite and `mcp-check` |

Windows stays on every pull request that changes code: it is where path
handling differs, and it has caught real path bugs that Linux and macOS
passed.

**Documentation** is a path under `docs/`, a path under `.changeset/`, or a
Markdown file at the top of the repository (`README.md`, `AGENTS.md`,
`CONTRIBUTING.md` and the like). Markdown anywhere else is read as data and
counts as code: the skill, the demo apps' READMEs (their answer keys are held
to them), `examples/report.md` (the sample report check) and the golden files.

The `docs` job runs every unit suite rather than a list of the ones that read
documentation, because a third of them do, and a list would go stale the
first time a suite started reading a page. When this was decided they were:

| Suite | Reads |
| --- | --- |
| `guide-test` | `docs/guide/`, `AGENTS.md`, `README.md` |
| `install-test` | `AGENTS.md`, `CHANGELOG.md`, `README.md` |
| `qa-test` | `docs/ci.md`, `.changeset/` |
| `ci-test` | `docs/`, `docs/benchmark.md` |
| `check-test` | `docs/`, `README.md` |
| `bench-test`, `demo-test`, `holdout-test` | `README.md` files |
| `hygiene-test` | every tracked file |
| `mcp-check` | `docs/guide/` (its `scout_*` tools and parameters, against the live schemas) |

The unit suites take about two minutes, so one job costs a few runner-minutes
where the matrix cost 174.

**The required check.** The branch ruleset requires `test`, which now passes
only when every job the plan runs succeeded and every job it leaves out was
skipped. A job skipped because the plan itself failed is a failure, never a
pass. The plan is the only place the rule lives: the jobs' `if:` conditions
and the check's expectations are held to it by `ci-test`.

**The label is read when the plan runs**, not from the event, so adding
`full-ci` to an open pull request and re-running the workflow is enough.
Adding a label does not start a run by itself: labels are added for other
reasons, and each would cancel the run in flight.

**Concurrency is unchanged.** Only a pull request's runs share a group and
cancel each other. A push to `main` and a dispatched run each get a group of
their own, so one never cancels another.

## Consequences

A pull request that changes code runs 10 jobs instead of 21, and one that
changes only documentation runs 3.

A break that shows only on Firefox, WebKit, macOS or Node 20 is now found on
`main` after the merge rather than on the pull request. That is the risk this
accepts. It is handled by fixing forward: the failing `main` run names the
cell, and a small pull request with the fix (labelled `full-ci`, so the fix is
tested on the cell that broke) goes in next. A release is not affected: the
release dispatches the full matrix on the Version Packages branch, and that
run is its required check.

A pull request expected to differ between engines or platforms, such as a
change to the write policy's interception or to the browser smoke harness,
should carry the `full-ci` label. The paths that set it automatically are kept
short on purpose: each one adds the full matrix to every pull request that
touches it.

## Failure direction

When the plan cannot tell what changed, it runs everything: a run with no
list of changed files, and every event other than a pull request, gets the
full matrix. A documentation-only pull request with one file that is not
documentation is a code pull request. Running a cell that was not needed
costs minutes; skipping one that was needed costs a broken `main`.
