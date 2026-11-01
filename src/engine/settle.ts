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
import { UNAUTHENTICATED_STATUSES } from "./authloss.js";
import { bestEffort } from "./best-effort.js";
import { answersNavigation, mediaTypeOf } from "./crawl.js";

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
   * Since a request whose answer had arrived last ended: it finished with an answer a page may move on (a redirect, a
   * 401), or the browser cancelled it (AnsweredEnds). A page leaves on an answer after it has arrived (a guard's
   * redirect to sign-in), and the request is over by then: a small answer is over the moment it arrives, WebKit on
   * Linux hands the page an answer only once its body has ended, and WebKit and Firefox cancel a document's open
   * requests the moment a navigation starts, reporting the navigation's own request only after that. So for a moment
   * nothing is in flight and the last start can be old while the page is on its way elsewhere.
   */
  sinceLastAnsweredEndMs: number;
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
  // An answered request just ended: where the page goes on its answer may not have sent its request yet.
  if (state.sinceLastAnsweredEndMs < QUIET_MS) return true;
  // Nothing in flight and nothing recent. The action itself is the last event
  // that could still produce a request, so the quiet window runs from whichever
  // of the two is later. Without this, an action whose request comes back
  // through a hop — a click that posts to a service worker, which then fetches —
  // is read while the page is between the two, and the request lands during the
  // NEXT action, which is then blamed for it.
  if (state.read) return state.sinceLastStartMs < QUIET_MS;
  return Math.min(state.sinceLastStartMs, state.elapsedMs) < QUIET_MS;
}

/** The statuses a request is redirected with; a 304 is a cached copy still good, not a redirect. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Whether a page is likely to leave on an answer once that answer's request has finished: a redirect
 * (REDIRECT_STATUSES), or a refusal a guard sends the visitor to sign-in on (UNAUTHENTICATED_STATUSES, and 403). Any
 * other answer finishing is the page's routine (a status poll, an analytics beacon, a chat widget's check, a lazy
 * image): counted, a page polling every 250 ms with each poll answered in 150 ms had every action and snapshot held to
 * SETTLE_CAP_MS, because each answer's window ran into the next poll.
 */
export function answerMayMovePage(status: number): boolean {
  return REDIRECT_STATUSES.has(status) || status === 403 || UNAUTHENTICATED_STATUSES.has(status);
}

/**
 * When a request whose answer had arrived last ended, for SettleState.sinceLastAnsweredEndMs: the browser cancelled it
 * with its answer in (a redirect the page started on the answer cancels it), or it finished with an answer a page may
 * move on (answerMayMovePage). A request the page aborts before its answer (a search box cancelling the previous
 * search, a status check on a timeout) is the page's own routine and is not counted: counted, a page that polls with a
 * short timeout had every action and snapshot held to SETTLE_CAP_MS. A request that failed any other way is not
 * counted, and nor is one the write policy refused, finished or not: the page did not reach the network.
 */
export class AnsweredEnds<R extends object> {
  /** Each answered request's status. */
  private readonly answered = new WeakMap<R, number>();
  private at = 0;

  /** A request's answer (its status and headers) arrived. */
  answer(request: R, status: number): void {
    this.answered.set(request, status);
  }

  /** A request finished. `refused` is the write policy's refusal. */
  finished(request: R, refused: boolean, at: number = Date.now()): void {
    const status = this.answered.get(request);
    if (!refused && status !== undefined && answerMayMovePage(status)) this.at = at;
  }

  /** A request failed: `cancelled` is requestCancelled's verdict on its error text, `refused` the write policy's refusal. */
  failed(request: R, cancelled: boolean, refused: boolean, at: number = Date.now()): void {
    if (cancelled && !refused && this.answered.has(request)) this.at = at;
  }

  /** When the latest counted end happened; 0 if none has. */
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

/**
 * How long a navigation that finished without failing still counts as on its way, waiting for its frame to commit it,
 * when its answer was not a page (navigationAnswersPage): a 204 or a file never commits, so the wait for one is short.
 */
export const NAVIGATION_COMMIT_GRACE_MS = 500;
/**
 * How long a navigation answered with a page still counts as on its way after it finished, if its frame never reports
 * the commit. The browser reports a page's request finishing and its frame committing it separately, and on a loaded
 * machine Firefox reported the commit more than NAVIGATION_COMMIT_GRACE_MS after the request finished. This bound is
 * only for a commit that never arrives; the waits that read `navigating` have their own caps.
 */
export const PAGE_COMMIT_CAP_MS = 10_000;

/**
 * Whether a navigation's answer is a page its frame will commit: a page media type (text/html, XHTML), a status that
 * carries a document (not a redirect hop, not 204 or 205), and not sent as an attachment. `headers` are the response's,
 * with lowercase names. A missing content type is not taken for a page.
 */
export function navigationAnswersPage(status: number, headers: Readonly<Record<string, string | undefined>>): boolean {
  if (!answersNavigation(status, headers["location"]) || status === 204 || status === 205) return false;
  if ((headers["content-disposition"] ?? "").trim().toLowerCase().startsWith("attachment")) return false;
  const type = mediaTypeOf(headers["content-type"]);
  return type === "text/html" || type === "application/xhtml+xml";
}

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
  private readonly open = new Map<R, { frame: F | undefined; order: number; at: number; page?: boolean }>();
  /** Per frame, the order of the latest navigation request it sent that has not yet committed. */
  private readonly pendingNavigation = new Map<F, number>();
  /** Per frame, when its pending navigation request finished without failing (it may still be about to commit), and whether its answer was a page. */
  private readonly finishedNavigation = new Map<F, { at: number; page: boolean }>();
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

  /** A request's response arrived; `page` is whether it is a page its frame will commit (navigationAnswersPage). */
  answered(request: R, page: boolean): void {
    const held = this.open.get(request);
    if (held) held.page = page;
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
    } else this.finishedNavigation.set(held.frame, { at, page: held.page === true });
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
   * URL watch to URL_NAVIGATING_CAP_MS, and the request counted as in flight, holding every settle wait to
   * SETTLE_CAP_MS. `isDownload` says whether a request is the one the file came from: it is dropped (the file is the
   * browser's to save, not content the page is waiting on), and the frame whose pending navigation it is stops counting
   * as navigating. Any other request, still arriving or not, is left as it was.
   */
  downloaded(isDownload: (request: R) => boolean): void {
    for (const [request, held] of this.open) {
      if (!isDownload(request)) continue;
      this.open.delete(request);
      if (held.frame === undefined || this.pendingNavigation.get(held.frame) !== held.order) continue;
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

  /** The request of `frame`'s navigation while it is still open (navigating), and when it started, for saying where the page was going. */
  navigationOf(frame: F): { request: R; at: number } | undefined {
    const order = this.pendingNavigation.get(frame);
    if (order === undefined) return undefined;
    for (const [request, held] of this.open) if (held.frame === frame && held.order === order) return { request, at: held.at };
    return undefined;
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
   * is still open, or finished without failing and has not been committed (a
   * document's body can end before the frame commits it). One answered with a
   * page counts until its frame commits it, to PAGE_COMMIT_CAP_MS, however late
   * the browser reports the commit; any other answer counts for
   * NAVIGATION_COMMIT_GRACE_MS, because one that has not committed by then (a
   * 204, a download) never will. One that failed (refused, aborted) never
   * will either: it does not count.
   */
  navigating(frame: F, now: number = Date.now()): boolean {
    const order = this.pendingNavigation.get(frame);
    if (order === undefined) return false;
    const finished = this.finishedNavigation.get(frame);
    if (finished !== undefined) return now - finished.at < (finished.page ? PAGE_COMMIT_CAP_MS : NAVIGATION_COMMIT_GRACE_MS);
    for (const held of this.open.values()) if (held.frame === frame && held.order === order) return true;
    return false;
  }

  /**
   * Whether `frame`'s navigation on its way has already been answered with a page, so its commit is all that is left:
   * the address is about to change, though the browser may report it late. Bounded by PAGE_COMMIT_CAP_MS from the
   * finish, as navigating is.
   */
  committing(frame: F, now: number = Date.now()): boolean {
    const order = this.pendingNavigation.get(frame);
    if (order === undefined) return false;
    const finished = this.finishedNavigation.get(frame);
    if (finished !== undefined) return finished.page && now - finished.at < PAGE_COMMIT_CAP_MS;
    for (const held of this.open.values()) if (held.frame === frame && held.order === order) return held.page === true;
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

/**
 * Longest to wait for the page's own clock to pass the quiet window (UrlWatch.pageBehind). A page whose scripts are
 * held back, by its own long task or a loaded machine, runs its timers late: by the wall clock its address has held
 * still for the window while a guard due inside it has not yet run. Waited for only while the page is behind, so a page
 * that keeps time pays only the probe's round trip, and one whose main thread never comes back still returns.
 */
export const URL_PAGE_CLOCK_CAP_MS = 5000;
/**
 * How long a page that has begun to leave (UrlWatch.leftForMs: it fired beforeunload during the watch) is waited on
 * for its navigation to be seen. The page starts leaving before the browser reports the navigation's request; a page
 * whose navigation is then cancelled (a 204, a download) holds the watch no longer than this.
 */
export const URL_LEAVING_GRACE_MS = 1000;

/**
 * The script that measures the quiet window on the page's own clock: it answers once a timer of `ms` set now has run,
 * which is after every timer the page set earlier with a delay no longer than that (setTimeout runs them in that
 * order; for a shorter wait than an overdue timer's delay, the browsers' deadline order), and says whether the page
 * began to leave (beforeunload) meanwhile. A page that leaves before it answers rejects it: its document is gone. The
 * wait is at least 1 ms: Chromium runs a 0 ms timer ahead of earlier timers that are already overdue.
 */
export function pageClockScript(ms: number): string {
  const wait = Math.max(1, Math.round(ms));
  return (
    "new Promise((resolve) => { let leaving = false; const mark = () => { leaving = true; };" +
    ' addEventListener("beforeunload", mark, true);' +
    ` setTimeout(() => { removeEventListener("beforeunload", mark, true); resolve({ leaving }); }, ${wait}); })`
  );
}

export interface UrlWatch {
  /** Since the URL last changed. */
  sinceChangeMs: number;
  /** Since the watch began. */
  elapsedMs: number;
  /** Whether the page's own navigation has started and not yet committed or failed: its address is about to change. */
  navigating?: boolean;
  /** How long the URL must hold still; URL_QUIET_MS unless given. */
  quietMs?: number;
  /** Whether the page's own clock has not yet passed the quiet window (pageClockScript): a timer due in it may not have run. */
  pageBehind?: boolean;
  /** Since the page began to leave (beforeunload) with its address unchanged since; absent when it has not. */
  leftForMs?: number;
}

/**
 * Whether to keep watching the URL before judging where the page landed. A navigation on its way is waited for until it
 * commits or fails, to URL_NAVIGATING_CAP_MS, as is a page that has begun to leave, for URL_LEAVING_GRACE_MS; a page
 * whose own clock is behind the window is waited for to URL_PAGE_CLOCK_CAP_MS; otherwise the address must hold still,
 * to URL_CAP_MS.
 */
export function keepWatchingUrl(w: UrlWatch): boolean {
  if (w.navigating) return w.elapsedMs < URL_NAVIGATING_CAP_MS;
  if (w.leftForMs !== undefined && w.leftForMs < URL_LEAVING_GRACE_MS) return w.elapsedMs < URL_NAVIGATING_CAP_MS;
  if (w.pageBehind) return w.elapsedMs < URL_PAGE_CLOCK_CAP_MS;
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
  /** When an answered request last ended (AnsweredEnds, SettleState.sinceLastAnsweredEndMs); 0 if never. */
  lastAnsweredEnd(): number;
  /** The deliberate pace the session was asked for (normalizePace). */
  paceMs(): number;
  /** The page the session drives now: a wait on a page the session has left ends. */
  current(): unknown;
}

/**
 * Wait after an action until the page has settled (shouldKeepWaiting), or the session has moved to another page.
 * `now` is the clock the wait measures by; a test passes one its stand-in page advances, so no assertion rests on
 * how long a real timer took (a 20 ms tick takes about 31 ms on Windows' default timer resolution). It must be the
 * clock `src.lastRequestStart()` and `src.lastAnsweredEnd()` are read on, or the time since the last request means nothing. `read` is for a wait
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
      sinceLastAnsweredEndMs: now() - src.lastAnsweredEnd(),
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
 * default none, so the window runs from the watch's start. `pageClock`, where a sign-in verdict is made, runs
 * pageClockScript for what is left of the window: until it answers the page is behind (UrlWatch.pageBehind), and an
 * answer that the page began to leave holds the watch until the address changes, for at most URL_LEAVING_GRACE_MS
 * (UrlWatch.leftForMs).
 */
export async function stableUrlOf(
  current: () => SettlingPage | null,
  now: () => number = Date.now,
  opts: { navigating?: () => boolean; quietMs?: number; heldMs?: number; pageClock?: (ms: number) => Promise<{ leaving: boolean }> } = {},
): Promise<string> {
  const page = current();
  if (!page || page.isClosed()) return page ? page.url() : "";
  const started = now();
  let url = page.url();
  let changedAt = started - Math.max(0, opts.heldMs ?? 0);
  let behind = false;
  let leftAt: number | null = null;
  if (opts.pageClock) {
    behind = true;
    const left = Math.max(0, (opts.quietMs ?? URL_QUIET_MS) - Math.max(0, opts.heldMs ?? 0));
    void opts.pageClock(left).then(
      (r) => {
        behind = false;
        if (r.leaving && page.url() === url) leftAt = now();
      },
      // Its document is gone (the page left or closed) or could not be read: the address, and the navigation on its way, decide.
      () => {
        behind = false;
      },
    );
  }
  for (;;) {
    const watch: UrlWatch = { sinceChangeMs: now() - changedAt, elapsedMs: now() - started, navigating: opts.navigating?.() ?? false };
    if (opts.quietMs !== undefined) watch.quietMs = opts.quietMs;
    if (behind) watch.pageBehind = true;
    if (leftAt !== null) watch.leftForMs = now() - leftAt;
    if (!keepWatchingUrl(watch)) return url;
    await bestEffort(page.waitForTimeout(SETTLE_TICK_MS));
    if (current() !== page || page.isClosed()) return url;
    const at = page.url();
    if (at !== url) {
      url = at;
      changedAt = now();
      leftAt = null;
    }
  }
}

/**
 * A navigation the page started on its own, before it is read.
 *
 * A page can move itself on just after it loads (a script's `location.href`), to an address that answers slowly or
 * never. Chromium holds a read of the page (page.evaluate) until that navigation commits or fails, with no limit of
 * its own, so a crawl that read the route then hung for as long as the address took: past 40 s on one that never
 * answered. Before the read, such a navigation is waited for until it lands or the page-load limit runs out, counted
 * from when the load began, so the route's whole load keeps to that limit; a navigation still on its way then is
 * reported as a navigation pending rather than read.
 */
export interface OwnNavigationWait {
  /** Whether the page's own navigation is on its way (InFlightRequests.navigating). */
  navigating: boolean;
  /** Since the load being judged began. */
  elapsedMs: number;
  /** The page-load limit for that load. */
  limitMs: number;
}

/** Whether to keep waiting for a navigation the page started on its own: while one is on its way, within the page-load limit. */
export function keepWaitingForNavigation(w: OwnNavigationWait): boolean {
  return w.navigating && w.elapsedMs < w.limitMs;
}

/**
 * Wait for a navigation the page started on its own to land (keepWaitingForNavigation). `startedAt` is when the load
 * began, on `now`'s clock. Answers whether the page can be read: true once nothing is on its way, or the page is closed;
 * false when a navigation was still on its way at the limit. Once a navigation has been waited for, the page it landed
 * on must then go QUIET_MS without starting another before it is read: a page that lands on a script that moves it on
 * again (A to B to C) would otherwise be read while C is on its way. A page with nothing on its way is read at once.
 */
export async function ownNavigationLanded(
  page: SettlingPage,
  navigating: () => boolean,
  limitMs: number,
  startedAt: number,
  now: () => number = Date.now,
): Promise<boolean> {
  let waited = false;
  let landedAt: number | null = null;
  for (;;) {
    if (page.isClosed()) return true;
    const on = navigating();
    if (!keepWaitingForNavigation({ navigating: on, elapsedMs: now() - startedAt, limitMs })) {
      if (on) return false;
      if (!waited) return true;
      landedAt ??= now();
      // Past the limit, a page that has landed is read without the quiet window.
      if (now() - landedAt >= QUIET_MS || now() - startedAt >= limitMs) return true;
    } else {
      waited = true;
      landedAt = null;
    }
    await bestEffort(page.waitForTimeout(SETTLE_TICK_MS));
  }
}

/** Wait up to `ms` for `seen` to hold, ticking on the page. Answers whether it did. */
export async function seenWithin(page: SettlingPage, seen: () => boolean, ms: number, now: () => number = Date.now): Promise<boolean> {
  const started = now();
  for (;;) {
    if (seen()) return true;
    if (page.isClosed() || now() - started >= ms) return false;
    await bestEffort(page.waitForTimeout(SETTLE_TICK_MS));
  }
}

/**
 * A navigation the page starts on its own while it is read.
 *
 * The check for a navigation on its way (ownNavigationLanded) sees one only once the browser has sent its request,
 * and the browser sends it a moment after the page's script asked for it: on a loaded machine, after the reads that
 * followed. Read then, the page that was leaving was recorded as the route's state, and on Chromium the next read of
 * it was held until that navigation landed. So each read is bracketed by the page's own account of itself
 * (DOCUMENT_PROBE_SCRIPT): which document it is, and a navigation it has started, seen by the Navigation
 * API's `navigate` event, which every engine fires as the script asks (LEAVING_INIT_SCRIPT). A read that spans two
 * documents, or ends on a page that has started to leave, is not a read of a page that stays. A page that only changes
 * its address in place (pushState, a fragment) is still one document: one that does so on a timer is read as before.
 */
export interface DocumentProbe {
  /** The document's time origin: each document a page loads has its own. */
  doc: number;
  /** The cross-document navigation the document has started and not cancelled, and when (its clock is the machine's). */
  leaving: { url: string; at: number } | null;
}

/** Where the probe finds its record: a symbol on the window, so no page name can collide with it. */
const LEAVING_KEY = "scenescout.leaving";

/**
 * Page-side, run before any of the page's scripts: names the document by its time origin and records the
 * cross-document navigation it starts. A same-document one (a fragment, pushState) and a download, which leaves the
 * page where it is, are not recorded; a navigation the page intercepts is cleared once it commits in place at its own
 * address. `Date.now` and the time origin are kept as the page found them, so a page that replaces them later cannot
 * change what is read, and an event the page dispatches itself is ignored.
 */
export const LEAVING_INIT_SCRIPT = `(() => {
  const KEY = Symbol.for(${JSON.stringify(LEAVING_KEY)});
  if (Object.prototype.hasOwnProperty.call(window, KEY)) return;
  const clock = Date.now;
  const doc = performance.timeOrigin;
  let mark = null;
  const nav = window.navigation;
  if (nav && typeof nav.addEventListener === "function") {
    nav.addEventListener("navigate", (e) => {
      // One the page dispatched itself is no navigation, and must not clear the record of one that is.
      if (!e.isTrusted) return;
      try {
        if (e.destination.sameDocument || e.hashChange || (e.downloadRequest !== null && e.downloadRequest !== undefined)) return;
        mark = { url: String(e.destination.url), at: clock(), event: e };
      } catch (err) {
        mark = null;
      }
    });
    nav.addEventListener("currententrychange", (e) => {
      if (!e.isTrusted) return;
      try {
        if (mark && nav.currentEntry && nav.currentEntry.url === mark.url) mark = null;
      } catch (err) {
        mark = null;
      }
    });
  }
  Object.defineProperty(window, KEY, {
    value: { doc, leaving: () => (mark && !mark.event.defaultPrevented ? { url: mark.url, at: mark.at } : null) },
  });
})()`;

/**
 * Page-side: the page's account of itself (DocumentProbe), read before and after a read of it. A document the init
 * script did not run in is named by its time origin as it reads now, and never reports leaving.
 */
export const DOCUMENT_PROBE_SCRIPT = `(() => {
  const own = window[Symbol.for(${JSON.stringify(LEAVING_KEY)})];
  if (own && typeof own.leaving === "function") return { doc: own.doc, leaving: own.leaving() };
  let doc = 0;
  try {
    doc = Number(performance.timeOrigin) || 0;
  } catch (err) {
    doc = 0;
  }
  return { doc, leaving: null };
})()`;

/**
 * How long a navigation the page started may go without a request before it is taken as one that sends none (an
 * external protocol's link, one a dialog cancelled). With the renderer slowed six-fold, the request was out within 1.5 s.
 */
export const LEAVING_REQUEST_GRACE_MS = 2000;

/** How far the page's clock may read ahead of the engine's: the same machine's, rounded by some engines. */
const LEAVING_CLOCK_SLOP_MS = 50;

/**
 * Whether the navigation the page started (`mark`) is on its way with no request seen yet: no navigation of the main
 * frame has started since, nothing has committed at its address since (one that sends no request, such as
 * about:blank), and it was started less than LEAVING_REQUEST_GRACE_MS ago. A commit elsewhere (the page's pushState)
 * is not it. Once its request is seen, whether it is on its way is the request's to say (InFlightRequests.navigating).
 */
export function leavingUnsent(
  mark: DocumentProbe["leaving"],
  seen: { starts: readonly { at: number }[]; commits: readonly { url: string; at: number }[] },
  now: number = Date.now(),
): boolean {
  if (mark === null) return false;
  const since = mark.at - LEAVING_CLOCK_SLOP_MS;
  const bare = (u: string): string => u.split("#")[0];
  if (seen.starts.some((s) => s.at >= since) || seen.commits.some((c) => c.at >= since && bare(c.url) === bare(mark.url))) return false;
  return now - mark.at < LEAVING_REQUEST_GRACE_MS;
}

/**
 * What a read bracketed by probes read: "one" document that is staying; a read that "crossed" from one document to
 * another (or whose probe a navigation ended), so what it read may be of either; or one of a page "leaving", which had
 * started a navigation of its own that is still on its way (`onItsWay`) as the read ended.
 */
export type DocumentRead = "one" | "crossed" | "leaving";

export function documentRead(
  before: DocumentProbe | null,
  after: DocumentProbe | null,
  onItsWay: (mark: NonNullable<DocumentProbe["leaving"]>) => boolean,
): DocumentRead {
  if (before === null || after === null || before.doc !== after.doc) return "crossed";
  return after.leaving !== null && onItsWay(after.leaving) ? "leaving" : "one";
}

/** How many times a read that crossed a document change or ended on a page leaving is taken again where the page landed. */
export const MOVED_READ_ROUNDS = 3;
