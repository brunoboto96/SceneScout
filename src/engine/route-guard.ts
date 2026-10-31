/**
 * The write policy on the wire: the context's route handler, and Chromium's
 * browser-level interception of the writes that handler never sees.
 *
 * The rules themselves live in policy.ts and unload.ts. This module applies
 * them to live requests: it decides, for each request a page sends, whether it
 * goes out, is refused with a stand-in answer, or is dropped, and it reports
 * each refusal back to the engine. What it needs from the engine (the page it
 * drives, the rule in force, where a refusal is reported) comes through
 * `RouteGuardHost`, so the decisions below can be table-tested without a
 * browser (policy-test).
 */
import { randomUUID } from "node:crypto";
import type { Browser, CDPSession, Page, Request, Response, Route, WebSocketRoute } from "playwright";
import { BROWSER_HOST_MAX_HOPS, BROWSER_HOST_REFUSAL, hostRedirectPlan, refusedBrowserHost, type BrowserHostList } from "./browser-hosts.js";
import { abortCodeFor, redirectStandIn } from "./app-header.js";
import { logAddress, socketAddress } from "./authloss.js";
import { settleWithin } from "./best-effort.js";
import { INFRASTRUCTURE_WRITE_RE } from "./claims.js";
import {
  allowsWrite,
  answersWithRefusal,
  DESTRUCTIVE_GET_REFUSAL,
  ESCAPE_REFUSAL,
  isAuthExempt,
  isDestructiveRequest,
  type AuthPostList,
  offAppPageWrite,
  policyRefusal,
  sandboxedRedirectPage,
  stricterMode,
  withForeignFrameSandbox,
  writeMethod,
  writeMethodLabel,
  type ReadPost,
  type WriteMode,
} from "./policy.js";
import { NOT_ALLOWED_WRITE_REFUSAL, signInRuleMode, writeAllowListFor, type AllowedWrite, type WriteAllowList } from "./write-allowlist.js";
import {
  bodyDigest,
  headerOf,
  isReadMethod,
  judgeUnseenWrite,
  LEAVE_MARKER_PATH,
  LeftPageRules,
  leaveMarkerToken,
  leaveMarkerUrl,
  pausedRequestBytes,
  RoutedWrites,
  UnseenRefusals,
  unseenWriteSource,
  type UnseenWriteVerdict,
} from "./unload.js";
import { destructiveGet, type WriteClassifier } from "./strict-writes.js";

const BENIGN_MUTATION_RE = INFRASTRUCTURE_WRITE_RE;

/**
 * Request URL → pathname, falling back to the raw string for anything
 * unparseable (data: URLs, relative forms Playwright occasionally reports).
 *
 * Extracted because BOTH destructive-wire checks must see the same thing. When
 * the bookkeeping check inlined its own version it drifted into passing the
 * HTTP METHOD as the url and the url as the body — so a destructive GraphQL
 * mutation, whose only evidence lives in the POST body, was never inspected
 * there at all, and a request the policy went on to BLOCK still marked its
 * route "mutated". One helper, two callers, no room to diverge again.
 */
export function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * A write that went out as the sent-writes notice and the double-submit count name it: the method, and the address as
 * logAddress keeps it (another site's by origin and path, the app's own with its query), capped. Both places that note a
 * sent write build it here, so a repeated request reads as one signature in either.
 */
export function sentWriteSig(label: string, url: string, appUrl: string): string {
  return `${label} ${logAddress(url, appUrl).slice(0, 120)}`;
}

/**
 * Whether a page load of this address is refused for what it names: a destructive command (strict-writes.ts
 * destructiveGet), in observe and read-only, when that refusal is turned on. Asked by the route handler, by the
 * browser-level check of a redirect's later hops, and by the allowlist header's own sends of a redirect's hops within
 * the app (browser.ts loadWithAppHeader), so none of them sends a load the others refuse.
 */
export function refusedPageLoad(rule: WriteMode, refuseDestructiveGets: boolean, url: string): boolean {
  return (rule === "observe" || rule === "read-only") && refuseDestructiveGets && destructiveGet(url);
}

/** A write the policy refused, as the engine's next notice reports it. */
export interface BlockedRequest {
  at: number;
  sig: string;
  answered: boolean;
  why?: string;
  type?: string;
  /** The rule that refused it, which a page a flow left may hold after the session's own has loosened (RouteGuard `rule`). */
  rule?: WriteMode;
  /** True: refused by the browserHosts list rather than the write policy (browser-hosts.ts), and reported in its own notice. */
  offHost?: boolean;
}

/** What the guard needs from the engine that drives the session. */
export interface RouteGuardHost {
  /** The app under test's base URL. */
  appUrl(): string;
  /** The rule a request is judged under, read as it arrives (policy.ts WriteRule). */
  rule(): WriteMode;
  /** The URL of the page the session drives, if one is open. */
  pageUrl(): string | undefined;
  /** Origins the user named as trusted embeds. */
  trustedEmbeds(): ReadonlySet<string>;
  /** The site an embed moved the driven page to, if one did (policy.ts EmbedMoveTracker). */
  movedByEmbed(): string | null;
  /** Record a refused write for the next notice. */
  noteBlocked(entry: BlockedRequest): void;
  /** Append to the run's action log. */
  logAction(entry: { action: string; target: string; url: string }): void;
  /** Tell the oracles a write was refused. */
  notePolicyBlock(): void;
  /** Record a write that went out without passing the route handler (Chromium's browser-level interception). */
  noteSentWrite(entry: { at: number; sig: string }): void;
  /** The foreign origin behind a write headed outside the app under `rule`, or null. */
  foreignWriteOf(req: Request, rule: WriteMode): string | null;
  /** Whether a document request is a frame's escape out of the app (WebKit's dropped sandbox). */
  embedEscapeNavigation(req: Request): boolean;
  /** What a document request loads into under `rule`: a frame of another origin, a frame of the app's, or neither. */
  frameDocumentKind(req: Request, rule: WriteMode): "foreign" | "app" | null;
  /** Whether the driven page sent `req` from its top document. */
  sentByMainFrame(req: Request): boolean;
  /** The read-POST entry that lets this request out under `rule`, or null. */
  readPostOf(rule: WriteMode, method: string, url: string, body: string | null | undefined, destructiveWire?: boolean): ReadPost | null;
  /** Remember, for the gap ledger, a POST observe refused. */
  noteObserveRefusedPost(url: string, body: string | null, referer: string | undefined): void;
  /** A POST to this endpoint went out: the pages observe refused it on are no longer a gap for it. */
  clearRefusedPost(url: string): void;
  /** Whether this run created the resource at `pathname` (safe-write ownership). */
  isOwnedResource(pathname: string): boolean;
  /** Record what a successful POST created (safe-write ownership). */
  recordCreation(res: Response): Promise<void>;
  /** Which classifier judges whether a write is destructive (strict-writes.ts; standard unless the operator turned strict on). */
  writeClassifier(): WriteClassifier;
  /** Whether a page load whose address is a destructive command is refused in observe and read-only (strict-writes.ts destructiveGet; off unless turned on). */
  refuseDestructiveGets(): boolean;
  /** The sign-in POSTs the operator listed (the config's authPosts or SCENESCOUT_AUTH_POSTS), or null for the path rule (policy.ts isAuthExempt). */
  authPosts(): readonly ReadPost[] | null;
  /** True: a listed POST must also look like a sign-in to the path rule, so the list only narrows it (a guided check). Absent: false. */
  authPostsNarrowOnly?(): boolean;
  /** The writes the operator listed (the config's allowedWrites or SCENESCOUT_ALLOWED_WRITES), or null when no list is set (write-allowlist.ts). */
  allowedWrites?(): { entries: readonly AllowedWrite[]; andModeRules: boolean } | null;
  /** The hosts a page may reach (the config's browserHosts or SCENESCOUT_BROWSER_HOSTS), or null when any host may be reached (browser-hosts.ts). */
  browserHosts?(): BrowserHostList | null;
}

/** What the route handler does with a write it sees, short of the ownership rule. */
export type RoutedWriteVerdict =
  | { kind: "refuse"; why: string }
  /** An auth or session request: out in every mode. */
  | { kind: "auth" }
  /** A POST the user named as a read: out, and logged. */
  | { kind: "read-post" }
  /** A write the operator's list names: out, and logged. */
  | { kind: "listed-write" }
  /** Judged by allowsWrite on whether this run owns the resource. */
  | { kind: "by-ownership" };

/**
 * The route handler's verdict on a write (not a GET, HEAD or OPTIONS) in a
 * mode other than destructive, in the order the handler applies the rules: a
 * foreign frame's write is refused before any other rule, sign-in included; a
 * write from a page an embed moved off the app is refused unless it is a
 * sign-in; a sign-in goes out; with a list of allowed writes, an unlisted
 * write is refused and a listed one goes out; a read POST goes out; the rest
 * is judged by ownership. unload.ts judgeUnseenWrite applies the same rules to the writes
 * the handler never sees.
 */
export function routedWriteVerdict(input: {
  rule: WriteMode;
  method: string;
  pathname: string;
  destructiveWire: boolean;
  foreign: string | null;
  offApp: string | null;
  readPost: boolean;
  /** The operator's sign-in allowlist for this request, when one is set. */
  authList?: AuthPostList | null;
  /** The operator's list of allowed writes as this request meets it, when one is set. */
  allowList?: WriteAllowList | null;
}): RoutedWriteVerdict {
  const { rule, method, pathname, destructiveWire } = input;
  if (input.foreign) return { kind: "refuse", why: `sent from a frame of ${input.foreign}` };
  const authExempt = isAuthExempt(signInRuleMode(rule, input.allowList), method, pathname, destructiveWire, input.authList);
  if (input.offApp && !authExempt) return { kind: "refuse", why: `sent from a page of ${input.offApp}, outside the app` };
  if (authExempt) return { kind: "auth" };
  if (input.allowList) {
    if (!input.allowList.listed) return { kind: "refuse", why: NOT_ALLOWED_WRITE_REFUSAL };
    if (!input.allowList.andModeRules) return { kind: "listed-write" };
  }
  if (input.readPost) return { kind: "read-post" };
  return { kind: "by-ownership" };
}

/**
 * Whether a write the request event saw marks its page's forms as exercised
 * (the route fact `mutated`): only one the route handler will let out. The
 * request event fires before the handler stops a refused write, so without
 * this a refused destructive POST would mark a form that was never submitted
 * as tested. `foreign` and `offApp` are asked only when the rule needs them.
 */
export function marksRouteExercised(input: {
  rule: WriteMode;
  method: string;
  pathname: string;
  destructiveWire: boolean;
  foreign: () => string | null;
  offApp: () => string | null;
  authList?: AuthPostList | null;
  allowList?: WriteAllowList | null;
}): boolean {
  const { rule, method, pathname, destructiveWire } = input;
  const authExempt = isAuthExempt(signInRuleMode(rule, input.allowList), method, pathname, destructiveWire, input.authList);
  // A list of allowed writes: only a listed write (or a sign-in) goes out, and a listed one needs nothing else unless the list only narrows.
  if (rule !== "destructive" && input.allowList && !authExempt && !input.allowList.listed) return false;
  const listedOut = rule !== "destructive" && !authExempt && input.allowList?.listed === true && !input.allowList.andModeRules;
  // Same test the route handler uses: in observe only an exempt auth request goes out.
  if (rule === "observe" && !authExempt && !listedOut) return false;
  if ((rule === "read-only" || rule === "observe") && destructiveWire && !listedOut) return false;
  // A foreign frame's write is refused in every mode the route handler runs in.
  if (rule !== "destructive" && input.foreign()) return false;
  if (rule !== "destructive" && input.offApp() && !authExempt) return false;
  return true;
}

/** The write policy's route handler and browser-level interception for one engine. */
export class RouteGuard {
  /** An address as a notice and the action log name it: another site's without its query (authloss.ts logAddress), capped. */
  private place(url: string): string {
    return logAddress(url, this.host.appUrl()).slice(0, 140);
  }

  /**
   * Chromium only (browsers.ts `unloadWriteInterception`): the writes the
   * route handler already let through, so the browser-level interception that
   * catches what it never sees does not judge them twice. That session lives
   * as long as the browser, so a page closed at the end still meets it.
   */
  private readonly routedWrites = new RoutedWrites();
  /** Requests the route handler is still judging, by the page that sent them: a page is closed only once its own are answered. */
  private readonly routesInFlight = new Map<Page, Set<Promise<unknown>>>();
  /** Requests the browser-level interception is still judging (unseenInFlight). */
  private readonly unseenJudging = new Set<Promise<unknown>>();
  /** Leave markers not yet heard at the browser level, by token (unload.ts LEAVE_MARKER_PATH). */
  private readonly leaveMarkers = new Map<string, () => void>();
  /**
   * Every leave marker URL this guard has issued, kept after its wait ends: a marker heard late, or a request carrying
   * one (a content policy's report of it), is still the engine's own and is failed rather than judged or sent.
   */
  private readonly issuedMarkers = new Set<string>();
  /** The rule each page left with a marker is still judged under, until its marker is heard (unload.ts LeftPageRules). */
  private readonly leftPages: LeftPageRules;
  /** Writes refused at the browser level, so the driver's own report of them (a redirect hop failing) is known as the policy's doing. */
  private readonly unseenRefusals = new UnseenRefusals();
  /**
   * Requests the write policy stopped, by identity — whether it dropped them or
   * answered them with a stand-in refusal. The request event fires for
   * every non-GET the page ATTEMPTS, before the route handler decides its fate,
   * so without this the same DELETE was reported twice with opposite meanings:
   * "server state may have mutated despite read-only mode" and "WRITE-POLICY
   * blocked". Identity rather than URL matching: two requests to one URL can
   * meet different fates, and a blocked /items/7/archive must not hide an
   * allowed POST /items that shares its prefix.
   */
  private readonly refusedByPolicy = new WeakSet<Request>();
  /**
   * In-flight recordCreation() calls (safe-write). A single UI action often
   * fires POST-then-immediately-PUT (create, then save the content it just
   * got an id for) — the PUT's route handler runs synchronously, but
   * recordCreation awaits the POST response body, so without this the PUT
   * could be evaluated and wrongly blocked before its own creation had
   * finished registering.
   */
  private pendingCreations = new Set<Promise<unknown>>();

  /** Page loads refused as destructive commands, by URL, until the navigation that asked for one reads it (tookRefusedLoad). */
  private readonly refusedLoads = new Set<string>();

  constructor(
    private readonly host: RouteGuardHost,
    leftPageRuleCapMs?: number,
  ) {
    this.leftPages = new LeftPageRules(leftPageRuleCapMs);
  }

  /**
   * The rule a request heard of now is judged under: the session's (WriteRule), or a stricter one a page left with a
   * marker still holds, since a write that page sent as it was left may be reported after the session's rule has loosened.
   */
  rule(now = Date.now()): WriteMode {
    const session = this.host.rule();
    const left = this.leftPages.at(now);
    return left === null ? session : stricterMode(session, left);
  }

  /** Whether a page load of `url` was refused as a destructive command; forgotten once asked. */
  tookRefusedLoad(url: string): boolean {
    let key = url;
    try {
      key = new URL(url).href;
    } catch {
      /* compared as given */
    }
    return this.refusedLoads.delete(key);
  }

  /** The operator's sign-in allowlist as one request is judged against it, or null when none is set. */
  authListFor(url: string): AuthPostList | null {
    const entries = this.host.authPosts();
    return entries ? { entries, appUrl: this.host.appUrl(), url, andSignInPath: this.host.authPostsNarrowOnly?.() === true } : null;
  }

  /** The operator's list of allowed writes as a request (its sent method, headers and body) meets it, or null when no list is set. */
  allowListFor(request: { method: string; url: string; headers?: Record<string, string>; body?: string | null }): WriteAllowList | null {
    return writeAllowListFor(this.host.allowedWrites?.() ?? null, this.host.appUrl(), request);
  }

  /** The host the browserHosts list refuses `url` for, or null when it may go (browser-hosts.ts refusedBrowserHost). */
  refusedHost(url: string): string | null {
    return refusedBrowserHost(this.host.browserHosts?.() ?? null, url);
  }

  /** A request the browserHosts list refused, as its notice names it: a page load by where it was going, anything else by its method. */
  private hostSig(method: string, url: string, document: boolean): string {
    return `${document ? "navigation to" : method} ${this.place(url)}`;
  }

  /** Report a request the browserHosts list refused, as every refusal is reported, in its own notice (BlockedRequest offHost). */
  private noteHostRefusal(sig: string, type: string, req: Request | null, topLevel = false): void {
    if (req) this.refusedByPolicy.add(req);
    // Only a page's own load: a frame's refused load must not explain a navigation that failed for another reason.
    if (topLevel) this.lastHostRefusedLoad = { at: Date.now(), sig };
    this.host.noteBlocked({ at: Date.now(), sig, answered: false, why: BROWSER_HOST_REFUSAL, type, offHost: true });
    this.host.logAction({ action: "browser-hosts:blocked", target: `${sig} (${BROWSER_HOST_REFUSAL})`, url: this.host.pageUrl() ?? "" });
    this.host.notePolicyBlock();
  }

  /**
   * The browserHosts route handler, run before the write policy's: a request to a host the list refuses is dropped
   * before it leaves the machine, whatever the mode; anything else is handed on to the write policy.
   */
  handleHosts(route: Route): Promise<void> {
    return this.judgeTracked(route, async (r) => {
      const req = r.request();
      if (this.refusedHost(req.url()) === null) return r.fallback().catch(() => {});
      this.noteHostRefusal(this.hostSig(req.method(), req.url(), req.resourceType() === "document"), req.resourceType(), req, RouteGuard.topLevelLoad(req));
      // Caught: a request the page has already cancelled rejects the abort, and an unhandled rejection ends the process.
      return r.abort("blockedbyclient").catch(() => {});
    });
  }

  /** A WebSocket the browserHosts list refuses (its route matches only those): closed before it connects, and reported. */
  refuseSocket(ws: WebSocketRoute): Promise<void> {
    this.noteHostRefusal(`WebSocket ${socketAddress(ws.url(), this.host.appUrl()).slice(0, 140)}`, "websocket", null);
    return ws.close({ code: 1008, reason: "refused by the browserHosts setting" }).catch(() => {});
  }

  /** The last page load the browserHosts list refused, a redirect's later hop included. */
  private lastHostRefusedLoad: { at: number; sig: string } | null = null;

  /** What the browserHosts list refused of a page load since `since`, so a navigation that failed for it can say so; null when nothing was. */
  hostRefusedLoadSince(since: number): string | null {
    const last = this.lastHostRefusedLoad;
    return last !== null && last.at >= since ? last.sig : null;
  }

  /** A page load's redirect to a host the browserHosts list refuses, found by a handler that sent the load itself: reported as any host refusal. */
  noteRefusedRedirect(req: Request, to: string, from: string): void {
    this.noteHostRefusal(`${this.hostSig("GET", to, true)} (a redirect from ${this.place(from)})`, "document", req, RouteGuard.topLevelLoad(req));
  }

  /** Whether a request is a page's own load (its top frame's navigation), not a frame's or a worker's. */
  private static topLevelLoad(req: Request): boolean {
    try {
      return req.isNavigationRequest() && req.frame().parentFrame() === null;
    } catch {
      return false; // a service worker's request has no frame
    }
  }

  /** Stand-in pages handed out for a redirect, by the address each loads, with how many hops of one page load led to it. */
  private readonly standInHops = new Map<string, number>();

  /**
   * Firefox and WebKit route no redirect's later hops (browsers.ts hostRedirectHops "page-loads"). Registered so it runs
   * after every other handler let the load out: a top-level page load is sent by SceneScout without following a
   * redirect (one send, as the browser's own would be), and a redirect to a host the list refuses is refused and
   * reported, while one to an allowed host is answered with a page that loads it itself, a new page load that comes back
   * through every handler. Anything else is handed on. A send that fails aborts with the network's code.
   */
  async probeRedirect(route: Route, timeoutMs: number): Promise<void> {
    const req = route.request();
    const list = this.host.browserHosts?.() ?? null;
    if (list === null || !RouteGuard.topLevelLoad(req) || req.method() !== "GET" || req.resourceType() !== "document") return route.fallback().catch(() => {});
    const hops = this.standInHops.get(req.url()) ?? 0;
    this.standInHops.delete(req.url());
    let res: Awaited<ReturnType<Route["fetch"]>>;
    try {
      res = await route.fetch({ maxRedirects: 0, timeout: timeoutMs });
    } catch (err) {
      return route.abort(abortCodeFor(err instanceof Error ? err.message : String(err))).catch(() => {});
    }
    const plan = hostRedirectPlan({ status: res.status(), location: res.headers()["location"], requestUrl: req.url(), list });
    if (plan === null) return route.fulfill({ response: res }).catch(() => {});
    if (plan.kind === "refuse") {
      this.noteRefusedRedirect(req, plan.url, req.url());
      return route.abort("blockedbyclient").catch(() => {});
    }
    if (hops + 1 > BROWSER_HOST_MAX_HOPS) {
      console.error(`[scenescout] browserHosts: a page load redirected more than ${BROWSER_HOST_MAX_HOPS} times, stopped`);
      return route.abort("failed").catch(() => {});
    }
    // Bounded: a load reads its own entry at once, so only abandoned ones collect.
    if (this.standInHops.size >= 50) this.standInHops.clear();
    this.standInHops.set(plan.url, hops + 1);
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    const setCookie = res.headers()["set-cookie"];
    if (setCookie) headers["set-cookie"] = setCookie;
    return route.fulfill({ status: 200, headers, body: redirectStandIn(plan.url) }).catch(() => {});
  }

  /** Whether the write policy stopped this request, at the route handler or at the browser level. */
  refused(req: Request): boolean {
    return this.refusedByPolicy.has(req) || this.unseenRefusals.has(req.method(), req.url());
  }

  /** The route handler's judgements still pending for requests `page` sent. */
  inFlight(page: Page): Promise<unknown>[] {
    return [...(this.routesInFlight.get(page) ?? [])];
  }

  /** The browser-level interception's judgements still pending. It cannot tell which page sent a request, so all of them. */
  unseenInFlight(): Promise<unknown>[] {
    return [...this.unseenJudging];
  }

  /**
   * A leave marker for a page at `pageUrl` (unload.ts LEAVE_MARKER_PATH): the URL the page is to beacon last as it is
   * left, the wait, bounded by `ms`, for the browser-level interception to hear it, and `unarmed`, for a page the marker
   * could not be put on. Null where the page has no origin to send one to. From now until the marker is heard (or
   * LEFT_PAGE_RULE_CAP_MS passes), the rule in force now is the strictest a request is judged under (`rule`), however
   * late it is heard and whatever the session's rule has become: the wait ending does not end that.
   */
  leaveMarker(pageUrl: string): { url: string; heard: (ms: number) => Promise<void>; unarmed: () => void } | null {
    const token = randomUUID();
    const url = leaveMarkerUrl(pageUrl, token);
    if (!url) return null;
    this.issuedMarkers.add(url);
    this.leftPages.left(token, this.rule());
    let resolve!: () => void;
    const heard = new Promise<void>((r) => (resolve = r));
    this.leaveMarkers.set(token, resolve);
    return {
      url,
      heard: async (ms) => {
        await settleWithin(heard, ms);
        this.leaveMarkers.delete(token);
      },
      unarmed: () => {
        this.leaveMarkers.delete(token);
        this.leftPages.heard(token);
      },
    };
  }

  /**
   * A page's leave marker was heard: what the page sent before it has been heard too. Its rule is let go once those
   * requests' judgements, all pending now, have settled, so none of them reads the looser rule.
   */
  private markerHeard(token: string): void {
    this.leaveMarkers.get(token)?.();
    void Promise.allSettled([...this.unseenJudging]).then(() => this.leftPages.heard(token));
  }

  /**
   * Whether a request is the engine's own leave marker, or carries one in its body: only a marker this guard issued, so
   * the app cannot make a request of its own go unjudged by sending it to the marker's path. The marker's token is the
   * returned value when the request is the marker itself, "" when it only carries one, null when it is neither.
   */
  private ownLeaveMarker(url: string, body: string | undefined): string | null {
    if (this.issuedMarkers.size === 0) return null;
    const token = leaveMarkerToken(url);
    if (token !== null && this.issuedMarkers.has(leaveMarkerUrl(url, token) ?? "")) return token;
    if (body?.includes(LEAVE_MARKER_PATH)) for (const issued of this.issuedMarkers) if (body.includes(issued)) return "";
    return null;
  }

  /** A new attach: creations a previous attach was waiting on are not this one's. */
  resetCreations(): void {
    this.pendingCreations = new Set();
  }

  /** The browser is gone: forget the writes judged in it. */
  clear(): void {
    this.routedWrites.clear();
    this.unseenRefusals.clear();
    this.leftPages.clear();
    // The closed browser's pages send no more markers: a wait still on one ends, and none is kept.
    for (const resolve of this.leaveMarkers.values()) resolve();
    this.leaveMarkers.clear();
    this.issuedMarkers.clear();
  }

  /** The route handler: judge one request, recorded against the page that sent it until it is answered. */
  handle(route: Route): Promise<void> {
    return this.judgeTracked(route, (r) => this.judge(r));
  }

  /** Run the route handler's judgement of one request, recorded against the page that sent it until it is answered. */
  private async judgeTracked(route: Route, judge: (route: Route) => Promise<unknown>): Promise<void> {
    let page: Page | null = null;
    try {
      page = route.request().frame().page();
    } catch {
      /* no frame: a service worker's request, which no page's close waits on */
    }
    const judging = judge(route);
    if (!page) {
      await judging;
      return;
    }
    let pending = this.routesInFlight.get(page);
    if (!pending) this.routesInFlight.set(page, (pending = new Set()));
    pending.add(judging);
    try {
      await judging;
    } finally {
      pending.delete(judging);
      if (pending.size === 0) this.routesInFlight.delete(page);
    }
  }

  private async judge(route: Route): Promise<unknown> {
    const req = route.request();
    // A leave marker is the engine's own and goes nowhere: it is heard at the browser level, never here in practice.
    if (this.ownLeaveMarker(req.url(), req.postDataBuffer()?.toString("utf8")) !== null)
      return route.abort("blockedbyclient").catch(() => {
        /* the page that sent it is gone */
      });
    const sent = req.method();
    // Read once, as the request arrives: the rule the page sent it under (policy.ts WriteRule), not whatever holds after an await below.
    const rule = this.rule();
    // A redirect is followed by the browser without asking, so its target
    // would load unsandboxed: a frame's redirect is answered with a
    // sandboxed page that navigates there itself, and the next hop comes
    // back here. Built from scratch: a redirect's framing or script
    // headers never applied to a redirect, and would block this page.
    const standIn = async (location: string, setCookie: string | undefined) => {
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": withForeignFrameSandbox(undefined),
        "cache-control": "no-store",
      };
      if (setCookie) headers["set-cookie"] = setCookie;
      await route.fulfill({ status: 200, headers, body: sandboxedRedirectPage(new URL(location, req.url()).href) });
    };
    // WebKit drops the sandbox for a frame that loads a data: URL in its own
    // place. A top-window navigation out of the app, with no Referer, while
    // a frame that held another site sits on a non-web URL, is that frame's
    // escape: refused, judged on the page as it is when the request arrives.
    if (sent === "GET" && req.resourceType() === "document" && this.host.embedEscapeNavigation(req)) {
      const why = ESCAPE_REFUSAL;
      // Reported like any refusal, so a click whose navigation this stopped does not read as a click that did nothing.
      this.host.noteBlocked({ at: Date.now(), sig: `navigation to ${this.place(req.url())}`, answered: false, why, type: req.resourceType(), rule });
      this.host.logAction({
        action: "write-policy:blocked",
        // Another site's address is logged without its query, as every address the engine keeps is (authloss.ts logAddress).
        target: `navigation to ${this.place(req.url())} (${why})`,
        url: this.host.pageUrl() ?? "",
      });
      this.refusedByPolicy.add(req);
      this.host.notePolicyBlock();
      // Caught: a request the page has already cancelled rejects the abort, and an unhandled rejection ends the process.
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    const url = req.url();
    // Judged as the method it names when it carries an override (policy.ts writeMethod): never looser than the one it was sent with.
    const judged = writeMethod({ method: sent, url, headers: req.headers(), body: req.postData() });
    const method = judged.method;
    const label = writeMethodLabel(sent, judged);
    const pathname = pathnameOf(url);
    const refuse = (why?: string) => {
      const answered = answersWithRefusal(req.resourceType());
      if (rule === "observe" && method === "POST" && !why && answered && !BENIGN_MUTATION_RE.test(url))
        this.host.noteObserveRefusedPost(url, req.postData(), this.host.sentByMainFrame(req) ? req.headers()["referer"] : undefined);
      this.host.noteBlocked({ at: Date.now(), sig: `${label} ${this.place(url)}`, answered, why, type: req.resourceType(), rule });
      this.host.logAction({
        action: "write-policy:blocked",
        target: `${label} ${pathname}${judged.via ? ` (${judged.via})` : ""}${why ? ` (${why})` : ""}`,
        url: this.host.pageUrl() ?? "",
      });
      this.refusedByPolicy.add(req);
      this.host.notePolicyBlock();
      // A script's request is answered with a refusal, so the page's handling
      // of one actually runs; a navigation is dropped (policy.ts says why).
      // Caught: a request the page has already cancelled rejects these, and an unhandled rejection ends the process.
      if (answered) return route.fulfill(policyRefusal(rule, label, pathname, req.headers()["origin"], why ?? judged.via)).catch(() => {});
      return route.abort("blockedbyclient").catch(() => {});
    };
    if (isReadMethod(method)) {
      // Opt-in: a page load whose address is a destructive command (`/items/3/delete`) is refused where the mode keeps data.
      if (req.resourceType() === "document" && refusedPageLoad(rule, this.host.refuseDestructiveGets(), url)) {
        // At most a few kept: a navigation reads its own at once, and a click's is never asked about.
        if (this.refusedLoads.size >= 20) this.refusedLoads.clear();
        this.refusedLoads.add(url);
        return refuse(DESTRUCTIVE_GET_REFUSAL);
      }
    }
    // A frame document carrying an override that names a write is judged below as that write, not loaded as a frame.
    const frameDoc = sent === "GET" && isReadMethod(method) && req.resourceType() === "document" ? this.host.frameDocumentKind(req, rule) : null;
    // A document loading into a frame of another origin gets the sandbox
    // that forbids popups and top-window navigation (policy.ts says why).
    if (frameDoc === "foreign") {
      try {
        const res = await route.fetch({ maxRedirects: 0 });
        const headers = res.headers();
        const location = res.status() >= 300 && res.status() < 400 ? headers["location"] : undefined;
        if (location) {
          await standIn(location, headers["set-cookie"]);
          return;
        }
        headers["content-security-policy"] = withForeignFrameSandbox(headers["content-security-policy"]);
        await route.fulfill({ response: res, headers });
        return;
      } catch {
        // Fail closed: a frame that cannot be sandboxed is not loaded. A request already cancelled rejects the abort: nothing is left to refuse.
        await route.abort("blockedbyclient").catch(() => {});
        return;
      }
    }
    // The app's own frame document can redirect into another site, whose
    // page would then load unsandboxed. Asked first, one hop at a time; a
    // document that does not redirect loads as it would have, sent on
    // rather than served from here — a served document counts as public in
    // Chromium and could no longer reach an app on localhost. The price is
    // a second GET of the app's frame documents that are not redirects.
    if (frameDoc === "app") {
      try {
        const res = await route.fetch({ maxRedirects: 0 });
        const location = res.status() >= 300 && res.status() < 400 ? res.headers()["location"] : undefined;
        // Every hop, not only one out of the app: Playwright does not route the
        // later hops of a redirect, so a chain through the app and then out
        // would go unseen, and each hop is then fetched once, not twice.
        if (location) {
          await standIn(location, res.headers()["set-cookie"]);
          return;
        }
      } catch {
        /* could not ask: load it as it would have loaded */
      }
      // A request the page has already cancelled rejects this; nothing is left to send then.
      await route.fallback().catch(() => {});
      return;
    }
    // What the policy lets out it hands on with route.fallback, never route.continue: the
    // refresh broker, registered before this handler, runs next. With no broker it goes out.
    if (isReadMethod(method)) return route.fallback();
    const destructiveWire = isDestructiveRequest(url, req.postData(), this.host.writeClassifier());
    // A POST the user named as a read (observe only, never one that looks destructive).
    const readPost = this.host.readPostOf(rule, method, url, req.postData(), destructiveWire);
    const allowList = this.allowListFor({ method: sent, url, headers: req.headers(), body: req.postData() });
    const verdict = routedWriteVerdict({
      rule,
      method,
      pathname,
      destructiveWire,
      // An embedded widget from another site writes to that site, not to the app under test.
      foreign: this.host.foreignWriteOf(req, rule),
      // An embed moved the session's page off the app: its writes out are not the app's, a sign-in excepted.
      offApp: offAppPageWrite(this.host.appUrl(), this.host.pageUrl(), url, this.host.movedByEmbed()),
      readPost: readPost !== null,
      authList: this.authListFor(url),
      allowList,
    });
    if (verdict.kind === "refuse") return refuse(verdict.why);
    // Auth/session flows must work in every mode — but never a destructive
    // one, and in observe only the requests a login itself needs.
    if (verdict.kind === "auth") {
      this.routedWrites.note(rule, method, url, bodyDigest(req.postDataBuffer()));
      return route.fallback();
    }
    if (verdict.kind === "listed-write") {
      this.host.logAction({
        action: "write-policy:allowed-write",
        target: `${method} ${pathname} (allowed by the list: ${allowList?.entry?.entry ?? "listed"})`,
        url: this.host.pageUrl() ?? "",
      });
      this.routedWrites.note(rule, method, url, bodyDigest(req.postDataBuffer()));
      if (method === "POST") this.host.clearRefusedPost(url);
      return route.fallback();
    }
    if (verdict.kind === "read-post" && readPost) {
      this.host.logAction({
        action: "write-policy:read-post",
        target: `${method} ${pathname} (named as a read: ${readPost.entry})`,
        url: this.host.pageUrl() ?? "",
      });
      this.routedWrites.note(rule, method, url, bodyDigest(req.postDataBuffer()));
      this.host.clearRefusedPost(url);
      return route.fallback();
    }

    let owned = this.host.isOwnedResource(pathname);
    // A single UI action commonly fires create-then-immediately-save
    // (POST gets an id, PUT saves content under it) faster than the
    // POST's recordCreation() can finish awaiting its response body.
    // The POST registered itself in pendingCreations SYNCHRONOUSLY in
    // this same handler (below) before its request even went out, so by
    // the time the follow-up PUT arrives here the pending entry is
    // guaranteed visible — give it a bounded moment to land before the
    // mutation is judged not-owned, otherwise the session's own,
    // just-created resource gets wrongly blocked by a timing accident.
    if (!owned && rule === "safe-write" && method !== "POST" && this.pendingCreations.size > 0) {
      await settleWithin(Promise.allSettled([...this.pendingCreations]), 1500);
      owned = this.host.isOwnedResource(pathname);
    }
    // POST: creation/RPC passes unless it smells destructive and isn't ours.
    // PUT/PATCH/DELETE: only in safe-write, only on our own resources.
    const allow = allowsWrite(rule, method, destructiveWire, owned);
    if (allow) {
      // Ownership tracking (safe-write): register the creation-tracking
      // task BEFORE the POST goes out. Registering from a context
      // "response" listener instead would race the follow-up PUT's route
      // handler — the response event fires asynchronously, so a PUT
      // chained directly off the POST's json() could be judged before
      // the listener ever ran. Here the registration is synchronous with
      // request dispatch, which closes that window completely.
      if (rule === "safe-write" && method === "POST" && !BENIGN_MUTATION_RE.test(url)) {
        const task: Promise<unknown> = req
          .response()
          .then((res) => (res && res.ok() ? this.host.recordCreation(res) : undefined))
          // A request that never got an answer created nothing to record.
          .catch(() => {})
          .finally(() => this.pendingCreations.delete(task));
        this.pendingCreations.add(task);
      }
      this.routedWrites.note(rule, method, url, bodyDigest(req.postDataBuffer()));
      if (method === "POST") this.host.clearRefusedPost(url);
      return route.fallback();
    }
    return refuse();
  }

  /**
   * Pause, at the browser level, every request the context's route handler
   * lets through or never sees (unload.ts says why), and judge the writes it
   * never saw. Everything else is sent on at once.
   */
  async interceptUnseenWrites(browser: Browser): Promise<void> {
    this.routedWrites.clear();
    const session = await browser.newBrowserCDPSession();
    session.on("Fetch.requestPaused", (event) => {
      // judgeUnseenRequest answers every request and catches its own errors, so it settles and never rejects.
      const judging = this.judgeUnseenRequest(session, event);
      this.unseenJudging.add(judging);
      void judging.finally(() => this.unseenJudging.delete(judging));
    });
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  }

  private async judgeUnseenRequest(
    session: CDPSession,
    event: {
      requestId: string;
      resourceType?: string;
      /** Set when the browser is following a redirect: the request that answered with it. */
      redirectedRequestId?: string;
      request: { url: string; method: string; headers?: Record<string, string>; postData?: string; postDataEntries?: Array<{ bytes?: string }> };
    },
  ): Promise<void> {
    const { url, method: sent, headers } = event.request;
    let method = sent;
    let label = sent;
    // Every paused request gets exactly one answer, whatever throws on the way: a request left paused hangs its page.
    let answered = false;
    const answer = async (allow: boolean): Promise<void> => {
      answered = true;
      await (
        allow
          ? session.send("Fetch.continueRequest", { requestId: event.requestId })
          : session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
      ).catch(() => {
        /* the request or the browser is already gone */
      });
    };
    try {
      // A leave marker: everything the page sent before it has now been heard. Failed unjudged, so it never leaves the browser.
      const marker = this.ownLeaveMarker(url, pausedRequestBytes(event.request)?.toString("utf8"));
      if (marker !== null) {
        if (marker) this.markerHeard(marker);
        return await answer(false);
      }
      // The browserHosts list, in every mode: this is where Chromium's redirect hops and anything the route handler never saw meet it.
      if (this.refusedHost(url) !== null) {
        this.unseenRefusals.note(sent, url);
        await answer(false);
        const type = (event.resourceType ?? "other").toLowerCase();
        // A hop the browser followed is said to be one; the address that answered with it is not known here.
        // The browser level cannot tell a page's load from a frame's: any document counts as the page's.
        this.noteHostRefusal(
          `${this.hostSig(sent, url, type === "document")}${event.redirectedRequestId ? " (a redirect)" : ""}`,
          type,
          null,
          type === "document",
        );
        return;
      }
      // A request paused here may have been sent by a page a flow has left, however long ago: until that page's marker is
      // heard, the flow's rule still holds (rule).
      const rule = this.rule();
      // Reads, and everything in destructive, go on. A later hop of a redirect is judged like any write: the route handler never sees one.
      if (rule === "destructive") return await answer(true);
      const bytes = pausedRequestBytes(event.request);
      // Judged as the method it names when it carries an override, as the route handler does.
      const judged = writeMethod({ method: sent, url, headers, body: bytes?.toString("utf8") });
      method = judged.method;
      label = writeMethodLabel(sent, judged);
      if (isReadMethod(method)) {
        // A later hop of a redirect is a page load the route handler never saw: refused here when it is a destructive command (opt-in).
        const refuseLoad = (event.resourceType ?? "").toLowerCase() === "document" && refusedPageLoad(rule, this.host.refuseDestructiveGets(), url);
        if (!refuseLoad) return await answer(true);
        this.unseenRefusals.note(sent, url);
        await answer(false);
        this.host.noteBlocked({ at: Date.now(), sig: `${label} ${this.place(url)}`, answered: false, why: DESTRUCTIVE_GET_REFUSAL, type: "document", rule });
        this.host.logAction({
          action: "write-policy:blocked",
          target: `${label} ${pathnameOf(url)} (${DESTRUCTIVE_GET_REFUSAL})`,
          url: this.host.pageUrl() ?? "",
        });
        this.host.notePolicyBlock();
        return;
      }
      // Keyed on the method judged, so an unrouted copy carrying an override is not excused by the plain write let through.
      if (this.routedWrites.claim(rule, method, url, bodyDigest(bytes))) return await answer(true);
      let verdict: UnseenWriteVerdict;
      let pathname = url;
      try {
        pathname = pathnameOf(url);
        const body = bytes?.toString("utf8");
        const destructiveWire = isDestructiveRequest(url, body, this.host.writeClassifier());
        const readPost = this.host.readPostOf(rule, method, url, body, destructiveWire);
        const { foreign, offApp } = unseenWriteSource({
          appUrl: this.host.appUrl(),
          mode: rule,
          url,
          originHeader: headerOf(headers, "origin"),
          referer: headerOf(headers, "referer"),
          currentPageUrl: this.host.pageUrl(),
          trustedEmbeds: this.host.trustedEmbeds(),
          movedByEmbed: this.host.movedByEmbed(),
        });
        verdict = judgeUnseenWrite({
          mode: rule,
          method,
          pathname,
          destructiveWire,
          foreign,
          offApp,
          owned: this.host.isOwnedResource(pathname),
          readPost: readPost !== null,
          authList: this.authListFor(url),
          allowList: this.allowListFor({ method: sent, url, headers, body }),
        });
        if (readPost && verdict.allow)
          this.host.logAction({
            action: "write-policy:read-post",
            target: `${method} ${pathname} (named as a read: ${readPost.entry})`,
            url: this.host.pageUrl() ?? "",
          });
      } catch (err) {
        // Fail closed: a write that cannot be judged is refused, and reported as refused below.
        console.error(
          `[scenescout] write policy: could not judge ${method} at the browser level, refused: ${err instanceof Error ? err.message : String(err)}`,
        );
        verdict = { allow: false };
      }
      // Known as refused before the browser fails it, so the driver's report of the failure finds it.
      if (!verdict.allow) this.unseenRefusals.note(sent, url);
      await answer(verdict.allow);
      if (verdict.allow) {
        // Reported like any other write that went out, as the request event does for a routed one.
        if (!BENIGN_MUTATION_RE.test(url)) this.host.noteSentWrite({ at: Date.now(), sig: sentWriteSig(label, url, this.host.appUrl()) });
        return;
      }
      // Refused and reported as any refusal is. Dropped rather than answered: the page that sent it is going or gone.
      this.host.noteBlocked({
        at: Date.now(),
        sig: `${label} ${this.place(url)}`,
        answered: false,
        why: verdict.why,
        type: (event.resourceType ?? "other").toLowerCase(),
        rule,
      });
      this.host.logAction({
        action: "write-policy:blocked",
        target: `${label} ${pathname}${verdict.why ? ` (${verdict.why})` : ""}`,
        url: this.host.pageUrl() ?? "",
      });
      this.host.notePolicyBlock();
    } catch (err) {
      console.error(`[scenescout] write policy: browser-level interception failed on ${method}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (!answered) {
        // Fail closed, and still say so: a refusal nobody hears about reads as a write that went out.
        try {
          this.unseenRefusals.note(sent, url);
        } catch {
          /* the error above is already logged */
        }
        await answer(false);
        try {
          this.host.noteBlocked({
            at: Date.now(),
            sig: `${method} ${this.place(url)}`,
            answered: false,
            type: (event.resourceType ?? "other").toLowerCase(),
          });
          this.host.logAction({
            action: "write-policy:blocked",
            target: `${method} ${this.place(url)} (not judged: an error in the policy)`,
            url: this.host.pageUrl() ?? "",
          });
          this.host.notePolicyBlock();
        } catch (err) {
          console.error(`[scenescout] write policy: could not report a refusal: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}
