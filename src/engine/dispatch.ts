/**
 * Tool-call dispatch: the per-session queue and the watchdog.
 *
 * Extracted from mcp-server.ts because these two are the whole basis of the
 * multi-role promise — "calls to DIFFERENT sessions run concurrently, calls to
 * the SAME session never interleave" — and living inside the server module they
 * could only be exercised by driving a real browser over stdio, so nothing in
 * `npm test` touched them. A regression here (two same-session calls
 * overlapping and corrupting one browser's ref table, or a watchdog timer that
 * never clears) would ship green. Here they are pure and table-testable: see
 * scripts/dispatch-test.ts.
 */

/**
 * Resolve with `onTimeout(...)` if `p` has not settled within `ms`.
 *
 * Two details that look incidental and are not:
 *  - the timer is cleared when `p` settles, so a long-lived process does not
 *    accumulate live timers (each would also hold the event loop open);
 *  - the guarded promise gets its own no-op `.catch`, because once the race has
 *    been won by the timeout nobody is left to handle a later rejection and
 *    Node would report an unhandled rejection for a call the caller was
 *    already told had timed out.
 */
export function withWatchdog<R>(label: string, p: Promise<R>, ms: number, onTimeout: (label: string, ms: number) => R): Promise<R> {
  let timer: NodeJS.Timeout | undefined;
  const guarded = p.finally(() => clearTimeout(timer));
  void guarded.catch(() => {});
  return Promise.race([
    guarded,
    new Promise<R>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout(label, ms)), ms);
    }),
  ]);
}

/**
 * Serializes work per key, and only per key.
 *
 * One browser's ref table and fingerprint are shared mutable state, so two
 * calls against the SAME session must not interleave. Two calls against
 * DIFFERENT sessions share nothing, so they must not queue behind each other —
 * that is what makes dispatching to several roles in one turn actually
 * parallel rather than merely concurrent-looking.
 */
export class SessionQueue {
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Calls queued or running per key — a chain may not be dropped while this is above zero. */
  private readonly pending = new Map<string, number>();
  /** Keys asked to be forgotten while still busy; dropped when they drain. */
  private readonly forgotten = new Set<string>();

  /** Queue `fn` behind anything already running for `key`; returns its result. */
  run<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    // Run `fn` whether the previous call resolved or REJECTED — a failed tool
    // call must not wedge that session's queue forever.
    const next = prior.then(fn, fn);
    // The stored link swallows rejections: it exists only to sequence the next
    // call, and an unhandled rejection here would crash the process for an
    // error the caller is already receiving.
    const settled = next.then(
      () => this.release(key),
      () => this.release(key),
    );
    this.chains.set(key, settled);
    return next;
  }

  private release(key: string): void {
    const left = (this.pending.get(key) ?? 1) - 1;
    if (left > 0) {
      this.pending.set(key, left);
      return;
    }
    this.pending.delete(key);
    if (this.forgotten.delete(key)) this.chains.delete(key);
  }

  /** Keys with work queued or in flight — diagnostics only. */
  get size(): number {
    return this.chains.size;
  }

  /**
   * Drop a key's chain once it is idle (e.g. its session closed).
   *
   * Dropping it WHILE a call is in flight would be a correctness bug, not
   * housekeeping: the next call for that key would find no chain, start
   * immediately, and interleave with the call still running — precisely the
   * overlap this class exists to prevent. `scout_close` runs on its own control
   * chain, so it really can land mid-call. A still-busy key is marked instead
   * and dropped when it drains.
   */
  forget(key: string): void {
    if ((this.pending.get(key) ?? 0) > 0) {
      this.forgotten.add(key);
      return;
    }
    this.chains.delete(key);
  }

  /** Forget every key (close-all), honouring the same in-flight rule. */
  clear(): void {
    for (const key of [...this.chains.keys()]) this.forget(key);
  }
}

/** How long BrowserEngine.close() gives pages, context and browser to close in order before escalating. */
export const TEARDOWN_MS = 8000;
/** How long the escalation's own browser.close() gets before the browser's process is killed. */
export const BROWSER_CLOSE_MS = 3000;

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
  /** End that process; false when it could not be ended. */
  kill: (pid: number) => boolean;
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
export async function boundedTeardown(steps: TeardownSteps, bounds = { teardownMs: TEARDOWN_MS, browserCloseMs: BROWSER_CLOSE_MS }): Promise<TeardownOutcome> {
  if (await settlesWithin(steps.graceful(), bounds.teardownMs)) return { timedOut: false };
  const browserClosed = await settlesWithin(steps.closeBrowser(), bounds.browserCloseMs);
  if (steps.pid === undefined) return { timedOut: true, browserClosed, left: "unknown" };
  if (!steps.isAlive(steps.pid)) return { timedOut: true, browserClosed };
  return steps.kill(steps.pid) ? { timedOut: true, browserClosed, killed: steps.pid } : { timedOut: true, browserClosed, left: steps.pid };
}

/** The line a teardown that timed out is logged with, or null when it did not time out. */
export function describeTeardown(outcome: TeardownOutcome, bounds = { teardownMs: TEARDOWN_MS, browserCloseMs: BROWSER_CLOSE_MS }): string | null {
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
