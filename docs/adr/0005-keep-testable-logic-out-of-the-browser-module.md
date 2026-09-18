# 5. Logic that does not need Playwright lives outside `browser.ts`

Status: accepted

## Context

`browser.ts` is the one module a test cannot reach without launching a real
browser. Anything that lives there can only be covered by the smoke suite, which
is slow, needs a served fixture app, and is a blunt instrument for a rule with
a dozen edge cases.

The rules that have actually shipped bugs in this project are all small,
pure, and edge-case-dense: route identity, destructive-label matching, the
auth-loss state machine, accept-attribute inference, per-session queuing. Every
one of them was reached by reading rather than by a failing test, because no
test could get at it.

The clearest case was the MCP dispatch layer. The multi-role promise — same
session serializes, different sessions run in parallel — rests entirely on a
per-session promise chain and a watchdog. Both lived inside `mcp-server.ts`, so
exercising them meant driving a browser over stdio, and `npm test` never touched
them. Two calls interleaving on one browser's ref table, or a watchdog timer
that never cleared, would have shipped green.

## Decision

Pure logic is extracted into its own module with its own table test:
`fingerprint.ts` (route/element identity), `policy.ts` (destructive matching),
`authloss.ts`, `collector.ts` (the in-page collector and geometry oracles),
`fixtures.ts` (synthetic uploads), `dispatch.ts` (session queue + watchdog).
`browser.ts` keeps only what genuinely needs a live page.

A rule that can be table-tested must be, and the cheapest layer that can
actually fail is the right one: pure logic in the matching `*-test.ts`, real
browser behaviour in `smoke.ts` backed by a `test-app/` fixture.

## Consequences

Many suites instead of one, and a handful of small modules instead of one big
file.

**Update.** The split this record deferred has since been done as its own
change: safe-write ownership (`ownership.ts`), the disk-upload fence
(`uploads.ts`), journey measurement (`journey.ts`) and orphan-browser selection
(`reaper.ts`) became pure, table-tested modules, and the in-page scroll and
overlay probes moved to `probes.ts`. `browser.ts` went from about 2,700 lines
to about 2,150 and now holds the engine class itself: attach, snapshot, the
actions, crawl and plan execution. What remains is genuinely bound to a live
page. The browser suite was split the same way, into independent suites under
`scripts/smoke/`, so one failure no longer hides the checks after it.
