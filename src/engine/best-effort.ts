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

/** How a read that a stalled page may hold ended: with its value, or released after `ms` (heldRead). */
export type HeldRead<T> = { stalled: false; value: T } | { stalled: true };

/**
 * `work`, a read the page may hold for as long as a navigation of its own is on its way (page.evaluate has no limit of
 * its own). When it has not settled after `ms`, `release` runs (it ends that navigation), and the read is given `ms`
 * more to fail; the answer is then `stalled`. Never waits longer than twice `ms`, and rejects only as `work` does
 * before the limit.
 */
export async function heldRead<T>(work: Promise<T>, ms: number, release: () => Promise<unknown>): Promise<HeldRead<T>> {
  let timer: NodeJS.Timeout | undefined;
  const early = work.then((value): HeldRead<T> => ({ stalled: false, value }));
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    const first = await Promise.race([early, late]);
    if (first !== "late") return first;
  } finally {
    clearTimeout(timer);
  }
  await bestEffort(release());
  await settleWithin(work, ms);
  return { stalled: true };
}
