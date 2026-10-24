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
their own, so one never cancels another. (Amended below for issue #692: main
and the Version Packages branch now each share a group.)

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

## Amendment: superseded runs on main and the version branch do not run (issue #692)

With several merges an hour the test queue reached 17 runs, the oldest
waiting two hours. Every merge started a full `main` run, and the release
workflow dispatched another full run on `changeset-release/main` after it
updated the Version Packages pull request. Most of those runs tested a commit
a newer one had already replaced.

GitHub's documented rule for a concurrency group ("Control the concurrency of
workflows and jobs"): at most one run in a group is running and at most one is
pending. A newly queued run cancels the run still pending in its group whatever
`cancel-in-progress` says; `cancel-in-progress: true` also cancels the run
already going. GitHub does not promise the order runs in a group start in.

`test.yml` now groups its runs like this. `ci-test` evaluates the block for
each kind of run and holds each line, beside the near miss that stays alone.

| Run | Group | A newer run in the group |
| --- | --- | --- |
| Pull request | One per pull request | Cancels the run going or waiting |
| Push to `main` | One for `main` | Replaces the run waiting; the run going always finishes |
| Dispatch on `changeset-release/main` (the release's) | One for the version branch | Cancels the run going or waiting |
| Any other dispatch (by hand, the weekly benchmark's results branch) | Its own | Nothing |

**Main** keeps the rule this record set: a `main` run in progress is the
release gate and is never cancelled. What changes is that `main` runs no
longer queue behind each other one per merge. The queue holds the run going
and the newest push's run waiting; a push in between has its waiting run
replaced. Its code is still tested, because the newest commit contains it, but
that commit has no verdict of its own: its run shows as cancelled. When the
newer run fails, the failure is narrowed to the commits since the last
`main` run that finished rather than to one merge. `main` runs also no longer
run side by side, which leaves the runners to pull requests.

**The version branch** holds one commit that matters: its head, which is the
Version Packages pull request's head. The required check `test` attaches to a
commit, so an older run, cancelled or finished, reports on an older commit and
cannot show a green check on the head. The head's `test` comes from the newest
run. When the same commit is dispatched twice, an older run still waiting is
cancelled before any job starts and reports nothing; one already going has its
`test` job (`if: always()`) fail on the cancelled jobs it needs, and the newer
run reports after it; GitHub shows the newest check of a name, so a cancelled
run reads as red until the newer one passes, never as a stale green.

The release workflow's own concurrency and the other workflows are unchanged.
The wave hold check the release also dispatches is a single short job and
keeps its group per run.

**Not done: skipping the version branch's run.** The version branch differs
from `main` only in the version, `CHANGELOG.md` and the plugin manifests, so
`main`'s own run tests the same code. Skipping the dispatch was considered and
not done. The pull request's required check must still report on the version
branch's head, which would mean copying a verdict from a `main` run across to
that commit; that `main` run may itself be waiting, replaced or failed; and
`install-test` reads the changelog and the manifests' versions, so the bump is
not inert.
