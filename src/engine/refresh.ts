/**
 * The refresh broker: one role's stored refresh token, presented by one
 * session at a time.
 *
 * Every session attached by the same role loads the same saved profile, so
 * every one of them holds the same refresh token. An app that rotates refresh
 * tokens with reuse detection treats a second presentation of a spent token as
 * theft and revokes the whole token family — every session of that role is
 * then signed out at once. The broker stops that: when a session's page is
 * about to send the role's refresh token, it first takes a lock next to the
 * profile. Holding it, the session re-reads the profile; if another session
 * has already rotated the token, it loads the rotated profile and sends the
 * current token in place of the spent one. When the response arrives and the
 * page has stored what it got back, the session writes its state over the
 * profile and releases the lock, so two sessions do not present one token.
 *
 * Which requests count is decided by brokerDecision. A token in the body, the
 * URL or a header the page set makes the request a refresh. A token that is
 * only in the Cookie header does not by itself: a refresh cookie scoped to "/"
 * rides on every request the page makes, scripts and images included. Such a
 * request counts only when it is plausibly the refresh call, a POST to a path
 * named for one or an endpoint the broker has seen rotate the cookie. Static
 * assets never count, and a broker that cannot do its job lets the request
 * through as the page sent it: an app left without its scripts is worse than
 * the rare double refresh.
 *
 * Sessions may be separate processes (one MCP server per lane) sharing the
 * profile on disk, so the lock is a file, created exclusively, owner-only,
 * and taken over only once it has gone stale.
 *
 * Everything here is Playwright-free so it can be table-tested; the browser
 * half — spotting the request and swapping the token on the wire — is in
 * browser.ts. No function here returns, logs or prints a token's value:
 * slots are named by where the token lives, never by what it is.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { splitProfile, withSessionStorage } from "./profiles.js";

// ── Where a refresh token lives in a profile ─────────────────────────────────

/** Cookie names, storage keys and JSON field names that hold a refresh token. */
export const REFRESH_NAME_RE = /refresh/i;

/**
 * The shortest value treated as a token. A real refresh token is long and
 * random; a short value ("1", "true") would match unrelated requests.
 */
export const MIN_TOKEN_LENGTH = 16;

/** How deep inside a JSON-valued storage entry a refresh-token field is looked for. */
const MAX_JSON_DEPTH = 4;

/**
 * One refresh token in a profile. `slot` names where it lives — a cookie, or a
 * storage key and the field inside it — so the same slot can be compared
 * across two versions of a profile. `value` is the token; it is never printed.
 */
export interface TokenSlot {
  slot: string;
  value: string;
  /** For a token held in a cookie, the cookie's name, so a Set-Cookie that rotates it can be recognised. */
  cookie?: string;
}

interface CookieShape {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
}

interface OriginShape {
  origin?: unknown;
  localStorage?: Array<{ name?: unknown; value?: unknown }>;
}

/**
 * Whether a value could be a token: long enough, no whitespace, and not an
 * address. An app that keeps the URL it refreshes at under a refresh-named key
 * ("/auth/refresh", "https://…/token") stores a path, which every request to
 * that path would otherwise seem to carry.
 */
function looksLikeToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= MIN_TOKEN_LENGTH && !/\s/.test(value) && !/^(\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(value);
}

/** Refresh-token fields inside a JSON value, by dotted path. */
function jsonFields(value: unknown, at: string, depth: number, out: Array<{ path: string; value: string }>): void {
  if (depth > MAX_JSON_DEPTH || !value || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const here = at ? `${at}.${key}` : key;
    if (REFRESH_NAME_RE.test(key) && looksLikeToken(inner)) out.push({ path: here, value: inner });
    else jsonFields(inner, here, depth + 1, out);
  }
}

/**
 * The refresh tokens a storage state holds: cookies named for one, storage
 * entries named for one, and fields named for one inside a JSON-valued
 * storage entry (an app that keeps `{ accessToken, refreshToken }` under one
 * key). Anything that is not a storage state yields none.
 */
export function refreshTokenSlots(state: unknown): TokenSlot[] {
  if (!state || typeof state !== "object") return [];
  const s = state as { cookies?: unknown; origins?: unknown };
  const out: TokenSlot[] = [];
  if (Array.isArray(s.cookies)) {
    for (const c of s.cookies as CookieShape[]) {
      if (typeof c?.name === "string" && REFRESH_NAME_RE.test(c.name) && looksLikeToken(c.value)) {
        out.push({ slot: `cookie ${c.name} (${String(c.domain ?? "")}${String(c.path ?? "")})`, value: c.value, cookie: c.name });
      }
    }
  }
  if (Array.isArray(s.origins)) {
    for (const o of s.origins as OriginShape[]) {
      if (!Array.isArray(o?.localStorage)) continue;
      for (const item of o.localStorage) {
        if (typeof item?.name !== "string" || typeof item.value !== "string") continue;
        const where = `storage ${String(o.origin ?? "")} ${item.name}`;
        if (REFRESH_NAME_RE.test(item.name) && looksLikeToken(item.value)) {
          out.push({ slot: where, value: item.value });
          continue;
        }
        if (!/^\s*[{[]/.test(item.value)) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(item.value);
        } catch {
          continue; // a storage value that only looks like JSON holds no field to find
        }
        const fields: Array<{ path: string; value: string }> = [];
        jsonFields(parsed, "", 0, fields);
        for (const f of fields) out.push({ slot: `${where} → ${f.path}`, value: f.value });
      }
    }
  }
  return out;
}

/** The forms a token can take on the wire: as is, and percent-encoded in a form body or query. */
function wireForms(value: string): string[] {
  const encoded = encodeURIComponent(value);
  return encoded === value ? [value] : [value, encoded];
}

/** A request as the broker reads it: its body and headers, never its response. */
export interface WireRequest {
  url: string;
  body: string | null;
  headers: Record<string, string>;
}

/**
 * Headers the browser adds to a request by itself. A token found in one of
 * these was not sent by the page as an act of refreshing: a cookie scoped to
 * "/" rides on every request the page makes, and a page whose own address
 * carries a token passes it on as the Referer of everything it loads.
 */
function browserAddedHeader(name: string): boolean {
  const n = name.toLowerCase();
  return n === "cookie" || n === "referer" || n === "origin" || n === "host" || n.startsWith("sec-") || n.startsWith(":");
}

/** Where a request carries a known token: its body, its URL, a header the page set, or only the Cookie header. */
export type TokenPresence = { slot: TokenSlot; via: "body" | "url" | "header" | "cookie" };

/**
 * The known refresh token a request carries, and where, or null. `known` is
 * what the session last loaded from the profile; a token the page got some
 * other way is not the role's and is left alone. A token in the body, the URL
 * or a header the page set wins over one that is only in the Cookie header.
 */
export function tokenPresence(req: WireRequest, known: readonly TokenSlot[]): TokenPresence | null {
  if (known.length === 0) return null;
  const carries = (haystack: string, t: TokenSlot) => wireForms(t.value).some((form) => haystack.includes(form));
  const explicit = Object.entries(req.headers)
    .filter(([name]) => !browserAddedHeader(name))
    .map(([, value]) => value);
  for (const t of known) {
    if (req.body && carries(req.body, t)) return { slot: t, via: "body" };
    if (carries(req.url, t)) return { slot: t, via: "url" };
    if (explicit.some((h) => carries(h, t))) return { slot: t, via: "header" };
  }
  const cookie = Object.entries(req.headers).find(([name]) => name.toLowerCase() === "cookie")?.[1] ?? "";
  for (const t of known) if (cookie && carries(cookie, t)) return { slot: t, via: "cookie" };
  return null;
}

/**
 * Requests for a page's static assets. They are never brokered, waited on or
 * dropped, whatever cookie rides on them: holding a script back behind the
 * refresh lock leaves the app under test without its code.
 */
export const STATIC_RESOURCE_TYPES: ReadonlySet<string> = new Set(["script", "stylesheet", "image", "font", "media", "manifest", "texttrack"]);

export function isStaticAsset(method: string, resourceType: string): boolean {
  return (method === "GET" || method === "HEAD") && STATIC_RESOURCE_TYPES.has(resourceType);
}

/**
 * Path segments that name a token refresh. Whole segments, as the write
 * policy's auth segments are, never substrings: `/api/tokens` mints an API
 * token and `/refreshments` is a menu.
 */
const REFRESH_SEGMENT_RE = /^(refresh|refresh[-_]?token|token|renew|reauth|reauthenticate)$/i;

/** A path whose last one or two segments name a token refresh: /auth/refresh, /oauth/token, /api/token/refresh. */
export function refreshLikePath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return segments.slice(-2).some((seg) => REFRESH_SEGMENT_RE.test(seg));
}

/** An endpoint as the broker remembers it: the method and the path, without the query. */
export function endpointKey(method: string, url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split("?")[0];
  }
  return `${method.toUpperCase()} ${pathname}`;
}

/**
 * Path segments of a sign-in, a sign-up or a sign-out. A cookie such a request
 * sets is a new sign-in, perhaps as somebody else, not a refresh: the broker
 * neither learns the endpoint nor saves the cookie over the role's profile.
 */
const SIGN_IN_SEGMENT_RE =
  /^(login|log-in|signin|sign-in|logout|log-out|signout|sign-out|signup|sign-up|register|verify|otp|magic-link|callback|authorize|sso)$/i;

/** Whether an endpoint seen to rotate the token may be learned as the refresh call: any but a sign-in, sign-up or sign-out. */
export function learnableEndpoint(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return !pathname
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .some((seg) => SIGN_IN_SEGMENT_RE.test(seg));
}

/** A body that asks for a grant other than a refresh (a password or code sign-in) is not a refresh, whatever cookie rides on it. */
function otherGrant(body: string | null): boolean {
  const m = /grant_type["']?\s*[=:]\s*["']?([A-Za-z_:.-]+)/.exec(body ?? "");
  return m !== null && !/refresh/i.test(m[1]);
}

/**
 * Whether a token that is only in the Cookie header could make this request a
 * refresh, so that header is worth reading at all. A cookie alone never does,
 * since a cookie scoped to "/" rides on every request. Only a request that is
 * plausibly the refresh call counts: one the broker has learned rotates the
 * token (`learned`, by endpointKey), or a POST, PUT or PATCH to a path whose
 * last one or two segments name a refresh.
 */
export function cookieMayCount(method: string, url: string, learned: ReadonlySet<string>): boolean {
  if (learned.has(endpointKey(method, url))) return true;
  if (method !== "POST" && method !== "PUT" && method !== "PATCH") return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return refreshLikePath(pathname);
}

/** A request the broker decides on: a WireRequest with its method and the kind of resource it loads. */
export interface BrokerRequest extends WireRequest {
  method: string;
  resourceType: string;
}

export type BrokerDecision =
  | { kind: "broker"; sent: TokenSlot; via: TokenPresence["via"] }
  | { kind: "pass"; why: "static asset" | "no known token" | "only in a cookie" | "another grant" };

/**
 * Whether a request goes through the refresh lock. A static asset never does.
 * A request carrying a known token in its body, URL or a header the page set
 * does. A token that is only in the Cookie header counts only for a request
 * that is plausibly the refresh call (cookieMayCount), and not for one whose
 * body asks for another grant.
 */
export function brokerDecision(req: BrokerRequest, known: readonly TokenSlot[], learned: ReadonlySet<string>): BrokerDecision {
  if (isStaticAsset(req.method, req.resourceType)) return { kind: "pass", why: "static asset" };
  const found = tokenPresence(req, known);
  if (!found) return { kind: "pass", why: "no known token" };
  if (found.via !== "cookie") return { kind: "broker", sent: found.slot, via: found.via };
  if (!cookieMayCount(req.method, req.url, learned)) return { kind: "pass", why: "only in a cookie" };
  if (otherGrant(req.body)) return { kind: "pass", why: "another grant" };
  return { kind: "broker", sent: found.slot, via: "cookie" };
}

/**
 * What a session holding the lock does with the token its page is about to
 * send, given the profile as it is on disk now:
 * - `send`: the profile still holds it — nobody rotated it, so this session
 *   is the one that refreshes.
 * - `swap`: another session rotated it while this one waited. Load the
 *   profile, and send the current token in place of the spent one.
 * - `unknown`: the profile no longer has that slot at all (signed in again
 *   as something else, or the app moved the token). Send it as is: the
 *   broker cannot know what would be current. Nothing is written back, so
 *   a login saved since is not overwritten by this session's state.
 */
export type RefreshPlan = { kind: "send" } | { kind: "swap"; to: TokenSlot } | { kind: "unknown" };

export function planRefresh(sent: TokenSlot, current: readonly TokenSlot[]): RefreshPlan {
  if (current.some((c) => c.value === sent.value)) return { kind: "send" };
  const same = current.find((c) => c.slot === sent.slot);
  return same ? { kind: "swap", to: same } : { kind: "unknown" };
}

/** Replace a spent token with the current one in a body, URL or header value, in whichever wire form it appears. */
export function swapToken(text: string, from: string, to: string): string {
  let out = text.split(from).join(to);
  const fromEnc = encodeURIComponent(from);
  if (fromEnc !== from) out = out.split(fromEnc).join(encodeURIComponent(to));
  return out;
}

/** Apply a swap to a whole request: the parts that changed, and nothing else. */
export function swapRequest(req: WireRequest, from: string, to: string): { url?: string; body?: string; headers?: Record<string, string> } {
  const out: { url?: string; body?: string; headers?: Record<string, string> } = {};
  const url = swapToken(req.url, from, to);
  if (url !== req.url) out.url = url;
  if (req.body !== null) {
    const body = swapToken(req.body, from, to);
    if (body !== req.body) out.body = body;
  }
  let headersChanged = false;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = swapToken(v, from, to);
    if (headers[k] !== v) headersChanged = true;
  }
  if (headersChanged) out.headers = headers;
  return out;
}

/**
 * Whether the page has stored the rotation it was sent: the slot the token
 * was sent from now holds a different token. Until then, writing the state
 * back would save the spent token for every other session to present.
 */
export function rotationStored(state: unknown, sent: TokenSlot): boolean {
  const now = refreshTokenSlots(state).find((t) => t.slot === sent.slot);
  return now !== undefined && now.value !== sent.value;
}

/**
 * The profile the broker writes back once the page has stored a rotation: the
 * page's storage state, which has no sessionStorage, with the sessionStorage
 * of the profile on disk kept beside it. Without it, an app whose sign-in also
 * lives in sessionStorage would lose that half on every brokered refresh.
 * A profile that could not be read (null) leaves the page's state as it is.
 */
export function profileAfterRotation(pageState: unknown, profileOnDisk: unknown): unknown {
  if (profileOnDisk === null) return pageState;
  return withSessionStorage(pageState, splitProfile(profileOnDisk).sessionStorage);
}

/**
 * The cookies a response's Set-Cookie headers set, by name. A header value may
 * hold several cookies joined by newlines, as some browsers report them.
 */
function setCookiePairs(setCookies: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of setCookies.flatMap((l) => l.split("\n"))) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}

/**
 * The known cookie tokens a response's Set-Cookie headers replace with a new
 * token: the request that got this response refreshed them. A cookie set to an
 * empty or short value is being cleared (a sign-out), not rotated.
 */
export function rotatedCookies(setCookies: readonly string[], known: readonly TokenSlot[]): TokenSlot[] {
  const set = setCookiePairs(setCookies);
  return known.filter((t) => {
    if (t.cookie === undefined) return false;
    const next = set.get(t.cookie);
    return looksLikeToken(next) && next !== t.value;
  });
}

/**
 * The rotated refresh token a refresh response carries, for a page that did
 * not store it in time: a refresh-named field in a JSON body, else a
 * refresh-named Set-Cookie. Null when neither names exactly one; guessing
 * between two would save the wrong one.
 */
export function rotatedFromResponse(body: string, setCookies: readonly string[]): string | null {
  const found = new Set<string>();
  try {
    const fields: Array<{ path: string; value: string }> = [];
    jsonFields(JSON.parse(body), "", 0, fields);
    for (const f of fields) found.add(f.value);
  } catch {
    // Not a JSON body: the Set-Cookie headers are all there is to read.
  }
  if (found.size === 0) {
    for (const [name, value] of setCookiePairs(setCookies)) if (REFRESH_NAME_RE.test(name) && looksLikeToken(value)) found.add(value);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** A copy of a storage state with one token replaced wherever it is held: a cookie's value, or inside a storage entry. */
export function swapProfileToken(state: unknown, from: string, to: string): unknown {
  const s = JSON.parse(JSON.stringify(state)) as { cookies?: CookieShape[]; origins?: OriginShape[] };
  for (const c of s.cookies ?? []) if (c.value === from) c.value = to;
  for (const o of s.origins ?? []) {
    for (const item of o.localStorage ?? []) if (typeof item.value === "string") item.value = swapToken(item.value, from, to);
  }
  return s;
}

/**
 * The headers the broker sends a request with when it has to send the request
 * itself, which it does only to put the current token in a Cookie header (a
 * browser keeps the Cookie header it built, whatever a route override says).
 * The page's own headers are kept; the ones the HTTP client sets for itself
 * (host, content length, connection, the encodings it can decode) and
 * pseudo-headers are left out, and `cookie` is the line to send.
 */
export function headersForResend(headers: Record<string, string>, cookie: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (n.startsWith(":") || ["host", "content-length", "connection", "transfer-encoding", "accept-encoding", "cookie"].includes(n)) continue;
    out[n] = value;
  }
  if (cookie) out.cookie = cookie;
  return out;
}

// ── Whether the broker runs ──────────────────────────────────────────────────

export const REFRESH_BROKER_ENV = "SCENESCOUT_REFRESH_BROKER";

/**
 * Whether a session brokers its role's refresh token. On by default for a
 * session attached by role; SCENESCOUT_REFRESH_BROKER=off turns it off, and
 * any other value than on/off is refused rather than guessed at. An explicit
 * attach option wins over the environment.
 */
export function brokerEnabled(opts: { roleSession: boolean; option?: boolean; env?: string }): boolean {
  if (!opts.roleSession) return false;
  if (opts.option !== undefined) return opts.option;
  const raw = opts.env?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "on") return true;
  if (raw === "off") return false;
  throw new Error(`${REFRESH_BROKER_ENV} must be "on" or "off" (got "${opts.env!.slice(0, 20)}")`);
}

// ── The lock ─────────────────────────────────────────────────────────────────

/** Owner read/write only, like the profile it guards. */
export const LOCK_FILE_MODE = 0o600;

/** A lock untouched this long is taken to belong to a process that died holding it. */
export const DEFAULT_STALE_MS = 30_000;

/** How long a session waits for the lock before it gives up and says so. */
export const DEFAULT_WAIT_MS = 45_000;

/** The lock file for a profile: beside it, so it shares the profile's owner-only directory. */
export function lockPathFor(profileFile: string): string {
  return `${profileFile}.lock`;
}

// ── Endpoints learned to rotate the token ──────────────────────────────────

/**
 * Where the broker keeps the endpoints it has seen rotate the role's refresh
 * token, beside the profile: every session of the role reads it, so a session
 * brokers an endpoint another session learned, even in another process.
 */
export function endpointsPathFor(profileFile: string): string {
  return `${profileFile}.endpoints`;
}

/** At most this many learned endpoints are kept, newest first. */
export const MAX_LEARNED_ENDPOINTS = 20;

const ENDPOINT_KEY_RE = /^(GET|POST|PUT|PATCH) \/\S{0,500}$/;

/** The learned endpoints on disk. None when there is no file yet; a file that is not the broker's teaches nothing. */
export function readLearnedEndpoints(file: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // written by rename, so never half-written: whatever this is, it is not a list of endpoints
  }
  const list = (parsed as { endpoints?: unknown } | null)?.endpoints;
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is string => typeof e === "string" && ENDPOINT_KEY_RE.test(e)).slice(0, MAX_LEARNED_ENDPOINTS);
}

/** The list with `key` added first, once, and the oldest dropped past the cap. A key that is not an endpoint changes nothing. */
export function withLearnedEndpoint(list: readonly string[], key: string): string[] {
  if (!ENDPOINT_KEY_RE.test(key)) return [...list];
  return [key, ...list.filter((e) => e !== key)].slice(0, MAX_LEARNED_ENDPOINTS);
}

/** Write the learned endpoints owner-only, by rename, so a reader never sees half a file. Call it holding the lock. */
export function writeLearnedEndpoints(file: string, list: readonly string[]): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  const fd = fs.openSync(temp, "wx", LOCK_FILE_MODE);
  try {
    fs.writeFileSync(fd, JSON.stringify({ endpoints: list }));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

/** Whether a lock last touched at `mtimeMs` is stale at `now`. */
export function isStale(mtimeMs: number, now: number, staleMs: number): boolean {
  return now - mtimeMs > staleMs;
}

export interface HeldLock {
  path: string;
  /** Random, and written into the file, so a release never removes a lock another process took over. */
  nonce: string;
  release(): void;
}

export interface LockOptions {
  staleMs?: number;
  waitMs?: number;
  /** Poll interval, jittered. */
  pollMs?: number;
  now?: () => number;
}

function readNonce(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { nonce?: unknown };
    return typeof parsed.nonce === "string" ? parsed.nonce : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // Half-written by its creator, or not ours: no nonce to compare.
    if (err instanceof SyntaxError) return "";
    throw err;
  }
}

/** One attempt: the lock, or null when another process holds a live one. */
/**
 * What an error from creating the lock file means. EEXIST: another process
 * holds it. On Windows, creating a file whose previous copy is still being
 * deleted (a lock just released) fails with EPERM, EBUSY or EACCES instead;
 * that is the lock changing hands, so it is waited out like a held lock, not
 * reported as a failure. Anything else is a real error.
 */
export function lockCreateError(code: string | undefined, platform: NodeJS.Platform = process.platform): "held" | "busy" | "error" {
  if (code === "EEXIST") return "held";
  if (platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) return "busy";
  return "error";
}

export function tryAcquireLock(file: string, opts: { staleMs?: number; now?: () => number; platform?: NodeJS.Platform } = {}): HeldLock | null {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const now = opts.now ?? Date.now;
  const nonce = crypto.randomBytes(12).toString("hex");
  try {
    const fd = fs.openSync(file, "wx", LOCK_FILE_MODE);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: now(), nonce }));
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    const meaning = lockCreateError((err as NodeJS.ErrnoException).code, opts.platform);
    if (meaning === "error") throw err;
    if (meaning === "busy") return null; // being deleted as it changes hands: try again next poll
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (statErr) {
      if ((statErr as NodeJS.ErrnoException).code === "ENOENT") return null; // released between the two calls: try again next poll
      throw statErr;
    }
    if (!isStale(mtimeMs, now(), staleMs)) return null;
    // Take over a stale lock by moving it aside under a name only this attempt
    // uses, then judging the file that was actually moved: if another waiter
    // took the stale lock over first, what was moved is its fresh lock, whose
    // time is recent, and it goes straight back.
    const aside = `${file}.${nonce}.stale`;
    try {
      fs.renameSync(file, aside);
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw renameErr;
    }
    if (!isStale(fs.statSync(aside).mtimeMs, now(), staleMs)) {
      try {
        fs.linkSync(aside, file);
      } catch (linkErr) {
        // A third process took the free name meanwhile. Two locks now exist for a
        // moment; the one moved aside can only be dropped, and its holder's
        // release finds a nonce not its own and leaves the new lock alone.
        if ((linkErr as NodeJS.ErrnoException).code !== "EEXIST") throw linkErr;
      }
      fs.rmSync(aside, { force: true });
      return null;
    }
    fs.rmSync(aside, { force: true });
    return tryAcquireLock(file, opts);
  }
  return {
    path: file,
    nonce,
    release() {
      // Only our own lock: one taken over as stale belongs to someone else now.
      if (readNonce(file) === nonce) fs.rmSync(file, { force: true });
    },
  };
}

/**
 * Wait for the lock. While it is held, its file is touched regularly so a
 * long refresh is never mistaken for a dead holder; the returned release
 * stops that. Throws after `waitMs` with a message that names the lock file.
 */
export async function acquireLock(file: string, opts: LockOptions = {}): Promise<HeldLock> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = opts.pollMs ?? 25;
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  for (;;) {
    const held = tryAcquireLock(file, { staleMs, now });
    if (held) {
      const beat = setInterval(
        () => {
          try {
            if (readNonce(file) === held.nonce) fs.utimesSync(file, new Date(), new Date());
          } catch {
            /* the lock was released or taken over; the next beat is cleared by release */
          }
        },
        Math.max(50, Math.floor(staleMs / 3)),
      );
      beat.unref();
      const release = held.release;
      return {
        ...held,
        release() {
          clearInterval(beat);
          release();
        },
      };
    }
    if (now() >= deadline) {
      throw new Error(
        `timed out after ${waitMs} ms waiting for the refresh lock at ${file}; another session is refreshing, or a stale lock is not yet ${staleMs} ms old`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs + Math.floor(Math.random() * pollMs)));
  }
}
