/**
 * Closing a session's browser within a bound, and never walking away from a
 * running one.
 *
 * Kept out of browser.ts so the rule can be table-tested with stand-in objects
 * (scripts/dispatch-test.ts). The cost of getting it wrong is a browser left
 * running under the engine's process: it is not an orphan, so the reaper never
 * takes it, and its pipe keeps node from exiting.
 */

/** The parts of a Playwright page, context and browser that teardown uses. */
export interface Closable {
  close(): Promise<unknown>;
}
export interface ContextLike extends Closable {
  pages(): Closable[];
}
/** The browser's process, as a Playwright BrowserServer holds it: closed gracefully, or killed. */
export interface BrowserProcess extends Closable {
  kill(): Promise<unknown>;
  running(): boolean;
  pid?: number;
}

/** How long teardown waits: for pages, context and browser to close in order, then for each escalation step. */
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

/** What a teardown had to do. */
export interface TeardownOutcome {
  /** The ordered teardown overran its bound. */
  timedOut: boolean;
  /** After a timeout: whether closing the browser directly settled within its own bound. */
  browserClosed?: boolean;
  /** After a timeout: the pid killed because the browser was still running. */
  killed?: number;
  /** After a timeout: the pid still running because the kill did not end it, or unknown when there was no process to kill. */
  left?: number | "unknown";
}

/**
 * Close the context's pages, then the context, then the browser, then its
 * process, and escalate when that overruns `bounds.teardownMs`: the browser is
 * closed directly on a bound of its own, without waiting on a page or context
 * that has not closed (closing the browser ends every context in it), and if
 * its process is still running after that, the process is killed.
 *
 * The objects are passed in rather than read from the caller's fields while
 * teardown runs. A caller that returns at the bound clears those fields, and a
 * teardown still running that then read them would find nothing to close and
 * leave the browser running, or close one a later attach opened.
 *
 * `proc` is the browser's process. A browser that is connected to rather than
 * launched only disconnects on close(), so the process's own close is what ends
 * it. Without a process only the browser's close() is tried, and a browser that
 * ignores it is reported as left running.
 */
export async function boundedTeardown(
  context: ContextLike | null,
  browser: Closable | null,
  proc: BrowserProcess | null,
  bounds: TeardownBounds = DEFAULT_TEARDOWN_BOUNDS,
): Promise<TeardownOutcome> {
  const ordered = (async () => {
    for (const p of context?.pages() ?? []) await p.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await proc?.close();
  })();
  if (await settlesWithin(ordered, bounds.teardownMs)) return { timedOut: false };
  const browserClosed = await settlesWithin(proc ? proc.close() : (browser?.close() ?? Promise.resolve()), bounds.browserCloseMs);
  if (!proc) return { timedOut: true, browserClosed, left: "unknown" };
  if (!proc.running()) return { timedOut: true, browserClosed };
  await settlesWithin(proc.kill(), bounds.browserCloseMs);
  const pid = proc.pid ?? 0;
  return proc.running() ? { timedOut: true, browserClosed, left: pid } : { timedOut: true, browserClosed, killed: pid };
}

/** The line a teardown that timed out is logged with, or null when it did not time out. */
export function describeTeardown(outcome: TeardownOutcome, bounds: TeardownBounds = DEFAULT_TEARDOWN_BOUNDS): string | null {
  if (!outcome.timedOut) return null;
  const close = outcome.browserClosed
    ? "closing the browser directly then settled"
    : `closing the browser directly did not settle within ${bounds.browserCloseMs}ms`;
  const end =
    outcome.killed !== undefined
      ? `killed browser process ${outcome.killed}`
      : outcome.left === "unknown"
        ? "there is no process to kill, so it may still be running"
        : outcome.left !== undefined
          ? `browser process ${outcome.left} could not be killed and may still be running`
          : "browser process has exited";
  return `teardown timed out after ${bounds.teardownMs}ms; ${close}; ${end}`;
}
