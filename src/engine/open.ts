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

/** The environment variable that sets `open` for every session of the server. A `scout_attach` `open` wins over it. */
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
export function noDisplay(env: Record<string, string | undefined>, platform: NodeJS.Platform): boolean {
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
 * What opens. A setting, from the attach or the environment, is followed as
 * given. With none, both open on a local desktop session, whether the
 * session's browser is headed or headless and whatever the MCP client
 * declares: what a client declares is outside this project's control, and a
 * person in a chat client is the one who most needs the page opened. Nothing
 * opens in CI or where no display would show it. A developer who wants no
 * tabs sets SCENESCOUT_OPEN=none.
 */
export function decideOpen(choice: OpenChoice | undefined, ctx: OpenContext): OpenDecision {
  if (choice) return both(choice, `open is set to ${choice}`);
  if (isCiEnv(ctx.env)) return both("none", "a CI run");
  if (noDisplay(ctx.env, ctx.platform)) return both("none", "no display to show a window on");
  return both("both", "a local desktop session");
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
