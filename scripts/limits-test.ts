/**
 * Table tests for the time limits in src/engine/limits.ts: how long an action
 * and a page load may take, where each is set (option > environment >
 * default), the bounds each is held to, what a timeout says (including a
 * scroll of a named target that could not run), and the waits a page gets
 * when a call names none, and which failed page loads are tried again.
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
  formatLoadRetries,
  isTimeoutMessage,
  LIMIT_BOUNDS,
  interruptedBy,
  interruptedByOwnNavigation,
  limitHint,
  loadInterrupted,
  LOAD_RETRIES,
  LOAD_RETRY_MIN_MS,
  loadRetryCause,
  loadRetryNote,
  loadRetryTimeoutMs,
  loadRetryPauseMs,
  LOAD_RETRY_PAUSE_MS,
  NETWORK_RETRY_ENV,
  stillNavigating,
  NETWORK_RETRY_PAUSE_MS,
  readNetworkRetry,
  retriedLoadFailure,
  NAV_TIMEOUT_ENV,
  pageTimeouts,
  parseLimit,
  parseLimitFlag,
  resolveTimeLimits,
  SCREENSHOT_TIMEOUT_MS,
  TARGET_READ_MS,
  watchdogFor,
} from "../src/engine/limits.ts";
import { scrollTargetRefusal } from "../src/engine/probes.ts";

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

test("a scroll target that matches nothing is not found; any other failure says what it was", () => {
  const timeout = new Error("locator.evaluate: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('[data-testid=\"side\"]')");
  // Nothing matches: the target is missing, whatever the evaluate said.
  assert.equal(scrollTargetRefusal("testid=side", 0, timeout, 5000), "Scroll target not found: testid=side");
  // It matches, so the failure is something else, and is named rather than read as a missing target.
  const closed = new Error("locator.evaluate: Target page, context or browser has been closed");
  const said = scrollTargetRefusal("testid=side", 1, closed, 5000);
  assert.ok(!said.includes("not found"), said);
  assert.equal(said, "Could not scroll testid=side: Target page, context or browser has been closed");
  // A count that itself failed (the page went away) is not proof the target is missing.
  const unknown = scrollTargetRefusal(
    "text=Filters",
    null,
    new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation"),
    5000,
  );
  assert.equal(unknown, "Could not scroll text=Filters: Execution context was destroyed, most likely because of a navigation");
  // A target that is there but did not answer in time names the action limit, like any other timed-out action.
  const slow = scrollTargetRefusal("label=Notes", 1, timeout, 5000);
  assert.ok(slow.startsWith("Could not scroll label=Notes: Timeout 5000ms exceeded. — the action limit (5000 ms)"), slow);
  assert.ok(!slow.includes("Call log"), "only the first line of the driver's error");
});

test("a wait that names no timeout gets the session's limits, not Playwright's 30 s", () => {
  const rows: Array<[{ actionTimeoutMs?: number; navTimeoutMs?: number }, number, number]> = [
    [{}, 5000, 20000],
    [{ actionTimeoutMs: 15000 }, 15000, 20000],
    [{ navTimeoutMs: 60000 }, 5000, 60000],
    [{ actionTimeoutMs: 1000, navTimeoutMs: 1000 }, 1000, 1000],
  ];
  for (const [options, timeout, navigationTimeout] of rows) {
    assert.deepEqual(pageTimeouts(resolveTimeLimits(options, {})), { timeout, navigationTimeout }, JSON.stringify(options));
  }
});

test("a bookkeeping read of a target never outlasts the action, whatever the action limit", () => {
  // At the smallest action limit a read is still no longer than the action, so a missing target costs one action limit.
  assert.ok(TARGET_READ_MS <= LIMIT_BOUNDS.action.min, `${TARGET_READ_MS} > ${LIMIT_BOUNDS.action.min}`);
  assert.ok(TARGET_READ_MS < DEFAULT_TIME_LIMITS.actionMs);
});

test("a screenshot keeps Playwright's own 30 s rather than the action limit the page now defaults to", () => {
  assert.equal(SCREENSHOT_TIMEOUT_MS, 30_000);
  assert.ok(SCREENSHOT_TIMEOUT_MS > pageTimeouts(DEFAULT_TIME_LIMITS).timeout);
});

test("a page load is retried only after net::ERR_NO_BUFFER_SPACE, and only once", () => {
  const refused = "page.goto: net::ERR_NO_BUFFER_SPACE at http://127.0.0.1:52494/slow-page\nCall log:\n  - navigating";
  assert.equal(LOAD_RETRIES, 1);
  assert.equal(loadRetryCause(refused, 0), "ERR_NO_BUFFER_SPACE");
  // Once retried, a second refusal is the load's failure.
  assert.equal(loadRetryCause(refused, 1), null);
  // Every other failure is the app's or the machine's answer, and is reported as it is.
  for (const other of [
    "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/",
    "page.goto: net::ERR_ADDRESS_UNREACHABLE at http://127.0.0.1:1/",
    "page.goto: net::ERR_INSUFFICIENT_RESOURCES at http://127.0.0.1:1/",
    "page.goto: Timeout 20000ms exceeded.",
    "page.goto: NS_ERROR_CONNECTION_REFUSED",
    "page.goto: net::ERR_NO_BUFFER_SPACE_SOMETHING at http://127.0.0.1:1/",
    // The code inside the address a failure names is the app's text, not the browser's error.
    "page.goto: net::ERR_TIMED_OUT at http://127.0.0.1:1/search?q=net::ERR_NO_BUFFER_SPACE",
    'page.goto: Navigation to "http://127.0.0.1:1/net::ERR_NO_BUFFER_SPACE" is interrupted by another navigation to "http://127.0.0.1:1/"',
    'page.goto: Timeout 20000ms exceeded.\nCall log:\n  - navigating to "http://127.0.0.1:1/?e=net::ERR_NO_BUFFER_SPACE"',
  ]) {
    assert.equal(loadRetryCause(other, 0), null, other);
  }
});

test("with SCENESCOUT_RETRY_NETWORK=on, a page load that failed on the network is retried once; never an HTTP answer, a cancel or a timeout", () => {
  assert.equal(NETWORK_RETRY_ENV, "SCENESCOUT_RETRY_NETWORK");
  assert.equal(readNetworkRetry({}), false, "off by default");
  assert.equal(readNetworkRetry({ [NETWORK_RETRY_ENV]: "" }), false);
  assert.equal(readNetworkRetry({ [NETWORK_RETRY_ENV]: "off" }), false);
  assert.equal(readNetworkRetry({ [NETWORK_RETRY_ENV]: " ON " }), true);
  for (const bad of ["1", "true", "yes", "twice"]) assert.throws(() => readNetworkRetry({ [NETWORK_RETRY_ENV]: bad }), /must be on or off/, bad);
  const retried: Array<[string, string]> = [
    ["page.goto: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:1/", "ERR_EMPTY_RESPONSE"],
    ["page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:1/", "ERR_CONNECTION_RESET"],
    ["page.goto: net::ERR_NAME_NOT_RESOLVED at http://app.invalid/", "ERR_NAME_NOT_RESOLVED"],
    ["page.goto: net::ERR_CERT_DATE_INVALID at https://app.example/", "ERR_CERT_DATE_INVALID"],
    ["page.goto: net::ERR_TIMED_OUT at http://127.0.0.1:1/search?q=net::ERR_ABORTED", "ERR_TIMED_OUT"],
    ["page.goto: NS_ERROR_NET_RESET", "NS_ERROR_NET_RESET"],
    ["page.goto: Could not connect to server", "Could not connect to server"],
  ];
  for (const [message, cause] of retried) {
    assert.equal(loadRetryCause(message, 0, true), cause, message);
    // Off, as by default: reported as it is.
    assert.equal(loadRetryCause(message, 0, false), null, message);
    // Once only.
    assert.equal(loadRetryCause(message, 1, true), null, message);
  }
  for (const other of [
    "page.goto: net::ERR_ABORTED at http://127.0.0.1:1/",
    "page.goto: net::ERR_BLOCKED_BY_CLIENT at http://127.0.0.1:1/",
    "page.goto: net::ERR_TOO_MANY_REDIRECTS at http://127.0.0.1:1/",
    "page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at http://127.0.0.1:1/",
    "page.goto: Timeout 20000ms exceeded.",
    // A code inside the address or the call log is the app's text.
    'page.goto: Navigation to "http://127.0.0.1:1/net::ERR_CONNECTION_RESET" is interrupted by another navigation to "http://127.0.0.1:1/"',
    'page.goto: Timeout 20000ms exceeded.\nCall log:\n  - navigating to "http://127.0.0.1:1/?e=net::ERR_CONNECTION_RESET"',
  ]) {
    assert.equal(loadRetryCause(other, 0, true), null, other);
  }
  // The socket the machine refused is retried whatever the setting.
  assert.equal(loadRetryCause("page.goto: net::ERR_NO_BUFFER_SPACE at http://127.0.0.1:1/", 0, true), "ERR_NO_BUFFER_SPACE");
  assert.equal(loadRetryPauseMs("ERR_NO_BUFFER_SPACE"), LOAD_RETRY_PAUSE_MS);
  assert.equal(loadRetryPauseMs("ERR_CONNECTION_RESET"), NETWORK_RETRY_PAUSE_MS);
  const note = loadRetryNote("http://127.0.0.1:8080/things", "ERR_CONNECTION_RESET");
  assert.match(
    note,
    /retried after ERR_CONNECTION_RESET \(the connection was refused or dropped: the network's, not an answer from the app; SCENESCOUT_RETRY_NETWORK=on; it was loaded once more\)/,
  );
  const [entry] = formatLoadRetries([
    { at: "2026-10-17T10:00:00.000Z", url: "http://127.0.0.1:8080/things", session: "check", cause: "NS_ERROR_UNKNOWN_HOST", sockets: "12 TCP sockets" },
  ]).filter((l) => l.startsWith("- "));
  assert.match(entry, /retried after NS_ERROR_UNKNOWN_HOST \(the host name did not resolve: the network's/);
});

test("a retried load is said in the action's result and in the report", () => {
  const note = loadRetryNote("http://127.0.0.1:8080/things", "ERR_NO_BUFFER_SPACE");
  assert.match(note, /retried after ERR_NO_BUFFER_SPACE/);
  assert.ok(note.includes("http://127.0.0.1:8080/things"));
  assert.deepEqual(formatLoadRetries([]), [], "no retry, no section");
  const lines = formatLoadRetries([
    {
      at: "2026-10-17T10:00:00.000Z",
      url: "http://127.0.0.1:8080/things",
      session: "lane-1",
      cause: "ERR_NO_BUFFER_SPACE",
      sockets: "150 TCP sockets on this machine: TIME_WAIT 92",
    },
  ]);
  assert.equal(lines[0], "## Page loads retried");
  const entry = lines.find((l) => l.startsWith("- "));
  assert.ok(entry, lines.join("\n"));
  assert.match(entry!, /`http:\/\/127\.0\.0\.1:8080\/things` \(session lane-1\): retried after ERR_NO_BUFFER_SPACE/);
  assert.ok(entry!.includes("150 TCP sockets on this machine: TIME_WAIT 92"));
});

test("a retried load gets what is left of its page-load limit, never less than a floor and never unlimited", () => {
  // Most of the limit is left: the retry has the rest, so the two tries together keep to the limit.
  assert.equal(loadRetryTimeoutMs(20_000, 2_500), 17_500);
  // The limit is spent, or nearly: the retry still gets the floor rather than 0, which Playwright reads as no limit.
  assert.equal(loadRetryTimeoutMs(20_000, 19_900), LOAD_RETRY_MIN_MS);
  assert.equal(loadRetryTimeoutMs(20_000, 25_000), LOAD_RETRY_MIN_MS);
  assert.ok(LOAD_RETRY_MIN_MS > 0);
  // No limit was given: the page's own navigation limit applies to the retry as it did to the first try.
  assert.equal(loadRetryTimeoutMs(undefined, 2_500), undefined);
});

test("a retry that failed again says so on the first line its callers show, keeping the rest", () => {
  const second = new Error("page.goto: net::ERR_NO_BUFFER_SPACE at http://127.0.0.1:1/x\nCall log:\n  - navigating");
  const out = retriedLoadFailure(second, "ERR_NO_BUFFER_SPACE") as Error;
  const [first, ...rest] = out.message.split("\n");
  assert.match(first, /^page\.goto: net::ERR_NO_BUFFER_SPACE at http:\/\/127\.0\.0\.1:1\/x .*retried after ERR_NO_BUFFER_SPACE/);
  assert.deepEqual(rest, ["Call log:", "  - navigating"]);
  // A retry that timed out is still a timeout, and still gets the limit's hint.
  const timedOut = retriedLoadFailure(new Error("page.goto: Timeout 17500ms exceeded."), "ERR_NO_BUFFER_SPACE") as Error;
  assert.ok(isTimeoutMessage(timedOut.message));
  assert.match((explainTimeout(timedOut, "nav", 20_000) as Error).message.split("\n")[0], /retried after ERR_NO_BUFFER_SPACE.*page-load limit/);
  // Not an Error: passed on as it is.
  assert.equal(retriedLoadFailure("odd", "ERR_NO_BUFFER_SPACE"), "odd");
});

test("a page load another navigation took the place of is the page moving on, not a failure; a real failure is still one (#674)", () => {
  // Firefox under load fails page.goto this way when the page's own redirect lands before the asked-for load finishes.
  // Contrastive pairs: the same load failing on the network or on its limit, and the same words in an address or in
  // the call log, which are the app's and not the browser's.
  for (const moved of [
    'page.goto: Navigation to "http://127.0.0.1:1/a" is interrupted by another navigation to "http://127.0.0.1:1/b"',
    'page.goto: Navigation to "http://127.0.0.1:1/a" is interrupted by another navigation to "http://127.0.0.1:1/login"\nCall log:\n  - navigating to "http://127.0.0.1:1/a", waiting until "domcontentloaded"',
    'Navigation to "/a" is interrupted by another navigation to "/b"',
  ]) {
    assert.equal(loadInterrupted(moved), true, moved);
  }
  for (const failed of [
    "page.goto: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:1/a",
    "page.goto: NS_ERROR_NET_RESET",
    "page.goto: Timeout 20000ms exceeded.",
    "page.goto: net::ERR_ABORTED at http://127.0.0.1:1/a",
    // The words inside the address a failure names, or in its call log, are the app's.
    "page.goto: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:1/?q=is interrupted by another navigation",
    'page.goto: Timeout 20000ms exceeded.\nCall log:\n  - Navigation to "/a" is interrupted by another navigation to "/b"',
    "",
  ]) {
    assert.equal(loadInterrupted(failed), false, failed);
  }
});

test("a page still moving on at the limit says where it was going, which limit ran out and how to raise it (#674)", () => {
  const said = stillNavigating("http://127.0.0.1:1/next", "nav", 15000);
  assert.match(said, /^the page moved itself on to http:\/\/127\.0\.0\.1:1\/next, which had not loaded when the page-load limit \(15000 ms\) ran out/);
  assert.ok(said.includes("navTimeoutMs") && said.includes("--nav-timeout-ms") && said.includes("SCENESCOUT_NAV_TIMEOUT_MS"), said);
});

test("an interruption is the page moving on only when the navigation that took the load's place started after it (#674)", () => {
  const message = 'page.goto: Navigation to "http://127.0.0.1:1/a" is interrupted by another navigation to "http://127.0.0.1:1/login?r=1"\nCall log:';
  assert.equal(interruptedBy(message), "http://127.0.0.1:1/login?r=1");
  assert.equal(interruptedBy("page.goto: net::ERR_ABORTED at http://127.0.0.1:1/a"), null);
  // The load itself, started at 1000 and answered at 1200: the document whose script may move the page on.
  const load = { url: "http://127.0.0.1:1/a", at: 1000, answeredAt: 1200 };
  const login = "http://127.0.0.1:1/login?r=1";
  // Contrastive pair: the same address, started after the load (the page's own redirect) and before it (an earlier
  // load committing late, which is not the page moving on from this one).
  assert.equal(interruptedByOwnNavigation(login, [load, { url: login, at: 1300 }], 1000), true);
  assert.equal(interruptedByOwnNavigation(login, [{ url: login, at: 999 }, load], 1000), false);
  // Contrastive pair: the same address started after the load, once the load was answered (its page moved on) and
  // before it was (the page the load was leaving moved on by its own timer, and the load never reached its page).
  const unanswered = { url: "http://127.0.0.1:1/a", at: 1000 };
  assert.equal(interruptedByOwnNavigation(login, [unanswered, { url: login, at: 1300 }], 1000), false);
  assert.equal(
    interruptedByOwnNavigation(
      login,
      [
        { ...unanswered, answeredAt: 1400 },
        { url: login, at: 1300 },
      ],
      1000,
    ),
    false,
  );
  // The interrupting navigation's own answer is never the load's, however soon it came.
  assert.equal(interruptedByOwnNavigation(login, [unanswered, { url: login, at: 1300, answeredAt: 1300 }], 1000), false);
  // Nor is the answer to a page loaded before this load began.
  assert.equal(
    interruptedByOwnNavigation(login, [{ url: "http://127.0.0.1:1/old", at: 500, answeredAt: 600 }, unanswered, { url: login, at: 1300 }], 1000),
    false,
  );
  // Another address started after the load is not the one named.
  assert.equal(interruptedByOwnNavigation(login, [load, { url: "http://127.0.0.1:1/other", at: 2000 }], 1000), false);
  // A fragment is never sent, so it is not compared.
  assert.equal(interruptedByOwnNavigation("http://127.0.0.1:1/b#top", [load, { url: "http://127.0.0.1:1/b", at: 2000 }], 1000), true);
});
