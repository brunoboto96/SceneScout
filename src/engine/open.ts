/**
 * Opening the live view and the report in the user's default browser.
 *
 * The live view's address and the report's path are printed in tool results,
 * but a person in a chat client may never see or follow them. The `open`
 * setting has the engine open them itself: the live view when a session
 * attaches, the report when scout_report writes it.
 *
 * Whether to open is decided here, by a pure function of the setting and the
 * environment, so every case is table-tested. Opening goes through the
 * platform opener with no shell, and only ever hands it a loopback URL or an
 * absolute file path. The live view's own rules (loopback only, a token on
 * every path, ADR 7) are unchanged: opening an address reaches nobody new.
 *
 * Nothing here imports Playwright, and the spawn is injected, so a test never
 * launches a browser.
 */
import path from "node:path";
import { isCiEnv } from "./capture.js";

/** The environment variable that sets `open` for every session of the server. A `scout_attach` `open` may only ask for less than it allows (ADR 25). */
export const OPEN_ENV = "SCENESCOUT_OPEN";

export const OPEN_CHOICES = ["live", "report", "both", "none"] as const;
export type OpenChoice = (typeof OPEN_CHOICES)[number];

/** The environment `open` is decided in. */
export interface OpenContext {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}

export interface OpenDecision {
  live: boolean;
  report: boolean;
  /** Why, in a phrase, for the attach reply. */
  why: string;
  /** Set when an attach's `open` asked for more than the environment allows: the plain line the attach result carries. */
  refused?: string;
}

/** `SCENESCOUT_OPEN`, or undefined when unset. A value outside the choices is refused rather than ignored. */
export function openChoiceFromEnv(env: Record<string, string | undefined>): OpenChoice | undefined {
  const raw = (env[OPEN_ENV] ?? "").trim();
  if (raw === "") return undefined;
  if (!(OPEN_CHOICES as readonly string[]).includes(raw)) throw new Error(`${OPEN_ENV} must be one of ${OPEN_CHOICES.join(", ")}, not ${JSON.stringify(raw)}`);
  return raw as OpenChoice;
}

/**
 * Nobody would see a window opened from here: a session over SSH, where the
 * browser would open on the remote machine if at all, or a Linux or other
 * Unix machine with no display server. macOS and Windows always have one.
 */
function noDisplay(env: Record<string, string | undefined>, platform: NodeJS.Platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  if (platform === "darwin" || platform === "win32") return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

const both = (choice: OpenChoice, why: string): OpenDecision => ({
  live: choice === "live" || choice === "both",
  report: choice === "report" || choice === "both",
  why,
});

/**
 * What opens. The operator outranks the agent (ADR 25), so a `scout_attach`
 * `open` (`asked`) can ask for opening only where the environment allows it:
 * `SCENESCOUT_OPEN=none` refuses it, and so does a detected CI run, an SSH
 * session or a machine with no display, unless `SCENESCOUT_OPEN` itself is set
 * to something else. `SCENESCOUT_OPEN=report` is not widened to the live view
 * by an argument. With no argument, the environment's setting is followed as
 * given; with neither, both open on a local desktop session, whether the
 * session's browser is headed or headless and whatever the MCP client
 * declares: a person in a chat client most needs the page opened. A developer
 * who wants no tabs sets SCENESCOUT_OPEN=none.
 */
export function decideOpen(asked: OpenChoice | undefined, ctx: OpenContext): OpenDecision {
  const fromEnv = openChoiceFromEnv(ctx.env);
  const detected = fromEnv ? undefined : isCiEnv(ctx.env) ? "a CI run" : noDisplay(ctx.env, ctx.platform) ? "no display to show a window on" : undefined;
  if (!asked) {
    if (fromEnv) return both(fromEnv, `${OPEN_ENV} is ${fromEnv}`);
    if (detected) return both("none", detected);
    return both("both", "a local desktop session");
  }
  const wants = both(asked, `open is set to ${asked}`);
  const limit = fromEnv ? both(fromEnv, `${OPEN_ENV} is ${fromEnv}`) : detected ? both("none", detected) : undefined;
  if (!limit) return wants;
  const live = wants.live && limit.live;
  const report = wants.report && limit.report;
  const refused = (wants.live && !live) || (wants.report && !report) ? `${limit.why}, which scout_attach {open: "${asked}"} does not override` : undefined;
  return { live, report, why: refused ? limit.why : wants.why, ...(refused ? { refused } : {}) };
}

/**
 * Whether this attach opens the live view. One address shows every session,
 * so a choice from the environment or the default opens it once per server and
 * a run of many lanes opens one window. An attach that asks for it itself
 * (scout_attach open) is answered every time: the person may have closed the
 * window since.
 */
export function opensLiveView(decision: OpenDecision, askedByAttach: boolean, openedBefore: boolean): boolean {
  return decision.live && (askedByAttach || !openedBefore);
}

/**
 * Only what the engine itself produced may be opened: the live view's
 * loopback address (plain http, no credentials) or an absolute path to a file.
 * Anything else — a remote URL, a relative path, something that could read as
 * an option to the opener — is refused.
 */
export function openableTarget(target: string): boolean {
  if (target === "" || /[\0-\x1f\x7f]/.test(target) || target.startsWith("-")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      return false;
    }
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && !u.username && !u.password;
  }
  return path.isAbsolute(target) || path.win32.isAbsolute(target);
}

/**
 * The platform's opener, run directly with the target as its only argument.
 * Windows' `start` is a cmd.exe built-in and cannot run without a shell, so
 * Windows uses the URL protocol handler `start` itself relies on.
 */
export function openerCommand(platform: NodeJS.Platform, target: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", target] };
  return { command: "xdg-open", args: [target] };
}

/** The part of child_process.spawn the opener needs, so a test can stand in for it. */
export type Spawner = (
  command: string,
  args: string[],
  options: { shell: false; stdio: "ignore"; detached: boolean },
) => { on(event: "error", listener: (err: Error) => void): unknown; unref(): void };

export type OpenOutcome = { ok: true } | { ok: false; why: string };

/**
 * Hand a target to the platform opener. Refuses a target openableTarget does
 * not accept. The opener runs detached and is not waited for; a failure to
 * start it (no xdg-open installed, say) arrives later through onError.
 */
export function openInBrowser(target: string, deps: { platform: NodeJS.Platform; spawn: Spawner; onError: (why: string) => void }): OpenOutcome {
  if (!openableTarget(target)) return { ok: false, why: "only the live view's loopback address or an absolute file path is opened" };
  const { command, args } = openerCommand(deps.platform, target);
  try {
    const child = deps.spawn(command, args, { shell: false, stdio: "ignore", detached: true });
    child.on("error", (err) => deps.onError(`${command} could not start: ${err.message}`));
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, why: `${command} could not start: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** What `scenescout watch` prints when the opener could not start. The address is printed above it either way. */
export const COULD_NOT_OPEN = "Could not open a browser from here. Open the address above yourself.";

/**
 * Open a target for a command-line user, and say so only when it was not
 * opened: nobody would see a window (CI, SSH, no display server), the target
 * was refused, or the opener could not start. The opener is not waited for,
 * so one that keeps running neither holds the command nor reads as a failure;
 * one that starts and then fails on its own goes unreported.
 */
export function openOrSay(
  target: string,
  deps: { env: Record<string, string | undefined>; platform: NodeJS.Platform; spawn: Spawner; say: (line: string) => void },
): void {
  const say = (why: string) => deps.say(`${COULD_NOT_OPEN} (${why})`);
  const { [OPEN_ENV]: _setting, ...env } = deps.env;
  const where = decideOpen(undefined, { env, platform: deps.platform });
  if (!where.live) return say(where.why);
  const outcome = openInBrowser(target, { platform: deps.platform, spawn: deps.spawn, onError: say });
  if (!outcome.ok) say(outcome.why);
}
