/**
 * Table tests for the time limits in src/engine/limits.ts: how long an action
 * and a page load may take, where each is set (option > environment >
 * default), the bounds each is held to, and what a timeout says.
 *
 *   npx tsx --test scripts/limits-test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseCheckArgs } from "../src/engine/check.ts";
import { parseCiArgs } from "../src/engine/ci.ts";
import {
  ACTION_TIMEOUT_ENV,
  DEFAULT_TIME_LIMITS,
  explainTimeout,
  explicitLimits,
  isTimeoutMessage,
  limitHint,
  NAV_TIMEOUT_ENV,
  parseLimit,
  parseLimitFlag,
  resolveTimeLimits,
  watchdogFor,
} from "../src/engine/limits.ts";

test("defaults: the values the engine has always used", () => {
  assert.deepEqual(resolveTimeLimits({}, {}), { actionMs: 5000, navMs: 20000, crawlNavMs: 15000, backNavMs: 10000 });
  assert.deepEqual(resolveTimeLimits({}, {}), DEFAULT_TIME_LIMITS);
  // Set but empty is unset: a CI template that exports the name with no value changes nothing.
  assert.deepEqual(resolveTimeLimits({}, { [ACTION_TIMEOUT_ENV]: "", [NAV_TIMEOUT_ENV]: "  " }), DEFAULT_TIME_LIMITS);
});

test("precedence: option over environment over default, for each limit on its own", () => {
  const env = { [ACTION_TIMEOUT_ENV]: "8000", [NAV_TIMEOUT_ENV]: "45000" };
  const rows: Array<[{ actionTimeoutMs?: number; navTimeoutMs?: number }, Record<string, string>, number, number]> = [
    [{}, env, 8000, 45000],
    [{ actionTimeoutMs: 12000 }, env, 12000, 45000],
    [{ navTimeoutMs: 60000 }, env, 8000, 60000],
    [{ actionTimeoutMs: 2000, navTimeoutMs: 3000 }, env, 2000, 3000],
    [{ navTimeoutMs: 60000 }, {}, 5000, 60000],
    [{}, { [ACTION_TIMEOUT_ENV]: "9000" }, 9000, 20000],
  ];
  for (const [options, e, action, nav] of rows) {
    const got = resolveTimeLimits(options, e);
    assert.equal(got.actionMs, action, JSON.stringify(options));
    assert.equal(got.navMs, nav, JSON.stringify(options));
  }
});

test("a nav limit that was set applies to every page load; unset, each keeps its own default", () => {
  assert.deepEqual(resolveTimeLimits({ navTimeoutMs: 40000 }, {}), { actionMs: 5000, navMs: 40000, crawlNavMs: 40000, backNavMs: 40000 });
  assert.deepEqual(resolveTimeLimits({}, { [NAV_TIMEOUT_ENV]: "2500" }), { actionMs: 5000, navMs: 2500, crawlNavMs: 2500, backNavMs: 2500 });
  // The action limit leaves every page load alone.
  const onlyAction = resolveTimeLimits({ actionTimeoutMs: 30000 }, {});
  assert.deepEqual([onlyAction.navMs, onlyAction.crawlNavMs, onlyAction.backNavMs], [20000, 15000, 10000]);
});

test("bounds: nonsense is refused with a sentence naming where it came from", () => {
  const refused: Array<[{ actionTimeoutMs?: number; navTimeoutMs?: number }, Record<string, string>, RegExp]> = [
    [{ actionTimeoutMs: 0 }, {}, /^actionTimeoutMs must be a whole number of milliseconds from 1000 to 120000 \(got 0\)/],
    [{ actionTimeoutMs: 999 }, {}, /actionTimeoutMs must be/],
    [{ actionTimeoutMs: 120001 }, {}, /actionTimeoutMs must be/],
    [{ actionTimeoutMs: 1500.5 }, {}, /actionTimeoutMs must be/],
    [{ navTimeoutMs: 300001 }, {}, /^navTimeoutMs must be a whole number of milliseconds from 1000 to 300000/],
    [{}, { [ACTION_TIMEOUT_ENV]: "0" }, new RegExp(`^${ACTION_TIMEOUT_ENV} must be`)],
    [{}, { [NAV_TIMEOUT_ENV]: "5s" }, new RegExp(`^${NAV_TIMEOUT_ENV} must be .*\\(got "5s"\\)`)],
    [{}, { [NAV_TIMEOUT_ENV]: "1e4" }, new RegExp(`^${NAV_TIMEOUT_ENV} must be`)],
    [{}, { [NAV_TIMEOUT_ENV]: "-5000" }, new RegExp(`^${NAV_TIMEOUT_ENV} must be`)],
    [{}, { [ACTION_TIMEOUT_ENV]: "5000ms" }, new RegExp(`^${ACTION_TIMEOUT_ENV} must be`)],
  ];
  for (const [options, env, pattern] of refused) assert.throws(() => resolveTimeLimits(options, env), { message: pattern }, JSON.stringify({ options, env }));
  // The edges are allowed.
  assert.equal(resolveTimeLimits({ actionTimeoutMs: 1000, navTimeoutMs: 300000 }, {}).navMs, 300000);
  assert.equal(parseLimit("action", " 120000 ", "x"), 120000);
  // An option that is valid wins even over a broken environment variable: the variable is never read.
  assert.equal(resolveTimeLimits({ actionTimeoutMs: 7000 }, { [ACTION_TIMEOUT_ENV]: "nonsense" }).actionMs, 7000);
});

test("flags: parsed the same way, the error naming the flag", () => {
  assert.deepEqual(parseLimitFlag("nav", undefined), { ok: true, value: undefined });
  assert.deepEqual(parseLimitFlag("nav", "60000"), { ok: true, value: 60000 });
  const bad = parseLimitFlag("action", "0");
  assert.ok(!bad.ok && /^--action-timeout-ms must be a whole number of milliseconds from 1000 to 120000/.test(bad.error));
});

test("scenescout check and ci take both limits, and refuse them out of bounds", () => {
  const check = parseCheckArgs(["http://127.0.0.1:3000", "--action-timeout-ms", "9000", "--nav-timeout-ms=60000"], "/work");
  assert.ok(check.ok);
  assert.equal(check.options.actionTimeoutMs, 9000);
  assert.equal(check.options.navTimeoutMs, 60000);
  const unset = parseCheckArgs(["http://127.0.0.1:3000"], "/work");
  assert.ok(unset.ok && !("actionTimeoutMs" in unset.options) && !("navTimeoutMs" in unset.options), "unset leaves the environment and the default to decide");
  const badCheck = parseCheckArgs(["http://127.0.0.1:3000", "--nav-timeout-ms=0"], "/work");
  assert.ok(!badCheck.ok && /--nav-timeout-ms must be/.test(badCheck.error));

  const ci = parseCiArgs(["http://127.0.0.1:3000", "--action-timeout-ms=15000", "--nav-timeout-ms", "90000"], "/work");
  assert.ok(ci.ok);
  assert.equal(ci.options.actionTimeoutMs, 15000);
  assert.equal(ci.options.navTimeoutMs, 90000);
  const badCi = parseCiArgs(["http://127.0.0.1:3000", "--action-timeout-ms=600000"], "/work");
  assert.ok(!badCi.ok && /--action-timeout-ms must be/.test(badCi.error));
});

test("a timeout names the limit that ran out, how long it was, and every way to raise it", () => {
  const hint = limitHint("nav", 20000);
  for (const part of ["page-load limit", "20000 ms", "navTimeoutMs", "--nav-timeout-ms", NAV_TIMEOUT_ENV]) assert.ok(hint.includes(part), part);
  const action = limitHint("action", 5000);
  for (const part of ["action limit", "5000 ms", "actionTimeoutMs", "--action-timeout-ms", ACTION_TIMEOUT_ENV]) assert.ok(action.includes(part), part);

  const playwright = new Error('page.goto: Timeout 20000ms exceeded.\nCall log:\n  - navigating to "http://x/"');
  const explained = explainTimeout(playwright, "nav", 20000) as Error;
  const [first, ...rest] = explained.message.split("\n");
  assert.ok(first.startsWith("page.goto: Timeout 20000ms exceeded. — the page-load limit (20000 ms)"), first);
  assert.ok(first.includes(NAV_TIMEOUT_ENV), "the hint is on line 1, which is the line callers keep");
  assert.deepEqual(rest, ["Call log:", '  - navigating to "http://x/"']);
  // Explaining twice does not say it twice (a flow step's navigate is explained, then its catch explains again).
  assert.equal((explainTimeout(explained, "action", 5000) as Error).message, explained.message);
});

test("anything that is not a timeout is left exactly as it was", () => {
  const refused = new Error("net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/");
  assert.equal(explainTimeout(refused, "nav", 20000), refused);
  assert.equal(explainTimeout("a string", "action", 5000), "a string");
  assert.ok(isTimeoutMessage("locator.click: Timeout 5000ms exceeded."));
  assert.ok(!isTimeoutMessage("Timeout while reading the file"));
  assert.ok(!isTimeoutMessage("the page answered HTTP 504 Gateway Timeout"));
});

test("a tool's watchdog grows with raised limits, so the limit and not the watchdog ends a slow call", () => {
  assert.equal(watchdogFor(60_000, DEFAULT_TIME_LIMITS), 60_000, "at the defaults nothing changes");
  // Lowered limits never shorten it.
  assert.equal(watchdogFor(60_000, resolveTimeLimits({ actionTimeoutMs: 1000, navTimeoutMs: 1000 }, {})), 60_000);
  // A page-load limit at its maximum outlasts the 60 s watchdog it would otherwise hit.
  const slowPages = resolveTimeLimits({ navTimeoutMs: 300_000 }, {});
  assert.equal(watchdogFor(60_000, slowPages), 60_000 + 285_000, "the crawl's page limit rose most, from 15 s");
  assert.ok(watchdogFor(60_000, slowPages) > slowPages.navMs);
  // An action is counted twice: a click that timed out is retried once.
  const slowActions = resolveTimeLimits({ actionTimeoutMs: 120_000 }, {});
  assert.equal(watchdogFor(60_000, slowActions), 60_000 + 2 * 115_000);
  assert.ok(watchdogFor(60_000, slowActions) > 2 * slowActions.actionMs);
});

test("explicitLimits: only what was set, for a command that keeps defaults of its own", () => {
  assert.deepEqual(explicitLimits({}, {}), {});
  assert.deepEqual(explicitLimits({}, { [NAV_TIMEOUT_ENV]: "45000" }), { navMs: 45000 });
  assert.deepEqual(explicitLimits({ actionTimeoutMs: 8000 }, { [ACTION_TIMEOUT_ENV]: "9000" }), { actionMs: 8000 });
  assert.throws(() => explicitLimits({}, { [ACTION_TIMEOUT_ENV]: "0" }), { message: new RegExp(`^${ACTION_TIMEOUT_ENV} must be`) });
});
