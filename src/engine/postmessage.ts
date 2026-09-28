/**
 * The postMessage-token oracle: a page that calls `postMessage` with
 * targetOrigin "*" and a message carrying a credential.
 *
 * targetOrigin is the sender's statement of who may read the message. "*"
 * means anyone: the message is delivered to whatever document the target
 * window holds at that moment, which may be an opener or frame that has
 * navigated to another site, or an embed of another site to begin with. A
 * token in such a message is handed to that site. Naming the intended origin
 * (or "/" for the sender's own) makes the browser drop the message instead.
 *
 * What counts as token-shaped (`tokenShapeOf`), on any string in the message,
 * however deeply nested, and inside a string that is itself JSON:
 *
 * - `jwt`: a whole value of three base64url parts whose first two begin
 *   `eyJ` (base64 of `{"`), the header and claims of a JSON Web Token. The
 *   signature part may be empty (an unsigned token is still a bearer
 *   credential).
 * - `bearer`: a whole value `Bearer <opaque>`, as an Authorization header
 *   carries it.
 * - `credential-key`: a value under a key that names a credential
 *   (`CREDENTIAL_KEYS`: access_token, id_token, refresh_token, api_key and
 *   the like, in any case and with or without `_`/`-`) that looks opaque:
 *   20 or more URL-safe characters with at least one letter and one digit.
 *   `token_type: "Bearer"` or `token: "pending"` is not one.
 * - `url-param`: a string with an `access_token=`, `id_token=` or
 *   `refresh_token=` parameter of 16 or more characters, the shape an
 *   implicit-flow redirect URL or fragment has.
 *
 * The value itself is never kept or reported. A finding names the path to it
 * inside the message (`data.auth.access_token`), its shape, and a masked
 * preview: its first four characters and its length, which identify the
 * token to someone who has it and give nothing to someone who does not.
 *
 * Capture is an init script (`postMessageCaptureScript`) that wraps
 * `window.postMessage` in every frame and hands the engine the message's
 * longer strings only when targetOrigin is "*". Two limits follow from how
 * browsers work, not from a choice: a call made on a window of another origin
 * (`iframe.contentWindow.postMessage(...)` into an embed of another site)
 * goes through the browser's cross-origin wrapper, which no page script can
 * replace, so it is not seen; and `MessagePort.postMessage` takes no
 * targetOrigin, so it is out of scope. What is seen is a call on the
 * sender's own window or on a same-origin one (an opener, a parent, a frame),
 * which is where the "*" is written, and the defect is that line of code.
 *
 * No browser is needed for these rules, so they are table-tested in
 * oracle-test; browser.ts installs the script and reports what it hands back.
 */
import { normalizePath } from "./fingerprint.js";

/** The binding the capture script reports through. */
export const POSTMESSAGE_BINDING = "__scenescoutPostMessage";

/** Strings shorter than this are not sent to the engine: nothing token-shaped is shorter. */
export const MIN_CANDIDATE_LENGTH = 16;
/** Longest string sent; a JWT carrying many claims runs to a few kilobytes. */
export const MAX_CANDIDATE_LENGTH = 8192;
/** Longest JSON-looking string sent whole, so the engine can parse it; a longer one is cut and its contents go unread. */
export const MAX_JSON_LENGTH = 262144;
/** Most values the walk visits per message: a large array or a binary buffer must not stall the app's call. */
export const MAX_VISITS = 2000;
/** Most items read from any one array or object. */
export const MAX_ITEMS = 200;
/** Most strings sent per message, and the deepest nesting walked. */
export const MAX_CANDIDATES = 50;
export const MAX_DEPTH = 6;

/** Whether a targetOrigin lets any origin read the message. Only "*" does; "/" is the sender's own origin. */
export function postsToAnyOrigin(targetOrigin: unknown): boolean {
  return targetOrigin === "*";
}

/**
 * The script run in every frame before the page's own scripts. It replaces
 * `window.postMessage` with a wrapper that, when targetOrigin is "*", walks
 * the message for strings of MIN_CANDIDATE_LENGTH or more and hands them,
 * each with its path, to the binding; then it calls the original with the
 * same arguments, whatever happened before. The walk skips binary buffers
 * and stops after MAX_VISITS values and MAX_ITEMS entries of any one array or object, so a large message costs the app little. Both call forms are read:
 * `postMessage(msg, origin)` and `postMessage(msg, { targetOrigin })`, whose
 * default is "/".
 *
 * Failures in the wrapper are swallowed on purpose: the app's call must go
 * through exactly as it would without SceneScout, and a capture error must
 * never be reported as the app's own page error.
 */
export function postMessageCaptureScript(binding = POSTMESSAGE_BINDING): string {
  return `(() => {
  const W = window;
  const orig = W.postMessage;
  if (typeof orig !== "function" || orig.__scenescoutWrapped) return;
  const NAME = ${JSON.stringify(binding)};
  const MIN = ${MIN_CANDIDATE_LENGTH}, LEN = ${MAX_CANDIDATE_LENGTH}, JSON_LEN = ${MAX_JSON_LENGTH}, MAX = ${MAX_CANDIDATES}, DEPTH = ${MAX_DEPTH}, VISITS = ${MAX_VISITS}, ITEMS = ${MAX_ITEMS};
  const collect = (data) => {
    const out = [];
    const seen = new Set();
    let visits = 0;
    const walk = (v, path, depth) => {
      if (out.length >= MAX || ++visits > VISITS) return;
      if (typeof v === "string") {
        if (v.length >= MIN) out.push([path, v.slice(0, /^\s*[{[]/.test(v) ? JSON_LEN : LEN)]);
        return;
      }
      if (!v || typeof v !== "object" || depth >= DEPTH || seen.has(v)) return;
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return;
      seen.add(v);
      const isArray = Array.isArray(v);
      let keys;
      try { keys = isArray ? Array.from({ length: Math.min(v.length, ITEMS) }, (_, i) => i) : Object.keys(v).slice(0, ITEMS); } catch (e) { return; }
      for (const k of keys) {
        let child;
        try { child = v[k]; } catch (e) { continue; }
        walk(child, isArray ? path + "[" + k + "]" : path + "." + k, depth + 1);
        if (out.length >= MAX) return;
      }
    };
    walk(data, "data", 0);
    return out;
  };
  const wrapped = function postMessage(message, targetOrigin) {
    try {
      const origin = typeof targetOrigin === "string"
        ? targetOrigin
        : targetOrigin && typeof targetOrigin === "object" && targetOrigin.targetOrigin !== undefined
          ? String(targetOrigin.targetOrigin)
          : "/";
      const report = W[NAME];
      if (origin === "*" && typeof report === "function") {
        const found = collect(message);
        if (found.length > 0) {
          const sent = report(found);
          // A report that fails must not become an unhandled rejection the page oracle files against the app.
          if (sent && typeof sent.then === "function") sent.then(undefined, () => undefined);
        }
      }
    } catch (e) {
      // The capture is ours; the app's call below must run as it would without it.
    }
    return orig.apply(this, arguments);
  };
  Object.defineProperty(wrapped, "__scenescoutWrapped", { value: true });
  W.postMessage = wrapped;
})();`;
}

export type TokenShape = "jwt" | "bearer" | "credential-key" | "url-param";

/** One token-shaped value found in a message: where it was and what it looked like, never the value. */
export interface TokenHit {
  path: string;
  shape: TokenShape;
  /** The first four characters and the length: `"eyJh…" (212 chars)`. */
  preview: string;
}

/** Key names, lower-cased with `_` and `-` removed, whose value is a credential. */
export const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "accesstoken",
  "idtoken",
  "refreshtoken",
  "authtoken",
  "sessiontoken",
  "bearertoken",
  "apitoken",
  "apikey",
  "clientsecret",
  "token",
  "jwt",
]);

const JWT_RE = /^eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*$/;
const BEARER_RE = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,})$/i;
const OPAQUE_RE = /^[A-Za-z0-9._~+/=-]{20,}$/;
const URL_PARAM_RE = /(?:^|[?#&])(?:access_token|id_token|refresh_token)=([^&#\s]{16,})/;
/** Paths are page text; cut so a hostile message cannot fill the report. */
const MAX_PATH_LENGTH = 120;

/** The last key of a path such as `data.auth.access_token` or `data.list[0]`. */
function lastKey(path: string): string {
  const m = /(?:\.([^.[\]]+)|\[[^\]]*\])$/.exec(path);
  return m?.[1] ?? "";
}

function isOpaque(value: string): boolean {
  return OPAQUE_RE.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

/** Masked preview of a credential: its first four characters and its length. Nothing past the fourth character is ever included. */
export function maskToken(value: string): string {
  return `"${value.slice(0, 4)}…" (${value.length} chars)`;
}

/**
 * The shape of one string at one path, with the part that is the credential
 * (so the preview is of the token, not of a `Bearer ` prefix), or null when
 * it is not token-shaped.
 */
export function tokenShapeOf(path: string, raw: string): { shape: TokenShape; secret: string } | null {
  const value = raw.trim();
  if (JWT_RE.test(value)) return { shape: "jwt", secret: value };
  const bearer = BEARER_RE.exec(value);
  if (bearer) return { shape: "bearer", secret: bearer[1] };
  if (CREDENTIAL_KEYS.has(lastKey(path).toLowerCase().replace(/[_-]/g, "")) && isOpaque(value)) return { shape: "credential-key", secret: value };
  const param = URL_PARAM_RE.exec(value);
  if (param) return { shape: "url-param", secret: param[1] };
  return null;
}

/** A string message that is itself JSON (`postMessage(JSON.stringify({...}), "*")`), walked like an object would be. */
function jsonStrings(path: string, value: string): Array<[string, string]> {
  const t = value.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    // Not JSON after all: the string was already judged as it is.
    return [];
  }
  const out: Array<[string, string]> = [];
  const walk = (v: unknown, p: string, depth: number): void => {
    if (out.length >= MAX_CANDIDATES) return;
    if (typeof v === "string") {
      if (v.length >= MIN_CANDIDATE_LENGTH) out.push([p, v]);
      return;
    }
    if (!v || typeof v !== "object" || depth >= MAX_DEPTH) return;
    if (Array.isArray(v)) v.forEach((c, i) => walk(c, `${p}[${i}]`, depth + 1));
    else for (const [k, c] of Object.entries(v)) walk(c, `${p}.${k}`, depth + 1);
  };
  walk(parsed, `${path}(json)`, 0);
  return out;
}

/**
 * The token-shaped values among what the capture script handed back. Entries
 * come from the page, so anything not a `[path, string]` pair is skipped.
 * One hit per path; the values are discarded here.
 */
export function tokenHits(entries: unknown): TokenHit[] {
  if (!Array.isArray(entries)) return [];
  const out: TokenHit[] = [];
  const seen = new Set<string>();
  const judge = (path: string, value: string): void => {
    const found = tokenShapeOf(path, value);
    const shown = path.slice(0, MAX_PATH_LENGTH);
    if (!found || seen.has(shown)) return;
    seen.add(shown);
    out.push({ path: shown, shape: found.shape, preview: maskToken(found.secret) });
  };
  for (const entry of entries.slice(0, MAX_CANDIDATES)) {
    // The page cuts strings itself; a page that does not (a spoofed call) is cut here to the same bounds.
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
    const [path, raw] = entry as [string, string];
    const value = raw.slice(0, MAX_JSON_LENGTH);
    judge(path, value);
    for (const [p, v] of jsonStrings(path, value)) judge(p, v);
  }
  return out;
}

function routeOf(url: string): string {
  try {
    return normalizePath(new URL(url).pathname);
  } catch {
    return url || "?";
  }
}

/** One report per route, receiving frame, path and shape, so a page that posts on every render is reported once. */
export function tokenPostKey(hit: TokenHit, pageUrl: string, frameUrl: string): string {
  let frameOrigin = "";
  try {
    frameOrigin = new URL(frameUrl).origin;
  } catch {
    frameOrigin = "?";
  }
  return `${routeOf(pageUrl)}|${frameOrigin}|${hit.path}|${hit.shape}`;
}

/**
 * The violation's detail. The shape and path come first because the oracle
 * log signs a violation on its first characters: two tokens posted by one
 * page must not read as one.
 */
export function describeTokenPost(hit: TokenHit, frameUrl: string): string {
  return (
    `${hit.shape} token at ${hit.path} (${hit.preview}) posted with targetOrigin "*" to the window of ${routeOf(frameUrl)} — ` +
    `any origin that window holds (an opener or frame that navigated elsewhere, another site's embed) receives the credential; name the intended origin instead`
  );
}
