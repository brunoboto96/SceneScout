/**
 * Whether a failed request failed on the network (the runner could not reach a
 * host) rather than in the app (#554). A network failure is one of four causes
 * that leave no HTTP answer at all: the name did not resolve, the connection
 * was refused or dropped, nothing answered in time, or the TLS handshake
 * failed. An HTTP status, however bad, is always an answer from the server,
 * and never one of these.
 *
 * Two readers share the four causes:
 * - `networkCause` reads a Node error (what `fetch` throws), for the preflight
 *   and SceneScout's own HTTP clients;
 * - `browserNetworkCause` reads a browser's error text (Chromium's `net::ERR_*`,
 *   Firefox's `NS_ERROR_*` and NSS codes, WebKit's sentences), for a page load
 *   or a request a page made during a run.
 *
 * Neither uses a regular expression: the browser's text may carry the address
 * that failed, which is the app's, so each reads only the code the text starts
 * with. The rules are table-tested in check-test.
 */

/** The network causes a request can fail with before any HTTP answer. */
export type NetworkCause = "dns" | "connection" | "timeout" | "tls";

export const NETWORK_CAUSES: readonly NetworkCause[] = ["dns", "connection", "timeout", "tls"];

// ── Node's errors ───────────────────────────────────────────────────────────

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "EAI_NONAME", "EAI_FAIL"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "HOSTNAME_MISMATCH",
  "EPROTO",
]);

/** The code given to a port the Fetch standard blocks (6000, 6667 and others), which no browser will load either. */
export const BLOCKED_PORT = "blocked port";

/** An error's code, its name, and the errors behind it (`cause`, and an AggregateError's `errors`, which a connection tried on several addresses throws). */
export function errorParts(err: unknown): { code?: string; name?: string; message?: string; inner: unknown[] } {
  if (!err || typeof err !== "object") return { inner: [] };
  const e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    name: typeof e.name === "string" ? e.name : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
    inner: [...(e.cause !== undefined ? [e.cause] : []), ...(Array.isArray(e.errors) ? e.errors : [])],
  };
}

/** The cause one code or name stands for, or null when it names none. */
function causeOf(code: string | undefined, name: string | undefined): NetworkCause | null {
  // AbortSignal.timeout ends the request with a TimeoutError; the only abort here is that one.
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (!code) return null;
  if (DNS_CODES.has(code)) return "dns";
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (TLS_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) return "tls";
  return null;
}

/**
 * Why a request got no HTTP answer: the first cause found walking the error and
 * the errors behind it (Node's fetch says only "fetch failed" and keeps the
 * reason in `cause`). A failure that names no known cause is a connection that
 * failed, with whatever code it carried.
 */
export function networkCause(err: unknown): { cause: NetworkCause; code: string } {
  const queue: unknown[] = [err];
  let firstCode: string | undefined;
  for (let seen = 0; queue.length > 0 && seen < 20; seen++) {
    const parts = errorParts(queue.shift());
    // Fetch, as a browser does, refuses a port on the Fetch standard's blocked list before connecting, and names no code.
    if (parts.message === "bad port") return { cause: "connection", code: BLOCKED_PORT };
    const cause = causeOf(parts.code, parts.name);
    if (cause) return { cause, code: parts.code ?? parts.name ?? "" };
    if (parts.code && !firstCode) firstCode = parts.code;
    queue.push(...parts.inner);
  }
  return { cause: "connection", code: firstCode ?? "no code" };
}

/**
 * Why a request of SceneScout's own (the model's API, a tracker) failed, as
 * text: Node's fetch says only "fetch failed" and keeps the reason in `cause`,
 * so the cause's code and message are added. Not cut to one line: each
 * caller does that with its own bound.
 */
export function fetchFailureCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause : null;
  const code = cause && typeof (cause as NodeJS.ErrnoException).code === "string" ? `${(cause as NodeJS.ErrnoException).code} ` : "";
  return cause ? `${err.message}: ${code}${cause.message}` : err.message;
}

// ── a browser's errors ──────────────────────────────────────────────────────

/** Chromium's codes (without `net::`), by cause. */
const CHROMIUM: Record<string, NetworkCause> = {
  ERR_NAME_NOT_RESOLVED: "dns",
  ERR_NAME_RESOLUTION_FAILED: "dns",
  ERR_DNS_TIMED_OUT: "dns",
  ERR_CONNECTION_REFUSED: "connection",
  ERR_CONNECTION_RESET: "connection",
  ERR_CONNECTION_CLOSED: "connection",
  ERR_CONNECTION_ABORTED: "connection",
  ERR_CONNECTION_FAILED: "connection",
  ERR_EMPTY_RESPONSE: "connection",
  ERR_ADDRESS_UNREACHABLE: "connection",
  ERR_INTERNET_DISCONNECTED: "connection",
  ERR_NETWORK_CHANGED: "connection",
  ERR_NETWORK_ACCESS_DENIED: "connection",
  ERR_SOCKET_NOT_CONNECTED: "connection",
  ERR_NO_BUFFER_SPACE: "connection",
  ERR_PROXY_CONNECTION_FAILED: "connection",
  ERR_TUNNEL_CONNECTION_FAILED: "connection",
  ERR_TIMED_OUT: "timeout",
  ERR_CONNECTION_TIMED_OUT: "timeout",
  ERR_BAD_SSL_CLIENT_AUTH_CERT: "tls",
};

/** Firefox's codes, by cause. NSS's own (`SSL_ERROR_*`, `SEC_ERROR_*`, `MOZILLA_PKIX_ERROR_*`) are all TLS. */
const FIREFOX: Record<string, NetworkCause> = {
  NS_ERROR_UNKNOWN_HOST: "dns",
  NS_ERROR_CONNECTION_REFUSED: "connection",
  NS_ERROR_NET_RESET: "connection",
  NS_ERROR_NET_INTERRUPT: "connection",
  NS_ERROR_NET_EMPTY_RESPONSE: "connection",
  NS_ERROR_OFFLINE: "connection",
  NS_ERROR_PROXY_CONNECTION_REFUSED: "connection",
  NS_ERROR_UNKNOWN_PROXY_HOST: "connection",
  NS_ERROR_NET_TIMEOUT: "timeout",
};

/** WebKit's sentences, by how they start: its own on macOS, its network library's on Linux and Windows. */
const WEBKIT: ReadonlyArray<[string, NetworkCause]> = [
  ["A server with the specified hostname could not be found", "dns"],
  ["Error resolving ", "dns"],
  ["Could not resolve host", "dns"],
  ["Could not connect", "connection"],
  ["Couldn't connect to server", "connection"],
  ["Connection refused", "connection"],
  ["The network connection was lost", "connection"],
  ["The Internet connection appears to be offline", "connection"],
  ["Connection terminated unexpectedly", "connection"],
  ["Empty reply from server", "connection"],
  ["The request timed out", "timeout"],
  ["Connection timed out", "timeout"],
  ["Operation timed out", "timeout"],
  ["The certificate for this server is invalid", "tls"],
  ["Unacceptable TLS certificate", "tls"],
  ["SSL handshake failed", "tls"],
  ["SSL connect error", "tls"],
];

/** The text after a driver's "page.goto: " prefix, when it has one: lowercase letters, a dot, letters, a colon and a space. */
function withoutDriverPrefix(line: string): string {
  const colon = line.indexOf(": ");
  if (colon <= 0) return line;
  const head = line.slice(0, colon);
  const dot = head.indexOf(".");
  if (dot <= 0 || dot === head.length - 1) return line;
  const lowerFirst = [...head.slice(0, dot)].every((c) => c >= "a" && c <= "z");
  const lettersAfter = [...head.slice(dot + 1)].every((c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
  return lowerFirst && lettersAfter ? line.slice(colon + 2) : line;
}

/** The first word of a line, up to a space or the end. */
function firstWord(text: string): string {
  const space = text.indexOf(" ");
  return space === -1 ? text : text.slice(0, space);
}

/**
 * The network cause of a browser's error, or null when it is not one: an
 * error page the browser was refused for, a request the page or the write
 * policy cancelled (`net::ERR_ABORTED`, `net::ERR_BLOCKED_BY_CLIENT`), a
 * redirect loop and a Playwright timeout are all left to the app's rules.
 *
 * Read from the start of the first line only, after any "page.goto: " prefix,
 * so an address or a call log later in the text cannot pass for a code.
 * `code` is the browser's own code (`net::ERR_NAME_NOT_RESOLVED`,
 * `NS_ERROR_UNKNOWN_HOST`), or WebKit's sentence up to its first period.
 */
export function browserNetworkCause(text: string): { cause: NetworkCause; code: string } | null {
  const newline = text.indexOf("\n");
  const line = withoutDriverPrefix((newline === -1 ? text : text.slice(0, newline)).trim());
  if (line.startsWith("net::ERR_")) {
    const code = firstWord(line);
    const name = code.slice("net::".length);
    if (CHROMIUM[name]) return { cause: CHROMIUM[name], code };
    if (name.startsWith("ERR_CERT_") || name.startsWith("ERR_SSL_")) return { cause: "tls", code };
    return null;
  }
  const word = firstWord(line);
  if (FIREFOX[word]) return { cause: FIREFOX[word], code: word };
  if (word.startsWith("SSL_ERROR_") || word.startsWith("SEC_ERROR_") || word.startsWith("MOZILLA_PKIX_ERROR_")) return { cause: "tls", code: word };
  for (const [start, cause] of WEBKIT) {
    if (line.startsWith(start)) {
      const stop = line.indexOf(".");
      return { cause, code: (stop === -1 ? line : line.slice(0, stop)).slice(0, 80) };
    }
  }
  return null;
}

/** What each cause means, in a few words, for a report's line. */
export const CAUSE_WORDS: Record<NetworkCause, string> = {
  dns: "the host name did not resolve",
  connection: "the connection was refused or dropped",
  timeout: "nothing answered in time",
  tls: "the TLS handshake failed",
};

/**
 * The sentence a failed first page load starts with, after "Could not load
 * <url> — ": chosen from the browser's error, so a name that does not resolve
 * or a certificate the browser refuses is not met with "is the app running?".
 */
export function startLoadHint(errorText: string): string {
  const failure = browserNetworkCause(errorText);
  switch (failure?.cause) {
    case "dns":
      return "the host name does not resolve from this machine. Check the spelling, and that this machine can see the network the app is on.";
    case "tls":
      return "the browser refused the site's certificate (expired, for another host, or from an authority this machine does not trust).";
    case "timeout":
      return "nothing answered in time. Check that the app is running and that no firewall drops this machine's packets.";
    case "connection":
      return "is the app running? The connection was refused or dropped: check too that nothing (a firewall, a proxy) keeps this machine out.";
    default:
      return "is the app running?";
  }
}
