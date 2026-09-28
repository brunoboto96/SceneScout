/**
 * Closing a session's browser within a bound, and never walking away from a
 * running one.
 *
 * Kept out of browser.ts so the rule is table-tested (scripts/dispatch-test.ts)
 * with stand-in steps. The cost of getting it wrong is a browser left running
 * under the engine's process: it is not an orphan, so the reaper never takes
 * it, and its pipe keeps node from exiting.
 */

/** How long BrowserEngine.close() waits: for pages, context and browser to close in order, then for the escalation's own browser close. */
export interface TeardownBounds {
  teardownMs: number;
  browserCloseMs: number;
}

export const DEFAULT_TEARDOWN_BOUNDS: TeardownBounds = { teardownMs: 8000, browserCloseMs: 3000 };
export const TEARDOWN_ENV = "SCENESCOUT_TEARDOWN_MS";
export const BROWSER_CLOSE_ENV = "SCENESCOUT_BROWSER_CLOSE_MS";

/**
 * The teardown bounds, from SCENESCOUT_TEARDOWN_MS and SCENESCOUT_BROWSER_CLOSE_MS when set, else the defaults.
 * Whole milliseconds from 100 to 120000; anything else throws, naming the variable, rather than being guessed at.
 */
export function teardownBounds(env: Record<string, string | undefined>): TeardownBounds {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw.trim());
    if (!/^\d+$/.test(raw.trim()) || value < 100 || value > 120_000)
      throw new Error(`${name} must be a whole number of milliseconds from 100 to 120000 (got "${raw}").`);
    return value;
  };
  return {
    teardownMs: read(TEARDOWN_ENV, DEFAULT_TEARDOWN_BOUNDS.teardownMs),
    browserCloseMs: read(BROWSER_CLOSE_ENV, DEFAULT_TEARDOWN_BOUNDS.browserCloseMs),
  };
}

/** Whether `p` settled (resolved or rejected) within `ms`. The timer is cleared either way, so it never holds node open. */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = p.then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([settled, new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** The steps of a browser teardown, passed in so the escalation below is tested without a browser. */
export interface TeardownSteps {
  /** Close pages, then the context, then the browser, in that order. */
  graceful: () => Promise<unknown>;
  /** Close the browser alone: what still has to happen when the ordered teardown hangs before reaching it. */
  closeBrowser: () => Promise<unknown>;
  /** The browser's process id, when it is known. */
  pid?: number;
  /** Whether that pid is still this process's browser, and not a pid reused since it exited: only then is it killed. */
  isAlive: (pid: number) => boolean;
  /** End that process; false when it could not be ended. Bounded like browser.close(). */
  kill: (pid: number) => boolean | Promise<boolean>;
}

/** What a teardown had to do. */
export interface TeardownOutcome {
  /** The ordered teardown overran its bound. */
  timedOut: boolean;
  /** After a timeout: whether the escalated browser.close() settled within its own bound. */
  browserClosed?: boolean;
  /** After a timeout: the pid killed because it was still running, if any. */
  killed?: number;
  /** After a timeout: the pid still running because it could not be killed, or unknown when no pid was known. */
  left?: number | "unknown";
}

/**
 * Tear a browser down within a bound, and never walk away from a running one.
 *
 * A context whose close hangs (a wedged renderer, an unload handler that never
 * returns) used to end the teardown before browser.close() was reached; the
 * engine then dropped its reference and the browser ran on as node's child,
 * holding node open. It is not an orphan until node dies, so the reaper did not
 * take it either. Now a timeout escalates: browser.close() on its own bound,
 * then the process is killed by its pid if it is still running as this
 * process's browser. Only after a timeout: a teardown that finished has asked
 * the browser to close and heard back, and a pid looked at after its browser
 * has exited may already be someone else's.
 */
export async function boundedTeardown(steps: TeardownSteps, bounds: TeardownBounds = DEFAULT_TEARDOWN_BOUNDS): Promise<TeardownOutcome> {
  if (await settlesWithin(steps.graceful(), bounds.teardownMs)) return { timedOut: false };
  const browserClosed = await settlesWithin(steps.closeBrowser(), bounds.browserCloseMs);
  if (steps.pid === undefined) return { timedOut: true, browserClosed, left: "unknown" };
  if (!steps.isAlive(steps.pid)) return { timedOut: true, browserClosed };
  let killed = false;
  await settlesWithin(
    (async () => {
      killed = await steps.kill(steps.pid as number);
    })(),
    bounds.browserCloseMs,
  );
  return killed ? { timedOut: true, browserClosed, killed: steps.pid } : { timedOut: true, browserClosed, left: steps.pid };
}

/** The line a teardown that timed out is logged with, or null when it did not time out. */
export function describeTeardown(outcome: TeardownOutcome, bounds: TeardownBounds = DEFAULT_TEARDOWN_BOUNDS): string | null {
  if (!outcome.timedOut) return null;
  const close = outcome.browserClosed ? "browser.close() then settled" : `browser.close() did not settle within ${bounds.browserCloseMs}ms`;
  const end =
    outcome.killed !== undefined
      ? `killed browser process ${outcome.killed}`
      : outcome.left === "unknown"
        ? "its process id is unknown, so it may still be running"
        : outcome.left !== undefined
          ? `browser process ${outcome.left} could not be killed and may still be running`
          : "browser process has exited";
  return `teardown timed out after ${bounds.teardownMs}ms; ${close}; ${end}`;
}
