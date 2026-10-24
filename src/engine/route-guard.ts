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
import type { Browser, CDPSession, Page, Request, Response, Route } from "playwright";
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
  withForeignFrameSandbox,
  writeMethod,
  writeMethodLabel,
  type ReadPost,
  type WriteMode,
} from "./policy.js";
import {
  bodyDigest,
  headerOf,
  isReadMethod,
  judgeUnseenWrite,
  LEAVE_MARKER_PATH,
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

/** A write the policy refused, as the engine's next notice reports it. */
export interface BlockedRequest {
  at: number;
  sig: string;
  answered: boolean;
  why?: string;
  type?: string;
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
  /** The foreign origin behind a write headed outside the app, or null. */
  foreignWriteOf(req: Request): string | null;
  /** Whether a document request is a frame's escape out of the app (WebKit's dropped sandbox). */
  embedEscapeNavigation(req: Request): boolean;
  /** What a document request loads into: a frame of another origin, a frame of the app's, or neither. */
  frameDocumentKind(req: Request): "foreign" | "app" | null;
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
}

/** What the route handler does with a write it sees, short of the ownership rule. */
export type RoutedWriteVerdict =
  | { kind: "refuse"; why: string }
  /** An auth or session request: out in every mode. */
  | { kind: "auth" }
  /** A POST the user named as a read: out, and logged. */
  | { kind: "read-post" }
  /** Judged by allowsWrite on whether this run owns the resource. */
  | { kind: "by-ownership" };

/**
 * The route handler's verdict on a write (not a GET, HEAD or OPTIONS) in a
 * mode other than destructive, in the order the handler applies the rules: a
 * foreign frame's write is refused before any other rule, sign-in included; a
 * write from a page an embed moved off the app is refused unless it is a
 * sign-in; a sign-in goes out; a read POST goes out; the rest is judged by
 * ownership. unload.ts judgeUnseenWrite applies the same rules to the writes
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
}): RoutedWriteVerdict {
  const { rule, method, pathname, destructiveWire } = input;
  if (input.foreign) return { kind: "refuse", why: `sent from a frame of ${input.foreign}` };
  const authExempt = isAuthExempt(rule, method, pathname, destructiveWire, input.authList);
  if (input.offApp && !authExempt) return { kind: "refuse", why: `sent from a page of ${input.offApp}, outside the app` };
  if (authExempt) return { kind: "auth" };
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
}): boolean {
  const { rule, method, pathname, destructiveWire } = input;
  // Same test the route handler uses: in observe only an exempt auth request goes out.
  if (rule === "observe" && !isAuthExempt(rule, method, pathname, destructiveWire, input.authList)) return false;
  if ((rule === "read-only" || rule === "observe") && destructiveWire) return false;
  // A foreign frame's write is refused in every mode the route handler runs in.
  if (rule !== "destructive" && input.foreign()) return false;
  if (rule !== "destructive" && input.offApp() && !isAuthExempt(rule, method, pathname, destructiveWire, input.authList)) return false;
  return true;
}

/** The write policy's route handler and browser-level interception for one engine. */
export class RouteGuard {
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

  constructor(private readonly host: RouteGuardHost) {}

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
   * left, and the wait, bounded by `ms`, for the browser-level interception to hear it. Null where the page has no
   * origin to send one to.
   */
  leaveMarker(pageUrl: string): { url: string; heard: (ms: number) => Promise<void> } | null {
    const token = randomUUID();
    const url = leaveMarkerUrl(pageUrl, token);
    if (!url) return null;
    this.issuedMarkers.add(url);
    let resolve!: () => void;
    const heard = new Promise<void>((r) => (resolve = r));
    this.leaveMarkers.set(token, resolve);
    return {
      url,
      heard: async (ms) => {
        await settleWithin(heard, ms);
        this.leaveMarkers.delete(token);
      },
    };
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
    const rule = this.host.rule();
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
      this.host.noteBlocked({ at: Date.now(), sig: `navigation to ${req.url().slice(0, 140)}`, answered: false, why, type: req.resourceType() });
      this.host.logAction({ action: "write-policy:blocked", target: `navigation to ${req.url().slice(0, 140)} (${why})`, url: this.host.pageUrl() ?? "" });
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
      this.host.noteBlocked({ at: Date.now(), sig: `${label} ${url.slice(0, 140)}`, answered, why, type: req.resourceType() });
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
      if ((rule === "observe" || rule === "read-only") && req.resourceType() === "document" && this.host.refuseDestructiveGets() && destructiveGet(url)) {
        // At most a few kept: a navigation reads its own at once, and a click's is never asked about.
        if (this.refusedLoads.size >= 20) this.refusedLoads.clear();
        this.refusedLoads.add(url);
        return refuse(DESTRUCTIVE_GET_REFUSAL);
      }
    }
    // A frame document carrying an override that names a write is judged below as that write, not loaded as a frame.
    const frameDoc = sent === "GET" && isReadMethod(method) && req.resourceType() === "document" ? this.host.frameDocumentKind(req) : null;
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
    const verdict = routedWriteVerdict({
      rule,
      method,
      pathname,
      destructiveWire,
      // An embedded widget from another site writes to that site, not to the app under test.
      foreign: this.host.foreignWriteOf(req),
      // An embed moved the session's page off the app: its writes out are not the app's, a sign-in excepted.
      offApp: offAppPageWrite(this.host.appUrl(), this.host.pageUrl(), url, this.host.movedByEmbed()),
      readPost: readPost !== null,
      authList: this.authListFor(url),
    });
    if (verdict.kind === "refuse") return refuse(verdict.why);
    // Auth/session flows must work in every mode — but never a destructive
    // one, and in observe only the requests a login itself needs.
    if (verdict.kind === "auth") {
      this.routedWrites.note(rule, sent, url, bodyDigest(req.postDataBuffer()));
      return route.fallback();
    }
    if (verdict.kind === "read-post" && readPost) {
      this.host.logAction({
        action: "write-policy:read-post",
        target: `${method} ${pathname} (named as a read: ${readPost.entry})`,
        url: this.host.pageUrl() ?? "",
      });
      this.routedWrites.note(rule, sent, url, bodyDigest(req.postDataBuffer()));
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
      this.routedWrites.note(rule, sent, url, bodyDigest(req.postDataBuffer()));
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
        if (marker) this.leaveMarkers.get(marker)?.();
        return await answer(false);
      }
      // A request paused here was sent a moment ago, possibly by a page a flow has just left: WriteRule still holds the flow's rule.
      const rule = this.host.rule();
      // Reads, and everything in destructive, go on. A later hop of a redirect is judged like any write: the route handler never sees one.
      if (rule === "destructive") return await answer(true);
      const bytes = pausedRequestBytes(event.request);
      // Judged as the method it names when it carries an override, as the route handler does.
      const judged = writeMethod({ method: sent, url, headers, body: bytes?.toString("utf8") });
      method = judged.method;
      label = writeMethodLabel(sent, judged);
      if (isReadMethod(method)) {
        // A later hop of a redirect is a page load the route handler never saw: refused here when it is a destructive command (opt-in).
        const refuseLoad =
          (rule === "observe" || rule === "read-only") &&
          (event.resourceType ?? "").toLowerCase() === "document" &&
          this.host.refuseDestructiveGets() &&
          destructiveGet(url);
        if (!refuseLoad) return await answer(true);
        this.unseenRefusals.note(sent, url);
        await answer(false);
        this.host.noteBlocked({ at: Date.now(), sig: `${label} ${url.slice(0, 140)}`, answered: false, why: DESTRUCTIVE_GET_REFUSAL, type: "document" });
        this.host.logAction({
          action: "write-policy:blocked",
          target: `${label} ${pathnameOf(url)} (${DESTRUCTIVE_GET_REFUSAL})`,
          url: this.host.pageUrl() ?? "",
        });
        this.host.notePolicyBlock();
        return;
      }
      if (this.routedWrites.claim(rule, sent, url, bodyDigest(bytes))) return await answer(true);
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
        if (!BENIGN_MUTATION_RE.test(url)) this.host.noteSentWrite({ at: Date.now(), sig: `${label} ${url.slice(0, 120)}` });
        return;
      }
      // Refused and reported as any refusal is. Dropped rather than answered: the page that sent it is going or gone.
      this.host.noteBlocked({
        at: Date.now(),
        sig: `${label} ${url.slice(0, 140)}`,
        answered: false,
        why: verdict.why,
        type: (event.resourceType ?? "other").toLowerCase(),
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
            sig: `${method} ${url.slice(0, 140)}`,
            answered: false,
            type: (event.resourceType ?? "other").toLowerCase(),
          });
          this.host.logAction({
            action: "write-policy:blocked",
            target: `${method} ${url.slice(0, 140)} (not judged: an error in the policy)`,
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
