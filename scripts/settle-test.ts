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
import vm from "node:vm";
import {
  AnsweredEnds,
  answerMayMovePage,
  ATTACH_URL_QUIET_MS,
  CRAWL_URL_HELD_MS,
  describePace,
  InFlightRequests,
  keepWaitingForNavigation,
  keepWatchingUrl,
  NAVIGATION_COMMIT_GRACE_MS,
  navigationAnswersPage,
  normalizePace,
  ownNavigationLanded,
  pageClockScript,
  PACE_MAX_MS,
  PAGE_COMMIT_CAP_MS,
  QUIET_MS,
  RECHECK_BUSY_CAP_MS,
  RECHECK_CAP_MS,
  RECHECK_DRAWN_AGE_MS,
  RECHECK_EMPTY_AGE_MS,
  RECHECK_OPEN_MS,
  RECHECK_WAITS_MS,
  recheckWait,
  seenWithin,
  SETTLE_CAP_MS,
  SETTLE_TICK_MS,
  settlePage,
  shouldKeepWaiting,
  stableUrlOf,
  URL_CAP_MS,
  URL_LEAVING_GRACE_MS,
  URL_NAVIGATING_CAP_MS,
  URL_PAGE_CLOCK_CAP_MS,
  URL_QUIET_MS,
} from "../src/engine/settle.ts";

const state = (over: Partial<Parameters<typeof shouldKeepWaiting>[0]> = {}) => ({
  inFlight: 0,
  sinceLastStartMs: QUIET_MS * 10,
  elapsedMs: QUIET_MS * 10,
  sinceLastAnsweredEndMs: QUIET_MS * 10,
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

test("a request whose answer just arrived and ended gets a quiet window, finished or cancelled", () => {
  // A page acts on an answer once it has arrived, and by then the request is over: a small answer finishes as it
  // arrives, WebKit on Linux hands the page an answer only once its body has ended, and WebKit and Firefox cancel a
  // document's open requests as a navigation starts and report the navigation's own request after that. Between the
  // end and what the page does next, nothing is in flight and the last start is old, yet the page is on its way.
  assert.equal(shouldKeepWaiting(state({ sinceLastAnsweredEndMs: 0 })), true);
  assert.equal(shouldKeepWaiting(state({ sinceLastAnsweredEndMs: QUIET_MS - 1 })), true);
  assert.equal(shouldKeepWaiting(state({ sinceLastAnsweredEndMs: QUIET_MS })), false, "the window is exclusive");
  // The same moment with no answered request ending recently: the page is quiet.
  assert.equal(shouldKeepWaiting(state()), false);
  // Before a read too: an answer is the page changing, not the action.
  assert.equal(shouldKeepWaiting(state({ elapsedMs: 0, sinceLastAnsweredEndMs: 0, read: true })), true);
  // And never past the cap.
  assert.equal(shouldKeepWaiting(state({ elapsedMs: SETTLE_CAP_MS, sinceLastAnsweredEndMs: 0 })), false);
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
  // Past the cap for an address that keeps moving, a navigation on its way is still waited for: whether the sign-in
  // page's request started in the settle before the watch or just after it must not decide the verdict. Contrastive
  // pair at the same moment, navigating or not.
  assert.equal(keepWatchingUrl({ sinceChangeMs: URL_CAP_MS, elapsedMs: URL_CAP_MS, navigating: true }), true);
  assert.equal(keepWatchingUrl({ sinceChangeMs: URL_CAP_MS, elapsedMs: URL_CAP_MS, navigating: false }), false);
  // Still bounded: a navigation that never answers does not hold the run past its own cap.
  assert.equal(keepWatchingUrl({ sinceChangeMs: 0, elapsedMs: URL_NAVIGATING_CAP_MS - 1, navigating: true }), true);
  assert.equal(keepWatchingUrl({ sinceChangeMs: 0, elapsedMs: URL_NAVIGATING_CAP_MS, navigating: true }), false);
  assert.ok(URL_CAP_MS < URL_NAVIGATING_CAP_MS, "a navigation on its way is given longer than an address that keeps moving");
});

test("the attach's sign-in verdict watches the address for a longer quiet window", () => {
  // A guard that fires 600 ms after load passes the run's window and is caught by the attach's.
  assert.equal(keepWatchingUrl({ sinceChangeMs: 600, elapsedMs: 600 }), false);
  assert.equal(keepWatchingUrl({ sinceChangeMs: 600, elapsedMs: 600, quietMs: ATTACH_URL_QUIET_MS }), true);
  assert.equal(keepWatchingUrl({ sinceChangeMs: ATTACH_URL_QUIET_MS, elapsedMs: ATTACH_URL_QUIET_MS, quietMs: ATTACH_URL_QUIET_MS }), false);
  assert.ok(URL_QUIET_MS < ATTACH_URL_QUIET_MS && ATTACH_URL_QUIET_MS < URL_CAP_MS, "longer than the run's window, and within the cap");
});

test("a sign-in verdict waits while the page's own clock is behind the quiet window", () => {
  // A 40 ms guard on a page whose timers run late (its own long task, a loaded runner): by the wall clock the address has
  // held still for the attach's window, while the guard has not run yet. Contrastive pair at the same moment: the page
  // behind, or caught up.
  const held = { sinceChangeMs: ATTACH_URL_QUIET_MS + 200, elapsedMs: ATTACH_URL_QUIET_MS + 200, quietMs: ATTACH_URL_QUIET_MS };
  assert.equal(keepWatchingUrl({ ...held, pageBehind: true }), true);
  assert.equal(keepWatchingUrl({ ...held, pageBehind: false }), false);
  assert.equal(keepWatchingUrl(held), false, "no page clock asked for: the wall clock alone, as before");
  // Bounded: a page whose main thread never comes back still returns, later than an address that keeps moving.
  assert.equal(keepWatchingUrl({ sinceChangeMs: 0, elapsedMs: URL_PAGE_CLOCK_CAP_MS - 1, pageBehind: true }), true);
  assert.equal(keepWatchingUrl({ sinceChangeMs: 0, elapsedMs: URL_PAGE_CLOCK_CAP_MS, pageBehind: true }), false);
  assert.ok(URL_CAP_MS < URL_PAGE_CLOCK_CAP_MS && URL_PAGE_CLOCK_CAP_MS < URL_NAVIGATING_CAP_MS);
});

test("a sign-in verdict waits for a page that has begun to leave until its navigation is seen", () => {
  // The guard ran and the page fired beforeunload, but the navigation's request has not been reported yet: the address
  // is unchanged and nothing is on its way. Contrastive pair: left or not, at the same moment.
  const held = { sinceChangeMs: URL_QUIET_MS * 2, elapsedMs: URL_QUIET_MS * 2 };
  assert.equal(keepWatchingUrl({ ...held, leftForMs: 20 }), true);
  assert.equal(keepWatchingUrl(held), false);
  // A navigation that never shows (a 204, a download) holds the watch no longer than the grace.
  assert.equal(keepWatchingUrl({ ...held, leftForMs: URL_LEAVING_GRACE_MS - 1 }), true);
  assert.equal(keepWatchingUrl({ ...held, leftForMs: URL_LEAVING_GRACE_MS }), false);
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
  await settlePage(page, { inFlight: () => 0, lastRequestStart: () => 0, lastAnsweredEnd: () => 0, paceMs: () => 0, current: () => page }, page.now);
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
  await settlePage(
    page,
    { inFlight: () => inFlight, lastRequestStart: () => started, lastAnsweredEnd: () => 0, paceMs: () => 0, current: () => page },
    page.now,
  );
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
  await settlePage(page, { inFlight: () => 0, lastRequestStart: () => lastStart, lastAnsweredEnd: () => 0, paceMs: () => 0, current: () => page }, page.now);
  assert.equal(page.ticks, 3 + Math.ceil(QUIET_MS / SETTLE_TICK_MS), `${page.ticks} ticks`);
});

test("an answered request that was cancelled, or finished on an answer a page may leave on, is counted; one aborted before its answer, finished on a routine answer or refused is not", () => {
  const at = 5000;
  const finished = { id: 0 };
  const ends = new AnsweredEnds<object>();
  ends.answer(finished, 401);
  ends.finished(finished, false, at - 10);
  assert.equal(ends.last, at - 10, "a request that finished on a 401: a guard sends the page to sign-in on that answer");
  const cancelledAfterAnswer = { id: 1 };
  ends.answer(cancelledAfterAnswer, 200);
  ends.failed(cancelledAfterAnswer, true, false, at);
  assert.equal(ends.last, at, "a request cancelled with its answer in is what a navigation leaves");
  // Each near miss differs from one of those in one fact, and none moves the time.
  const beforeAnswer = { id: 2 };
  ends.failed(beforeAnswer, true, false, at + 10);
  assert.equal(ends.last, at, "cancelled before its answer: the page's own abort (a search box, a status check's timeout)");
  const refused = { id: 3 };
  ends.answer(refused, 401);
  ends.failed(refused, true, true, at + 20);
  assert.equal(ends.last, at, "refused by the write policy");
  const lost = { id: 4 };
  ends.answer(lost, 401);
  ends.failed(lost, false, false, at + 30);
  assert.equal(ends.last, at, "failed with its answer in, but not cancelled (a lost connection)");
  const refusedFinished = { id: 5 };
  ends.answer(refusedFinished, 401);
  ends.finished(refusedFinished, true, at + 40);
  assert.equal(ends.last, at, "finished, but it was the write policy that answered it");
  const routine = { id: 6 };
  ends.answer(routine, 200);
  ends.finished(routine, false, at + 50);
  assert.equal(ends.last, at, "finished on a 200: a poll or a beacon, which a page does not leave on");
  assert.equal(new AnsweredEnds<object>().last, 0, "none yet");
});

/** A wait driven through the same recorder the engine feeds (AnsweredEnds), on the stand-in clock. */
function settleThrough(page: ReturnType<typeof standInPage>, s: { inFlight: () => number; lastStart: () => number }, ends: AnsweredEnds<object>) {
  return settlePage(
    page,
    { inFlight: s.inFlight, lastRequestStart: s.lastStart, lastAnsweredEnd: () => ends.last, paceMs: () => 0, current: () => page },
    page.now,
  );
}

test("settlePage waits through the gap between a request's answer ending and the redirect the page starts on it", async () => {
  // A redirect a page starts on a request's answer comes after the request has ended, in one of two orders. Finished:
  // a small answer, or WebKit on Linux, which hands the page an answer only once its body has ended, so the page acts
  // on it only after the request has finished. Cancelled: the answer arrived with the body still open, and WebKit and
  // Firefox cancel the request as the redirect starts. Either way the navigation's own request comes a few ticks
  // later, and read in that gap the page is still on the address it is leaving.
  const run = async (ending: "finished with its answer" | "cancelled after its answer" | "cancelled before its answer", follows: boolean) => {
    const page = standInPage();
    const ends = new AnsweredEnds<object>();
    const check = { id: "session-check" };
    let inFlight = 1;
    let lastStart = page.clock;
    let navigationSeenAt = -1;
    if (ending !== "cancelled before its answer") ends.answer(check, 401);
    page.onTick = () => {
      if (page.ticks === 10) {
        inFlight = 0;
        if (ending === "finished with its answer") ends.finished(check, false, page.clock);
        else ends.failed(check, true, false, page.clock);
      }
      if (follows && page.ticks === 13) {
        inFlight = 1;
        lastStart = page.clock;
        navigationSeenAt = page.ticks;
      }
      if (page.ticks === 15) inFlight = 0;
    };
    await settleThrough(page, { inFlight: () => inFlight, lastStart: () => lastStart }, ends);
    return { ticks: page.ticks, navigationSeenAt };
  };
  for (const ending of ["finished with its answer", "cancelled after its answer"] as const) {
    const redirected = await run(ending, true);
    assert.equal(redirected.navigationSeenAt, 13, `${ending}: the navigation's request is seen inside the wait`);
    assert.equal(redirected.ticks, 13 + Math.ceil(QUIET_MS / SETTLE_TICK_MS), `${ending}: ${redirected.ticks} ticks`);
    // Nothing follows: the wait ends QUIET_MS after the answer, not on the first look after it.
    assert.equal((await run(ending, false)).ticks, 10 + Math.ceil(QUIET_MS / SETTLE_TICK_MS), `${ending}, nothing follows`);
  }
  // Contrast: the page aborted the request before its answer, and nothing follows; the wait ends on the first look.
  assert.equal((await run("cancelled before its answer", false)).ticks, 10);
});

test("settlePage is not held to the cap by a page that polls with a timeout shorter than its answer", async () => {
  // A status check every 240 ms, aborted by its own 140 ms timeout before the server answers: each abort is followed
  // within QUIET_MS by the next check. Counted as cancellations, the windows join up and every wait runs to the cap.
  const page = standInPage();
  const cancels = new AnsweredEnds<object>();
  let open: object | null = null;
  let lastStart = 0;
  const poll = () => {
    const tick = page.ticks % 12;
    if (tick === 1) {
      open = { at: page.clock };
      lastStart = page.clock;
    }
    if (tick === 8 && open) {
      cancels.failed(open, true, false, page.clock);
      open = null;
    }
  };
  page.onTick = poll;
  poll();
  const started = page.clock;
  await settleThrough(page, { inFlight: () => (open ? 1 : 0), lastStart: () => lastStart }, cancels);
  assert.equal(page.ticks, 8, `returns on the first look after the check is aborted, at ${page.clock - started} ms`);
});

test("which finished answers a page may move on", () => {
  for (const status of [301, 302, 303, 307, 308, 401, 403, 419, 440]) assert.equal(answerMayMovePage(status), true, String(status));
  for (const status of [200, 201, 204, 206, 304, 400, 404, 409, 422, 429, 500, 503]) assert.equal(answerMayMovePage(status), false, String(status));
});

test("a page polling every 250 ms is not held to the cap by its answers, unless they are ones a page leaves on", async () => {
  // A poll every 250 ms (12 ticks of 20 ms, near enough), answered in 160 ms: each answer ends less than QUIET_MS
  // before the next poll starts. Answered 200, as a status poll, a beacon or a chat widget's check is, the wait ends
  // in the gap between polls, as it does for a page that sent nothing. Answered 401, every poll is one the page may
  // leave on, the windows join up, and the wait runs to the cap: held there, and no longer.
  const run = async (status: number) => {
    const page = standInPage();
    const ends = new AnsweredEnds<object>();
    let open: object | null = null;
    let lastStart = 0;
    const poll = () => {
      const tick = page.ticks % 12;
      if (tick === 1) {
        open = { at: page.clock };
        lastStart = page.clock;
      }
      if (tick === 9 && open) {
        ends.answer(open, status);
        ends.finished(open, false, page.clock);
        open = null;
      }
    };
    page.onTick = poll;
    poll();
    const started = page.clock;
    await settleThrough(page, { inFlight: () => (open ? 1 : 0), lastStart: () => lastStart }, ends);
    return page.clock - started;
  };
  const routine = await run(200);
  assert.ok(routine < SETTLE_CAP_MS / 4, `answered 200: the wait ends between polls, at ${routine} ms`);
  assert.equal(await run(401), SETTLE_CAP_MS, "answered 401: held to the cap, and no longer");
});

test("settlePage gives up at the cap on a page that never goes quiet", async () => {
  const page = standInPage();
  const started = page.clock;
  await settlePage(page, { inFlight: () => 1, lastRequestStart: () => page.clock, lastAnsweredEnd: () => 0, paceMs: () => 0, current: () => page }, page.now);
  assert.equal(page.clock - started, SETTLE_CAP_MS);
});

test("settlePage stops waiting once the session has moved to another page", async () => {
  const page = standInPage();
  const other = standInPage();
  // Something is always in flight, so only the page changing ends the wait before the cap.
  await settlePage(page, { inFlight: () => 1, lastRequestStart: () => page.clock, lastAnsweredEnd: () => 0, paceMs: () => 0, current: () => other }, page.now);
  assert.equal(page.ticks, 1);
});

test("settlePage holds a page for the pace the session asked for, and no longer", async () => {
  const page = standInPage();
  const started = page.clock;
  await settlePage(page, { inFlight: () => 0, lastRequestStart: () => 0, lastAnsweredEnd: () => 0, paceMs: () => 300, current: () => page }, page.now);
  assert.equal(page.clock - started, 300);
});

test("settlePage reads the page even when its document wait fails", async () => {
  const page = standInPage();
  page.waitForLoadState = async () => {
    throw new Error("Target page, context or browser has been closed");
  };
  await settlePage(page, { inFlight: () => 0, lastRequestStart: () => 0, lastAnsweredEnd: () => 0, paceMs: () => 0, current: () => page }, page.now);
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

test("stableUrlOf waits for a navigation that starts just after the watch began and answers after the 3 s cap", async () => {
  // The flake this pins (Firefox, a loaded runner): the guard's request to a slow sign-in page started a few
  // milliseconds after the settle before the watch had gone quiet, so the watch began with nothing on its way, and its
  // 3 s cap ended it while the sign-in page (answering in 3.5 s) was still on its way. The stale profile passed as
  // signed in. Contrastive pair: the same page and timing with nothing on its way is read at the cap as it was.
  const tick = (ms: number) => Math.round(ms / SETTLE_TICK_MS);
  const page = standInPage("http://app.test/private");
  let navigating = false;
  page.onTick = () => {
    if (page.ticks === 1) navigating = true;
    if (page.ticks === tick(3500) + 1) {
      navigating = false;
      page.href = "http://app.test/login";
    }
  };
  const started = page.clock;
  assert.equal(await stableUrlOf(() => page, page.now, { navigating: () => navigating, quietMs: ATTACH_URL_QUIET_MS }), "http://app.test/login");
  assert.ok(page.clock - started > URL_CAP_MS, "the watch ran past the 3 s cap while the navigation was on its way");
  // A sign-in page that never answers holds the watch no longer than its own cap.
  const hung = standInPage("http://app.test/private");
  const hungStart = hung.clock;
  assert.equal(await stableUrlOf(() => hung, hung.now, { navigating: () => hung.ticks >= 1 }), "http://app.test/private");
  assert.equal(hung.clock - hungStart, URL_NAVIGATING_CAP_MS);
  // The contrast: nothing on its way, and an address that keeps moving, ends at the 3 s cap.
  const moving = standInPage("http://app.test/a");
  const movingStart = moving.clock;
  moving.onTick = () => {
    moving.href = `http://app.test/hop-${moving.ticks}`;
  };
  await stableUrlOf(() => moving, moving.now, { navigating: () => false });
  assert.equal(moving.clock - movingStart, URL_CAP_MS);
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

test("stableUrlOf, given the page's clock, waits for a guard the page runs late and returns the sign-in page", async () => {
  // The page answers its clock 2 s late (its timers held back); its guard ran in that time, so it reports it began to
  // leave, and the address changes 100 ms after. Contrastive pair: the same page and timing, its guard finding a sign-in.
  const lateClock = (page: ReturnType<typeof standInPage>, leaves: boolean) => {
    const asked: number[] = [];
    let answer: (r: { leaving: boolean }) => void = () => {};
    const started = page.clock;
    page.onTick = () => {
      if (page.clock - started === 2000) answer({ leaving: leaves });
      if (leaves && page.clock - started === 2100) page.href = "http://app.test/login";
    };
    const clock = (ms: number) => {
      asked.push(ms);
      return new Promise<{ leaving: boolean }>((resolve) => {
        answer = resolve;
      });
    };
    return { clock, asked };
  };
  const stale = standInPage("http://app.test/private");
  const s = lateClock(stale, true);
  assert.equal(await stableUrlOf(() => stale, stale.now, { quietMs: ATTACH_URL_QUIET_MS, pageClock: s.clock }), "http://app.test/login");
  assert.deepEqual(s.asked, [ATTACH_URL_QUIET_MS], "the page is asked for the whole window on its own clock");
  const fresh = standInPage("http://app.test/private");
  const f = lateClock(fresh, false);
  const started = fresh.clock;
  assert.equal(await stableUrlOf(() => fresh, fresh.now, { quietMs: ATTACH_URL_QUIET_MS, pageClock: f.clock }), "http://app.test/private");
  assert.ok(fresh.clock - started >= 2000 && fresh.clock - started <= 2000 + 2 * SETTLE_TICK_MS, "read once the page caught up, no later");
  // The old rule: the wall clock alone reads the page before its guard runs.
  const wall = standInPage("http://app.test/private");
  lateClock(wall, true);
  assert.equal(await stableUrlOf(() => wall, wall.now, { quietMs: ATTACH_URL_QUIET_MS }), "http://app.test/private");
});

test("stableUrlOf, given the page's clock, costs a page that keeps time nothing more, and asks only for what is left", async () => {
  const page = standInPage("http://app.test/private");
  const started = page.clock;
  // A page that keeps time answers as the window ends.
  const clock = (ms: number) =>
    new Promise<{ leaving: boolean }>((resolve) => {
      page.onTick = () => {
        if (page.clock - started >= ms) resolve({ leaving: false });
      };
    });
  assert.equal(await stableUrlOf(() => page, page.now, { quietMs: ATTACH_URL_QUIET_MS, pageClock: clock }), "http://app.test/private");
  assert.ok(page.clock - started <= ATTACH_URL_QUIET_MS + SETTLE_TICK_MS);
  // A crawl's route already up for part of the window is asked for the rest; a page whose document is gone answers by rejecting.
  const asked: number[] = [];
  const route = standInPage("http://app.test/private");
  const routeStarted = route.clock;
  await stableUrlOf(() => route, route.now, {
    quietMs: CRAWL_URL_HELD_MS,
    heldMs: 300,
    pageClock: (ms) => {
      asked.push(ms);
      return Promise.reject(new Error("Execution context was destroyed"));
    },
  });
  assert.deepEqual(asked, [CRAWL_URL_HELD_MS - 300]);
  assert.ok(
    route.clock - routeStarted <= CRAWL_URL_HELD_MS - 300 + SETTLE_TICK_MS,
    "a rejected probe leaves the wall window to decide, not the page-clock cap",
  );
  const old = standInPage("http://app.test/private");
  await stableUrlOf(() => old, old.now, { quietMs: CRAWL_URL_HELD_MS, heldMs: 5000, pageClock: (ms) => (asked.push(ms), Promise.resolve({ leaving: false })) });
  assert.equal(asked.at(-1), 0);
  assert.ok(old.ticks <= 1, "a route up longer than the window is read on the first look after the page answers");
});

test("stableUrlOf, once the address changes after the page began to leave, holds the quiet window and not the leaving grace", async () => {
  const page = standInPage("http://app.test/private");
  const started = page.clock;
  page.onTick = () => {
    if (page.clock - started === 100) page.href = "http://app.test/login";
  };
  const got = await stableUrlOf(() => page, page.now, { pageClock: () => Promise.resolve({ leaving: true }) });
  assert.equal(got, "http://app.test/login");
  assert.ok(page.clock - started <= 100 + URL_QUIET_MS + SETTLE_TICK_MS, `read once the new address held still, at ${page.clock - started} ms`);
});

test("pageClockScript answers after its timer, saying whether the page began to leave meanwhile", async () => {
  const run = async (leave: boolean) => {
    const target = new EventTarget();
    const timers: (() => void)[] = [];
    const delays: number[] = [];
    const context = vm.createContext({
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      setTimeout: (fn: () => void, ms: number) => {
        delays.push(ms);
        timers.push(fn);
      },
      Promise,
    });
    const answer = vm.runInContext(pageClockScript(700.4), context) as Promise<{ leaving: boolean }>;
    if (leave) target.dispatchEvent(new Event("beforeunload"));
    timers.shift()!();
    const got = await answer;
    // Once answered it listens no more.
    target.dispatchEvent(new Event("beforeunload"));
    // The answer was made in the page's realm: compared by its fields.
    return { got: { leaving: got.leaving }, delays: [...delays] };
  };
  assert.deepEqual(await run(true), { got: { leaving: true }, delays: [700] });
  assert.deepEqual(await run(false), { got: { leaving: false }, delays: [700] });
  // Chromium runs a 0 ms timer ahead of earlier timers already overdue; from 1 ms on, all three engines run them by deadline.
  assert.equal(pageClockScript(-5).includes("}, 1);"), true, "a window already passed still waits behind the page's overdue timers");
  assert.equal(pageClockScript(0).includes("}, 1);"), true);
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

test("which navigation answers are a page their frame will commit", () => {
  const html = { "content-type": "text/html; charset=utf-8" };
  assert.equal(navigationAnswersPage(200, html), true);
  assert.equal(navigationAnswersPage(200, { "content-type": "application/XHTML+xml" }), true);
  assert.equal(navigationAnswersPage(404, html), true, "an error page is still a page");
  assert.equal(navigationAnswersPage(500, html), true);
  assert.equal(navigationAnswersPage(302, { ...html, location: "/login" }), false, "a redirect hop: the answer is still to come");
  assert.equal(navigationAnswersPage(204, html), false, "no content: nothing to commit");
  assert.equal(navigationAnswersPage(205, html), false);
  assert.equal(navigationAnswersPage(200, { ...html, "content-disposition": "attachment; filename=a.html" }), false, "a download");
  assert.equal(navigationAnswersPage(200, { ...html, "content-disposition": "inline" }), true);
  assert.equal(navigationAnswersPage(200, { "content-type": "application/pdf" }), false, "a file");
  assert.equal(navigationAnswersPage(200, { "content-type": "application/json" }), false);
  assert.equal(navigationAnswersPage(200, {}), false, "no content type is not taken for a page");
});

test("a navigation answered with a page is on its way until its frame commits it, however late the commit is reported (#726)", () => {
  // Firefox reports a navigation's request finishing and its frame committing the page separately; on a loaded
  // machine the commit came more than NAVIGATION_COMMIT_GRACE_MS after the finish. Counted as no longer on its way,
  // the attach's URL watch then ended on the address before the page's redirect to sign-in. Contrastive pair: the
  // same timing for an answer that is not a page (a 204) is not on its way once the grace has passed.
  const t = tracker();
  t.started("to-login", "main", true);
  t.answered("to-login", true);
  t.ended("to-login", false, 1000);
  assert.equal(t.navigating("main", 1000 + NAVIGATION_COMMIT_GRACE_MS + 1500), true, "finished, its commit not yet reported");
  t.navigated("main");
  assert.equal(t.navigating("main", 1000 + NAVIGATION_COMMIT_GRACE_MS + 1501), false, "committed");
  t.started("no-content", "main", true);
  t.answered("no-content", false);
  t.ended("no-content", false, 5000);
  assert.equal(t.navigating("main", 5000 + NAVIGATION_COMMIT_GRACE_MS), false, "a 204 never commits");
  // A page whose commit never arrives is on its way no longer than PAGE_COMMIT_CAP_MS.
  t.started("never-commits", "main", true);
  t.answered("never-commits", true);
  t.ended("never-commits", false, 9000);
  assert.equal(t.navigating("main", 9000 + PAGE_COMMIT_CAP_MS - 1), true);
  assert.equal(t.navigating("main", 9000 + PAGE_COMMIT_CAP_MS), false);
  // A redirect hop answered first, then the page it leads to: the hop is not the page, the page is.
  t.started("hop", "main", true);
  t.answered("hop", false);
  t.ended("hop", false, 20_000);
  t.started("landing", "main", true);
  t.answered("landing", true);
  t.ended("landing", false, 20_010);
  assert.equal(t.navigating("main", 20_010 + NAVIGATION_COMMIT_GRACE_MS * 3), true);
  // Only a navigation answered with a page is committing: one still waiting for its answer, or answered with a 204, is not.
  t.started("waiting", "main", true);
  assert.equal(t.committing("main", 20_020), false, "no answer yet");
  t.answered("waiting", true);
  assert.equal(t.committing("main", 20_021), true, "answered with a page, its body still arriving");
  t.ended("waiting", false, 20_030);
  assert.equal(t.committing("main", 20_030 + NAVIGATION_COMMIT_GRACE_MS * 3), true, "finished, its commit not yet reported");
  t.navigated("main");
  assert.equal(t.committing("main", 20_031), false, "committed");
  t.started("empty", "main", true);
  t.answered("empty", false);
  t.ended("empty", false, 20_040);
  assert.equal(t.committing("main", 20_041), false, "a 204 has nothing to commit");
  t.started("never-committed", "main", true);
  t.answered("never-committed", true);
  t.ended("never-committed", false, 30_000);
  assert.equal(t.committing("main", 30_000 + PAGE_COMMIT_CAP_MS - 1), true);
  assert.equal(t.committing("main", 30_000 + PAGE_COMMIT_CAP_MS), false, "a commit that never arrives holds no longer than the cap");
});

test("the attach's sign-in verdict sees a guard that redirects during the watch when the commit lags past the grace (#726)", async () => {
  // The smoke page that redirects 600 ms after load: the sign-in request starts 400 ms into the watch and finishes 50 ms
  // later, and Firefox under load reported the commit 650 ms after that, after the grace and after the quiet window.
  const stand = standInPage("http://app.test/private");
  const t = tracker();
  const begun = stand.clock;
  let phase = 0;
  stand.onTick = () => {
    const at = stand.clock - begun;
    if (phase === 0 && at >= 400) {
      phase = 1;
      t.started("to-login", "main", true, stand.clock);
    } else if (phase === 1 && at >= 450) {
      phase = 2;
      t.answered("to-login", true);
      t.ended("to-login", false, stand.clock);
    } else if (phase === 2 && at >= 1100) {
      phase = 3;
      stand.href = "http://app.test/login";
      t.navigated("main");
    }
  };
  const url = await stableUrlOf(() => stand, stand.now, { navigating: () => t.navigating("main", stand.clock), quietMs: ATTACH_URL_QUIET_MS });
  assert.equal(url, "http://app.test/login");
});

test("a navigation answered with a page stops being on its way when it fails, its frame goes or another replaces it (#726)", () => {
  // Each of these means the commit is never coming: none may hold a wait to PAGE_COMMIT_CAP_MS.
  const t = tracker();
  t.started("stopped", "main", true);
  t.answered("stopped", true);
  t.ended("stopped", true, 1000);
  assert.equal(t.navigating("main", 1001), false, "aborted mid-body");
  assert.equal(t.committing("main", 1001), false);
  t.started("detached", "child", true);
  t.answered("detached", true);
  t.ended("detached", false, 2000);
  t.gone((f) => f === "child");
  assert.equal(t.navigating("child", 2001), false, "its frame was removed");
  assert.equal(t.committing("child", 2001), false);
  t.started("replaced", "main", true);
  t.answered("replaced", true);
  t.ended("replaced", false, 3000);
  t.started("newer", "main", true);
  t.answered("newer", false);
  t.ended("newer", false, 3010);
  assert.equal(t.navigating("main", 3010 + NAVIGATION_COMMIT_GRACE_MS), false, "the newer navigation's answer is what counts");
});

test("the attach's sign-in verdict waits for a redirect to sign-in whose commit is reported late (#726)", async () => {
  // The guard's request to the sign-in page started during the settle and finished just after the watch began, and the
  // browser reported the commit 1.5 s after that: past NAVIGATION_COMMIT_GRACE_MS and past the watch's quiet window.
  // The stale profile was read as signed in. Contrastive pair: the same timing when the answer is not a page.
  const run = async (page: boolean): Promise<{ url: string; tookMs: number }> => {
    const stand = standInPage("http://app.test/private");
    const t = tracker();
    const begun = stand.clock;
    t.started("to-login", "main", true, begun - 30);
    let finished = false;
    stand.onTick = () => {
      if (!finished && stand.clock - begun >= 50) {
        finished = true;
        t.answered("to-login", page);
        t.ended("to-login", false, stand.clock);
      }
      if (page && stand.clock - begun >= 1550 && stand.href.endsWith("/private")) {
        stand.href = "http://app.test/login";
        t.navigated("main");
      }
    };
    const url = await stableUrlOf(() => stand, stand.now, { navigating: () => t.navigating("main", stand.clock), quietMs: ATTACH_URL_QUIET_MS });
    return { url, tookMs: stand.clock - begun };
  };
  assert.equal((await run(true)).url, "http://app.test/login");
  const empty = await run(false);
  assert.equal(empty.url, "http://app.test/private");
  assert.ok(empty.tookMs <= ATTACH_URL_QUIET_MS + SETTLE_TICK_MS, `an answer that never commits does not hold the watch (${empty.tookMs} ms)`);
});

test("a navigation answered with a download is not on its way, while its file is still arriving", () => {
  // Firefox keeps a navigation's request open until the whole file has arrived, so counted as on its way it held every
  // URL watch to URL_NAVIGATING_CAP_MS. Contrastive pair: the same open navigation, and a download from another request.
  const t = tracker();
  t.started("to-file", "main", true);
  t.downloaded((request) => request === "an-earlier-file");
  assert.equal(t.navigating("main"), true, "a download from another request leaves this navigation on its way");
  t.downloaded((request) => request === "to-file");
  assert.equal(t.navigating("main"), false, "the navigation that became a download never commits");
  // Its request is still open; when the file ends, nothing about the frame changes.
  t.ended("to-file", false, 9000);
  assert.equal(t.navigating("main", 9001), false);
  // Only the frame whose navigation became the download stops navigating: the main frame's own is still on its way.
  t.started("frame-file", "child", true);
  t.started("next-page", "main", true);
  t.downloaded((request) => request === "frame-file");
  assert.equal(t.navigating("main"), true);
  assert.equal(t.navigating("child"), false);
});

test("a download's request is not waited for by the settle, while the same file fetched by the page is (#674)", () => {
  // Firefox keeps the request a download came from open until the whole file has arrived, so counted in flight it held
  // every settle wait to SETTLE_CAP_MS. Contrastive pair: the same file, still arriving, fetched by the page's script.
  const t = tracker();
  t.started("file-download", "main", true);
  t.started("file-fetch", "main", false);
  assert.equal(t.count, 2);
  t.downloaded((request) => request === "file-download");
  assert.equal(t.count, 1, "the download's request is out of the count; the fetch of the same file is still in it");
  assert.equal(t.openWithin(RECHECK_OPEN_MS, Date.now()), 1);
  // Its end, when the file has arrived, is not counted out a second time.
  t.ended("file-download", false);
  assert.equal(t.count, 1);
  t.ended("file-fetch", false);
  assert.equal(t.count, 0);
  // A download that is not a navigation (a frame's or a worker's request) leaves the count too.
  t.started("worker-file", undefined, false);
  t.downloaded((request) => request === "worker-file");
  assert.equal(t.count, 0);
});

test("the request of a frame's navigation is named while it is open, with when it started, and not once it has committed or failed", () => {
  const t = tracker();
  assert.equal(t.navigationOf("main"), undefined);
  t.started("fetch", "main", false, 100);
  t.started("to-next", "main", true, 200);
  assert.deepEqual(t.navigationOf("main"), { request: "to-next", at: 200 });
  assert.equal(t.navigationOf("child"), undefined, "only the frame that sent it");
  t.navigated("main");
  assert.equal(t.navigationOf("main"), undefined, "committed");
  t.started("refused", "main", true);
  t.ended("refused", true);
  assert.equal(t.navigationOf("main"), undefined, "failed");
});

test("a navigation the page started on its own is waited for within the page-load limit, and only while it is on its way (#674)", () => {
  // Contrastive pairs: the same elapsed time with and without a navigation on its way, and the same navigation either
  // side of the limit.
  assert.equal(keepWaitingForNavigation({ navigating: true, elapsedMs: 0, limitMs: 15_000 }), true);
  assert.equal(keepWaitingForNavigation({ navigating: false, elapsedMs: 0, limitMs: 15_000 }), false, "nothing on its way: read at once");
  assert.equal(keepWaitingForNavigation({ navigating: true, elapsedMs: 14_999, limitMs: 15_000 }), true);
  assert.equal(keepWaitingForNavigation({ navigating: true, elapsedMs: 15_000, limitMs: 15_000 }), false, "never past the limit");
});

test("ownNavigationLanded ends at the page-load limit on a navigation that never answers, counted from when the load began (#674)", async () => {
  // Read while such a navigation was on its way, Chromium held a crawl past 40 s. The load began 2 s before the wait
  // (the settle after it), so the wait itself is the limit less those 2 s.
  const page = standInPage();
  const startedAt = page.clock - 2000;
  assert.equal(await ownNavigationLanded(page, () => true, 5000, startedAt, page.now), false, "still on its way at the limit: not read");
  assert.equal(page.clock - startedAt, 5000);
});

test("ownNavigationLanded reads at once when nothing is on its way, and a page that landed once it has gone QUIET_MS without moving on", async () => {
  const page = standInPage();
  const quiet = page.clock;
  assert.equal(await ownNavigationLanded(page, () => false, 5000, quiet, page.now), true);
  assert.equal(page.clock, quiet, "nothing waited for");
  let on = true;
  page.onTick = () => {
    if (page.ticks === 10) on = false;
  };
  const started = page.clock;
  assert.equal(await ownNavigationLanded(page, () => on, 5000, started, page.now), true);
  assert.equal(page.clock - started, 10 * SETTLE_TICK_MS + Math.ceil(QUIET_MS / SETTLE_TICK_MS) * SETTLE_TICK_MS, "read QUIET_MS after it landed");
  // A page that closes ends the wait: there is nothing left to read on it.
  const closing = standInPage();
  closing.onTick = () => {
    closing.closed = true;
  };
  assert.equal(await ownNavigationLanded(closing, () => true, 5000, closing.clock, closing.now), true);
  assert.equal(closing.ticks, 1);
});

test("ownNavigationLanded does not read a page that lands and at once moves on again to an address that never answers (#674)", async () => {
  // A to B to C: B's script starts C a moment after B lands. Read in that moment, Chromium held the read while C was on
  // its way. Contrastive pair: the same landing on B with nothing after it, read QUIET_MS later.
  const hops = standInPage();
  let on = true;
  hops.onTick = () => {
    if (hops.ticks === 5) on = false; // B lands
    if (hops.ticks === 7) on = true; // B's script moves on to C, which never answers
  };
  const started = hops.clock;
  assert.equal(await ownNavigationLanded(hops, () => on, 3000, started, hops.now), false, "C still on its way at the limit");
  assert.equal(hops.clock - started, 3000);
  const settled = standInPage();
  let settledOn = true;
  settled.onTick = () => {
    if (settled.ticks === 5) settledOn = false;
  };
  assert.equal(await ownNavigationLanded(settled, () => settledOn, 3000, settled.clock, settled.now), true);
});

test("seenWithin answers as soon as its condition holds, and false at its bound", async () => {
  const page = standInPage();
  let seen = false;
  page.onTick = () => {
    if (page.ticks === 3) seen = true;
  };
  const started = page.clock;
  assert.equal(await seenWithin(page, () => seen, 1000, page.now), true);
  assert.equal(page.clock - started, 3 * SETTLE_TICK_MS);
  const never = standInPage();
  const from = never.clock;
  assert.equal(await seenWithin(never, () => false, 1000, never.now), false);
  assert.equal(never.clock - from, 1000);
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
