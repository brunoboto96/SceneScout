/**
 * Closing a session's browser within a bound, without losing the browser.
 *
 * Kept out of browser.ts so the rule can be table-tested with stand-in objects.
 * The cost of getting it wrong is a browser left running under the engine's
 * process: it is not an orphan, so the reaper never takes it, and its pipe keeps
 * node from exiting.
 */

/** The parts of a Playwright page, context and browser that teardown uses. */
export interface Closable {
  close(): Promise<unknown>;
}
export interface ContextLike extends Closable {
  pages(): Closable[];
}

/**
 * Close the context's pages, then the context, then the browser, and return
 * once that is done or `capMs` has passed, whichever is first.
 *
 * The browser and context are passed in rather than read from the caller's
 * fields while teardown runs. A caller that returns at the cap clears those
 * fields, and a teardown still running that then read them would find nothing
 * to close and leave the browser running. When the cap is reached, the browser
 * is also closed directly, without waiting on a page or context that has not
 * closed: closing the browser ends every context in it.
 */
export async function boundedTeardown(context: ContextLike | null, browser: Closable | null, capMs: number): Promise<void> {
  let finished = false;
  const ordered = (async () => {
    for (const p of context?.pages() ?? []) await p.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  })()
    .catch(() => {})
    .finally(() => {
      finished = true;
    });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    ordered.finally(() => clearTimeout(timer)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, capMs);
    }),
  ]);
  if (!finished) void browser?.close().catch(() => {});
}
