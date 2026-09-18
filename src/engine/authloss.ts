/**
 * Auth-loss detection: telling "this role may not see that page" apart from
 * "our credentials died and nothing since is meaningful".
 *
 * Extracted from browser.ts because it is a small state machine with real
 * invariants — a streak, a once-only explanatory tail, a single-consumption
 * notice buffer — that was previously inline in a 2300-line class and reachable
 * only by driving a whole browser. Three separate bugs landed in it there
 * (a bounce judged before the page settled, a notice lost whenever the
 * surrounding call threw, and that same notice then leaking onto the NEXT
 * call's result). All three are cheap to pin once the logic stands alone.
 */

/** Paths that look like a login/auth screen — the landing place of a dead session. */
export const LOGIN_ROUTE_RE = /\/(login|signin|sign-in|auth)(\/|$)/;

/** Consecutive login bounces before we stop assuming it is a permission wall. */
export const AUTH_LOSS_STREAK = 3;

export class AuthLossTracker {
  /** Consecutive navigations that ended on a login page. */
  private streak = 0;
  /** Set once the verdict has been delivered, so the long tail is added once. */
  private reported = false;
  /** Notice for the in-flight call, consumed exactly once by take(). */
  private pending = "";

  /**
   * Did a navigation to `requested` end up on a login screen?
   *
   * Normalizes `requested` itself rather than trusting callers: crawl passes
   * raw targets and tolerates slash-less paths, so an explicit crawl of
   * "login" — the anonymous auth-surface pass — was scored as a bounce and fed
   * the streak. Deliberately does not fire when the caller ASKED for the login
   * page, whatever shape they asked in.
   */
  isLoginRedirect(requested: string, landedUrl: string, baseUrl: string): boolean {
    let landedPath: string;
    try {
      landedPath = new URL(landedUrl, baseUrl || "http://x").pathname;
    } catch {
      return false;
    }
    const wanted = requested.startsWith("/") ? requested : `/${requested}`;
    return LOGIN_ROUTE_RE.test(landedPath) && !LOGIN_ROUTE_RE.test(wanted);
  }

  /**
   * Record one navigation's outcome and build the notice for it.
   *
   * `bounced` decides both the streak and whether the route counts as covered;
   * the caller owns the memory writes, because ownership of the store belongs
   * to the engine, not to this tracker.
   */
  record(opts: { requestedRoute: string; landedRoute: string; bounced: boolean; role: string }): void {
    const { requestedRoute, landedRoute, bounced, role } = opts;
    if (bounced) this.streak += 1;
    else this.streak = 0;

    const divergence =
      landedRoute === requestedRoute
        ? ""
        : `⚠ REDIRECTED: asked for ${requestedRoute}, landed on ${landedRoute}` +
          (bounced
            ? ` — this is a login page, so the route is NOT counted as covered.`
            : ` — the app redirected; the route counts as covered for role '${role}'.`) +
          `\n`;

    this.pending = this.banner() + divergence;
  }

  /**
   * The verdict, once the streak says the session is dead.
   *
   * One bounce is ordinary (a permission wall, a session that was never
   * authenticated). Three in a row means the credentials this session attached
   * with have expired, and every subsequent "OK" is a lie: the page rendered,
   * the URL changed, and nothing that follows tests the app. This used to be
   * invisible because the passive HTTP oracle rates 401 as `medium` and then
   * collapses repeats to "nothing new" — the signal decayed exactly as the
   * problem got worse.
   */
  private banner(): string {
    if (this.streak < AUTH_LOSS_STREAK) return "";
    const first = !this.reported;
    this.reported = true;
    return (
      `⚠ SESSION AUTH LOST — ${this.streak} consecutive navigations were redirected to a login page. ` +
      `The credentials this session attached with have almost certainly expired. ` +
      `Nothing tested past this point is meaningful: re-attach with a fresh storage state before continuing.` +
      (first
        ? ` Routes bounced this way are recorded as NOT covered, so the completion contract still sees them as gaps.`
        : "") +
      `\n`
    );
  }

  /**
   * Take the pending notice, clearing it.
   *
   * Single-consumption matters: the notice describes ONE navigation. Left set,
   * it prepended a stale "REDIRECTED: asked for X" to the next, unrelated call
   * — which is what happened whenever the surrounding navigate() threw before
   * reaching its return statement.
   */
  take(): string {
    const out = this.pending;
    this.pending = "";
    return out;
  }

  /** Discard any un-consumed notice. Called before a navigation starts. */
  clear(): void {
    this.pending = "";
  }

  /**
   * The verdict for a BATCH of navigations (a crawl), independent of how the
   * last one happened to land.
   *
   * A crawl records every route in turn, so the per-route notice is overwritten
   * on each iteration and only the final one survives to be taken. That loses
   * the verdict in the ordinary mixed case: the token dies, forty routes bounce,
   * and then the sweep reaches a genuinely public route — which resets the
   * streak, so the last notice is empty and the crawl reports nothing wrong.
   * Once the session has been declared dead, say so at the end of the batch
   * whatever the final route did.
   */
  batchVerdict(): string {
    if (!this.reported) return "";
    return (
      `⚠ SESSION AUTH LOST during this sweep — navigations were redirected to a login page. ` +
      `The credentials this session attached with have almost certainly expired, so routes crawled after that ` +
      `point tested a logged-out app. They are recorded as NOT covered; re-attach with a fresh storage state ` +
      `and crawl again.\n`
    );
  }
}
