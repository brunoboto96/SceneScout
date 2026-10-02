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
  shouldKeepWaiting,
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
