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
import { bestEffort } from "./best-effort.js";

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

/** How long a navigation that finished without failing still counts as on its way, waiting for its frame to commit it. */
export const NAVIGATION_COMMIT_GRACE_MS = 500;

/**
 * Which requests are still in flight, for the wait above.
 *
 * Counting the context's request events up and down is not enough. A request
 * that has had its response headers but not its whole body when its document
 * goes away (the page is left, or a frame is removed or moves on) gets neither
 * a "finished" nor a "failed" event, so a plain counter never comes back down
 * and every later wait runs to its cap. Each request is therefore held with the
 * frame that sent it and the order it started in, and is dropped when it ends,
 * when its frame is gone, or when its frame commits a navigation that started
 * after it did. A same-document navigation (history.pushState) sends no
 * navigation request, so it drops nothing — unless a navigation that answered
 * without a new document (a 204, a download) is still pending for that frame,
 * in which case the requests started before it are dropped early. Generic over the request and frame
 * types so it is tested without a browser.
 */
export class InFlightRequests<R, F> {
  private readonly open = new Map<R, { frame: F | undefined; order: number }>();
  /** Per frame, the order of the latest navigation request it sent that has not yet committed. */
  private readonly pendingNavigation = new Map<F, number>();
  /** Per frame, when its pending navigation request finished without failing (it may still be about to commit). */
  private readonly finishedNavigation = new Map<F, number>();
  private order = 0;

  /** A request started. `frame` is undefined for one no frame sent (a worker's). */
  started(request: R, frame: F | undefined, isNavigation: boolean): void {
    const order = ++this.order;
    this.open.set(request, { frame, order });
    if (isNavigation && frame !== undefined) {
      this.pendingNavigation.set(frame, order);
      this.finishedNavigation.delete(frame);
    }
  }

  /**
   * A request finished or failed. One already dropped is ignored, so it cannot
   * be counted out twice. A navigation that failed never commits, so it stops
   * being the one a later commit of its frame is measured against. A finished
   * one may still be about to commit (its body can end first), so it stays.
   */
  ended(request: R, failed = false, at: number = Date.now()): void {
    const held = this.open.get(request);
    this.open.delete(request);
    if (held?.frame === undefined || this.pendingNavigation.get(held.frame) !== held.order) return;
    if (failed) {
      this.pendingNavigation.delete(held.frame);
      this.finishedNavigation.delete(held.frame);
    } else this.finishedNavigation.set(held.frame, at);
  }

  /**
   * A frame committed a navigation. Requests its old document sent before the
   * navigation began are dropped; the navigation itself and anything started
   * after it stay. Without a navigation request (a same-document change) nothing is dropped.
   */
  navigated(frame: F): void {
    const navigation = this.pendingNavigation.get(frame);
    if (navigation === undefined) return;
    this.pendingNavigation.delete(frame);
    this.finishedNavigation.delete(frame);
    for (const [request, held] of this.open) if (held.frame === frame && held.order < navigation) this.open.delete(request);
  }

  /** Frames that are gone (detached, or their page closed): every request they sent is dropped. */
  gone(isGone: (frame: F) => boolean): void {
    for (const [request, held] of this.open) if (held.frame !== undefined && isGone(held.frame)) this.open.delete(request);
    for (const frame of [...this.pendingNavigation.keys()])
      if (isGone(frame)) {
        this.pendingNavigation.delete(frame);
        this.finishedNavigation.delete(frame);
      }
  }

  get count(): number {
    return this.open.size;
  }

  /**
   * Whether `frame` has a navigation on its way: its latest navigation request
   * is still open, or finished without failing less than
   * NAVIGATION_COMMIT_GRACE_MS ago and has not been committed (a document's
   * body can end before the frame commits it). One that finished long enough
   * ago without committing (a 204, a download) never will, and one that failed
   * (refused, aborted) never will either: neither counts.
   */
  navigating(frame: F, now: number = Date.now()): boolean {
    const order = this.pendingNavigation.get(frame);
    if (order === undefined) return false;
    const finishedAt = this.finishedNavigation.get(frame);
    if (finishedAt !== undefined) return now - finishedAt < NAVIGATION_COMMIT_GRACE_MS;
    for (const held of this.open.values()) if (held.frame === frame && held.order === order) return true;
    return false;
  }
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
/**
 * The quiet window the attach's sign-in verdict watches with, when the session
 * carries a saved sign-in. An app whose scripts send a signed-out visitor to
 * sign-in after a hydration pass or a token check can take longer than the
 * run's window, and a verdict read before that passes a stale profile as
 * signed in, for the rest of the run. Paid once per attach with credentials.
 */
export const ATTACH_URL_QUIET_MS = 1000;

export interface UrlWatch {
  /** Since the URL last changed. */
  sinceChangeMs: number;
  /** Since the watch began. */
  elapsedMs: number;
  /** Whether the page's own navigation has started and not yet committed or failed: its address is about to change. */
  navigating?: boolean;
  /** How long the URL must hold still; URL_QUIET_MS unless given. */
  quietMs?: number;
}

/** Whether to keep watching the URL before judging where the page landed. */
export function keepWatchingUrl(w: UrlWatch): boolean {
  if (w.elapsedMs >= URL_CAP_MS) return false;
  if (w.navigating) return true;
  return w.sinceChangeMs < (w.quietMs ?? URL_QUIET_MS);
}

/**
 * The page a wait reads. Playwright's Page answers it; a test gives a
 * stand-in, so the waits below run without a browser (settle-test).
 */
export interface SettlingPage {
  waitForLoadState(state: "domcontentloaded"): Promise<unknown>;
  waitForTimeout(timeout: number): Promise<unknown>;
  url(): string;
  isClosed(): boolean;
}

/** What the wait after an action reads from the session, each time it looks. */
export interface SettleSource {
  /** Requests started and not yet finished, failed, or left behind by their frame. */
  inFlight(): number;
  /** When the most recent request started. */
  lastRequestStart(): number;
  /** The deliberate pace the session was asked for (normalizePace). */
  paceMs(): number;
  /** The page the session drives now: a wait on a page the session has left ends. */
  current(): unknown;
}

/**
 * Wait after an action until the page has settled (shouldKeepWaiting), or the session has moved to another page.
 * `now` is the clock the wait measures by; a test passes one its stand-in page advances, so no assertion rests on
 * how long a real timer took (a 20 ms tick takes about 31 ms on Windows' default timer resolution). It must be the
 * clock `src.lastRequestStart()` is read on, or the time since the last request means nothing.
 */
export async function settlePage(page: SettlingPage, src: SettleSource, now: () => number = Date.now): Promise<void> {
  await bestEffort(page.waitForLoadState("domcontentloaded"));
  // Wait on what is actually in flight rather than a flat sleep. The rule is
  // shouldKeepWaiting above; the reasoning for not using networkidle is at the
  // top of this file.
  const started = now();
  for (;;) {
    const state = {
      inFlight: src.inFlight(),
      sinceLastStartMs: now() - src.lastRequestStart(),
      elapsedMs: now() - started,
      paceMs: src.paceMs(),
    };
    if (!shouldKeepWaiting(state)) return;
    await bestEffort(page.waitForTimeout(SETTLE_TICK_MS));
    if (src.current() !== page) return;
  }
}

/**
 * The URL once it has stopped changing (keepWatchingUrl), read from the page
 * `current` names: "" when there is none, and the URL so far once the session
 * leaves it or it closes.
 *
 * Only called where a bounce verdict is about to be made. A client-side auth
 * guard redirects on a timer and issues no request until it does, so the
 * request-based settle has nothing to wait on and the page is read while it
 * is still, briefly, the page it was asked for. `now` is the clock it measures by, as for settlePage.
 * `navigating` says whether the page's own navigation is on its way (InFlightRequests.navigating): a guard that has
 * fired, whose sign-in page has not answered yet, has not changed the address, so the watch waits for it (to the
 * cap). `quietMs` replaces URL_QUIET_MS (the attach's verdict uses ATTACH_URL_QUIET_MS).
 */
export async function stableUrlOf(
  current: () => SettlingPage | null,
  now: () => number = Date.now,
  opts: { navigating?: () => boolean; quietMs?: number } = {},
): Promise<string> {
  const page = current();
  if (!page || page.isClosed()) return page ? page.url() : "";
  const started = now();
  let url = page.url();
  let changedAt = started;
  for (;;) {
    const watch = { sinceChangeMs: now() - changedAt, elapsedMs: now() - started, navigating: opts.navigating?.() ?? false };
    if (!keepWatchingUrl(opts.quietMs !== undefined ? { ...watch, quietMs: opts.quietMs } : watch)) return url;
    await bestEffort(page.waitForTimeout(SETTLE_TICK_MS));
    if (current() !== page || page.isClosed()) return url;
    const at = page.url();
    if (at !== url) {
      url = at;
      changedAt = now();
    }
  }
}
