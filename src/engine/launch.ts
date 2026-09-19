/**
 * Turning a failed browser launch into something the person can act on.
 *
 * For anyone who installed from npm and never ran the setup step, the first
 * attach fails because the browser was never downloaded — and Playwright reports
 * that as a multi-line box of text with a path in it. That is the single most
 * likely first-run failure, so it gets one plain instruction instead.
 */
import { APPROX_DISK_MB, launchTarget, type BrowserEngineName } from "../browsers.js";

/** Playwright's wording when the browser binary is not on disk. */
const MISSING_BROWSER_RE = /Executable doesn't exist|playwright install|browserType\.launch:.*(not found|ENOENT)/i;

export function isMissingBrowser(message: string): boolean {
  return MISSING_BROWSER_RE.test(message);
}

/** What the failed launch was trying to open. Defaults describe what every run did before browsers became a choice. */
export type LaunchNeed = { engine: BrowserEngineName; headed: boolean };

/** The error text for a launch that failed. `reaped` is how many orphaned browsers were cleaned up between attempts. */
export function explainLaunchFailure(message: string, reaped: number, need: LaunchNeed = { engine: "chromium", headed: false }): string {
  if (isMissingBrowser(message)) {
    const target = launchTarget(need.engine, need.headed);
    // The headless shell alone cannot open a window, which is the one case
    // where a browser is "missing" for someone who did run install.
    const why =
      target === "chromium" && need.headed
        ? "A headed run needs the full Chromium browser, and only the headless shell is installed"
        : `The ${target} build has not been downloaded yet`;
    return (
      `${why} (one-time, about ${APPROX_DISK_MB[target]} MB on disk). Run this once, then attach again:\n` +
      `  npx -y scenescout install --browser-only --browsers ${target}\n` +
      `(from a clone: node dist/cli.js install --browser-only --browsers ${target}). ` +
      `On Linux, if system libraries are missing: npx playwright install --with-deps ${target}`
    );
  }
  const firstLine = message.split("\n")[0];
  return (
    `browser launch failed twice (${firstLine})` +
    (reaped > 0 ? ` — ${reaped} orphaned browser process(es) were reaped between attempts` : "") +
    `. Check disk space, then run \`scenescout doctor\` to verify the setup.`
  );
}
