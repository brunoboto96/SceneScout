/**
 * Filming one piece of work into a video file (`scenescout check --video`):
 * start, run the work, stop, and say whether a video was saved. The browser
 * hands in its page's screencast; nothing here needs Playwright, so the
 * failure paths are table-tested.
 */

/** The part of a page's screencast filming uses (Playwright's page.screencast). */
export interface Screencast {
  start(options: { path: string; size?: { width: number; height: number } }): Promise<unknown>;
  stop(): Promise<void>;
}

export interface Filmed<T> {
  value: T;
  /** The video's path, or null when none was saved. */
  video: string | null;
  /** Why no video was saved. */
  videoError?: string;
}

const why = (err: unknown): string => (err instanceof Error ? err.message.split("\n")[0] : String(err));

/**
 * Run `work` while `screencast` films it into `videoTo`. The work's own result
 * and errors are never touched by the filming: a video that cannot be started
 * or saved is reported in `videoError`, and the work runs regardless.
 *
 * A start that fails is followed by a stop, its error ignored: a screencast
 * left half-started would refuse every later start ("already started"), so
 * one failure would cost the video of every flow after it.
 */
export async function film<T>(
  screencast: Screencast,
  videoTo: string,
  size: { width: number; height: number } | null,
  work: () => Promise<T>,
  io: { prepare: (file: string) => Promise<void>; written: (file: string) => Promise<boolean> },
): Promise<Filmed<T>> {
  let videoError: string | undefined;
  let filming = false;
  try {
    await io.prepare(videoTo);
    await screencast.start({ path: videoTo, ...(size ? { size } : {}) });
    filming = true;
  } catch (err) {
    videoError = `the video could not be started: ${why(err)}`;
    // Whatever the failed start left running is stopped, so the next flow can start afresh; there is nothing to save.
    await screencast.stop().catch(() => undefined);
  }
  let value: T;
  try {
    value = await work();
  } finally {
    if (filming) await screencast.stop().catch((err: unknown) => (videoError = `the video could not be saved: ${why(err)}`));
  }
  if (videoError) return { value, video: null, videoError };
  return (await io.written(videoTo)) ? { value, video: videoTo } : { value, video: null, videoError: "no video was written" };
}
