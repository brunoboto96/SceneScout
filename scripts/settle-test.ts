/**
 * When the engine stops waiting after an action.
 *
 * The rule replaced a flat 400 ms sleep on every action. Measured against the
 * demo app, that sleep was 54% of a snapshot's wall time and, on a run of two
 * hundred actions, over a minute of doing nothing — while still cutting off any
 * page that took longer than 400 ms to answer. These tests pin both halves:
 * fast when the page is quiet, patient when it is not, and never past the cap.
 *
 *   npx tsx --test scripts/settle-test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describePace,
  InFlightRequests,
  keepWatchingUrl,
  normalizePace,
  PACE_MAX_MS,
  QUIET_MS,
  SETTLE_CAP_MS,
  SETTLE_TICK_MS,
  settlePage,
  shouldKeepWaiting,
  stableUrlOf,
  URL_CAP_MS,
  URL_QUIET_MS,
} from "../src/engine/settle.ts";

const state = (over: Partial<Parameters<typeof shouldKeepWaiting>[0]> = {}) => ({
  inFlight: 0,
  sinceLastStartMs: QUIET_MS * 10,
  elapsedMs: QUIET_MS * 10,
  paceMs: 0,
  ...over,
});

test("a quiet page is read immediately — nothing in flight, nothing recent", () => {
  assert.equal(shouldKeepWaiting(state()), false);
});

test("the quiet window runs from the action too, not only from the last request", () => {
  // A click that posts to a service worker, which then fetches, makes no
  // request of its own: in flight is zero and the last request is ancient.
  // Reading the page there means the fetch lands during the NEXT action, which
  // is then blamed for it — which is how a worker-issued DELETE stopped being
  // reported against the click that caused it.
  assert.equal(shouldKeepWaiting(state({ elapsedMs: 0 })), true);
  assert.equal(shouldKeepWaiting(state({ elapsedMs: QUIET_MS - 1 })), true);
  assert.equal(shouldKeepWaiting(state({ elapsedMs: QUIET_MS })), false);
});

test("a request still out is waited for", () => {
  assert.equal(shouldKeepWaiting(state({ inFlight: 1 })), true);
  assert.equal(shouldKeepWaiting(state({ inFlight: 3, elapsedMs: 900 })), true);
});

test("a page that fires its XHR a tick after the click gets a quiet window", () => {
  // Nothing in flight yet — the request finished — but one started very
  // recently, so the page is still mid-change and must not be read.
  assert.equal(shouldKeepWaiting(state({ sinceLastStartMs: 0 })), true);
  assert.equal(shouldKeepWaiting(state({ sinceLastStartMs: QUIET_MS - 1 })), true);
  assert.equal(shouldKeepWaiting(state({ sinceLastStartMs: QUIET_MS })), false, "the window is exclusive");
});

test("the cap ends the wait however busy the page is", () => {
  // A page polling forever must not stall the run: the old constant survives
  // as a ceiling rather than a floor.
  assert.equal(shouldKeepWaiting(state({ inFlight: 5, elapsedMs: SETTLE_CAP_MS })), false);
  assert.equal(shouldKeepWaiting(state({ inFlight: 5, elapsedMs: SETTLE_CAP_MS - 1 })), true);
});

test("a pace the session asked for is a floor on the whole wait", () => {
  // Quiet page, but the session asked to be followable: keep waiting.
  assert.equal(shouldKeepWaiting(state({ paceMs: 5000, elapsedMs: 4999 })), true);
  assert.equal(shouldKeepWaiting(state({ paceMs: 5000, elapsedMs: 5000 })), false);
  // The floor outranks the cap — that is the point of asking for it.
  assert.ok(5000 > SETTLE_CAP_MS);
});

test("with no pace asked for, the wait is as short as the page allows", () => {
  assert.equal(shouldKeepWaiting(state({ paceMs: 0 })), false);
});

test("a pace is clamped: a negative or absurd value is a typo, not an instruction", () => {
  assert.equal(normalizePace(undefined), 0);
  assert.equal(normalizePace(0), 0);
  assert.equal(normalizePace(-1), 0);
  assert.equal(normalizePace(Number.NaN), 0);
  assert.equal(normalizePace(Number.POSITIVE_INFINITY), 0);
  assert.equal(normalizePace(1500.4), 1500);
  assert.equal(normalizePace(PACE_MAX_MS * 100), PACE_MAX_MS);
});

test("the attach result says nothing about pace unless one was asked for", () => {
  assert.equal(describePace(0), "");
  assert.match(describePace(5000), /5000 ms/);
  assert.match(describePace(5000), /paceMs: 0/, "it says how to undo itself");
});

// ── waiting for a redirect that has not happened yet ────────────────────────

test("a bounce verdict waits for the URL to hold still", () => {
  // A client-side auth guard issues NO request until its timer fires, so the
  // request-based rule above has nothing to wait on: the page goes quiet, the
  // URL is read, and the gated route is recorded as reached. This project's
  // own CI failed intermittently on exactly that, against a 40 ms timer that a
  // loaded macOS runner delayed past the quiet window.
  assert.equal(keepWatchingUrl({ sinceChangeMs: 0, elapsedMs: 0 }), true);
  assert.equal(keepWatchingUrl({ sinceChangeMs: URL_QUIET_MS - 1, elapsedMs: 500 }), true);
  assert.equal(keepWatchingUrl({ sinceChangeMs: URL_QUIET_MS, elapsedMs: 500 }), false, "held still long enough to be believed");
});

test("a page redirecting in a loop does not hold up the run", () => {
  // The window is a window, not a guarantee. A guard slower than the cap lands
  // after the verdict, and a page that never stops moving must still return.
  assert.equal(keepWatchingUrl({ sinceChangeMs: 0, elapsedMs: URL_CAP_MS }), false);
  assert.equal(keepWatchingUrl({ sinceChangeMs: 0, elapsedMs: URL_CAP_MS - 1 }), true);
  assert.ok(URL_QUIET_MS < URL_CAP_MS, "the cap must be reachable");
});

// ── which requests are in flight ─────────────────────────────────────────────
// A request whose document goes away after its headers arrived and before its
// body did gets neither a finished nor a failed event. Counted as a plain
// number, it stayed in flight forever and held every later wait to the cap.

const tracker = () => new InFlightRequests<string, string>();

test("requests are counted in and out by their own events", () => {
  const t = tracker();
  t.started("a", "main", false);
  t.started("b", "main", false);
  assert.equal(t.count, 2);
  t.ended("a");
  assert.equal(t.count, 1);
  t.ended("a");
  assert.equal(t.count, 1, "an end seen twice counts out once");
  t.ended("b");
  assert.equal(t.count, 0);
});

test("a frame that is removed takes its requests with it, and only its own", () => {
  const t = tracker();
  t.started("frame-fetch", "child", false);
  t.started("page-fetch", "main", false);
  t.started("worker-fetch", undefined, false);
  t.gone((f) => f === "child");
  assert.equal(t.count, 2);
  t.ended("frame-fetch");
  assert.equal(t.count, 2, "a late end for a dropped request does not count out another one");
});

test("a page that closes drops every frame it held", () => {
  const t = tracker();
  t.started("a", "page1/main", false);
  t.started("b", "page1/child", false);
  t.started("c", "page2/main", false);
  t.gone((f) => f.startsWith("page1/"));
  assert.equal(t.count, 1);
});

test("a frame that commits a navigation drops what its old document left, not what came after", () => {
  const t = tracker();
  t.started("old-fetch", "child", false);
  t.started("navigation", "child", true);
  t.started("other-frame", "main", false);
  t.navigated("child");
  assert.equal(t.count, 2, "the navigation itself and the other frame's request stay");
  t.started("new-fetch", "child", false);
  t.ended("navigation");
  assert.equal(t.count, 2);
  t.navigated("child");
  assert.equal(t.count, 2, "a later same-document change drops nothing the new document sent");
});

test("a same-document navigation (no navigation request) drops nothing", () => {
  const t = tracker();
  t.started("spa-fetch", "main", false);
  t.navigated("main");
  assert.equal(t.count, 1);
});

test("a navigation that failed is not the one a later same-document change is measured against", () => {
  const t = tracker();
  t.started("spa-fetch", "main", false);
  t.started("refused-navigation", "main", true);
  t.ended("refused-navigation", true);
  t.navigated("main");
  assert.equal(t.count, 1, "the fetch is still in flight and still waited for");
});

test("a redirect chain commits once, keeping the final hop", () => {
  const t = tracker();
  t.started("old-fetch", "main", false);
  t.started("hop-1", "main", true);
  t.ended("hop-1");
  t.started("hop-2", "main", true);
  t.navigated("main");
  assert.equal(t.count, 1);
  t.ended("hop-2");
  assert.equal(t.count, 0);
});

// ---- the waits themselves, on a stand-in page (settlePage, stableUrlOf) ----

/**
 * A stand-in for the page a wait reads: its URL, whether it is closed, and how often the wait looked again. Its clock
 * is its own: each tick the wait asks for advances it by exactly that tick and takes no real time, so these checks say
 * the same on any machine. A real 20 ms timer takes about 31 ms on Windows' default timer resolution, and a check that
 * counted ticks as time failed there.
 */
function standInPage(url = "http://app.test/a") {
  const page = {
    href: url,
    closed: false,
    loadWaits: 0,
    ticks: 0,
    /** The stand-in clock's time, in ms. */
    clock: 1_000_000,
    now: () => page.clock,
    onTick: () => {},
    async waitForLoadState(_state: "domcontentloaded") {
      page.loadWaits += 1;
    },
    async waitForTimeout(ms: number) {
      page.ticks += 1;
      page.clock += ms;
      await new Promise((resolve) => setImmediate(resolve));
      page.onTick();
    },
    url: () => page.href,
    isClosed: () => page.closed,
  };
  return page;
}

test("settlePage waits for the document, then returns once the quiet window after the action has passed", async () => {
  const page = standInPage();
  await settlePage(page, { inFlight: () => 0, lastRequestStart: () => 0, paceMs: () => 0, current: () => page }, page.now);
  assert.equal(page.loadWaits, 1);
  // The quiet window runs from the action as well (QUIET_MS): exactly long enough for it, not a tick more.
  assert.equal(page.ticks, Math.ceil(QUIET_MS / SETTLE_TICK_MS));
});

test("settlePage waits while a request is in flight, and stops when it lands", async () => {
  const page = standInPage();
  let inFlight = 1;
  page.onTick = () => {
    if (page.ticks === 10) inFlight = 0;
  };
  const started = page.clock;
  await settlePage(page, { inFlight: () => inFlight, lastRequestStart: () => started, paceMs: () => 0, current: () => page }, page.now);
  assert.equal(page.ticks, 10, "it returns on the first look after the request lands, the quiet window having passed while it was out");
});

test("settlePage gives up at the cap on a page that never goes quiet", async () => {
  const page = standInPage();
  const started = page.clock;
  await settlePage(page, { inFlight: () => 1, lastRequestStart: () => page.clock, paceMs: () => 0, current: () => page }, page.now);
  assert.equal(page.clock - started, SETTLE_CAP_MS);
});

test("settlePage stops waiting once the session has moved to another page", async () => {
  const page = standInPage();
  const other = standInPage();
  // Something is always in flight, so only the page changing ends the wait before the cap.
  await settlePage(page, { inFlight: () => 1, lastRequestStart: () => page.clock, paceMs: () => 0, current: () => other }, page.now);
  assert.equal(page.ticks, 1);
});

test("settlePage holds a page for the pace the session asked for, and no longer", async () => {
  const page = standInPage();
  const started = page.clock;
  await settlePage(page, { inFlight: () => 0, lastRequestStart: () => 0, paceMs: () => 300, current: () => page }, page.now);
  assert.equal(page.clock - started, 300);
});

test("settlePage reads the page even when its document wait fails", async () => {
  const page = standInPage();
  page.waitForLoadState = async () => {
    throw new Error("Target page, context or browser has been closed");
  };
  await settlePage(page, { inFlight: () => 0, lastRequestStart: () => 0, paceMs: () => 0, current: () => page }, page.now);
  // The same wait as on a page whose document wait succeeds.
  assert.equal(page.ticks, Math.ceil(QUIET_MS / SETTLE_TICK_MS));
});

test("stableUrlOf answers empty with no page, and a closed page's URL at once", async () => {
  assert.equal(await stableUrlOf(() => null), "");
  const page = standInPage("http://app.test/closed");
  page.closed = true;
  assert.equal(await stableUrlOf(() => page, page.now), "http://app.test/closed");
  assert.equal(page.ticks, 0);
});

test("stableUrlOf follows a late redirect and returns where it settled", async () => {
  const page = standInPage("http://app.test/private");
  let changedAt = 0;
  page.onTick = () => {
    if (page.ticks === 5) {
      page.href = "http://app.test/login";
      changedAt = page.clock;
    }
  };
  assert.equal(await stableUrlOf(() => page, page.now), "http://app.test/login");
  // It kept watching for the whole quiet window after the change, and returned as soon as it had passed.
  assert.equal(page.clock - changedAt, URL_QUIET_MS);
});

test("stableUrlOf stops at its cap on a URL that never holds still", async () => {
  const page = standInPage("http://app.test/0");
  const started = page.clock;
  page.onTick = () => {
    page.href = `http://app.test/${page.ticks}`;
  };
  await stableUrlOf(() => page, page.now);
  assert.equal(page.clock - started, URL_CAP_MS);
});

test("stableUrlOf returns the URL so far once the session leaves the page", async () => {
  const page = standInPage("http://app.test/a");
  let current: typeof page | null = page;
  page.onTick = () => {
    page.href = "http://app.test/b";
    current = null;
  };
  assert.equal(await stableUrlOf(() => current, page.now), "http://app.test/a");
  assert.equal(page.ticks, 1);
});
