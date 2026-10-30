# 33. Every pull request runs every cell

Status: accepted. Supersedes [ADR 26](0026-a-pull-request-runs-the-cells-it-can-break-and-main-runs-them-all.md) for pull requests that change code.

## Context

ADR 26 gave a pull request that changes code the suite on Linux and Windows
(Node 24) and Chromium only, and left macOS, Node 20, Firefox and WebKit to
`main`, with a `full-ci` label to ask for more. The cost of that choice showed
up in pull request #712: it passed its checks, merged, and then failed on
macOS. `main` turned red, and every other merge waited until it was fixed.
A break that only a platform or engine cell can see reached the shared branch
instead of stopping at the pull request, and the label depended on the author
knowing in advance that a change was platform-specific.

## Decision

The owner decided (2026-10-31) that every pull request runs the full test
matrix.

| Run | Jobs |
| --- | --- |
| Push to `main`, a dispatched run, and a pull request that changes code | Every cell: the suite on Linux (Node 20 and 24), macOS and Windows, three shards each; the browser suite on Firefox and WebKit, three shards each; both action jobs |
| Pull request that changes only documentation | One `docs` job, as in ADR 26 |

The documentation-only shortcut stays. A change to only `docs/`, `.changeset/`
or a top-level Markdown file cannot alter what any browser or platform cell
tests, and the `docs` job still runs every unit suite and `mcp-check`, which
read those files. Markdown anywhere else counts as code, as before.

The `full-ci` label is removed. It has no effect, the plan no longer reads a
pull request's labels, and the list of paths that used to force the full
matrix (the browser engine, the dependency files, the workflow and the plan)
is gone because every code change runs everything.

Everything else in ADR 26 is unchanged: the `plan` job, the required `test`
check and its verdict rule, the failure direction (when the plan cannot tell
what changed, it runs everything) and the concurrency groups.

## Consequences

A pull request that changes code runs 22 jobs, as `main` does (a recent `main`
run took about 190 runner-minutes), where it ran 10. That is the cost accepted: longer waits for a runner
when several pull requests push at once, and more minutes per push. The
mitigations in place are the per-pull-request cancelling concurrency group and
the single docs job for prose.

A platform- or engine-specific failure is found on the pull request that
caused it, and `main` stays green for the pull requests behind it.
