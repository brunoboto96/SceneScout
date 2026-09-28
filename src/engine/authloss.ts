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

/** How the session being tracked signed in (profiles.ts AttachAuth's kind). */
export type SignInKind = "role" | "file" | "none";

/**
 * Should this loss be answered by re-attaching from the role's saved profile?
 *
 * Only a session attached by role has a profile that `scenescout login` (or
 * another process) may have refreshed since, so only it has something to
 * re-read. A storage-state file or an anonymous session is reported as
 * before. Once per session: a second loss means the refresh did not hold,
 * and retrying on a loop would hide a dead profile behind endless recoveries.
 */
export function shouldReattach(opts: { streak: number; signIn: SignInKind; alreadyReattached: boolean }): boolean {
  return opts.streak >= AUTH_LOSS_STREAK && opts.signIn === "role" && !opts.alreadyReattached;
}

/**
 * Where a recovered session goes next: back to what the navigation that
 * declared the loss asked for (not the login page it landed on), then to the
 * streak's other targets, which bounced too and are not covered. Each is a
 * same-origin page the session itself navigated to, so going back is a GET it
 * already made.
 */
export interface ReattachPlan {
  returnTo: string;
  retry: string[];
}

export class AuthLossTracker {
  /** Consecutive navigations that ended on a login page. */
  private streak = 0;
  /** Set once the verdict has been delivered, so the long tail is added once. */
  private reported = false;
  /** Notice for the in-flight call, consumed exactly once by take(). */
  private pending = "";
  /** How the session signed in; set by beginSession. */
  private signIn: SignInKind = "none";
  /** The role label of the session, for the notices. */
  private role = "";
  /** What each navigation of the current streak asked for, in order. */
  private streakTargets: string[] = [];
  /** A re-attach this navigation earned and the engine has not taken yet. */
  private due: ReattachPlan | null = null;
  /** Taken by the engine: the next recorded navigation says whether it worked. */
  private awaiting: (ReattachPlan & { left: string[] }) | null = null;
  /** What happened to this session's one re-attach. */
  private outcome: { kind: "recovered"; route: string } | { kind: "failed"; why: string } | null = null;
  /** Notices a batch (crawl) must still say at its end, since it discards the per-route ones. */
  private batchNotes: string[] = [];

  /**
   * Start tracking a newly attached session. An explicit attach is new
   * credentials: the streak, the verdict and the one re-attach start afresh,
   * so a new session neither inherits a dead one's bounces nor names its routes.
   */
  beginSession(signIn: SignInKind, role: string): void {
    this.signIn = signIn;
    this.role = role;
    this.streak = 0;
    this.streakTargets = [];
    this.reported = false;
    this.pending = "";
    this.due = null;
    this.awaiting = null;
    this.outcome = null;
    this.batchNotes = [];
  }

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
   * to the engine, not to this tracker. `target` is what the caller navigated
   * to (a path with its real ids, where `requestedRoute` is the normalized
   * route), which a re-attach goes back to; it defaults to the route.
   */
  record(opts: { requestedRoute: string; landedRoute: string; bounced: boolean; role: string; target?: string }): void {
    const { requestedRoute, landedRoute, bounced, role } = opts;
    const target = opts.target ?? requestedRoute;
    this.due = null;
    const divergence =
      landedRoute === requestedRoute
        ? ""
        : `⚠ REDIRECTED: asked for ${requestedRoute}, landed on ${landedRoute}` +
          (bounced
            ? ` — this is a login page, so the route is NOT counted as covered.`
            : ` — the app redirected; the route counts as covered for role '${role}'.`) +
          `\n`;
    if (this.awaiting) {
      this.settleReattach(requestedRoute, target, bounced, divergence);
      return;
    }
    if (bounced) {
      this.streak += 1;
      this.streakTargets.push(target);
    } else {
      this.streak = 0;
      this.streakTargets = [];
    }

    if (shouldReattach({ streak: this.streak, signIn: this.signIn, alreadyReattached: this.outcome !== null })) {
      // The verdict is replaced by the recovery's own notice once the engine
      // has re-attached; if it never does (the call threw), the verdict stands.
      this.due = { returnTo: target, retry: [...new Set(this.streakTargets)].filter((t) => t !== target) };
    }
    this.pending = this.banner() + divergence;
  }

  /**
   * The re-attach this navigation earned, if any: consumed once, and from then
   * on this session has used its one re-attach. `revisits` says which of the
   * streak's other targets the caller will visit again itself (a crawl, its own
   * paths); the plan it gets back holds only those, and the notice asks for the rest.
   */
  takeReattach(opts: { revisits?: (target: string) => boolean } = {}): ReattachPlan | null {
    const plan = this.due;
    this.due = null;
    if (!plan) return null;
    const revisits = opts.revisits;
    this.awaiting = revisits
      ? { returnTo: plan.returnTo, retry: plan.retry.filter(revisits), left: plan.retry.filter((t) => !revisits(t)) }
      : { returnTo: plan.returnTo, retry: [], left: plan.retry };
    this.outcome = { kind: "failed", why: "it had not finished" };
    return { returnTo: this.awaiting.returnTo, retry: this.awaiting.retry };
  }

  /** Whether a re-attach was taken and the navigation that decides it has not been recorded. */
  get reattaching(): boolean {
    return this.awaiting !== null;
  }

  /** The profile could not be applied, or the page to go back to never loaded: the loss is reported, with why. */
  abortReattach(why: string): void {
    this.awaiting = null;
    this.outcome = { kind: "failed", why };
    const note = `The session tried to re-attach once from role '${this.role}''s saved profile, but ${why}.`;
    this.pending = this.banner(this.lossTail(note));
    this.batchNotes.push(`⚠ ${note}\n`);
  }

  /** The navigation after a re-attach decides it: signed in again, or not. */
  private settleReattach(requestedRoute: string, target: string, bounced: boolean, divergence: string): void {
    const plan = this.awaiting!;
    this.awaiting = null;
    if (bounced) {
      // Still on a login page with the latest profile: that profile is dead too.
      this.streak = Math.max(this.streak, AUTH_LOSS_STREAK);
      this.streakTargets.push(target);
      const why = `its latest saved profile landed on a login page as well, so that profile has expired too`;
      this.outcome = { kind: "failed", why };
      const note = `The session re-attached once from role '${this.role}''s saved profile, but ${why}.`;
      this.pending = this.banner(this.lossTail(note)) + divergence;
      this.batchNotes.push(`⚠ ${note}\n`);
      return;
    }
    this.streak = 0;
    this.streakTargets = [];
    // The loss was answered: a later batch verdict must not claim this session is dead.
    this.reported = false;
    this.outcome = { kind: "recovered", route: requestedRoute };
    const others =
      (plan.retry.length === 0 ? "" : ` The other routes that bounced (${plan.retry.join(", ")}) are visited again in this sweep.`) +
      (plan.left.length === 0 ? "" : ` The other routes that bounced before it (${plan.left.join(", ")}) are still NOT covered: visit them again.`);
    const note =
      `↻ SESSION RE-ATTACHED — its sign-in was lost, so it re-attached once from role '${this.role}''s latest saved profile and ` +
      `is signed in again at ${requestedRoute}.${others} This happens once per session: a second loss is reported, not retried.\n`;
    this.pending = note + divergence;
    this.batchNotes.push(note);
  }

  /** The end of a loss once the one re-attach is spent: what happened, and that it is not retried. */
  private lossTail(note: string): string {
    return ` ${note} It is not retried: record the profile again with \`scenescout login\` for role '${this.role}' and re-attach.`;
  }

  /**
   * One line on what this session's re-attach did, for whoever hands its
   * results on (a lane's report). Empty when it never re-attached.
   */
  reattachSummary(): string {
    if (!this.outcome) return "";
    if (this.outcome.kind === "recovered")
      return `its sign-in was lost and it re-attached once from role '${this.role}''s saved profile, continuing from ${this.outcome.route}`;
    return `its sign-in was lost and re-attaching from role '${this.role}''s saved profile did not recover it: ${this.outcome.why}`;
  }

  /** Start a batch (crawl): its end-of-batch notes cover only what happened during it. */
  beginBatch(): void {
    this.batchNotes = [];
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
  private banner(tail?: string): string {
    if (this.streak < AUTH_LOSS_STREAK) return "";
    const first = !this.reported;
    this.reported = true;
    // After the session's one re-attach, a later loss says so rather than implying a retry is still to come.
    const spent = tail ?? (this.outcome !== null ? this.lossTail(`This session already re-attached once from role '${this.role}''s saved profile.`) : "");
    return (
      `⚠ SESSION AUTH LOST — ${this.streak} consecutive navigations were redirected to a login page. ` +
      `The credentials this session attached with have almost certainly expired. ` +
      `Nothing tested past this point is meaningful: re-attach with a fresh storage state before continuing.` +
      (first ? ` Routes bounced this way are recorded as NOT covered, so the completion contract still sees them as gaps.` : "") +
      spent +
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
    const notes = this.batchNotes.join("");
    if (!this.reported) return notes;
    return (
      notes +
      `⚠ SESSION AUTH LOST during this sweep — navigations were redirected to a login page. ` +
      `The credentials this session attached with have almost certainly expired, so routes crawled after that ` +
      `point tested a logged-out app. They are recorded as NOT covered; re-attach with a fresh storage state ` +
      `and crawl again.\n`
    );
  }
}
