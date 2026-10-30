/**
 * Reading a live page that may change under the read.
 *
 * The engine probes a page the app is still driving: between deciding to read
 * an attribute, a bounding box or the body text and the read itself, the page
 * may navigate, re-render the element away, or close. Playwright reports each
 * of those as a rejected promise. For a probe, that is not an error to surface:
 * the answer is simply "not known this time", and the caller already has a
 * value that means that (null, an empty list, false).
 *
 * `bestEffort` says so once, here, instead of an unexplained `.catch(() => null)`
 * at every probe. Use it only where that is the reason. A call that ignores a
 * failure for some other reason (a route another handler already answered, a
 * browser that is already closing) keeps its own `.catch` and its own comment.
 *
 * Kept out of browser.ts so it can be table-tested without a browser.
 */

/**
 * `work`'s value, or `fallback` when it rejects (undefined when no fallback is
 * given). Never rejects. `work` may be absent, for a read through an optional
 * chain (`this.context?.storageState()`): there is nothing to read then, and
 * the answer is the fallback. A fallback is a value rather than a function:
 * every caller's fallback is a constant, and computing it eagerly costs nothing.
 */
export function bestEffort<T>(work: Promise<T> | undefined): Promise<T | undefined>;
export function bestEffort<T, F>(work: Promise<T> | undefined, fallback: F): Promise<T | F>;
export function bestEffort<T, F>(work: Promise<T> | undefined, fallback?: F): Promise<T | F | undefined> {
  return work === undefined ? Promise.resolve(fallback) : work.catch(() => fallback);
}

/** Await `p` for at most `ms`, clearing the timer either way (never rejects, never leaks a timer). */
export async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    p.catch(() => {}).finally(() => clearTimeout(timer)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
}

/**
 * How a read that a stalled page may hold ended (heldRead): with its value, or given up on, `navigating` saying whether
 * a navigation of the page's own was on its way then (and so was ended, when a release was given).
 */
export type HeldRead<T> = { stalled: false; value: T } | { stalled: true; navigating: boolean };

/** How long a read slower than its limit, with no navigation on its way, is still waited for before it is released. */
export const SLOW_READ_MS = 60_000;
/** How often a read past its limit looks again for a navigation on its way. */
export const HELD_READ_TICK_MS = 100;

/**
 * `work`, a read the page may hold for as long as a navigation of its own is on its way (page.evaluate has no limit of
 * its own). Once it has not settled after `ms`, `release` runs (it ends that navigation) as soon as `navigating()` says
 * one is on its way, and the read is given `ms` more to fail; the answer is then `stalled`. A read with nothing on its way
 * is only slow: it is waited for `slowMs` more, then left, never released, as there is no navigation to end. With
 * `release` null a held read is left too, for a read that may be skipped without ending the page's navigation. Rejects
 * only as `work` does before it is released or left.
 */
export async function heldRead<T>(
  work: Promise<T>,
  ms: number,
  release: (() => Promise<unknown>) | null,
  navigating: () => boolean = () => true,
  slowMs: number = SLOW_READ_MS,
  tickMs: number = HELD_READ_TICK_MS,
): Promise<HeldRead<T>> {
  const early = work.then((value): HeldRead<T> => ({ stalled: false, value }));
  const first = await within(early, ms);
  if (first !== "late") return first;
  for (let waited = 0; !navigating() && waited < slowMs; waited += tickMs) {
    const next = await within(early, Math.min(tickMs, slowMs - waited));
    if (next !== "late") return next;
  }
  if (!navigating()) return { stalled: true, navigating: false };
  if (release === null) return { stalled: true, navigating: true };
  await bestEffort(release());
  await settleWithin(work, ms);
  return { stalled: true, navigating: true };
}

/** `p`'s value, or "late" after `ms`, clearing the timer either way. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "late"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}
