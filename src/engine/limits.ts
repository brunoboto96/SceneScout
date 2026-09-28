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
export const DEFAULT_BACK_NAV_TIMEOUT_MS = 10000;

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
export function checkLimit(kind: LimitKind, value: number, source: string): number {
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
 * The same error with the hint added when it is a timeout, unchanged otherwise.
 * The hint goes on line 1, since callers cut a Playwright error to its first
 * line; the call log below it is kept. An error that already carries a hint is
 * returned as it is.
 */
export function explainTimeout(err: unknown, kind: LimitKind, ms: number): unknown {
  if (!(err instanceof Error) || !isTimeoutMessage(err.message) || err.message.includes(HINT_MARK)) return err;
  const [first, ...rest] = err.message.split("\n");
  const out = new Error([`${first} — ${limitHint(kind, ms)}.`, ...rest].join("\n"));
  out.name = err.name;
  return out;
}
