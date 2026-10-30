/**
 * Writes the context's route handler never sees, and how the engine judges
 * them anyway.
 *
 * In Chromium, a request a page sends while it is being left (a
 * `navigator.sendBeacon` or a `fetch(..., { keepalive: true })` on
 * `pagehide`, `visibilitychange` or `unload`, or one still leaving as a page
 * is closed) is never handed to the context's route handler: it arrives with
 * no network id, or after the page's own DevTools session has gone, and the
 * driver lets it through unseen. Left alone it reached the server in every
 * mode, observe included. The engine therefore also intercepts at the
 * browser level (the DevTools Fetch domain on the browser target, which does
 * pause these requests) and judges there every write the route handler did
 * not already judge, by the same rules (ADR 2). Which engines need this is
 * `unloadWriteInterception` in `browsers.ts`.
 *
 * Everything here is pure, so the rules are table-tested in policy-test; the
 * wiring to the browser lives in `browser.ts`.
 */
import { createHash } from "node:crypto";
import { NOT_ALLOWED_WRITE_REFUSAL, signInRuleMode, type WriteAllowList } from "./write-allowlist.js";
import {
  allowsForeignWriteOnSignIn,
  allowsWrite,
  foreignWrite,
  isAuthExempt,
  offAppPageWrite,
  stricterMode,
  trustsForeignWrite,
  type AuthPostList,
  type WriteMode,
} from "./policy.js";

/** Whether a method sends nothing the write policy judges. */
export function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export type UnseenWriteVerdict = { allow: true } | { allow: false; why?: string };

/**
 * Who sent a write the route handler never saw, as far as its headers tell:
 * the embed it is charged to (`foreign`) and the off-app page it came from
 * (`offApp`), the two inputs `judgeUnseenWrite` takes from the sender.
 *
 * The sending frame may be gone, so its URL is not known. The page it was
 * sent from is its Referer; where there is none, the page the session drives
 * stands in for `offApp` only.
 *
 * - `foreign`: policy.ts `foreignWrite` with no frame chain, so a write out of
 *   the app whose Origin header names another site is that site's embed's. A
 *   sign-in provider's page reached as the whole page, beaconing to itself as
 *   it is left, is therefore refused outside destructive; the route handler,
 *   which knows the frame, would let it through. The cautious direction. An
 *   `Origin: null` write out of the app is taken to be an embed's too, whether
 *   or not the page embeds anything, since the page can no longer be asked.
 * - The sign-in exception (a captcha on the app's own sign-in page) is judged
 *   against the Referer, the page the request was sent from, never against
 *   whatever page the session has moved to by the time the request is seen.
 *   With no Referer it does not apply.
 * - Trusted embeds (safe-write only) are judged by the Origin header alone.
 */
export function unseenWriteSource(input: {
  appUrl: string;
  mode: WriteMode;
  url: string;
  originHeader?: string;
  referer?: string;
  /** The page the session drives when the request is seen. */
  currentPageUrl?: string;
  trustedEmbeds: ReadonlySet<string>;
  /** EmbedMoveTracker's `movedTo`: the site an embed moved the page to, if one did. */
  movedByEmbed: string | null;
}): { foreign: string | null; offApp: string | null } {
  const { appUrl, mode, url, originHeader, referer } = input;
  let foreign = foreignWrite(appUrl, { url, frameChain: [], frameUrl: null, originHeader, pageHasForeignFrame: true });
  if (foreign && referer && allowsForeignWriteOnSignIn(mode, referer, appUrl)) foreign = null;
  if (foreign && trustsForeignWrite(mode, input.trustedEmbeds, appUrl, { frameChain: [], originHeader, unadoptedPageUrl: null })) foreign = null;
  const offApp = offAppPageWrite(appUrl, referer ?? input.currentPageUrl, url, input.movedByEmbed);
  return { foreign, offApp };
}

/**
 * The route handler's verdict on a write, from what a browser-level
 * interception can know about it. Same rules in the same order: a write
 * another site's frame sends outside the app is refused; so is one sent from
 * a page an embed moved off the app, a sign-in excepted; a sign-in passes;
 * then a POST the user named as a read (observe only), then the mode
 * decides. `foreign` and `offApp` come from
 * `unseenWriteSource`, since the sending frame may no longer exist.
 * The one step it does not take is safe-write's short wait for a creation
 * still in flight: a page being left has nothing more to wait for.
 */
export function judgeUnseenWrite(input: {
  mode: WriteMode;
  method: string;
  pathname: string;
  destructiveWire: boolean;
  foreign: string | null;
  offApp: string | null;
  owned: boolean;
  /** policy.ts readPostAllowed: a POST the user named as a read, let out of observe. */
  readPost?: boolean;
  /** The operator's sign-in allowlist for this request, when one is set (policy.ts isAuthExempt). */
  authList?: AuthPostList | null;
  /** The operator's list of allowed writes as this request meets it, when one is set (write-allowlist.ts). */
  allowList?: WriteAllowList | null;
}): UnseenWriteVerdict {
  const { mode, method, pathname, destructiveWire } = input;
  if (mode === "destructive" || isReadMethod(method)) return { allow: true };
  if (input.foreign) return { allow: false, why: `sent from a frame of ${input.foreign}` };
  const authExempt = isAuthExempt(signInRuleMode(mode, input.allowList), method, pathname, destructiveWire, input.authList);
  if (input.offApp && !authExempt) return { allow: false, why: `sent from a page of ${input.offApp}, outside the app` };
  if (authExempt) return { allow: true };
  if (input.allowList) {
    if (!input.allowList.listed) return { allow: false, why: NOT_ALLOWED_WRITE_REFUSAL };
    if (!input.allowList.andModeRules) return { allow: true };
  }
  if (input.readPost) return { allow: true };
  return allowsWrite(mode, method, destructiveWire, input.owned) ? { allow: true } : { allow: false };
}

/**
 * How long a write the route handler let through stays on the ledger. The
 * browser-level pause follows the route handler's `continue` within
 * milliseconds; an entry that outlives this is a request that never reached
 * the network (answered by a service worker, cancelled by the page).
 */
export const ROUTED_WRITE_TTL_MS = 5000;

/** Entries past this many are dropped oldest first: a page that posts in a loop cannot grow the ledger without bound. */
const MAX_ROUTED_WRITES = 200;

/** A request body's identity for the ledger: the SHA-256 of its bytes, or "" for no body. */
export function bodyDigest(body: Buffer | null | undefined): string {
  return body && body.length > 0 ? createHash("sha256").update(body).digest("hex") : "";
}

/**
 * The writes the route handler has already judged and let through, so the
 * browser-level interception, which sees them again, lets them pass without
 * judging them twice. The key is the mode, the method, the URL and the body's
 * digest (`bodyDigest`), so a write let through can only excuse the very same
 * request: never one with another body to the same URL, such as a delete
 * command sent where a harmless save was allowed a moment before, and never
 * one sent after a flow switched to a stricter rule. A write is claimed once:
 * two identical requests, one routed and one not, leave the second to be
 * judged. Requests the route handler refused never reach the browser level,
 * so they are not recorded.
 */
export class RoutedWrites {
  private entries: Array<{ key: string; at: number }> = [];

  constructor(private readonly ttlMs = ROUTED_WRITE_TTL_MS) {}

  private static key(mode: WriteMode, method: string, url: string, digest: string): string {
    return `${mode} ${method} ${url.split("#")[0]} ${digest}`;
  }

  private prune(now: number): void {
    this.entries = this.entries.filter((e) => now - e.at <= this.ttlMs);
    if (this.entries.length > MAX_ROUTED_WRITES) this.entries = this.entries.slice(-MAX_ROUTED_WRITES);
  }

  note(mode: WriteMode, method: string, url: string, digest: string, now = Date.now()): void {
    this.prune(now);
    this.entries.push({ key: RoutedWrites.key(mode, method, url, digest), at: now });
  }

  /** Whether the route handler let this write through a moment ago; each note is claimed at most once. */
  claim(mode: WriteMode, method: string, url: string, digest: string, now = Date.now()): boolean {
    this.prune(now);
    const key = RoutedWrites.key(mode, method, url, digest);
    const i = this.entries.findIndex((e) => e.key === key);
    if (i < 0) return false;
    this.entries.splice(i, 1);
    return true;
  }

  clear(): void {
    this.entries = [];
  }
}

/** How long a write refused at the browser level stays recognisable to the driver's request events. */
export const UNSEEN_REFUSAL_TTL_MS = 10000;

/**
 * Writes refused at the browser level, which the driver may still report as
 * requests of its own: a 307 or 308 hop is a request Playwright knows, and it
 * then sees it fail (ERR_BLOCKED_BY_CLIENT). Without this the refusal was also
 * filed as the app's failed request and listed as a possible mutation. Keyed
 * by method and URL (fragment dropped), since the driver's request object is
 * not the paused one; kept briefly, and not consumed, since several listeners
 * ask about the same request.
 */
export class UnseenRefusals {
  private entries: Array<{ key: string; at: number }> = [];

  constructor(private readonly ttlMs = UNSEEN_REFUSAL_TTL_MS) {}

  private static key(method: string, url: string): string {
    return `${method} ${url.split("#")[0]}`;
  }

  private prune(now: number): void {
    this.entries = this.entries.filter((e) => now - e.at <= this.ttlMs);
    if (this.entries.length > MAX_ROUTED_WRITES) this.entries = this.entries.slice(-MAX_ROUTED_WRITES);
  }

  note(method: string, url: string, now = Date.now()): void {
    this.prune(now);
    this.entries.push({ key: UnseenRefusals.key(method, url), at: now });
  }

  has(method: string, url: string, now = Date.now()): boolean {
    this.prune(now);
    const key = UnseenRefusals.key(method, url);
    return this.entries.some((e) => e.key === key);
  }

  clear(): void {
    this.entries = [];
  }
}

type PausedBody = { postData?: string; postDataEntries?: Array<{ bytes?: string }> };

/**
 * The body of a request paused by the DevTools Fetch domain, as bytes: the
 * base64 entries decoded and joined, else the plain `postData`. Undefined when
 * the protocol sent neither (a body too large to include). Its digest then
 * matches no routed write, so the request is judged, on its URL alone.
 */
export function pausedRequestBytes(request: PausedBody): Buffer | undefined {
  const entries = request.postDataEntries?.filter((e) => typeof e.bytes === "string");
  if (entries && entries.length > 0) return Buffer.concat(entries.map((e) => Buffer.from(e.bytes!, "base64")));
  return request.postData === undefined ? undefined : Buffer.from(request.postData, "utf8");
}

/** The same body as text, for the policy's body rules. */
export function pausedRequestBody(request: PausedBody): string | undefined {
  return pausedRequestBytes(request)?.toString("utf8");
}

/** A header's value from a DevTools header map, whose names keep the case they were sent with. */
export function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

/**
 * The path of the marker a page is made to beacon as the last thing it does on `pagehide`, when the engine leaves it
 * (browser.ts `armLeaveMarker`). The browser-level interception hears what one page sent as it was left in the order it
 * was sent, so once the marker is heard, every write the page sent before it has been heard too and is being judged.
 * Without it, a beacon the browser reported a moment after the navigation away returned was judged after the engine
 * had stopped waiting: refused, but missing from the flow's list. The marker itself is failed unjudged and never sent.
 */
export const LEAVE_MARKER_PATH = "/__scenescout_left__/";

/** A leave marker's URL on `origin`, or null where a page has no origin a beacon can be sent to. */
export function leaveMarkerUrl(pageUrl: string, token: string): string | null {
  let origin: string;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    origin = u.origin;
  } catch {
    return null;
  }
  return `${origin}${LEAVE_MARKER_PATH}${encodeURIComponent(token)}`;
}

/** The token a request to a leave marker carries, "" for one under the marker's path with none, or null for any other request. */
export function leaveMarkerToken(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(LEAVE_MARKER_PATH)) return null;
  const rest = pathname.slice(LEAVE_MARKER_PATH.length);
  try {
    return decodeURIComponent(rest);
  } catch {
    return "";
  }
}

/**
 * The longest a page the engine left under a rule keeps that rule in force while its leave marker is unheard. A marker
 * the page could not send (a content policy that stops it, a renderer that died on the way out) is never heard; past
 * this the session's own rule applies again, as it would have before the marker existed.
 */
export const LEFT_PAGE_RULE_CAP_MS = 30000;

/**
 * The rule each page the engine left is still judged under, until everything the page sent as it was left has been
 * heard and judged: the page's leave marker (LEAVE_MARKER_PATH) is heard after the page's own leaving writes, so once
 * it is, none of them is still to come. Until then a write the browser reports late, however late, is judged by the
 * rule the page was left under (a flow's), never by the looser one the session has gone back to (policy.ts WriteRule
 * holds a loosened rule for a fixed time only). Measured: the browser-level interception names only the sending frame,
 * which keeps its id across the navigation away, and the route handler's frame is the same object before and after,
 * so neither tells a write from the left document from one sent by the next: the marker's order does.
 *
 * The rule held is the strictest of all pages left and not yet heard; one unheard past `capMs` is let go.
 */
export class LeftPageRules {
  private readonly pages = new Map<string, { mode: WriteMode; until: number }>();

  constructor(private readonly capMs = LEFT_PAGE_RULE_CAP_MS) {}

  /** A page is being left under `mode`, its marker carrying `token`. */
  left(token: string, mode: WriteMode, now = Date.now()): void {
    this.pages.set(token, { mode, until: now + this.capMs });
  }

  /** The page's marker was heard and what it sent before it judged; or the page was never armed, so no marker will come. */
  heard(token: string): void {
    this.pages.delete(token);
  }

  /** The strictest rule a page left and not yet heard holds, or null when none does. */
  at(now = Date.now()): WriteMode | null {
    let rule: WriteMode | null = null;
    for (const [token, page] of this.pages) {
      if (page.until < now) this.pages.delete(token);
      else rule = rule === null ? page.mode : stricterMode(rule, page.mode);
    }
    return rule;
  }

  clear(): void {
    this.pages.clear();
  }
}
