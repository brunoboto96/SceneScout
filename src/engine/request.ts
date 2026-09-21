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

/** Methods a session may replay. Anything else is refused before it reaches the page. */
export const REPLAYABLE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type ReplayMethod = (typeof REPLAYABLE_METHODS)[number];

/** Most of a response body that reaches the agent. A JSON list can be megabytes; the signature is in the first lines. */
export const BODY_MAX = 2000;
/** Response headers worth reporting. "Identical response" means status, body AND headers, so the ones that commonly differ are kept. */
export const REPORTED_HEADERS = ["content-type", "content-length", "location", "www-authenticate", "retry-after", "x-request-id", "cache-control"];

export interface ReplayResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  ms: number;
  url: string;
}

/**
 * The path to call, resolved against the attached origin and fenced to it.
 * Navigation is fenced the same way: a run attached to one app must not be
 * able to make its browser talk to another host just because a path was
 * spelled as a full URL.
 */
export function resolveRequestUrl(baseUrl: string, path: string): { url: string } | { problem: string } {
  const trimmed = path.trim();
  if (!trimmed) return { problem: "No path given. Pass a path such as /api/things, or a full URL on the attached origin." };
  let target: URL;
  let base: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(trimmed, base);
  } catch {
    return { problem: `Could not read ${JSON.stringify(trimmed)} as a path or a URL.` };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { problem: `Only http and https can be requested; ${target.protocol} cannot.` };
  }
  if (target.origin !== base.origin) {
    return {
      problem: `${target.origin} is not the origin this session is attached to (${base.origin}). A session talks to its own app only; attach another session to test another host.`,
    };
  }
  return { url: target.toString() };
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
export function buildRequestScript(input: { url: string; method: ReplayMethod; body?: string; headers: Record<string, string> }): string {
  const { url, method, body, headers } = input;
  const init: Record<string, unknown> = { method, credentials: "include", headers };
  if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = body;
  return (
    `(async () => { const started = Date.now();` +
    ` const res = await fetch(${JSON.stringify(url)}, ${JSON.stringify(init)});` +
    ` const text = await res.text();` +
    ` const headers = {}; res.headers.forEach((v, k) => { headers[k] = v; });` +
    ` return { status: res.status, statusText: res.statusText, headers, body: text.slice(0, ${BODY_MAX * 2}), full: text.length, ms: Date.now() - started, url: res.url }; })()`
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

/** The raw result of the in-page fetch, reduced to what the agent and the report need. */
export function toReplayResult(raw: {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  full: number;
  ms: number;
  url: string;
}): ReplayResult {
  const kept: Record<string, string> = {};
  for (const name of REPORTED_HEADERS) {
    const value = raw.headers[name];
    if (value !== undefined) kept[name] = value;
  }
  return {
    status: raw.status,
    statusText: raw.statusText,
    headers: kept,
    body: raw.body.slice(0, BODY_MAX),
    truncated: raw.full > BODY_MAX,
    ms: raw.ms,
    url: raw.url,
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

/** What the agent reads back. Leads with the signature, because that is what a finding quotes. */
export function formatReplay(method: ReplayMethod, result: ReplayResult): string {
  const lines = [replaySignature(method, result.url, result.status) + (result.statusText ? ` ${result.statusText}` : ""), `took ${result.ms} ms`];
  const headers = Object.entries(result.headers);
  if (headers.length > 0) lines.push(headers.map(([k, v]) => `${k}: ${v}`).join(" · "));
  if (result.body.length > 0) {
    lines.push("", result.body + (result.truncated ? `\n… truncated at ${BODY_MAX} characters` : ""));
  } else {
    lines.push("", "(empty body)");
  }
  return lines.join("\n");
}
