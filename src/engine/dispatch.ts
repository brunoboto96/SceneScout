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
   * overlap this class exists to prevent. `ft_close` runs on its own control
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
