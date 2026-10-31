/**
 * How long the engine waits for one action on the page (a click, typing, a
 * hover, a pick from a list) and for one page to load, before it calls the
 * wait a failure.
 *
 * On a loaded machine — a shared CI runner, a laptop building something else —
 * the defaults can run out while the app is fine, and the run then reports a
 * timeout that belongs to the machine. So both are settings: a scout_attach
 * option (or a `scenescout check` / `ci` flag) wins over an environment
 * variable, which wins over the default. The defaults are the values the
 * engine has always used.
 *
 * It lives apart from browser.ts so the precedence, the bounds and the
 * parsing are table-tested (scripts/limits-test.ts) without a browser.
 */
import { codeSpan } from "./inert-text.js";
import { fromJs } from "./js-regex.js";
import { browserNetworkCause, CAUSE_WORDS } from "./network-failure.js";

export type LimitKind = "action" | "nav";

export interface TimeLimits {
  /** One action on the page: click, type, press, hover, select, upload, and a saved flow step's wait for its target. */
  actionMs: number;
  /** Opening a page: attach, scout_navigate. */
  navMs: number;
  /** A page the crawl or a saved flow opens. Its own default; a nav limit that was set applies here too. */
  crawlNavMs: number;
  /** Going back, and waiting for a popup to load. Its own default; a nav limit that was set applies here too. */
  backNavMs: number;
}

export const DEFAULT_ACTION_TIMEOUT_MS = 5000;
export const DEFAULT_NAV_TIMEOUT_MS = 20000;
/** The crawl has always given each route less than a deliberate navigation. */
export const DEFAULT_CRAWL_NAV_TIMEOUT_MS = 15000;
/** Going back and a popup's load have always had the shortest wait. */
const DEFAULT_BACK_NAV_TIMEOUT_MS = 10000;

export const DEFAULT_TIME_LIMITS: TimeLimits = {
  actionMs: DEFAULT_ACTION_TIMEOUT_MS,
  navMs: DEFAULT_NAV_TIMEOUT_MS,
  crawlNavMs: DEFAULT_CRAWL_NAV_TIMEOUT_MS,
  backNavMs: DEFAULT_BACK_NAV_TIMEOUT_MS,
};

export const ACTION_TIMEOUT_ENV = "SCENESCOUT_ACTION_TIMEOUT_MS";
export const NAV_TIMEOUT_ENV = "SCENESCOUT_NAV_TIMEOUT_MS";

/** Inclusive bounds. Under a second is no wait at all; past the maximum a stuck page holds the run for minutes per step. */
export const LIMIT_BOUNDS: Record<LimitKind, { min: number; max: number }> = {
  action: { min: 1000, max: 120_000 },
  nav: { min: 1000, max: 300_000 },
};

/** How each limit is set, by name, for errors and for the hint a timeout carries. */
export const LIMIT_NAMES: Record<LimitKind, { what: string; option: string; flag: string; env: string }> = {
  action: { what: "action limit", option: "actionTimeoutMs", flag: "--action-timeout-ms", env: ACTION_TIMEOUT_ENV },
  nav: { what: "page-load limit", option: "navTimeoutMs", flag: "--nav-timeout-ms", env: NAV_TIMEOUT_ENV },
};

function boundsText(kind: LimitKind): string {
  const { min, max } = LIMIT_BOUNDS[kind];
  return `a whole number of milliseconds from ${min} to ${max}`;
}

/** Check one value against its bounds. `source` names where it came from, so the error says what to fix. */
function checkLimit(kind: LimitKind, value: number, source: string): number {
  const { min, max } = LIMIT_BOUNDS[kind];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${source} must be ${boundsText(kind)} (got ${value}).`);
  }
  return value;
}

/**
 * Read one limit from text (an environment variable, a CLI flag). Digits only:
 * "5s", "5000ms", "1e4" and "-1" are refused rather than guessed at.
 */
export function parseLimit(kind: LimitKind, raw: string, source: string): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new Error(`${source} must be ${boundsText(kind)} (got "${raw}").`);
  return checkLimit(kind, Number(text), source);
}

/** A CLI flag's value, as the argument parsers want it: a number or a sentence. */
export function parseLimitFlag(kind: LimitKind, raw: string | undefined): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: parseLimit(kind, raw, LIMIT_NAMES[kind].flag) };
  } catch (err) {
    return { ok: false, error: (err as Error).message.replace(/\.$/, "") };
  }
}

function pick(kind: LimitKind, option: number | undefined, env: Record<string, string | undefined>): number | undefined {
  const names = LIMIT_NAMES[kind];
  if (option !== undefined) return checkLimit(kind, option, names.option);
  const raw = env[names.env];
  if (raw === undefined || raw.trim() === "") return undefined;
  return parseLimit(kind, raw, names.env);
}

/**
 * Only the limits that were set, by option or environment, each checked. For
 * a command with defaults of its own (signing in to save a login profile
 * waits longer than an exploring session), which applies a set limit and
 * otherwise keeps its own.
 */
export function explicitLimits(
  options: { actionTimeoutMs?: number; navTimeoutMs?: number },
  env: Record<string, string | undefined>,
): { actionMs?: number; navMs?: number } {
  const action = pick("action", options.actionTimeoutMs, env);
  const nav = pick("nav", options.navTimeoutMs, env);
  return { ...(action !== undefined ? { actionMs: action } : {}), ...(nav !== undefined ? { navMs: nav } : {}) };
}

/**
 * The limits a session runs with: the option when given, else the
 * environment variable when set, else the default. A value out of bounds
 * throws, naming where it came from — an attach never starts on a limit it
 * would silently replace.
 */
export function resolveTimeLimits(options: { actionTimeoutMs?: number; navTimeoutMs?: number }, env: Record<string, string | undefined>): TimeLimits {
  const { actionMs: action, navMs: nav } = explicitLimits(options, env);
  return {
    actionMs: action ?? DEFAULT_ACTION_TIMEOUT_MS,
    navMs: nav ?? DEFAULT_NAV_TIMEOUT_MS,
    crawlNavMs: nav ?? DEFAULT_CRAWL_NAV_TIMEOUT_MS,
    backNavMs: nav ?? DEFAULT_BACK_NAV_TIMEOUT_MS,
  };
}

/**
 * A read of an element for bookkeeping (its test id, its label, whether it is
 * a select) rather than the action on it. It is never the step's real wait, and
 * on a target the page no longer has it must not hold the step for
 * Playwright's own 30 s. No longer than the smallest action limit, so a read never
 * outlasts the action it serves.
 */
export const TARGET_READ_MS = 1000;

/**
 * A screenshot is not an action on the page: it keeps the 30 s Playwright has
 * always given it, which the page's own default (pageTimeouts) no longer does.
 */
export const SCREENSHOT_TIMEOUT_MS = 30_000;

/**
 * The defaults a session's page gets, for a wait on it that names no timeout
 * of its own: the action limit for an action or a read of an element, the
 * page-load limit for a load. Without them such a wait falls to Playwright's
 * 30 s, so a missing target held a step for several times the action limit.
 * They are set on each page rather than the context, because the context's
 * default also bounds the requests the route handler sends for the app
 * (route.fetch), which are not actions.
 */
export function pageTimeouts(limits: TimeLimits): { timeout: number; navigationTimeout: number } {
  return { timeout: limits.actionMs, navigationTimeout: limits.navMs };
}

/**
 * A tool call's watchdog, given the session's limits. The watchdogs are sized
 * for the default limits; a session that raised them gets the watchdog
 * lengthened by as much, so a raised limit is what ends a slow call, with its
 * hint, rather than the watchdog. An action is counted twice: a click that
 * timed out is retried once. Never shorter than the base.
 */
export function watchdogFor(baseMs: number, limits: TimeLimits): number {
  const moreAction = Math.max(0, limits.actionMs - DEFAULT_ACTION_TIMEOUT_MS);
  const moreNav = Math.max(0, limits.navMs - DEFAULT_NAV_TIMEOUT_MS, limits.crawlNavMs - DEFAULT_CRAWL_NAV_TIMEOUT_MS);
  return baseMs + 2 * moreAction + moreNav;
}

/** True for a Playwright timeout ("Timeout 5000ms exceeded", "page.goto: Timeout 20000ms exceeded."). */
export function isTimeoutMessage(message: string): boolean {
  return /\bTimeout \d+ms exceeded/i.test(message);
}

/** How a browser fails page.goto when the page started another navigation before the asked-for load finished. */
const INTERRUPTED_RE = fromJs(String.raw`^(?:[a-z]+\.[a-zA-Z]+: )?Navigation to ".*" is interrupted by another navigation to "`);

/**
 * Whether a page load failed only because another navigation took its place ("page.goto: Navigation to "/a" is
 * interrupted by another navigation to "/b""). Read from the error's first line, the browser's own: the same words in an
 * address further down are the app's. When the session's own load is the only one it started, the other navigation is
 * the page's: its script or a redirect moved it on before the asked-for load finished (Firefox under load does this to
 * a page that redirects as it loads). The page moved on rather than failing, so where it landed is what is reported.
 */
export function loadInterrupted(message: string): boolean {
  return INTERRUPTED_RE.test(message.split("\n")[0]);
}

/** The address an interrupted load names as the navigation that took its place; null for any other error. */
const INTERRUPTED_BY_RE = fromJs(String.raw`^(?:[a-z]+\.[a-zA-Z]+: )?Navigation to ".*" is interrupted by another navigation to "(.*)"$`);

export function interruptedBy(message: string): string | null {
  return INTERRUPTED_BY_RE.exec(message.split("\n")[0])?.groups[1] ?? null;
}

/** How long an interrupted load waits for the request of the navigation that took its place, when it has not been seen yet. */
export const INTERRUPTION_GRACE_MS = 1000;

/** A main-frame navigation's first request: where it went, when it started and, once it was, when it was answered. */
export interface NavigationStart {
  url: string;
  at: number;
  /** When the first answer to it (or to a redirect it followed) arrived; unset while none has. */
  answeredAt?: number;
}

/**
 * Whether an interrupted load (interruptedBy) is the page moving itself on: the navigation that took its place started
 * at or after the load did, and after a navigation begun since the load (the load itself) had been answered, since only
 * a document that arrived can run the script that moves the page on. One that started before the load is a navigation
 * from earlier (the previous load committing late); one that started after it while nothing begun since had been
 * answered came from the page the load was leaving (its own timer moving it on), and the load never reached its page.
 * In both the page has not moved on from the asked-for load, so the load's error stands. Fragments are not compared.
 */
export function interruptedByOwnNavigation(target: string, starts: readonly NavigationStart[], loadStartedAt: number): boolean {
  const bare = (u: string): string => u.split("#")[0];
  const answeredBefore = (s: NavigationStart): boolean =>
    starts.some((a) => a !== s && a.at >= loadStartedAt && a.at <= s.at && a.answeredAt !== undefined && a.answeredAt <= s.at);
  return starts.some((s) => s.at >= loadStartedAt && bare(s.url) === bare(target) && answeredBefore(s));
}

const HINT_MARK = "ran out. If the machine is loaded";

/** What to say when a limit ran out: which one, how long it was, and how to raise it. */
export function limitHint(kind: LimitKind, ms: number): string {
  const n = LIMIT_NAMES[kind];
  return (
    `the ${n.what} (${ms} ms) ${HINT_MARK} rather than the app slow, raise it: ` +
    `${n.option} on scout_attach, ${n.flag} on scenescout check or ci, or ${n.env} in the environment`
  );
}

/**
 * What a load is reported as when the page moved itself on to `url` (a script's redirect, or one that interrupted the
 * load) and that navigation was still on its way when the limit ran out: the page cannot be read until it lands.
 */
export function stillNavigating(url: string, kind: LimitKind, ms: number): string {
  return `the page moved itself on to ${url}, which had not loaded when ${limitHint(kind, ms)}`;
}

/**
 * The same error with the hint added when it is a timeout, unchanged otherwise.
 * The hint goes on line 1, since callers cut a Playwright error to its first
 * line; the call log below it is kept. An error that already carries a hint is
 * returned as it is.
 */
/** An error's first line, without the driver's "page.goto: " prefix: what a report shows of it. */
export function firstLineOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .split("\n")[0]
    .replace(/^[a-z]+\.[a-zA-Z]+: /, "")
    .trim();
}

export function explainTimeout(err: unknown, kind: LimitKind, ms: number): unknown {
  if (!(err instanceof Error) || !isTimeoutMessage(err.message) || err.message.includes(HINT_MARK)) return err;
  const [first, ...rest] = err.message.split("\n");
  const out = new Error([`${first} — ${limitHint(kind, ms)}.`, ...rest].join("\n"));
  out.name = err.name;
  return out;
}

/**
 * The page-load failures that are always tried again, once. net::ERR_NO_BUFFER_SPACE
 * is the machine refusing the browser a socket (on Windows, WSAENOBUFS), a
 * transient condition of the machine and not an answer from the app: the
 * hosted Windows runners raised it with as few as 150 sockets open.
 *
 * A network failure (network-failure.ts: a name that did not resolve, a
 * connection refused or dropped, a network timeout, a failed TLS handshake) is
 * tried again once only when NETWORK_RETRY_ENV is `on` (#554): off by default,
 * because a retry that hides a server that drops connections would hide a
 * defect. Every other failure, and every HTTP answer, is reported as it is.
 */
export const RETRIED_LOAD_ERRORS = ["ERR_NO_BUFFER_SPACE"] as const;
/** The code a load was retried after: ERR_NO_BUFFER_SPACE, or the browser's code for a network failure (ERR_CONNECTION_RESET, NS_ERROR_NET_RESET, a WebKit sentence). */
export type RetriedLoadError = string;

/** Turns on the one retry of a page load that failed on the network: `on` or `off` (the default). */
export const NETWORK_RETRY_ENV = "SCENESCOUT_RETRY_NETWORK";

/** Whether a page load that failed on the network is tried again, from the environment. Any value but on, off or empty is refused rather than guessed at. */
export function readNetworkRetry(env: Record<string, string | undefined>): boolean {
  const raw = (env[NETWORK_RETRY_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off") return false;
  if (raw === "on") return true;
  throw new Error(`${NETWORK_RETRY_ENV} must be on or off (got "${env[NETWORK_RETRY_ENV]}").`);
}

/** How many times one page load is tried again after a retried error. */
export const LOAD_RETRIES = 1;

/** The pause before the retry, so a machine short of socket buffers has a moment to free one. */
export const LOAD_RETRY_PAUSE_MS = 500;

/** The pause before a network failure's retry: long enough for a dropped connection or a resolver's hiccup to pass. */
export const NETWORK_RETRY_PAUSE_MS = 2000;

/** The pause before the retry of a load that failed with `cause`. */
export function loadRetryPauseMs(cause: RetriedLoadError): number {
  return cause === "ERR_NO_BUFFER_SPACE" ? LOAD_RETRY_PAUSE_MS : NETWORK_RETRY_PAUSE_MS;
}

/**
 * The least time a retried load is given. The retry has what is left of the
 * load's limit, so the two tries together keep to it; a limit already spent
 * (by the error page's wait and the socket table) still leaves the retry this
 * much rather than 0, which Playwright reads as no limit at all.
 */
export const LOAD_RETRY_MIN_MS = 2000;

/** The timeout for a retried load: the limit less the time the first try and the wait before the retry took. Undefined when the load had no limit of its own. */
export function loadRetryTimeoutMs(limitMs: number | undefined, elapsedMs: number): number | undefined {
  if (limitMs === undefined || limitMs <= 0) return limitMs;
  return Math.max(LOAD_RETRY_MIN_MS, limitMs - elapsedMs);
}

/**
 * The error a retried load failed with, saying on its first line (the line
 * callers show) that it was the retry that failed. The call log below is kept.
 */
export function retriedLoadFailure(err: unknown, cause: RetriedLoadError): unknown {
  if (!(err instanceof Error)) return err;
  const [first, ...rest] = err.message.split("\n");
  const out = new Error([`${first} (this load was retried after ${cause}, and failed again)`, ...rest].join("\n"));
  out.name = err.name;
  return out;
}

/**
 * The error to retry a failed page load for, given how many times it was
 * already retried and whether network failures are retried (readNetworkRetry);
 * null when it is not retried.
 */
export function loadRetryCause(message: string, retriesSoFar: number, retryNetwork = false): RetriedLoadError | null {
  if (retriesSoFar >= LOAD_RETRIES) return null;
  // Only the code the browser leads its error with ("page.goto: net::ERR_… at <url>"): the same text inside the
  // address a failure names, or in its call log, is the app's and not the browser's error.
  const code = /^(?:[a-z]+\.[a-zA-Z]+: )?net::([A-Z_]+)(?: at |$)/.exec(message.split("\n")[0])?.[1];
  const always = RETRIED_LOAD_ERRORS.find((retried) => retried === code);
  if (always) return always;
  if (!retryNetwork) return null;
  const failure = browserNetworkCause(message);
  if (!failure) return null;
  return failure.code.startsWith("net::") ? failure.code.slice("net::".length) : failure.code;
}

/** What a retried cause was, in a few words. */
function retryWhy(cause: RetriedLoadError): string {
  if (cause === "ERR_NO_BUFFER_SPACE") return "the machine refused the browser a socket";
  const failure = browserNetworkCause(cause.startsWith("ERR_") ? `net::${cause}` : cause);
  return `${failure ? CAUSE_WORDS[failure.cause] : "a network failure"}: the network's, not an answer from the app; ${NETWORK_RETRY_ENV}=on`;
}

/** The line an action's result carries for a load that was retried, so a flaky machine stays visible. */
export function loadRetryNote(url: string, cause: RetriedLoadError): string {
  return `Note: loading ${url} was retried after ${cause} (${retryWhy(cause)}; it was loaded once more).`;
}

/** One load the engine retried, for the report. */
export interface LoadRetry {
  at: string;
  url: string;
  session: string;
  cause: RetriedLoadError;
  /** The machine's TCP table when the load failed (tcp-table.ts). */
  sockets: string;
}

/** The report's section listing the loads this run retried; empty when there were none. */
export function formatLoadRetries(retries: readonly LoadRetry[]): string[] {
  if (retries.length === 0) return [];
  return [
    `## Page loads retried`,
    ``,
    `A page load the machine refused a socket for is loaded once more, and so is one that failed on the network when ${NETWORK_RETRY_ENV} is on. Each was retried once; a load that failed again is reported where it failed.`,
    ``,
    ...retries.map(
      (r) => `- ${codeSpan(r.url)} (session ${r.session}): retried after ${r.cause} (${retryWhy(r.cause)}), at ${r.at}. Sockets then: ${r.sockets}`,
    ),
    ``,
  ];
}
