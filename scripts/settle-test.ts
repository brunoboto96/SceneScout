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
import { describePace, normalizePace, PACE_MAX_MS, QUIET_MS, SETTLE_CAP_MS, shouldKeepWaiting } from "../src/engine/settle.ts";

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
