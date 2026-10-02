/**
 * Turning a failed browser launch into something the person can act on.
 *
 * For anyone who installed from npm and never ran the setup step, the first
 * attach fails because the browser was never downloaded — and Playwright reports
 * that as a multi-line box of text with a path in it. That is the single most
 * likely first-run failure, so it gets one plain instruction instead. Before
 * that, readyBrowser downloads the missing build itself where the setting and
 * the environment allow, so a first attach needs no terminal step.
 */
import {
  APPROX_DISK_MB,
  attachDownloadLine,
  BROWSER_DOWNLOAD_ENV,
  browserDownloadDecision,
  launchTarget,
  type BrowserEngineName,
  type BrowserPresence,
  type InstallTarget,
} from "../browsers.js";

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
    // Someone who installed only the headless shell did run install, so say what is different about a headed run.
    const why =
      target === "chromium" && need.headed
        ? "A headed run needs the full Chromium browser, which has not been downloaded (the headless shell alone cannot open a window)"
        : `The ${target} build has not been downloaded yet`;
    return `${why} (one-time, about ${APPROX_DISK_MB[target]} MB on disk). ${installByHand(target)}`;
  }
  const firstLine = message.split("\n")[0];
  return (
    `browser launch failed twice (${firstLine})` +
    (reaped > 0 ? ` — ${reaped} orphaned browser process(es) were reaped between attempts` : "") +
    `. Check disk space, then run \`scenescout doctor\` to verify the setup.`
  );
}

/** The commands that download one build by hand, ending the message that names them. */
function installByHand(target: InstallTarget): string {
  return (
    `Run this once, then attach again:\n` +
    `  npx -y scenescout install --browser-only --browsers ${target}\n` +
    `(from a clone: node dist/cli.js install --browser-only --browsers ${target}). ` +
    `On Linux, if system libraries are missing: npx playwright install --with-deps ${target}`
  );
}

/** What readyBrowser is given: the environment, and the two things it may not do itself in a test. */
export interface BrowserReadyDeps {
  env: NodeJS.ProcessEnv;
  /** Which builds are on disk now. */
  present: () => Promise<BrowserPresence>;
  /** Download these builds; `detail` says why when it did not work. */
  download: (targets: InstallTarget[]) => Promise<{ ok: boolean; detail?: string }>;
  /** Tell whoever is waiting, in plain words. */
  say: (line: string) => void;
  now?: () => number;
}

/**
 * Make sure the build an attach is about to launch is on disk, downloading it
 * the first time when browserDownloadDecision allows. Returns a line for the
 * attach's answer when it downloaded, null when the build was already there,
 * and throws with the command to run by hand when it will not or could not.
 */
export async function readyBrowser(need: LaunchNeed, deps: BrowserReadyDeps): Promise<string | null> {
  const target = launchTarget(need.engine, need.headed);
  if ((await deps.present())[target].installed) return null;
  const decision = browserDownloadDecision(deps.env);
  if (decision === "refuse") {
    throw new Error(
      `The ${target} build has not been downloaded, and ${BROWSER_DOWNLOAD_ENV}=off keeps SceneScout from downloading it. ${installByHand(target)}`,
    );
  }
  if (decision === "tell") {
    throw new Error(
      `The ${target} build has not been downloaded. In CI SceneScout downloads a browser only when asked: add the install step below to the job before the tests, ` +
        `or set ${BROWSER_DOWNLOAD_ENV}=on to let the attach download it. ${installByHand(target)}`,
    );
  }
  const now = deps.now ?? Date.now;
  deps.say(attachDownloadLine(target));
  const began = now();
  const result = await deps.download([target]);
  if (!result.ok) {
    throw new Error(
      `The test browser could not be downloaded${result.detail ? ` (${result.detail})` : ""}. Check the network or proxy, or download it by hand. ${installByHand(target)}`,
    );
  }
  // The installer's exit code is not the build: look again before saying it is there.
  if (!(await deps.present())[target].installed) {
    throw new Error(`The download finished, but the ${target} build is still not where Playwright looks for it. ${installByHand(target)}`);
  }
  const line = `The test browser is ready (${target}, downloaded once in ${Math.round((now() - began) / 1000)} s; later tests start straight away).`;
  deps.say(line);
  return line;
}
