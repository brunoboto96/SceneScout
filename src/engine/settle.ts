/**
 * How long to wait after an action before reading the page.
 *
 * This used to be a flat 400 ms sleep on every action, for a good reason:
 * `waitForLoadState("networkidle")` latches once reached and then resolves
 * instantly forever after, so it cannot be used to wait out the request an
 * action just fired, and draining the oracles before that request lands would
 * misattribute its violations to the next step.
 *
 * The floor was still the wrong shape. Measured against a demo app, a snapshot
 * cost 740 ms of which 400 ms was the sleep — 54% of the wall time — and a run
 * of 203 actions spent 81 seconds asleep. Meanwhile a page slower than 400 ms
 * got cut off exactly when it mattered.
 *
 * The engine already intercepts every request, so it knows what is in flight.
 * Waiting on THAT, with a quiet window after the last one starts, is both
 * faster on a page that answers quickly and more patient with one that does
 * not. The old constant survives as a ceiling rather than a floor.
 *
 * The same rule carries the deliberate slow-down: a run being watched by a
 * person taking notes wants a fixed pace, not the fastest one. `paceMs` is a
 * floor a session asks for; unset, a session goes as fast as its page allows.
 */

/** No request has started for this long and none is in flight: the page has settled. */
export const QUIET_MS = 120;
/** Longest to wait for requests to drain, however busy the page is. A page that never goes quiet must not stall the run. */
export const SETTLE_CAP_MS = 2000;
/** How often the wait re-checks. */
export const SETTLE_TICK_MS = 20;

export interface SettleState {
  /** Requests started and not yet finished or failed. */
  inFlight: number;
  /** Since the most recent request STARTED. A page that fires one late must not be read before it lands. */
  sinceLastStartMs: number;
  /** Since the action completed. */
  elapsedMs: number;
  /** A floor this session asked for, so a person can follow along. 0 means as fast as the page allows. */
  paceMs: number;
}

/**
 * Whether to keep waiting. Split out from the browser so the rule can be
 * table-tested: it is the difference between a run that is fast and one that
 * reads a page before it has finished changing.
 */
export function shouldKeepWaiting(state: SettleState): boolean {
  // A pace a session asked for is a floor on the whole wait, and it is the
  // only reason to wait once everything else says the page is ready.
  if (state.elapsedMs < state.paceMs) return true;
  // Never longer than the cap, whatever the page is doing.
  if (state.elapsedMs >= SETTLE_CAP_MS) return false;
  // Something is still out: wait for it, up to the cap.
  if (state.inFlight > 0) return true;
  // Nothing in flight and nothing recent. The action itself is the last event
  // that could still produce a request, so the quiet window runs from whichever
  // of the two is later. Without this, an action whose request comes back
  // through a hop — a click that posts to a service worker, which then fetches —
  // is read while the page is between the two, and the request lands during the
  // NEXT action, which is then blamed for it.
  return Math.min(state.sinceLastStartMs, state.elapsedMs) < QUIET_MS;
}

/** A pace a session asked for, clamped. Negative or absurd values are a typo, not an instruction. */
export const PACE_MAX_MS = 60_000;

export function normalizePace(paceMs: number | undefined): number {
  if (typeof paceMs !== "number" || !Number.isFinite(paceMs) || paceMs <= 0) return 0;
  return Math.min(Math.round(paceMs), PACE_MAX_MS);
}

/** What the attach result says about a deliberate pace, or nothing when the session runs at full speed. */
export function describePace(paceMs: number): string {
  if (paceMs <= 0) return "";
  return `\n⏱ PACE: at least ${paceMs} ms between actions, so a person can follow along. Unset it with paceMs: 0 to go as fast as the page allows.`;
}

/**
 * Waiting for a client-side redirect that has not happened yet.
 *
 * A guard that redirects on a timer after hydration issues no request until it
 * fires, so there is nothing for the request-based settle above to wait on:
 * it goes quiet, the URL is read, and the page reports the route it was asked
 * for rather than the login page it actually bounced to. The old flat 400 ms
 * sleep covered this by accident, and removing it made the bounce invisible
 * whenever a loaded machine delayed the timer past the quiet window.
 *
 * So where a BOUNCE VERDICT is about to be made — attach judging a storage
 * state, navigate judging coverage — the URL is watched until it has held
 * still, rather than read once. This is paid per navigation, not per action.
 */

/**
 * How long the URL must hold still before a bounce verdict is believed.
 *
 * This is a window, not a guarantee: a guard slower than it still lands after
 * the verdict. What it buys is the realistic case — a guard written to fire
 * promptly, delayed by a loaded machine — which is the one that made this
 * project's own CI fail intermittently on a 40 ms timer.
 */
export const URL_QUIET_MS = 400;
/** Longest to watch. A page redirecting in a loop must not hold up the run. */
export const URL_CAP_MS = 3000;

export interface UrlWatch {
  /** Since the URL last changed. */
  sinceChangeMs: number;
  /** Since the watch began. */
  elapsedMs: number;
}

/** Whether to keep watching the URL before judging where the page landed. */
export function keepWatchingUrl(w: UrlWatch): boolean {
  if (w.elapsedMs >= URL_CAP_MS) return false;
  return w.sinceChangeMs < URL_QUIET_MS;
}
