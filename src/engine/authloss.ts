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

/**
 * The endpoints a single sign-on provider on another origin signs in at (`/authorize`, `/oauth2/…`, `/saml2/…`, `/sso/…`,
 * `/adfs/…`, `/openid-connect/…`), by whole segment and in any case (`/idp/profile/SAML2/Redirect/SSO`). Judged only on
 * another origin, where the app's own sign-in shapes (LOGIN_ROUTE_RE) count as well, and only with a sign-in request's
 * parameters (IDP_REQUEST_PARAMS): on its own, such a segment is as likely a docs page (`/guides/sso`) or a payment step
 * (`/authorize`).
 */
const IDP_ENDPOINT_RE = /\/(authorize|oauth|oauth2|saml|saml2|sso|adfs|openid-connect)(\/|$)/i;

/**
 * The query parameters that make a provider's endpoint a sign-in request: OAuth 2.0 and OpenID Connect (`client_id`,
 * `redirect_uri`, `response_type`), SAML's redirect binding (`SAMLRequest`, `RelayState`) and WS-Federation (`wtrealm`).
 * Only their names are read; their values are the sign-in's state and are never printed.
 */
const IDP_REQUEST_PARAMS: readonly string[] = ["client_id", "redirect_uri", "response_type", "SAMLRequest", "RelayState", "wtrealm"];

/** Whether `u`, on another origin than the app's, is a provider's sign-in endpoint (IDP_ENDPOINT_RE) asked to sign in. */
function isProviderSignIn(u: URL): boolean {
  if (!IDP_ENDPOINT_RE.test(u.pathname)) return false;
  return IDP_REQUEST_PARAMS.some((name) => u.searchParams.has(name));
}

/**
 * The route a hash router keeps in the address's fragment (`#/login`, `#!/login?next=…` gives `/login`), or null for a
 * fragment that is not a route (an in-page anchor such as `#login`, or none).
 */
export function hashRoute(hash: string): string | null {
  const body = hash.startsWith("#!") ? hash.slice(2) : hash.startsWith("#") ? hash.slice(1) : "";
  if (!body.startsWith("/")) return null;
  const q = body.indexOf("?");
  return q === -1 ? body : body.slice(0, q);
}

/**
 * Whether `url` is a sign-in page. On the app's own origin (`baseUrl`'s, or any when it is not given) its path, or the
 * route its fragment holds (a hash router's `/#/login`), has a sign-in segment (LOGIN_ROUTE_RE). On another origin, it
 * is an identity provider's sign-in, so a provider's endpoint asked to sign in counts too (isProviderSignIn). Only http
 * and https pages are.
 */
export function isSignInPage(url: string | URL, baseUrl = ""): boolean {
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  let own = true;
  if (baseUrl) {
    try {
      own = new URL(baseUrl).origin === u.origin;
    } catch {
      own = true;
    }
  }
  const route = hashRoute(u.hash);
  if (LOGIN_ROUTE_RE.test(u.pathname) || (route !== null && LOGIN_ROUTE_RE.test(route))) return true;
  return !own && isProviderSignIn(u);
}

/**
 * Where a sign-in page is, for a notice: on the app's origin its path (with the fragment's route, for a hash router),
 * on another origin that origin and path. Never the query, which on a provider's page carries the sign-in's state.
 */
export function signInPlace(url: string, baseUrl: string): string {
  try {
    const u = new URL(url);
    const route = hashRoute(u.hash);
    const here = route === null ? u.pathname : `${u.pathname}#${route}`;
    return new URL(baseUrl).origin === u.origin ? here : `${u.origin}${here}`;
  } catch {
    return url;
  }
}

/** Consecutive login bounces before we stop assuming it is a permission wall. */
export const AUTH_LOSS_STREAK = 3;

/**
 * How many different routes a sign-out of the session's own (AuthLossTracker.signOut) explains. Checking that a few
 * signed-in pages now send the visitor to sign-in is what a sign-out test does; more than this, and the move to sign-in
 * is as likely a sign-in that ran out with no refused request to show it (an app that checks its token's expiry in the
 * page, or a "Log in" link clicked while signed in), so the next such route counts toward SESSION AUTH LOST with the
 * ones before it.
 */
export const SIGNED_OUT_ROUTES = AUTH_LOSS_STREAK;

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
 * Did the page go to a sign-in page on its own since the session last saw it?
 *
 * A navigation, a back and a crawl judge where they land, but an app's scripts
 * can send a signed-out visitor to sign-in later than any of them watches (a
 * token check that answers after a second or two). The session then reads the
 * sign-in page as if it were still on the route it asked for. So, while a
 * session holds a sign-in (`watching`), every call compares the address it last
 * saw (`seen`) with the address now (`now`): on a sign-in page now (isSignInPage,
 * a hash router's `/#/login` included), from a page of the app that was not one,
 * is a bounce of the page it was on. Returns that page's address, or null.
 *
 * The sign-in page may be on another origin: an app that signs in through a
 * single sign-on provider sends a signed-out visitor to the provider's host.
 * There only an address shaped like a sign-in, or a provider's endpoint asked
 * to sign in, counts (isSignInPage), so a page that moved to an ordinary page of
 * another site is not a bounce.
 *
 * Without a sign-in there is nothing to lose and nothing is judged. A session
 * that was already on a sign-in page (it asked for one, or a bounce was
 * recorded), or on a page outside the app, is not judged again, and neither is
 * about:blank.
 */
export function lateSignInBounce(opts: { watching: boolean; seen: string; now: string; baseUrl: string }): string | null {
  const { watching, seen, now, baseUrl } = opts;
  if (!watching || !seen || !now || seen === now) return null;
  let origin: string;
  let seenUrl: URL;
  let nowUrl: URL;
  try {
    origin = new URL(baseUrl).origin;
    seenUrl = new URL(seen);
    nowUrl = new URL(now);
  } catch {
    return null;
  }
  if (seenUrl.origin !== origin) return null;
  if (!isSignInPage(nowUrl, baseUrl) || isSignInPage(seenUrl, baseUrl)) return null;
  return seen;
}

/** HTTP statuses an app answers a request with when the session's sign-in is missing or has run out. */
export const UNAUTHENTICATED_STATUSES: ReadonlySet<number> = new Set([401, 419, 440]);

/**
 * Why an action of the session's own ended on a sign-in page: the tester signed out (or opened sign-in) on purpose, or
 * the sign-in had run out and the app sent the session to sign-in when the action used it. Told apart by the app's
 * answers: a request answered as unauthenticated (UNAUTHENTICATED_STATUSES) during the call (`unauthenticatedAt`, after
 * `callStartedAt`) and before the page reached the sign-in page (`signInAt`, 0 when not seen) means it ran out. A
 * sign-out's own requests succeed; the sign-in page asking the app whether anyone is signed in, after it has loaded,
 * is answered 401 and does not count. A back (`back`) only returns to a sign-in page the browser already holds: it
 * signs nobody out, so it is `returned`, and bounces after it count as before.
 */
export function actionSignInCause(opts: {
  callStartedAt: number;
  unauthenticatedAt: readonly number[];
  signInAt: number;
  back?: boolean;
}): "sign-out" | "ran-out" | "returned" {
  const { callStartedAt, unauthenticatedAt, signInAt } = opts;
  const ranOut = unauthenticatedAt.some((t) => t >= callStartedAt && (signInAt === 0 || t <= signInAt));
  if (ranOut) return "ran-out";
  return opts.back ? "returned" : "sign-out";
}

/**
 * A sign-in page's address as the action log keeps it: on the app's own origin as it is, on another origin its origin
 * and path only. A provider's query carries the sign-in request's state (`state`, `SAMLRequest`, `RelayState`,
 * `code_challenge`), which redaction does not recognise as secret, so it is not written at all.
 */
export function signInLogUrl(url: string, baseUrl: string): string {
  try {
    const u = new URL(url);
    return new URL(baseUrl).origin === u.origin ? url : `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

/**
 * Did an action take the page off a sign-in page, to a page of the app that is not one? That is how a person signs in
 * through the app's own form (or comes back from a provider's), so a sign-out the session made (AuthLossTracker.signOut)
 * ends there. A move between two sign-in pages, or to another site, does not; nor does a back, which the caller leaves
 * out, since it returns to a page the browser already holds.
 */
export function leftSignIn(opts: { seen: string; now: string; baseUrl: string }): boolean {
  const { seen, now, baseUrl } = opts;
  if (!seen || !now || seen === now) return false;
  try {
    const nowUrl = new URL(now);
    if (nowUrl.origin !== new URL(baseUrl).origin) return false;
    return isSignInPage(seen, baseUrl) && !isSignInPage(nowUrl, baseUrl);
  } catch {
    return false;
  }
}

/**
 * What a watched call does to the page's address: `judges` its own landing (a navigation, a crawl, a plan, a replay, a
 * baseline capture), only `reads` the page (a snapshot, a scroll, a hover, a design audit, an element capture), or
 * `moves` it as a person would (a click, typing, a select, a key press, an upload, a back).
 */
export type WatchedCall = "judges" | "reads" | "moves";

/**
 * What a sign-in page found by lateSignInBounce means, by when it was found and by what call.
 *
 * Found `before` a call runs, the page went there on its own since the last call: a bounce (`count`). Found as a call
 * ends, it depends on the call. A call that only reads cannot have sent the page there, so that too is the page going
 * on its own (`count`). An action can: a click on "Sign out" or on a "Log in" link lands on a sign-in page on purpose,
 * and counting it would mark the page the tester was on as not covered, add to SESSION AUTH LOST and, for a role
 * session, sign the tester back in after they signed out. So it is said, not counted (`note`); whether the sign-in
 * still holds is for the next navigation to a signed-in page to show. A call that judges its own landing has already
 * recorded it (`none`).
 */
export function lateSignInVerdict(call: WatchedCall, when: "before" | "end"): "count" | "note" | "none" {
  if (when === "before") return "count";
  if (call === "reads") return "count";
  return call === "moves" ? "note" : "none";
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
  /** The last navigation recorded, when it did not bounce, with the streak as it stood before it ended it. */
  private lastClear: { route: string; streak: number; targets: string[] } | null = null;
  /** Where an action of the session's own went to a sign-in page from (a sign-out), until it signs in again. */
  private signedOutFrom: string | null = null;
  /** The routes that bounced while signed out, each with what was asked for: one reached signed in shows the sign-in is back. */
  private signedOutBounces = new Map<string, string>();

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
    this.lastClear = null;
    this.signedOutFrom = null;
    this.signedOutBounces.clear();
  }

  /**
   * An action of the session's own landed on a sign-in page (a click on "Sign out", or a "Log in" link). From then on,
   * a page that sends the session to sign-in is what signing out does, not a sign-in that ran out: each such bounce is
   * still recorded and its route is not covered, but none counts toward SESSION AUTH LOST, so the verdict is not raised
   * and a role session is not signed back in behind the tester's back. It lasts until the session signs in again: an
   * action takes it from a sign-in page into the app (signInAgain), or a route that bounced while signed out is reached
   * signed in (record). A new attach ends it too. It explains at most SIGNED_OUT_ROUTES different routes: the next
   * one ends it, and it and those before it count toward the verdict.
   */
  signOut(from: string): void {
    this.signedOutFrom = from;
    this.signedOutBounces.clear();
    this.streak = 0;
    this.streakTargets = [];
    this.lastClear = null;
    this.due = null;
  }

  /** An action took the session off a sign-in page into the app (authloss.ts leftSignIn): bounces count again. */
  signInAgain(): void {
    if (this.signedOutFrom === null) return;
    this.signedOutFrom = null;
    this.signedOutBounces.clear();
    this.streak = 0;
    this.streakTargets = [];
    this.lastClear = null;
  }

  /** Whether the session signed out on purpose and has not signed in again (signOut). */
  get signedOut(): boolean {
    return this.signedOutFrom !== null;
  }

  /**
   * Did a navigation to `requested` end up on a login screen?
   *
   * Normalizes `requested` itself rather than trusting callers: crawl passes
   * raw targets and tolerates slash-less paths, so an explicit crawl of
   * "login" — the anonymous auth-surface pass — was scored as a bounce and fed
   * the streak. Deliberately does not fire when the caller ASKED for the login
   * page, whatever shape they asked in. A landing counts by isSignInPage: a
   * hash router's `/#/login`, and a provider's sign-in on another origin.
   */
  isLoginRedirect(requested: string, landedUrl: string, baseUrl: string): boolean {
    let landed: URL;
    try {
      landed = new URL(landedUrl, baseUrl || "http://x");
    } catch {
      return false;
    }
    const wanted = requested.startsWith("/") ? requested : `/${requested}`;
    let asked: URL;
    try {
      asked = new URL(wanted, "http://x");
    } catch {
      return false;
    }
    return isSignInPage(landed, baseUrl) && !isSignInPage(asked);
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
    this.lastClear = bounced || this.awaiting ? null : { route: requestedRoute, streak: this.streak, targets: [...this.streakTargets] };
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
    if (!bounced && this.signedOutBounces.has(requestedRoute)) this.signInAgain();
    let ended = "";
    if (bounced && this.signedOutFrom !== null) {
      if (this.signedOutBounces.has(requestedRoute) || this.signedOutBounces.size < SIGNED_OUT_ROUTES) {
        // Signed out on purpose: the bounce is the sign-out's doing. Not covered, and not counted toward the verdict.
        this.signedOutBounces.set(requestedRoute, target);
        this.pending =
          divergence +
          `This session signed out on purpose (from ${this.signedOutFrom}), so this is not counted as a lost sign-in and it is not ` +
          `signed back in. Re-attach to test signed in again.\n`;
        return;
      }
      // More routes than a sign-out explains: they count toward the verdict, this one with the ones before it.
      ended =
        `This session went to sign-in from ${this.signedOutFrom} by an action of its own, but ${this.signedOutBounces.size + 1} different ` +
        `routes have sent it to sign-in since, more than signing out explains, so they count as a lost sign-in.\n`;
      this.streak = this.signedOutBounces.size;
      this.streakTargets = [...this.signedOutBounces.values()];
      this.signedOutFrom = null;
      this.signedOutBounces.clear();
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
    this.pending = ended + this.banner() + divergence;
  }

  /**
   * A page the session was on went to a login page on its own, after its navigation was recorded as landing where it
   * asked (lateSignInBounce). That navigation was a bounce after all: when it is the last one recorded, the streak it
   * ended is put back before this bounce is counted, so a dead session whose app redirects late still reaches the
   * verdict. Otherwise it counts as any other bounce.
   */
  recordLate(opts: { requestedRoute: string; landedRoute: string; role: string; target?: string }): void {
    const clear = this.lastClear;
    if (clear && clear.route === opts.requestedRoute) {
      this.streak = clear.streak;
      this.streakTargets = clear.targets;
    }
    this.record({ ...opts, bounced: true });
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

  /**
   * Whether the session's sign-in is gone now: the streak has reached the
   * verdict and no re-attach is still to say otherwise. A navigation that
   * lands signed in, a re-attach that recovers, and a new attach each end it.
   * A session given no sign-in has none to lose: its bounces are the site's
   * access rule, reported by the verdict's notice, not a sign-in that ran out.
   */
  get lost(): boolean {
    return this.signIn !== "none" && this.streak >= AUTH_LOSS_STREAK && this.awaiting === null;
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
