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
 * that is, SceneScout sends itself (route.fetch, with no redirect followed) and
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
  if (words.has("ETIMEDOUT")) return "timedout";
  if (message.includes("socket hang up")) return "connectionclosed";
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

/** The longest a page load's HEAD may take (never longer than the page-load limit): past it, nothing is learnt and the load goes as any other. */
export const APP_HEADER_HEAD_MS = 5000;

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
 * What a page load carrying the header is, learned by HEAD before any body is
 * read (SceneScout sends the header's requests itself, and its send reads the
 * whole answer, so a file would arrive whole before the browser saw it):
 * - "page": an HTML page, perhaps behind redirects within the app: sent with the header;
 * - "file": a download or a file shown as it is, perhaps behind redirects within
 *   the app: handed back to the browser without the header, so it behaves as with none;
 * - "unknown": HEAD is not answered (405, 501), or a redirect leaves the app:
 *   sent with the header as any other request.
 * `next` is the address of the hop to ask next, when the answer is a redirect within the app.
 */
export function headVerdict(input: {
  status: number;
  headers: Readonly<Record<string, string>>;
  requestUrl: string;
  appUrl: string;
}): { kind: "page" | "file" | "unknown" } | { kind: "next"; url: string } {
  if (input.status === 405 || input.status === 501) return { kind: "unknown" };
  if (input.status >= 300 && input.status < 400) {
    const plan = appRedirectPlan({ ...input, location: input.headers["location"], method: "GET", resourceType: "fetch" });
    return plan && plan.kind === "follow" ? { kind: "next", url: plan.url } : { kind: "unknown" };
  }
  return { kind: answersWithPage(input.headers) ? "page" : "file" };
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
