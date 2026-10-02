/**
 * Calling the app's own API with the UI bypassed.
 *
 * A refusal shown by hiding or disabling a button is not a refusal. Confirming
 * that the server refuses the same action is the single most valuable check a
 * permission pass makes, and until now it could only be done outside the tool
 * — in a shell, with curl and a hand-extracted token — so none of that
 * evidence reached the report. A whole validation run's permission matrices
 * lived in shell history and vanished with it.
 *
 * The request is made by the PAGE, not beside it. That matters twice over:
 * it goes through the same interception the write policy is enforced on, so a
 * safe-write session cannot delete a record it does not own by calling the
 * endpoint instead of clicking; and it carries the session's own credentials,
 * because it is the same origin with the same cookies.
 *
 * Bearer schemes are handled by replaying the Authorization header the app
 * itself last sent, which the engine already sees on every intercepted
 * request. Nothing here knows what a token looks like or where an app keeps
 * one, so nothing here is tuned to any app.
 *
 * Everything in this file is pure so it can be table-tested; the one
 * `page.evaluate` lives in browser.ts.
 */
import { redactSecrets } from "./memory.js";
import { POLICY_REFUSAL_HEADER } from "./policy.js";

/** Methods a session may replay. Anything else is refused before it reaches the page. */
export const REPLAYABLE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type ReplayMethod = (typeof REPLAYABLE_METHODS)[number];

/** Most of a response body that reaches the agent. A JSON list can be megabytes; the signature is in the first lines. */
export const BODY_MAX = 2000;
/** Most of a body one call can return when it asks for a part of it (`select`, or `offset`/`limit`). */
export const VIEW_MAX = 8000;
/** Most of a body the page hands back when a part of it was asked for: a select needs the whole document to parse. */
export const BODY_FETCH_MAX = 1_000_000;

/** Which part of a response body to return: one JSON value by path, and/or a window of characters. */
export interface BodyView {
  /** A dotted path into a JSON body, e.g. "stats.open" or "items.0.name" ("items[0].name" reads the same). */
  select?: string;
  /** The first character to return. */
  offset?: number;
  /** How many characters to return, at most VIEW_MAX. Default BODY_MAX. */
  limit?: number;
}

/** Whether a view asks for anything other than the default first BODY_MAX characters. */
export function wantsView(view: BodyView | undefined): view is BodyView {
  return !!view && (view.select !== undefined || view.offset !== undefined || view.limit !== undefined);
}

/** The steps of a select path: "a.b[0].c" and "a.b.0.c" are the same three-then-one steps. */
export function selectSteps(select: string): string[] {
  return select
    .trim()
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((step) => step !== "");
}

/**
 * The part of the body a view asks for, and the line that says what it is.
 * A select parses the body as JSON and returns the value at the path,
 * pretty-printed; a path that runs out says where and what keys were there
 * instead. offset/limit then take a window of that text (or of the raw body
 * with no select), and the note names the next offset when there is more.
 */
export function viewBody(text: string, full: number, view: BodyView): { body: string; note: string } {
  let source = text;
  let total = full;
  let what = "the body";
  if (view.select !== undefined) {
    if (full > text.length) {
      return {
        body: "",
        note: `select needs the whole body, and this one is ${full} characters, past the ${text.length} read. Page through it with offset and limit instead.`,
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { body: "", note: `select reads a JSON body, and this one is not JSON. Page through it with offset and limit instead.` };
    }
    const steps = selectSteps(view.select);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const here = steps.slice(0, i).join(".") || "the top level";
      if (Array.isArray(value)) {
        const index = /^\d+$/.test(step) ? Number(step) : Number.NaN;
        if (!(index < value.length))
          return { body: "", note: `select ${JSON.stringify(view.select)}: no item ${JSON.stringify(step)} at ${here}, which is a list of ${value.length}.` };
        value = value[index];
      } else if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(record, step)) {
          const keys = Object.keys(record);
          return {
            body: "",
            note: `select ${JSON.stringify(view.select)}: no key ${JSON.stringify(step)} at ${here}. Keys there: ${keys.slice(0, 40).join(", ")}${keys.length > 40 ? ` … +${keys.length - 40}` : ""}.`,
          };
        }
        value = record[step];
      } else {
        return {
          body: "",
          note: `select ${JSON.stringify(view.select)}: ${here} is ${value === null ? "null" : typeof value}, which has no ${JSON.stringify(step)}.`,
        };
      }
    }
    source = JSON.stringify(value, null, 2) ?? "undefined";
    total = source.length;
    what = `select ${JSON.stringify(view.select)}`;
  }
  const offset = Math.max(0, Math.floor(view.offset ?? 0));
  const limit = Math.min(VIEW_MAX, Math.max(1, Math.floor(view.limit ?? (view.select !== undefined && view.offset === undefined ? VIEW_MAX : BODY_MAX))));
  if (offset >= total && total > 0) return { body: "", note: `${what}: offset ${offset} is past its end (${total} characters).` };
  const end = Math.min(total, offset + limit);
  const body = source.slice(offset, end);
  const whole = offset === 0 && end === total;
  const note = whole
    ? `${what}: all ${total} characters`
    : `${what}: characters ${offset}–${end} of ${total}${end < total ? `; the next part is offset ${end}` : ""}`;
  return { body, note };
}
/** Response headers worth reporting. "Identical response" means status, body AND headers, so the ones that commonly differ are kept. */
export const REPORTED_HEADERS = ["content-type", "content-length", "location", "www-authenticate", "retry-after", "x-request-id", "cache-control"];

export interface ReplayResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  /** Set when a part of the body was asked for (BodyView): what part it is, in place of the truncation line. */
  view?: string;
  ms: number;
  url: string;
  /**
   * Set when the write policy answered in the server's place: the server never
   * received the request, so its status says nothing about what the server
   * enforces. Carries the policy's marker (`refused; mode=read-only`).
   */
  refusedByPolicy: string | null;
}

/**
 * Where a page, a crawl path, a plan step or a replayed call goes, given the
 * URL the session was attached on. One rule for every tool:
 *
 * - A path resolves against the attached ORIGIN, never the attach URL's path.
 *   `/widgets` is `/widgets` whether the session attached on `/` or on
 *   `/things`, as URL rules and every browser read it; a bare `widgets` is
 *   read as `/widgets` too, so the page the session happens to be on never
 *   changes where a target goes.
 * - A full URL on the attached origin is used as given.
 * - Anything on another origin, or a scheme other than http(s), is refused:
 *   a run attached to one app must not be able to make its browser talk to
 *   another host just because a target was spelled as a full URL.
 *
 * `offOrigin` marks the refusal that is the fence, so a caller can word it as one.
 */
export function resolveTarget(attachUrl: string, target: string): { url: string } | { problem: string; offOrigin: boolean } {
  const trimmed = target.trim();
  if (!trimmed) return { problem: "No path given. Pass a path such as /api/things, or a full URL on the attached origin.", offOrigin: false };
  let resolved: URL;
  let origin: string;
  try {
    origin = new URL(attachUrl).origin;
    resolved = new URL(trimmed, `${origin}/`);
  } catch {
    return { problem: `Could not read ${JSON.stringify(trimmed)} as a path or a URL.`, offOrigin: false };
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return { problem: `Only http and https can be reached; ${resolved.protocol} cannot.`, offOrigin: false };
  }
  if (resolved.origin !== origin) {
    return {
      problem: `${resolved.origin} is not the origin this session is attached to (${origin}). A session talks to its own app only; attach another session to test another host.`,
      offOrigin: true,
    };
  }
  return { url: resolved.toString() };
}

/** The URL scout_request calls: resolveTarget's rule, so a call and a page load never disagree on where a path goes. */
export function resolveRequestUrl(attachUrl: string, path: string): { url: string } | { problem: string } {
  const out = resolveTarget(attachUrl, path);
  return "url" in out ? out : { problem: out.problem };
}

/** The method, upper-cased, or the reason it cannot be replayed. */
export function resolveMethod(method: string | undefined): { method: ReplayMethod } | { problem: string } {
  const upper = (method ?? "GET").trim().toUpperCase();
  if (!(REPLAYABLE_METHODS as readonly string[]).includes(upper)) {
    return { problem: `${upper} is not a method this can replay. Use one of: ${REPLAYABLE_METHODS.join(", ")}.` };
  }
  return { method: upper as ReplayMethod };
}

/**
 * The script the page runs. Built as one expression so it can be evaluated
 * directly, with every value passed through JSON rather than interpolated as
 * code: a header value or a body is data from the agent, and a quote in it
 * must not be able to end the string it sits in.
 *
 * `credentials: "include"` so the session's cookies go with it, and the
 * app's own Authorization header is replayed when one has been seen.
 */
export function buildRequestScript(input: { url: string; method: ReplayMethod; body?: string; headers: Record<string, string>; keep?: number }): string {
  const { url, method, body, headers } = input;
  const keep = input.keep ?? BODY_MAX * 2;
  const init: Record<string, unknown> = { method, credentials: "include", headers };
  if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = body;
  return (
    `(async () => { const started = Date.now();` +
    ` const res = await fetch(${JSON.stringify(url)}, ${JSON.stringify(init)});` +
    ` const text = await res.text();` +
    ` const headers = {}; res.headers.forEach((v, k) => { headers[k] = v; });` +
    ` return { status: res.status, statusText: res.statusText, headers, body: text.slice(0, ${keep}), full: text.length, ms: Date.now() - started, url: res.url }; })()`
  );
}

/** The headers to send: what the caller asked for, plus the app's own auth and a JSON content type when a body is present. */
export function requestHeaders(input: { given?: Record<string, string>; auth?: string | null; body?: string }): Record<string, string> {
  const out: Record<string, string> = {};
  // The app's own header first, so an explicit one from the caller wins — that
  // is how a session tests what happens with a different or absent credential.
  if (input.auth) out["authorization"] = input.auth;
  if (input.body !== undefined) out["content-type"] = "application/json";
  for (const [name, value] of Object.entries(input.given ?? {})) out[name.toLowerCase()] = value;
  return out;
}

/**
 * The Authorization header to remember from a request the browser is sending,
 * or null to leave the remembered one as it is. Every request the app sends to
 * its own origin counts, reads included: an app that rotates its access token
 * and then only reads would otherwise leave scout_request replaying the token
 * of its last write, long expired. A request to another origin, or one sent
 * from a frame of another origin, is skipped, so an embedded widget's bearer
 * token is never replayed to the app; and so is a scout_request call's own
 * request, so a credential the caller chose for one call does not become the
 * session's. `frameUrl` is the sending frame's address, when it has one (a
 * worker's request has none; about:blank and the like count as the app's).
 */
export function authToRemember(input: { url: string; baseUrl: string; headers: Record<string, string>; replay: boolean; frameUrl?: string }): string | null {
  if (input.replay) return null;
  try {
    const origin = new URL(input.baseUrl).origin;
    if (new URL(input.url).origin !== origin) return null;
    if (input.frameUrl && /^https?:/i.test(input.frameUrl) && new URL(input.frameUrl).origin !== origin) return null;
  } catch {
    return null;
  }
  const entry = Object.entries(input.headers).find(([name]) => name.toLowerCase() === "authorization");
  const value = entry?.[1];
  return value && value.trim() ? value : null;
}

/**
 * A line for a replay the server answered 401 while the page's own latest
 * authorised request to the origin succeeded: the replayed credential is the
 * likely cause, not the server's permissions. Empty otherwise. Statuses only,
 * never the credential.
 */
export function staleCredentialNote(replayStatus: number, sentAuth: boolean, pageLast: { status: number } | null): string {
  if (replayStatus !== 401 || !sentAuth || !pageLast || pageLast.status < 200 || pageLast.status >= 300) return "";
  return (
    `\n⚠ The page's own latest authorised request to this origin got ${pageLast.status}, but this call got 401: ` +
    `the replayed credential may be stale. Load a page that calls the API, then call again before reading this as a permission or sign-in problem.`
  );
}

/** The raw result of the in-page fetch, reduced to what the agent and the report need. */
export function toReplayResult(
  raw: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    full: number;
    ms: number;
    url: string;
  },
  view?: BodyView,
): ReplayResult {
  const kept: Record<string, string> = {};
  for (const name of REPORTED_HEADERS) {
    const value = raw.headers[name];
    if (value !== undefined) kept[name] = value;
  }
  const part = wantsView(view) ? viewBody(raw.body, raw.full, view) : null;
  return {
    status: raw.status,
    statusText: raw.statusText,
    headers: kept,
    body: part ? part.body : raw.body.slice(0, BODY_MAX),
    truncated: part ? false : raw.full > BODY_MAX,
    ...(part ? { view: part.note } : {}),
    ms: raw.ms,
    url: raw.url,
    refusedByPolicy: raw.headers[POLICY_REFUSAL_HEADER] ?? null,
  };
}

/** The signature a finding carries for this call: the line that dedups the same refusal across runs. */
export function replaySignature(method: ReplayMethod, url: string, status: number): string {
  let path = url;
  try {
    const parsed = new URL(url);
    path = parsed.pathname + parsed.search;
  } catch {
    // Not a URL we can shorten; the whole string is the signature.
  }
  return `${method} ${path} ${status}`;
}

/**
 * What the agent reads back. Leads with the signature, because that is what a
 * finding quotes — except when the write policy answered, where there is no
 * server signature to quote. Printing the stand-in's 403 as one would read as
 * the server enforcing a permission it was never asked about.
 */
export function formatReplay(method: ReplayMethod, result: ReplayResult): string {
  if (result.refusedByPolicy) {
    const path = replaySignature(method, result.url, result.status).replace(/ \d+$/, "");
    return (
      `REFUSED by the write policy (${result.refusedByPolicy}): ${path} never reached the server.\n` +
      `This is the engine's safety net, not the server's answer, so it says nothing about whether the server enforces this rule. ` +
      `To test that, re-attach in a mode that allows the request on a record this session owns, or leave it out of the finding.`
    );
  }
  const lines = [replaySignature(method, result.url, result.status) + (result.statusText ? ` ${result.statusText}` : ""), `took ${result.ms} ms`];
  const headers = Object.entries(result.headers);
  if (headers.length > 0) lines.push(headers.map(([k, v]) => `${k}: ${v}`).join(" · "));
  if (result.view !== undefined) {
    lines.push(`(${result.view})`, "", result.body.length > 0 ? result.body : "(nothing here)");
  } else if (result.body.length > 0) {
    lines.push(
      "",
      result.body +
        (result.truncated
          ? `\n… truncated at ${BODY_MAX} characters — pass offset:${BODY_MAX} for the next part, or select:"a.b" for one value of a JSON body`
          : ""),
    );
  } else {
    lines.push("", "(empty body)");
  }
  return lines.join("\n");
}

// ── the requests a page made since it loaded (scout_network) ────────────────

/** One data request the driven page made. */
export interface PageRequest {
  method: string;
  /** The URL as requested, redacted when listed (formatPageRequests). */
  url: string;
  /** Milliseconds since the page loaded. */
  atMs: number;
  /** The page's route when it was sent: a client-side route change does not load a new page. */
  route: string;
  status?: number;
  /** How long it took to answer or fail. */
  ms?: number;
  /** The browser's reason, when it failed without an answer. */
  failed?: string;
  /** The write policy answered or stopped it: the server never saw it. */
  refused?: boolean;
  /** Sent by scout_request, not by the page's own code. */
  replay?: boolean;
}

/**
 * The data requests (fetch and XHR) the driven page made since its document
 * loaded, newest last. A page that shows its empty state on a client-side tab
 * switch while the API has data leaves two explanations — the list request
 * failed, or it never ran — and only this tells them apart. A new document
 * starts a new list; a client-side route change does not, so each entry
 * keeps the route it was sent from. Bounded: past MAX the oldest go, and the
 * listing says how many.
 */
export class PageRequests {
  static readonly MAX = 300;
  private loadedAt = 0;
  private loadedUrl = "";
  private entries: PageRequest[] = [];
  private dropped = 0;
  private readonly byRequest = new WeakMap<object, PageRequest>();

  /** A new document began loading: the list starts again. */
  loaded(url: string, at: number): void {
    this.loadedAt = at;
    this.loadedUrl = url;
    this.entries = [];
    this.dropped = 0;
  }

  started(key: object, r: { method: string; url: string; route: string; at: number }): void {
    const entry: PageRequest = { method: r.method, url: r.url, route: r.route, atMs: Math.max(0, r.at - this.loadedAt) };
    this.byRequest.set(key, entry);
    this.entries.push(entry);
    if (this.entries.length > PageRequests.MAX) {
      this.entries.shift();
      this.dropped += 1;
    }
  }

  answered(key: object, status: number, at: number, refused: boolean): void {
    const entry = this.byRequest.get(key);
    if (!entry || entry.status !== undefined) return;
    entry.status = status;
    entry.ms = Math.max(0, at - this.loadedAt - entry.atMs);
    if (refused) entry.refused = true;
  }

  failed(key: object, reason: string, at: number, refused: boolean): void {
    const entry = this.byRequest.get(key);
    if (!entry || entry.status !== undefined) return;
    entry.failed = reason || "failed";
    entry.ms = Math.max(0, at - this.loadedAt - entry.atMs);
    if (refused) entry.refused = true;
  }

  /** Label the latest request to this URL as scout_request's own call. */
  markReplay(method: string, url: string): void {
    const entry = [...this.entries].reverse().find((e) => e.method === method && e.url === url && !e.replay);
    if (entry) entry.replay = true;
  }

  get snapshot(): { loadedUrl: string; loadedAt: number; entries: readonly PageRequest[]; dropped: number } {
    return { loadedUrl: this.loadedUrl, loadedAt: this.loadedAt, entries: this.entries, dropped: this.dropped };
  }
}

/** Most entries one listing prints by default, and at most. */
export const PAGE_REQUESTS_SHOWN = 40;
export const PAGE_REQUESTS_SHOWN_MAX = 200;

/**
 * Query parameters whose value is a credential by its name, whatever the
 * value looks like: `access_token`, `client_secret`, a signed URL's
 * `X-Amz-Signature`, a one-time `code`.
 */
const SECRET_PARAM_RE = /token|secret|sig(nature)?$|^sig|password|passwd|api[-_]?key|^key$|auth|credential|session|^code$|otp/i;

/**
 * A request's address as the listing prints it: the path on the page's
 * origin, the whole URL elsewhere. A query parameter named like a
 * credential has its value replaced before anything else, then the rest
 * passes the same redaction as an oracle's violation; it is cut only after.
 */
export function shownUrl(url: string, origin: string): string {
  let shown = url;
  try {
    const u = new URL(url);
    let hidden = 0;
    for (const name of [...new Set(u.searchParams.keys())]) {
      if (SECRET_PARAM_RE.test(name)) {
        u.searchParams.set(name, "redacted");
        hidden += 1;
      }
    }
    const search = hidden > 0 ? u.search.replace(/=redacted\b/g, "=[redacted]") : u.search;
    shown = (u.origin === origin ? "" : u.origin) + u.pathname + search;
  } catch {
    // Not a URL we can shorten; shown whole, and redacted below.
  }
  const redacted = redactSecrets(shown);
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
}

/**
 * The listing scout_network returns: one line per request, oldest first, the
 * newest `limit` of them, optionally only those whose address contains a
 * string. Query values that look like credentials are redacted the way an
 * oracle's violation is, because the listing is printed and may be quoted in
 * a finding.
 */
export function formatPageRequests(
  log: { loadedUrl: string; loadedAt: number; entries: readonly PageRequest[]; dropped: number },
  opts: { now: number; limit?: number; contains?: string },
): string {
  if (!log.loadedUrl) return "No page has loaded in this session yet: navigate first.";
  let origin = "";
  let loadedRoute = log.loadedUrl;
  try {
    const u = new URL(log.loadedUrl);
    origin = u.origin;
    loadedRoute = u.pathname;
  } catch {
    // Kept as given.
  }
  const limit = Math.min(PAGE_REQUESTS_SHOWN_MAX, Math.max(1, Math.floor(opts.limit ?? PAGE_REQUESTS_SHOWN)));
  const needle = opts.contains?.trim().toLowerCase() ?? "";
  const matching = log.entries.filter((e) => !needle || shownUrl(e.url, origin).toLowerCase().includes(needle));
  const shown = matching.slice(-limit);
  const ago = Math.max(0, Math.round((opts.now - log.loadedAt) / 1000));
  const head =
    `DATA REQUESTS (fetch/XHR) since this page loaded — ${shownUrl(log.loadedUrl, origin)}, ${ago}s ago: ` +
    `${matching.length}${needle ? ` matching ${JSON.stringify(opts.contains)}` : ""}` +
    (shown.length < matching.length ? `, the newest ${shown.length} shown` : "") +
    (log.dropped > 0 ? ` (${log.dropped} older ones no longer kept)` : "");
  if (shown.length === 0) {
    return `${head}.\nNone${needle ? " matching" : ""}: if the page shows data it fetched, it fetched it before this load or without fetch/XHR (a server-rendered page, a WebSocket).`;
  }
  const lines = shown.map((e) => {
    const outcome =
      e.status !== undefined
        ? `${e.status}${e.ms !== undefined ? ` · ${e.ms} ms` : ""}`
        : e.failed !== undefined
          ? `failed: ${e.failed}`
          : "pending (no answer yet)";
    const notes = [
      e.refused ? "refused by the write policy, never reached the server" : "",
      e.replay ? "sent by scout_request" : "",
      e.route && e.route !== loadedRoute ? `on ${e.route}` : "",
    ].filter(Boolean);
    return `  +${(e.atMs / 1000).toFixed(1)}s ${e.method} ${shownUrl(e.url, origin)} → ${outcome}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  });
  return [`${head}:`, ...lines].join("\n");
}
