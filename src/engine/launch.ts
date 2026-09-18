/**
 * Turning a failed browser launch into something the person can act on.
 *
 * For anyone who installed from npm and never ran the setup step, the first
 * attach fails because Chromium was never downloaded — and Playwright reports
 * that as a multi-line box of text with a path in it. That is the single most
 * likely first-run failure, so it gets one plain instruction instead.
 */

/** Playwright's wording when the browser binary is not on disk. */
const MISSING_BROWSER_RE = /Executable doesn't exist|playwright install|browserType\.launch:.*(not found|ENOENT)/i;

export function isMissingBrowser(message: string): boolean {
  return MISSING_BROWSER_RE.test(message);
}

/** The error text for a launch that failed. `reaped` is how many orphaned browsers were cleaned up between attempts. */
export function explainLaunchFailure(message: string, reaped: number): string {
  if (isMissingBrowser(message)) {
    return (
      `Chromium has not been downloaded yet (one-time, ~150 MB). Run this once, then attach again:\n` +
      `  npx -y scenescout install --browser-only\n` +
      `(from a clone: npm run setup). On Linux, if system libraries are missing: npx playwright install --with-deps chromium`
    );
  }
  const firstLine = message.split("\n")[0];
  return (
    `browser launch failed twice (${firstLine})` +
    (reaped > 0 ? ` — ${reaped} orphaned browser process(es) were reaped between attempts` : "") +
    `. Check disk space, then run \`scenescout doctor\` to verify the setup.`
  );
}
