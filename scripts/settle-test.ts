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
  ATTACH_URL_QUIET_MS,
  CRAWL_URL_HELD_MS,
  describePace,
  InFlightRequests,
  keepWatchingUrl,
  NAVIGATION_COMMIT_GRACE_MS,
  normalizePace,
  PACE_MAX_MS,
  QUIET_MS,
  RECHECK_BUSY_CAP_MS,
  RECHECK_CAP_MS,
  RECHECK_DRAWN_AGE_MS,
  RECHECK_EMPTY_AGE_MS,
  RECHECK_OPEN_MS,
  RECHECK_WAITS_MS,
  recheckWait,
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

test("a read after a settled action does not wait the quiet window again; a request since it does", () => {
  // A snapshot changes nothing on the page, so the action's quiet window is not run again from the read: the wait
  // before it already saw the page quiet, and only a request started since can make it busy again.
  assert.equal(shouldKeepWaiting(state({ elapsedMs: 0, read: true })), false);
  assert.equal(shouldKeepWaiting(state({ elapsedMs: 0, sinceLastStartMs: QUIET_MS - 1, read: true })), true);
  assert.equal(shouldKeepWaiting(state({ elapsedMs: 0, inFlight: 1, read: true })), true);
  // An action still gets it: that is where a request through a service worker comes from.
  assert.equal(shouldKeepWaiting(state({ elapsedMs: 0 })), true);
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

test("a bounce verdict waits while the page's own navigation is still on its way", () => {
  // A guard that has fired but whose sign-in page has not answered yet: the address has not changed, and a quiet window
  // read from the address alone ends before it does. Contrastive pair: the same quiet time, navigating or not.
  assert.equal(keepWatchingUrl({ sinceChangeMs: URL_QUIET_MS * 2, elapsedMs: 1000, navigating: true }), true);
  assert.equal(keepWatchingUrl({ sinceChangeMs: URL_QUIET_MS * 2, elapsedMs: 1000, navigating: false }), false);
  // Still bounded: a navigation that never answers does not hold the run past the cap.
  assert.equal(keepWatchingUrl({ sinceChangeMs: 0, elapsedMs: URL_CAP_MS, navigating: true }), false);
});

test("the attach's sign-in verdict watches the address for a longer quiet window", () => {
  // A guard that fires 600 ms after load passes the run's window and is caught by the attach's.
  assert.equal(keepWatchingUrl({ sinceChangeMs: 600, elapsedMs: 600 }), false);
  assert.equal(keepWatchingUrl({ sinceChangeMs: 600, elapsedMs: 600, quietMs: ATTACH_URL_QUIET_MS }), true);
  assert.equal(keepWatchingUrl({ sinceChangeMs: ATTACH_URL_QUIET_MS, elapsedMs: ATTACH_URL_QUIET_MS, quietMs: ATTACH_URL_QUIET_MS }), false);
  assert.ok(URL_QUIET_MS < ATTACH_URL_QUIET_MS && ATTACH_URL_QUIET_MS < URL_CAP_MS, "longer than the run's window, and within the cap");
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

test("settlePage holds the quiet window from a request that starts late, on the clock the request was stamped by", async () => {
  const page = standInPage();
  // A short request starts and lands between two looks, inside the action's own quiet window, so the window runs
  // on from the request rather than ending where the action's would.
  let lastStart = 0;
  page.onTick = () => {
    if (page.ticks === 3) lastStart = page.clock;
  };
  await settlePage(page, { inFlight: () => 0, lastRequestStart: () => lastStart, paceMs: () => 0, current: () => page }, page.now);
  assert.equal(page.ticks, 3 + Math.ceil(QUIET_MS / SETTLE_TICK_MS), `${page.ticks} ticks`);
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

test("stableUrlOf waits out a navigation in flight and returns where it committed", async () => {
  const page = standInPage("http://app.test/private");
  let navigating = true;
  page.onTick = () => {
    // The sign-in page answers well after the run's quiet window has passed.
    if (page.ticks === 40) {
      navigating = false;
      page.href = "http://app.test/login";
    }
  };
  assert.equal(await stableUrlOf(() => page, page.now, { navigating: () => navigating }), "http://app.test/login");
  // The contrast: the same page with nothing on its way is read after the quiet window, without the extra wait.
  const still = standInPage("http://app.test/private");
  const started = still.clock;
  assert.equal(await stableUrlOf(() => still, still.now, { navigating: () => false }), "http://app.test/private");
  assert.equal(still.clock - started, URL_QUIET_MS);
});

test("stableUrlOf takes the quiet window it is given", async () => {
  const page = standInPage("http://app.test/private");
  page.onTick = () => {
    if (page.clock - 1_000_000 === 600) page.href = "http://app.test/login";
  };
  assert.equal(await stableUrlOf(() => page, page.now, { quietMs: ATTACH_URL_QUIET_MS }), "http://app.test/login");
  const late = standInPage("http://app.test/private");
  late.onTick = () => {
    if (late.clock - 1_000_000 === 600) late.href = "http://app.test/login";
  };
  assert.equal(await stableUrlOf(() => late, late.now), "http://app.test/private", "the run's window ends before a 600 ms guard");
});

test("a crawl's watch counts from when the route's document arrived, not from when the watch began", async () => {
  // A route whose scripts send a signed-out visitor to sign-in 600 ms after its document arrived. How far into the
  // document's life the watch begins depends on the machine: the load, the settle before it and the timer all run
  // late on a loaded runner. The verdict must not.
  for (const ageAtWatch of [50, 150, 300, 550]) {
    const page = standInPage("http://app.test/private");
    const arrived = page.clock - ageAtWatch;
    page.onTick = () => {
      if (page.clock - arrived >= 600 && page.href.endsWith("/private")) page.href = "http://app.test/login";
    };
    assert.equal(
      await stableUrlOf(() => page, page.now, { quietMs: CRAWL_URL_HELD_MS, heldMs: ageAtWatch }),
      "http://app.test/login",
      `watch begun ${ageAtWatch} ms after the document arrived`,
    );
  }
  // The contrast: the run's window counted from the watch's start ends before the same guard when the watch began
  // early, which is what a crawl read with on a fast settle.
  const early = standInPage("http://app.test/private");
  const arrived = early.clock - 150;
  early.onTick = () => {
    if (early.clock - arrived >= 600) early.href = "http://app.test/login";
  };
  assert.equal(await stableUrlOf(() => early, early.now), "http://app.test/private");
  // A route whose address holds still is read once its document has been up CRAWL_URL_HELD_MS, no later...
  const still = standInPage("http://app.test/private");
  const start = still.clock;
  assert.equal(await stableUrlOf(() => still, still.now, { quietMs: CRAWL_URL_HELD_MS, heldMs: 200 }), "http://app.test/private");
  assert.equal(still.clock - start, CRAWL_URL_HELD_MS - 200);
  // ...and one already up that long is read at once.
  const old = standInPage("http://app.test/private");
  await stableUrlOf(() => old, old.now, { quietMs: CRAWL_URL_HELD_MS, heldMs: 5000 });
  assert.equal(old.ticks, 0);
  assert.ok(CRAWL_URL_HELD_MS < URL_CAP_MS, "within the cap");
});

test("a navigation request is on its way from its start until its frame commits it or it fails", () => {
  const t = tracker();
  assert.equal(t.navigating("main"), false);
  t.started("fetch", "main", false);
  assert.equal(t.navigating("main"), false, "a fetch is not a navigation");
  t.started("to-login", "main", true);
  assert.equal(t.navigating("main"), true);
  assert.equal(t.navigating("child"), false, "only the frame that sent it");
  t.navigated("main");
  assert.equal(t.navigating("main"), false, "committed");
  t.started("refused", "main", true);
  t.ended("refused", true);
  assert.equal(t.navigating("main"), false, "failed");
  // Finished, not yet committed: a document's body can end before its frame commits it, and the address has not moved.
  t.started("document", "main", true);
  t.ended("document", false, 5000);
  assert.equal(t.navigating("main", 5000 + NAVIGATION_COMMIT_GRACE_MS - 1), true, "finished, waiting for its commit");
  t.navigated("main");
  assert.equal(t.navigating("main", 5001), false, "committed");
  // Answered with no new document (a 204, a download): it finished and never commits, so once the grace has passed
  // nothing is on its way.
  t.started("no-content", "main", true);
  t.ended("no-content", false, 6000);
  assert.equal(t.navigating("main", 6000 + NAVIGATION_COMMIT_GRACE_MS), false);
  // Aborted: failed at once, never pending, grace or not.
  t.started("aborted", "main", true);
  t.ended("aborted", true, 7000);
  assert.equal(t.navigating("main", 7001), false);
  // A redirect: the first hop has finished, the second is on its way, however long after.
  t.started("hop-1", "main", true);
  t.ended("hop-1", false, 8000);
  t.started("hop-2", "main", true);
  assert.equal(t.navigating("main", 8000 + NAVIGATION_COMMIT_GRACE_MS * 10), true);
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

// ── re-reading the page's controls before a snapshot (snapshot-collect.ts) ──

const recheck = (over: Partial<Parameters<typeof recheckWait>[0]> = {}) =>
  recheckWait({ counts: [5], elapsedMs: 0, inFlight: 0, sinceLastStartMs: QUIET_MS * 10, ageMs: 60_000, ...over });

test("the re-check waits grow from a short first one, and two equal reads of a quiet page end it", () => {
  assert.deepEqual([...RECHECK_WAITS_MS], [50, 100, 200, 400]);
  assert.equal(recheck(), 50, "one re-check always: the first read may have caught the page mid-render");
  assert.equal(recheck({ counts: [5, 5], elapsedMs: 50 }), null);
  // The count moved: read again, after a longer wait.
  assert.equal(recheck({ counts: [3, 5], elapsedMs: 50 }), 100);
  assert.equal(recheck({ counts: [3, 5, 5], elapsedMs: 150 }), null);
  assert.equal(recheck({ counts: [1, 2, 3, 4], elapsedMs: 350 }), 400);
  assert.equal(recheck({ counts: [1, 2, 3, 4, 5], elapsedMs: 750 }), 250, "the last wait is cut to the cap");
  assert.equal(recheck({ counts: [1, 2, 3, 4, 5, 6], elapsedMs: RECHECK_CAP_MS }), null, "and a page that keeps changing is read at the cap");
});

test("an empty page that stays empty is stable after two reads; one rendering late is waited for", () => {
  // The old rule never counted an empty page stable and slept eight times on it (4 s per visit to a dead end).
  assert.equal(recheck({ counts: [0] }), 50);
  assert.equal(recheck({ counts: [0, 0], elapsedMs: 50 }), null, "quiet and still empty: nothing is coming");
  // The same page with its data still on the way: not stable while a request is out or has just started.
  assert.equal(recheck({ counts: [0, 0], elapsedMs: 50, inFlight: 1 }), 100);
  assert.equal(recheck({ counts: [0, 0], elapsedMs: 50, sinceLastStartMs: QUIET_MS - 1 }), 100);
  // ...and it renders: two equal reads once quiet end the wait.
  assert.equal(recheck({ counts: [0, 0, 7], elapsedMs: 150 }), 200);
  assert.equal(recheck({ counts: [0, 0, 7, 7], elapsedMs: 350 }), null);
});

test("a page whose shell is drawn while its content loads is not stable while its requests are out", () => {
  // Navigation and a sidebar already listed, the route's own controls on their way: equal counts are not enough.
  assert.equal(recheck({ counts: [12, 12], elapsedMs: 50, inFlight: 2 }), 100);
  assert.equal(recheck({ counts: [12, 12, 12, 12, 12], elapsedMs: 750, inFlight: 2 }), 400, "busy, it may go past the quiet cap");
  assert.equal(recheck({ counts: [12, 12], elapsedMs: RECHECK_BUSY_CAP_MS, inFlight: 2 }), null, "but never past its own");
  assert.ok(RECHECK_BUSY_CAP_MS > RECHECK_CAP_MS && RECHECK_BUSY_CAP_MS <= 4000, "no longer than the old eight re-checks of an empty page");
});

test("two equal reads count only when both were taken while the page was quiet", () => {
  // The first of the pair was read while the data was still on its way, the second just after it landed and before
  // the app drew it: equal, but the shell twice. One more read, now quiet, decides.
  assert.equal(recheck({ counts: [12, 12], busyAt: [true, false], elapsedMs: 50 }), 100);
  assert.equal(recheck({ counts: [12, 12, 12], busyAt: [true, false, false], elapsedMs: 150 }), null);
});

test("a request the page keeps open for its life (a stream, a long poll) stops counting once it is old", () => {
  const t = tracker();
  t.started("stream", "top", false, 0);
  t.started("data", "top", false, RECHECK_OPEN_MS);
  assert.equal(t.count, 2);
  // At RECHECK_OPEN_MS + 50: the stream is old, the data request young.
  assert.equal(t.openWithin(RECHECK_OPEN_MS, RECHECK_OPEN_MS + 50), 1);
  t.ended("data");
  assert.equal(t.openWithin(RECHECK_OPEN_MS, RECHECK_OPEN_MS + 50), 0, "only the stream is left, and it is the page's way of working");
  // So a page with only an old stream out reads as quiet, and equal reads end the wait.
  assert.equal(recheck({ counts: [12, 12], elapsedMs: 50, inFlight: t.openWithin(RECHECK_OPEN_MS, RECHECK_OPEN_MS + 50) }), null);
});

test("a page that has just loaded or just been acted on is not taken as read before it has had time to draw", () => {
  // A single-page app draws its route's content from a timer, with no request to wait on. Two equal quiet reads of the
  // shell 50 ms apart prove nothing about a page that loaded 170 ms ago; the same reads of a page up for a while do.
  assert.equal(typeof recheck({ counts: [2, 2], elapsedMs: 50, ageMs: 170 }), "number", "the shell, just loaded: read again");
  assert.equal(recheck({ counts: [2, 2], elapsedMs: 50, ageMs: RECHECK_DRAWN_AGE_MS }), null, "the same reads, the page up long enough");
  assert.equal(recheck({ counts: [2, 2], elapsedMs: 50, ageMs: RECHECK_DRAWN_AGE_MS - 30 }), 30, "the next read is when the page is old enough, not later");
  // Young, a quiet page may be read past the quiet cap until it is old enough, never past the busy cap.
  assert.equal(typeof recheck({ counts: [2, 2], elapsedMs: RECHECK_CAP_MS, ageMs: RECHECK_DRAWN_AGE_MS - 1 }), "number");
  assert.equal(recheck({ counts: [2, 2], elapsedMs: RECHECK_BUSY_CAP_MS, ageMs: 0 }), null);
});

test("an empty page is not taken as a dead end until it has been up as long as the old rule gave it", () => {
  // An empty shell that draws everything from a timer: two empty reads soon after the load are not a dead end.
  assert.equal(typeof recheck({ counts: [0, 0], elapsedMs: 50, ageMs: 200 }), "number");
  assert.equal(typeof recheck({ counts: [0, 0], elapsedMs: 50, ageMs: RECHECK_DRAWN_AGE_MS }), "number", "a drawn page's age is not enough for an empty one");
  assert.equal(recheck({ counts: [0, 0], elapsedMs: 50, ageMs: RECHECK_EMPTY_AGE_MS }), null, "empty and up that long: it is what it is");
  // ...and once it draws, the drawn page's age applies.
  assert.equal(recheck({ counts: [0, 0, 5, 5], elapsedMs: 750, ageMs: 900 }), null);
  assert.ok(RECHECK_EMPTY_AGE_MS <= RECHECK_BUSY_CAP_MS, "the empty page's wait fits within the re-reads' own cap");
});
