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
  /**
   * Since the browser last cancelled a request whose answer had already arrived (AnsweredCancels). WebKit and Firefox
   * cancel a document's open requests the moment a navigation starts, and report the navigation's own request only
   * after that, so for that moment nothing is in flight while the page is on its way elsewhere: a redirect started on
   * a request's answer, with its request still open, is otherwise read as a page that went quiet and stayed.
   */
  sinceLastCancelMs: number;
  /** A floor this session asked for, so a person can follow along. 0 means as fast as the page allows. */
  paceMs: number;
  /**
   * The wait is before a read (a snapshot), not after an action. A read sends
   * nothing, so the quiet window is not run again from it: the wait before it
   * already saw the page quiet, and only a request started since counts.
   */
  read?: boolean;
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
  // An answered request was just cancelled: the navigation that cancelled it may not have sent its own request yet.
  if (state.sinceLastCancelMs < QUIET_MS) return true;
  // Nothing in flight and nothing recent. The action itself is the last event
  // that could still produce a request, so the quiet window runs from whichever
  // of the two is later. Without this, an action whose request comes back
  // through a hop — a click that posts to a service worker, which then fetches —
  // is read while the page is between the two, and the request lands during the
  // NEXT action, which is then blamed for it.
  if (state.read) return state.sinceLastStartMs < QUIET_MS;
  return Math.min(state.sinceLastStartMs, state.elapsedMs) < QUIET_MS;
}

/**
 * When the browser last cancelled a request after its answer had arrived, for SettleState.sinceLastCancelMs. Only an
 * answered request counts: a redirect a page starts on a request's answer cancels that request with its answer in, and
 * that is the gap the quiet window is for. A request the page aborts before its answer (a search box cancelling the
 * previous search, a status check on a timeout) is the page's own routine: counted, a page that polls with a short
 * timeout had every action and snapshot held to SETTLE_CAP_MS. A request the write policy refused is never counted.
 */
export class AnsweredCancels<R extends object> {
  private readonly answered = new WeakSet<R>();
  private at = 0;

  /** A request's answer (its status and headers) arrived. */
  answer(request: R): void {
    this.answered.add(request);
  }

  /** A request failed: `cancelled` is requestCancelled's verdict on its error text, `refused` the write policy's refusal. */
  failed(request: R, cancelled: boolean, refused: boolean, at: number = Date.now()): void {
    if (cancelled && !refused && this.answered.has(request)) this.at = at;
  }

  /** When the latest counted cancellation happened; 0 if none has. */
  get last(): number {
    return this.at;
  }
}

/** The waits between reads of a page's controls before a snapshot, growing (recheckWait). */
export const RECHECK_WAITS_MS: readonly number[] = [50, 100, 200, 400];
/** Longest the re-reads go on while the page is quiet. */
export const RECHECK_CAP_MS = 1000;
/** Longest while the page still has requests out or just started one: its content may be on the way. */
export const RECHECK_BUSY_CAP_MS = 4000;

/**
 * How long after a page loaded, or was last acted on, two equal quiet reads of it count. A single-page app can draw
 * its route's content from a timer, with no request to wait on; the old fixed re-check never judged a page sooner
 * than about this long after the action (a 120 ms quiet window, then 300 ms).
 */
export const RECHECK_DRAWN_AGE_MS = 400;
/**
 * The same for a page with no controls at all: an empty shell is most often one still drawing, and calling it a dead
 * end is a finding. The old rule read an empty page for about this long. The count is the page's own document's, so a
 * page whose controls are all inside frames is read this long too, as it was before.
 */
export const RECHECK_EMPTY_AGE_MS = 4000;

export interface RecheckState {
  /** How many controls each read so far found, the first read first. */
  counts: readonly number[];
  /** For each read, whether the page was busy when it was taken (absent: none was). */
  busyAt?: readonly boolean[];
  /** Since the first read. */
  elapsedMs: number;
  /** Requests started and not yet finished, less than RECHECK_OPEN_MS ago (InFlightRequests.openWithin). */
  inFlight: number;
  /** Since the most recent request started. */
  sinceLastStartMs: number;
  /**
   * How long the page had been up at the latest read: since its document arrived or the latest action, whichever is
   * later. Measured, not inferred from the reads, so a snapshot taken long after the page drew needs no extra wait.
   */
  ageMs: number;
}

/** A request open longer than this is not content on its way (an EventSource, a long poll): it does not keep the re-reads going. */
export const RECHECK_OPEN_MS = SETTLE_CAP_MS;

/** Whether the page is busy for the re-reads: a young request out, or one started within QUIET_MS. */
export function recheckBusy(inFlight: number, sinceLastStartMs: number): boolean {
  return inFlight > 0 || sinceLastStartMs < QUIET_MS;
}

/**
 * How long to wait before reading the page's controls again, or null when the
 * last read can be used. A single-page app can show an empty shell, or a shell
 * with its navigation drawn, while the route's own content loads; reading
 * until two reads agree is what keeps a snapshot from listing the loading
 * state.
 *
 * Two equal reads, both taken while the page was quiet and with the page still
 * quiet (no young request out, none started within QUIET_MS), end it, an empty
 * page included once it is old enough (below): one with nothing on its way is what it is. While
 * the page is busy, equal reads do not count, up to RECHECK_BUSY_CAP_MS. There is always one re-read.
 *
 * Nor do they count while the page is young (RECHECK_DRAWN_AGE_MS, or RECHECK_EMPTY_AGE_MS for a page with no
 * controls): a page that draws from a timer, with no request, is read for at least as long after its load or the
 * action as the old fixed re-check gave it. A snapshot taken after the page has been up that long is not slowed.
 */
export function recheckWait(s: RecheckState): number | null {
  const n = s.counts.length;
  const busy = recheckBusy(s.inFlight, s.sinceLastStartMs);
  const quietPair = !(s.busyAt?.[n - 1] ?? false) && !(s.busyAt?.[n - 2] ?? false);
  const untilOld = (s.counts[n - 1] === 0 ? RECHECK_EMPTY_AGE_MS : RECHECK_DRAWN_AGE_MS) - s.ageMs;
  const young = untilOld > 0;
  if (n >= 2 && s.counts[n - 1] === s.counts[n - 2] && quietPair && !busy && !young) return null;
  const cap = busy || young ? RECHECK_BUSY_CAP_MS : RECHECK_CAP_MS;
  if (s.elapsedMs >= cap) return null;
  // Young, the next read is taken as the page comes of age rather than up to a whole step after it.
  return Math.min(RECHECK_WAITS_MS[Math.min(n - 1, RECHECK_WAITS_MS.length - 1)], cap - s.elapsedMs, young ? untilOld : Infinity);
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
  private readonly open = new Map<R, { frame: F | undefined; order: number; at: number }>();
  /** Per frame, the order of the latest navigation request it sent that has not yet committed. */
  private readonly pendingNavigation = new Map<F, number>();
  /** Per frame, when its pending navigation request finished without failing (it may still be about to commit). */
  private readonly finishedNavigation = new Map<F, number>();
  private order = 0;

  /** A request started. `frame` is undefined for one no frame sent (a worker's). */
  started(request: R, frame: F | undefined, isNavigation: boolean, at: number = Date.now()): void {
    const order = ++this.order;
    this.open.set(request, { frame, order, at });
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

  /**
   * A download started. A navigation answered with a file never commits, but Firefox keeps its request open until the
   * whole file has arrived, so without this the frame counted as navigating for as long as the file took, holding a
   * URL watch to URL_NAVIGATING_CAP_MS. `isDownload` says whether a request is the one the file came from; the frame
   * whose pending navigation it is stops counting as navigating. A download from any other request changes nothing.
   */
  downloaded(isDownload: (request: R) => boolean): void {
    for (const [request, held] of this.open) {
      if (held.frame === undefined || this.pendingNavigation.get(held.frame) !== held.order || !isDownload(request)) continue;
      this.pendingNavigation.delete(held.frame);
      this.finishedNavigation.delete(held.frame);
    }
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
   * The requests still open that started less than `ms` ago. A stream that
   * never ends (an EventSource, a long poll) stays open for the page's life;
   * past this age it is the page's way of working, not content on its way.
   */
  openWithin(ms: number, now: number = Date.now()): number {
    let n = 0;
    for (const held of this.open.values()) if (now - held.at < ms) n += 1;
    return n;
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
/** Longest to watch an address that keeps moving with no navigation open: a page redirecting in a loop must not hold up the run. */
export const URL_CAP_MS = 3000;
/**
 * Longest to watch while the page's own navigation is on its way (UrlWatch.navigating). A guard that has fired sends
 * its sign-in page's request at once, but a loaded sign-in service can take seconds to answer, and the address only
 * changes when it does. Whether that request started during the settle before the watch or a few milliseconds after
 * it depends on the machine; with URL_CAP_MS as the bound for both, the same page was AUTH FAILED when it started
 * during the settle and signed in when it started after. The longer bound only applies while a navigation is open, so
 * a page with nothing on its way pays nothing for it, and one that never answers, or a loop whose hops overlap so a
 * navigation is always open, still returns.
 */
export const URL_NAVIGATING_CAP_MS = 10_000;
/**
 * The quiet window the attach's sign-in verdict watches with, when the session
 * carries a saved sign-in. An app whose scripts send a signed-out visitor to
 * sign-in after a hydration pass or a token check can take longer than the
 * run's window, and a verdict read before that passes a stale profile as
 * signed in, for the rest of the run. Paid once per attach with credentials.
 */
export const ATTACH_URL_QUIET_MS = 1000;
/**
 * How long a crawled route's address must have held still, counted from when its document arrived, before a crawl
 * with a saved sign-in reads the route. Counted from the document rather than from the watch: how long the load and
 * the settle before the watch took varies with the machine, and a window that began wherever they ended caught a
 * guard 600 ms after load on one runner and missed it on the next. Paid per route with credentials, less the time the
 * route has already been up.
 */
export const CRAWL_URL_HELD_MS = 1000;

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

/**
 * Whether to keep watching the URL before judging where the page landed. A navigation on its way is waited for until it
 * commits or fails, to URL_NAVIGATING_CAP_MS; otherwise the address must hold still, to URL_CAP_MS.
 */
export function keepWatchingUrl(w: UrlWatch): boolean {
  if (w.navigating) return w.elapsedMs < URL_NAVIGATING_CAP_MS;
  if (w.elapsedMs >= URL_CAP_MS) return false;
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
  /** When the browser last cancelled an answered request (AnsweredCancels, SettleState.sinceLastCancelMs); 0 if never. */
  lastRequestCancel(): number;
  /** The deliberate pace the session was asked for (normalizePace). */
  paceMs(): number;
  /** The page the session drives now: a wait on a page the session has left ends. */
  current(): unknown;
}

/**
 * Wait after an action until the page has settled (shouldKeepWaiting), or the session has moved to another page.
 * `now` is the clock the wait measures by; a test passes one its stand-in page advances, so no assertion rests on
 * how long a real timer took (a 20 ms tick takes about 31 ms on Windows' default timer resolution). It must be the
 * clock `src.lastRequestStart()` and `src.lastRequestCancel()` are read on, or the time since the last request means nothing. `read` is for a wait
 * before a read rather than after an action (SettleState.read).
 */
export async function settlePage(page: SettlingPage, src: SettleSource, now: () => number = Date.now, read = false): Promise<void> {
  await bestEffort(page.waitForLoadState("domcontentloaded"));
  // Wait on what is actually in flight rather than a flat sleep. The rule is
  // shouldKeepWaiting above; the reasoning for not using networkidle is at the
  // top of this file.
  const started = now();
  for (;;) {
    const state = {
      inFlight: src.inFlight(),
      sinceLastStartMs: now() - src.lastRequestStart(),
      sinceLastCancelMs: now() - src.lastRequestCancel(),
      elapsedMs: now() - started,
      paceMs: src.paceMs(),
      read,
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
 * fired, whose sign-in page has not answered yet, has not changed the address, so the watch waits for it, to
 * URL_NAVIGATING_CAP_MS, whether it started before the watch or during it. `quietMs` replaces URL_QUIET_MS (the
 * attach's verdict uses ATTACH_URL_QUIET_MS). `heldMs` is how long the
 * address had already held still when the watch began (a crawl passes its document's age, CRAWL_URL_HELD_MS); by
 * default none, so the window runs from the watch's start.
 */
export async function stableUrlOf(
  current: () => SettlingPage | null,
  now: () => number = Date.now,
  opts: { navigating?: () => boolean; quietMs?: number; heldMs?: number } = {},
): Promise<string> {
  const page = current();
  if (!page || page.isClosed()) return page ? page.url() : "";
  const started = now();
  let url = page.url();
  let changedAt = started - Math.max(0, opts.heldMs ?? 0);
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
