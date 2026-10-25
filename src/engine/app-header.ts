/**
 * An allowlist header for the app under test (#555). A team that lets CI
 * traffic through its web application firewall by a shared header sets
 * `SCENESCOUT_APP_HEADER` to `Name: value`, and SceneScout adds that header to
 * every request the browser sends to the app's own origin (the scheme, host
 * and port the session attached to), and to the preflight's request for the
 * start page. It is never added to a request for any other origin: a font, a
 * script, a sign-in provider or an analytics host never sees it, nor does the
 * model's API or a tracker.
 *
 * The value is a credential: it is never printed. `appHeaderLine` names the
 * header and not its value, and the value is among the secrets every line a
 * `ci` run writes is redacted of (ci.ts secretValues).
 *
 * It is read from the environment only, so the operator who starts the
 * command or the server sets it; no tool argument can name one. A name that
 * would change who the request is (`Cookie`, `Authorization`, `Host`), how it
 * is framed (`Content-Length`) or what the write policy reads as its method
 * (`X-HTTP-Method-Override`) is refused.
 *
 * The rules are table-tested in policy-test.
 */

export const APP_HEADER_ENV = "SCENESCOUT_APP_HEADER";

/** Names an allowlist header may not take. */
const REFUSED_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "origin",
  "referer",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "keep-alive",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
]);

/** The characters RFC 9110 allows in a header name (a token). */
const TOKEN_EXTRA = "!#$%&'*+-.^_`|~";

function isToken(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  for (const c of name) {
    const letterOrDigit = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
    if (!letterOrDigit && !TOKEN_EXTRA.includes(c)) return false;
  }
  return true;
}

/** The longest value accepted: a header far past this is not an allowlist token. */
export const APP_HEADER_MAX_VALUE = 1024;

export interface AppHeader {
  /** Lower case, as Playwright's header maps hold names. */
  name: string;
  value: string;
}

/**
 * The allowlist header the environment sets, or null when it sets none. A
 * malformed one throws, naming the variable but never repeating the value.
 */
export function readAppHeader(env: Record<string, string | undefined>): AppHeader | null {
  const raw = env[APP_HEADER_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  const colon = raw.indexOf(":");
  if (colon <= 0) throw new Error(`${APP_HEADER_ENV} must be "Name: value" (no colon was found after a name).`);
  const name = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (!isToken(name)) throw new Error(`${APP_HEADER_ENV}'s name must be a header name: letters, digits and ${TOKEN_EXTRA}, at most 100 characters.`);
  const lower = name.toLowerCase();
  if (REFUSED_NAMES.has(lower) || lower.startsWith("sec-") || lower.startsWith("proxy-"))
    throw new Error(
      `${APP_HEADER_ENV} cannot set ${name}: it would change who the request is, how it is framed or what the write policy reads as its method. Use a header of your own, such as X-CI-Allow.`,
    );
  if (value === "") throw new Error(`${APP_HEADER_ENV} sets ${name} with an empty value.`);
  if (value.length > APP_HEADER_MAX_VALUE) throw new Error(`${APP_HEADER_ENV}'s value is longer than ${APP_HEADER_MAX_VALUE} characters.`);
  for (const c of value) {
    const code = c.charCodeAt(0);
    if (code < 0x20 ? c !== "\t" : code === 0x7f) throw new Error(`${APP_HEADER_ENV}'s value holds a control character, which no header may carry.`);
  }
  return { name: lower, value };
}

/** The origin of an address, or null when it does not parse or is not http(s). */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Whether a request for `requestUrl` gets the header: only when it is for the app's own origin (scheme, host and port). */
export function appHeaderApplies(requestUrl: string, appUrl: string): boolean {
  const app = originOf(appUrl);
  return app !== null && originOf(requestUrl) === app;
}

/** A request's headers with the allowlist header added (replacing one of the same name). */
export function withAppHeader(headers: Readonly<Record<string, string>>, header: AppHeader): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== header.name) out[name] = value;
  out[header.name] = header.value;
  return out;
}

/** The line that says the header is sent, naming it and never its value. */
export function appHeaderLine(header: AppHeader, appUrl: string): string {
  return `Allowlist header (${APP_HEADER_ENV}): ${header.name} is sent to ${originOf(appUrl) ?? "the app"} only; its value is never printed.`;
}

/**
 * Whether a request of this resource type is sent with the header. Each one
 * that is, SceneScout sends itself, with no redirect followed (a page load by
 * Node's fetch, decided by documentAnswerPlan; any other by route.fetch), and
 * hands the answer to the browser, so the header never follows a redirect the
 * browser takes; a redirect within the app is followed with it (appRedirectPlan).
 * An event stream never ends, so it cannot be sent that way; it goes as the
 * page sent it, without the header.
 */
export function appHeaderCarried(resourceType: string): boolean {
  return resourceType !== "eventsource" && resourceType !== "websocket";
}

/** The error codes Playwright's route.abort takes that a failed send can stand for. */
export type AbortCode = "namenotresolved" | "connectionrefused" | "connectionreset" | "connectionclosed" | "timedout" | "failed";

/**
 * The code to abort a request with when SceneScout's own send of it failed,
 * read from the error's words (Node's codes, as Playwright repeats them), so
 * the page and the oracles see the network failure the browser would have
 * seen. Anything else is a plain failure.
 */
export function abortCodeFor(message: string): AbortCode {
  const words = new Set(message.split(/[\s:,()]+/));
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "EAI_NONAME", "EAI_FAIL"].some((w) => words.has(w))) return "namenotresolved";
  if (words.has("ECONNREFUSED")) return "connectionrefused";
  if (words.has("ECONNRESET") || words.has("EPIPE")) return "connectionreset";
  if (words.has("ETIMEDOUT") || words.has("UND_ERR_CONNECT_TIMEOUT")) return "timedout";
  // Playwright's send says "socket hang up"; Node's fetch names undici's socket error.
  if (message.includes("socket hang up") || words.has("UND_ERR_SOCKET")) return "connectionclosed";
  // SceneScout's own limit on the send (the page-load limit) ran out: the app was slow, as a page load past that limit
  // would be without the header. A plain failure, never the network's timeout.
  return "failed";
}

/** A request's headers without the allowlist header: what a request handed back to the browser is sent with. */
export function withoutAppHeader(headers: Readonly<Record<string, string>>, header: AppHeader): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== header.name) out[name] = value;
  return out;
}

/** Headers Node's fetch sets itself or refuses, and the Cookie header, which a send of SceneScout's own builds from the browser's jar. */
const OWN_SEND_DROPPED = new Set(["cookie", "host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "expect", "te", "trailer"]);

/** A request's headers as a send of SceneScout's own (Node's fetch) may carry them. */
export function forOwnSend(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (!name.startsWith(":") && !OWN_SEND_DROPPED.has(name.toLowerCase())) out[name] = value;
  return out;
}

/**
 * Whether a request whose page is at `referer` comes from another site than
 * `url`: another scheme, or another registrable domain, read as the last two
 * labels of the host (an address or a one-label host such as localhost is its
 * own site). Without a public-suffix list, two sites under one public
 * suffix (shop.example.co.uk and news.other.co.uk) read as one, so the error
 * is to send a cookie, as before, never to withhold one the browser sends. No Referer, or one that is not a URL: not known to be
 * another site's.
 */
export function crossSite(referer: string | undefined, url: string): boolean {
  let from: URL;
  let to: URL;
  try {
    from = new URL(referer ?? "");
    to = new URL(url);
  } catch {
    return false;
  }
  if (from.protocol !== to.protocol) return true;
  if (from.hostname === to.hostname) return false;
  const address = (host: string) => host.includes(":") || host.split(".").every((label) => label !== "" && [...label].every((ch) => ch >= "0" && ch <= "9"));
  const site = (host: string) => (address(host) || !host.includes(".") ? host : host.split(".").slice(-2).join("."));
  return site(from.hostname) !== site(to.hostname);
}

/**
 * The Cookie line the browser sends with a request of the app's, built from
 * its jar for that address when the request shows none at the time it is
 * routed (Chromium adds cookies, and its Sec-Fetch-Site, only after the
 * route handler has run): what SceneScout sends in the browser's place. A
 * request another site's page started (crossSite) goes without a
 * SameSite=Strict cookie and, unless it is a top-level page load, without a
 * Lax one too, as the browser sends it.
 */
export function cookieLineFor(jar: readonly { name: string; value: string; sameSite?: string }[], fromAnotherSite: boolean, topLevelLoad: boolean): string {
  return jar
    .filter((c) => !fromAnotherSite || (c.sameSite !== "Strict" && (topLevelLoad || c.sameSite !== "Lax")))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/**
 * The Cookie line a page load handed back to the browser carries when the
 * request already showed one as it was routed (Firefox adds cookies before the
 * route handler runs): `line`, with the cookies SceneScout's own send of it was
 * answered with put over it, as the browser's jar now holds them. A cookie
 * whose Path does not cover `pathname` is left out, and one set to expire
 * (Max-Age 0 or less, or an Expires before `now`) is removed.
 */
export function cookieLineAfter(line: string, setCookies: readonly string[], pathname: string, now = Date.now()): string {
  const jar = new Map<string, string>();
  for (const pair of line.split(";")) {
    const eq = pair.indexOf("=");
    const name = eq < 0 ? "" : pair.slice(0, eq).trim();
    if (name) jar.set(name, pair.slice(eq + 1).trim());
  }
  for (const set of setCookies) {
    const [first, ...attrs] = set.split(";");
    const eq = first.indexOf("=");
    const name = eq < 0 ? "" : first.slice(0, eq).trim();
    if (!name) continue;
    let gone = false;
    let path = "/";
    for (const attr of attrs) {
      const at = attr.indexOf("=");
      const key = (at < 0 ? attr : attr.slice(0, at)).trim().toLowerCase();
      const value = at < 0 ? "" : attr.slice(at + 1).trim();
      if (key === "max-age" && Number(value) <= 0) gone = true;
      if (key === "expires" && Date.parse(value) < now) gone = true;
      if (key === "path" && value.startsWith("/")) path = value;
    }
    if (pathname !== path && !pathname.startsWith(path.endsWith("/") ? path : `${path}/`)) continue;
    if (gone) jar.delete(name);
    else jar.set(name, first.slice(eq + 1).trim());
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/**
 * Whether an answer's headers say it is a page the browser shows, rather than
 * a file it downloads or displays as it is: not an attachment, and HTML (or no
 * type at all, which the browser sniffs).
 */
export function answersWithPage(headers: Readonly<Record<string, string>>): boolean {
  const lower = (name: string) =>
    Object.entries(headers)
      .find(([n]) => n.toLowerCase() === name)?.[1]
      ?.trim()
      .toLowerCase() ?? "";
  if (lower("content-disposition").startsWith("attachment")) return false;
  const type = lower("content-type").split(";")[0].trim();
  return type === "" || type === "text/html" || type === "application/xhtml+xml";
}

/**
 * The largest file a page load carrying the header is read whole for and
 * handed to the browser as one answer, by the length its answer declares. A
 * larger one, or one that declares none (a stream), is handed back instead
 * (documentAnswerPlan).
 */
export const APP_HEADER_FILE_READ_MAX = 1024 * 1024;

/**
 * What to do with the answer to a page load SceneScout sent once, with the
 * header, decided from its status and headers before any of its body is read.
 * Playwright can hand the browser only a whole body, never a stream, so:
 * - "fulfil": a page, an error, a redirect away from the app (the browser
 *   follows it without the header) or a file that declares a length of at most
 *   APP_HEADER_FILE_READ_MAX, sent uncompressed, is read whole and handed to
 *   the browser, and the app sees the load once;
 * - "stand-in": a redirect within the app is answered with a page that loads
 *   the next address itself (redirectStandIn), as a new page load, routed and
 *   sent with the header in its turn;
 * - "hand-back": a file that declares no length (a stream), a longer one, or a
 *   compressed one (its length is not what it decodes to) is not read: its body is cancelled once its headers are in, and the load is
 *   handed back to the browser, which sends it again without the header, so a
 *   slow or large file arrives as it does with no header rather than whole
 *   after a wait. The app sees that address twice.
 */
export function documentAnswerPlan(input: {
  status: number;
  headers: Readonly<Record<string, string>>;
  requestUrl: string;
  appUrl: string;
}): { kind: "fulfil" | "hand-back" } | { kind: "stand-in"; url: string } {
  const header = (name: string) =>
    Object.entries(input.headers)
      .find(([n]) => n.toLowerCase() === name)?.[1]
      ?.trim();
  if (input.status >= 300 && input.status < 400) {
    const plan = appRedirectPlan({ ...input, location: header("location"), method: "GET", resourceType: "document" });
    return plan && plan.kind === "stand-in" ? { kind: "stand-in", url: plan.url } : { kind: "fulfil" };
  }
  if (input.status < 200 || input.status >= 300 || answersWithPage(input.headers)) return { kind: "fulfil" };
  // A length counts only for a body sent as it is: a compressed one is read decoded, at a size its length does not say.
  const encoded = (header("content-encoding") ?? "").toLowerCase();
  if (encoded !== "" && encoded !== "identity") return { kind: "hand-back" };
  const length = header("content-length") ?? "";
  return /^\d{1,15}$/.test(length) && Number(length) <= APP_HEADER_FILE_READ_MAX ? { kind: "fulfil" } : { kind: "hand-back" };
}

/**
 * How a page load is answered when SceneScout followed redirects within the
 * app itself (documentAnswerPlan's "stand-in") and they ended in this answer:
 * - "stand-in": a page (or an error, or a redirect away from the app) is kept
 *   and the load is answered with a stand-in page that loads its address, so
 *   the browser shows it at its own address, answered from what was kept;
 * - "redirect": a file is not kept: the load is answered with a redirect to its
 *   address, which the browser follows without the header, as it would the
 *   app's own redirect, so a download starts as it does with no header rather
 *   than from a page that has already loaded.
 */
export function redirectsEndPlan(input: { status: number; headers: Readonly<Record<string, string>> }): "stand-in" | "redirect" {
  return input.status >= 200 && input.status < 300 && !answersWithPage(input.headers) ? "redirect" : "stand-in";
}

/** Headers the decoded, whole body handed to the browser no longer matches, or that only the connection the answer came on had. */
const FULFIL_DROPPED = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "trailer", "upgrade"]);

/**
 * The headers an answer SceneScout read itself (Node's fetch, which decodes a
 * compressed body) is handed to the browser with: as they came, less those the
 * decoded, whole body no longer matches, and with each Set-Cookie on a line of
 * its own (Playwright passes the lines to the browser as separate headers,
 * and the browser stores what they set).
 */
export function fulfilHeaders(entries: Iterable<readonly [string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [raw, value] of entries) {
    const name = raw.toLowerCase();
    if (FULFIL_DROPPED.has(name)) continue;
    const sep = name === "set-cookie" ? "\n" : ", ";
    out[name] = name in out ? `${out[name]}${sep}${value}` : value;
  }
  return out;
}

/** A cookie as Playwright's BrowserContext.addCookies takes one. */
export interface JarCookie {
  name: string;
  value: string;
  /** A leading dot for a cookie its Domain shares with subdomains; the bare host for a host-only one. */
  domain: string;
  path: string;
  /** Seconds since the epoch; -1 for a cookie that lasts the session. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * What the Set-Cookie lines of an answer to `url` change in the browser's jar,
 * read as a browser reads them (RFC 6265), for an answer the browser never saw:
 * the cookies to add, and those to remove (Max-Age 0 or less, or an Expires
 * not after `now`). A line the browser would refuse is left out: no name, a
 * Domain that does not cover the host, Secure over plain http (localhost
 * aside), SameSite=None without Secure, or a __Secure- or __Host- name whose
 * rules it breaks. `accepted` is the lines the browser would keep. Used when a page load's answer is
 * handed back to the browser unread (documentAnswerPlan), so the jar holds what
 * the app set in answer to the load it saw, and the browser's own send of it
 * carries that.
 */
export function jarChanges(
  setCookies: readonly string[],
  url: string,
  now = Date.now(),
): { add: JarCookie[]; remove: { name: string; domain: string; path: string }[]; accepted: string[] } {
  const add: JarCookie[] = [];
  const remove: { name: string; domain: string; path: string }[] = [];
  const accepted: string[] = [];
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return { add, remove, accepted };
  }
  const host = at.hostname.toLowerCase();
  const address = host.startsWith("[") || /^[\d.]+$/.test(host);
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  const slash = at.pathname.lastIndexOf("/");
  const defaultPath = slash <= 0 ? "/" : at.pathname.slice(0, slash);
  for (const line of setCookies) {
    const [first, ...attrs] = line.split(";");
    const eq = first.indexOf("=");
    const name = eq < 0 ? "" : first.slice(0, eq).trim();
    if (!name) continue;
    const value = first.slice(eq + 1).trim();
    let domain = host;
    let path = defaultPath;
    let expires = -1;
    let maxAge: number | null = null;
    let httpOnly = false;
    let secure = false;
    let sameSite: JarCookie["sameSite"];
    let refused = false;
    let domainNamed = false;
    for (const attr of attrs) {
      const sign = attr.indexOf("=");
      const key = (sign < 0 ? attr : attr.slice(0, sign)).trim().toLowerCase();
      const val = sign < 0 ? "" : attr.slice(sign + 1).trim();
      if (key === "domain" && val !== "") {
        domainNamed = true;
        const d = (val.startsWith(".") ? val.slice(1) : val).toLowerCase();
        // An address is its own host only; a name's Domain covers it and its subdomains.
        if (d === host) domain = address || !host.includes(".") ? host : `.${d}`;
        else if (!address && d.includes(".") && host.endsWith(`.${d}`)) domain = `.${d}`;
        else refused = true;
      } else if (key === "path" && val.startsWith("/")) path = val;
      else if (key === "max-age" && /^-?\d{1,15}$/.test(val)) maxAge = Number(val);
      else if (key === "expires") {
        const when = Date.parse(val);
        if (!Number.isNaN(when)) expires = Math.floor(when / 1000);
      } else if (key === "httponly") httpOnly = true;
      else if (key === "secure") secure = true;
      else if (key === "samesite") {
        const v = val.toLowerCase();
        sameSite = v === "strict" ? "Strict" : v === "lax" ? "Lax" : v === "none" ? "None" : undefined;
      }
    }
    if (refused || (secure && at.protocol !== "https:" && !local) || (sameSite === "None" && !secure)) continue;
    // The name prefixes a browser holds a cookie to: __Secure- needs Secure; __Host- also Path=/ and no Domain at all,
    // not even one naming the host itself.
    const lower = name.toLowerCase();
    if ((lower.startsWith("__secure-") || lower.startsWith("__host-")) && !secure) continue;
    if (lower.startsWith("__host-") && (domainNamed || path !== "/")) continue;
    accepted.push(line);
    // Max-Age wins over Expires.
    if (maxAge !== null ? maxAge <= 0 : expires !== -1 && expires * 1000 <= now) {
      remove.push({ name, domain, path });
      continue;
    }
    if (maxAge !== null) expires = Math.floor(now / 1000) + maxAge;
    add.push({ name, value, domain, path, expires, httpOnly, secure, ...(sameSite ? { sameSite } : {}) });
  }
  return { add, remove, accepted };
}

/** The most hops SceneScout follows itself for one request, as a browser would (the Fetch standard's limit). */
export const APP_HEADER_MAX_HOPS = 20;

/**
 * What to do with a redirect the app answered a request carrying the header
 * with. The browser follows a redirect without routing its next hop, so a hop
 * it followed would reach the app without the header:
 * - "follow": a request of the page's own (fetch, a script, an image) whose
 *   next hop is on the app's origin is sent on by SceneScout, with the header;
 * - "stand-in": a page load whose next hop is on the app's origin is answered
 *   with a page that loads that address itself, as a new navigation that is
 *   routed and gets the header;
 * - "hand-over": a hop to another origin, or a 307 or 308 that would resend a
 *   body, is handed to the browser to follow, without the header.
 * Null when the answer is not a redirect.
 */
export function appRedirectPlan(input: {
  status: number;
  location: string | undefined;
  requestUrl: string;
  appUrl: string;
  method: string;
  resourceType: string;
}): { kind: "follow" | "stand-in"; url: string; method: string } | { kind: "hand-over" } | null {
  if (input.status < 300 || input.status >= 400 || !input.location) return null;
  let next: string;
  try {
    next = new URL(input.location, input.requestUrl).href;
  } catch {
    return { kind: "hand-over" };
  }
  if (!appHeaderApplies(next, input.appUrl)) return { kind: "hand-over" };
  const method = input.method.toUpperCase();
  // 303, and a POST answered 301 or 302, become a GET, as browsers do; 307 and 308 keep the method and its body.
  const nextMethod = input.status === 303 || ((input.status === 301 || input.status === 302) && method === "POST") ? "GET" : method;
  if (nextMethod !== "GET" && nextMethod !== "HEAD") return { kind: "hand-over" };
  return { kind: input.resourceType === "document" ? "stand-in" : "follow", url: next, method: nextMethod };
}

/** The page a page load's redirect within the app is answered with: it loads the next address itself, replacing itself in the history. */
export function redirectStandIn(url: string): string {
  // JSON.stringify, with "<" escaped, keeps the address a string inside the script whatever it holds.
  const literal = JSON.stringify(url).replace(/</g, "\\u003c");
  return `<!doctype html><meta name="referrer" content="no-referrer"><title>Redirecting</title><script>location.replace(${literal})</script>`;
}
