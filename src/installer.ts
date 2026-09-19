/**
 * Setup logic behind `scenescout install` and `scenescout doctor`.
 *
 * It lives outside cli.ts for the same reason engine rules live outside
 * browser.ts: every function here takes its environment (home directory,
 * command runner) as an argument, so a test can point it at a temp dir and a
 * fake `claude` binary instead of mutating the developer's real ~/.claude.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { engineOf, type InstallTarget } from "./browsers.js";

export const SKILL_NAME = "scenescout";
export const MCP_NAME = "scenescout";
/** Names this tool's skill and MCP server had before renames; cleaned up on install so the old slash command and a duplicate tool set do not linger. */
const LEGACY_SKILL_NAMES = ["frontend-tester", "scenecraft"];
const LEGACY_MCP_NAMES = ["scenecraft"];

export type RunResult = { status: number | null; stdout: string; stderr: string; missing: boolean };
export type Runner = (command: string, args: string[], opts?: { cwd?: string }) => RunResult;

/** Real runner. `missing` separates "the binary is not installed" from "it ran and failed". */
export const spawnRunner: Runner = (command, args, opts) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 60_000, cwd: opts?.cwd });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  // On Windows node refuses to start a .cmd or .bat file directly (EINVAL). For
  // the caller that is the same situation as a missing binary: nothing ran, and
  // the command has to be handed to the person instead.
  const missing = code === "ENOENT" || (process.platform === "win32" && code === "EINVAL");
  // With `encoding` set, a command that never ran still yields "" for stderr: the error is the only account of it.
  const stderr = r.stderr || (code === "ETIMEDOUT" ? "npm did not finish within 60 s" : r.error ? String(r.error.message) : "");
  return { status: r.status, stdout: r.stdout ?? "", stderr, missing };
};

export type SkillInstall = { mode: "symlink" | "copy"; dest: string; src: string; notes: string[] };

/** Written into a copy-mode install so a later install can tell its own copy from a user's directory. */
const OWNERSHIP_MARKER = ".installed-by-scenescout";
/** Every marker any version has written; a copy made under an earlier name is still ours to replace. */
const OWNERSHIP_MARKERS = [OWNERSHIP_MARKER, ".installed-by-scenecraft"];

/**
 * An npx run executes from a cache directory that npm may delete at any time;
 * a symlink into it would dangle. Everything else (a clone, a global install)
 * is stable, and a symlink there keeps skill edits live.
 */
export function isEphemeralRoot(packageRoot: string): boolean {
  return packageRoot.split(path.sep).includes("_npx");
}

/** Where Claude Code keeps user-level config; it honours CLAUDE_CONFIG_DIR, so install must too. */
export function resolveClaudeDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, ".claude");
}

/**
 * Did a SceneScout install put this entry here? A symlink is only ever ours
 * (it is a pointer, deleting it loses nothing); a real directory is ours only
 * if it carries the marker a copy-mode install writes. Anything else may be
 * the user's own work, and an installer has no business deleting that.
 */
function isOurs(entry: string): boolean {
  const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink()) return true;
  return stat.isDirectory() && OWNERSHIP_MARKERS.some((marker) => fs.existsSync(path.join(entry, marker)));
}

/**
 * Remove an entry isOurs() vouched for. A link is unlinked, never rm'd: with
 * `force`, a recursive rm of a DANGLING link stats the missing target, swallows
 * the ENOENT, and leaves the link in place — and a dangling link is exactly
 * what a moved or deleted checkout leaves behind.
 */
function removeOwned(entry: string): void {
  if (fs.lstatSync(entry).isSymbolicLink()) fs.unlinkSync(entry);
  else fs.rmSync(entry, { recursive: true, force: true });
}

export function installSkill(opts: { packageRoot: string; claudeDir: string; now?: () => number }): SkillInstall {
  const src = path.join(opts.packageRoot, "skills", SKILL_NAME);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) {
    throw new Error(`skill source not found at ${src} — is this a complete SceneScout checkout?`);
  }
  const skillsDir = path.join(opts.claudeDir, "skills");
  const dest = path.join(skillsDir, SKILL_NAME);
  const notes: string[] = [];
  fs.mkdirSync(skillsDir, { recursive: true });

  for (const name of LEGACY_SKILL_NAMES) {
    const legacy = path.join(skillsDir, name);
    if (isOurs(legacy)) {
      removeOwned(legacy);
      notes.push(`removed the pre-rename skill at ${legacy}`);
    } else if (fs.lstatSync(legacy, { throwIfNoEntry: false })) {
      notes.push(`left ${legacy} alone — it was not installed by SceneScout; delete it yourself if it is the old skill`);
    }
  }

  if (isOurs(dest)) {
    removeOwned(dest);
  } else if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
    // Not provably ours: move it aside instead of deleting someone's edits.
    const backup = `${dest}.backup-${(opts.now ?? Date.now)()}`;
    fs.renameSync(dest, backup);
    notes.push(`an existing ${dest} was not installed by SceneScout — moved it to ${backup}`);
  }

  if (!isEphemeralRoot(opts.packageRoot)) {
    try {
      fs.symlinkSync(src, dest, "dir");
      return { mode: "symlink", dest, src, notes };
    } catch {
      // Symlinks need elevated rights on stock Windows — fall through to a copy.
    }
  }
  fs.cpSync(src, dest, { recursive: true });
  fs.writeFileSync(path.join(dest, OWNERSHIP_MARKER), "Managed by `scenescout install`; re-running it replaces this directory.\n");
  return { mode: "copy", dest, src, notes };
}

/** POSIX-shell quoting for the command we print; never used to execute anything. */
function quote(arg: string): string {
  return /^[A-Za-z0-9_\/.:=@-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The arguments after `--` that start the published package through npx. */
export const NPX_SERVE_ARGS = ["-y", "scenescout", "serve"];

/**
 * The command Claude Code should run to start the server.
 *
 * From a stable location (a clone, a global install) that is this node binary
 * plus the server script. From an npx run it must NOT be: the script then lives
 * in npm's cache, which npm may clear at any time, leaving a registration that
 * silently stops working. There the launcher is `npx -y scenescout serve`,
 * which fetches the package again if it has to.
 *
 * Both use an ABSOLUTE binary path: Claude Code's launch environment often
 * lacks the shell PATH (nvm/fnm), and a bare "node" or "npx" fails to start.
 */
export function launchCommand(opts: { packageRoot: string; nodePath: string; serverPath: string }): string[] {
  if (!isEphemeralRoot(opts.packageRoot)) return [opts.nodePath, opts.serverPath];
  const npx = path.join(path.dirname(opts.nodePath), process.platform === "win32" ? "npx.cmd" : "npx");
  // Some Node installs ship without npm beside the binary; a bare "npx" that
  // resolves on PATH is better than an absolute path to nothing.
  return [fs.existsSync(npx) ? npx : "npx", ...NPX_SERVE_ARGS];
}

export function mcpAddArgs(launch: string[]): string[] {
  return ["mcp", "add", "--scope", "user", MCP_NAME, "--", ...launch];
}

export function manualRegisterCommand(launch: string[]): string {
  return ["claude", ...mcpAddArgs(launch)].map(quote).join(" ");
}

export type McpRegistration =
  | { status: "registered"; replaced: boolean; removedLegacy: string[]; notes: string[] }
  | { status: "claude-missing"; manual: string }
  | { status: "failed"; manual: string; detail: string };

/**
 * Register the MCP server with Claude Code. Idempotent: an existing
 * registration under our name is replaced, so re-running install after moving
 * the checkout or switching node versions repairs the stored paths.
 */
export function registerMcp(opts: { launch: string[]; serverPath: string; run: Runner }): McpRegistration {
  const manual = manualRegisterCommand(opts.launch);
  const add = () => opts.run("claude", mcpAddArgs(opts.launch));
  let result = add();
  if (result.missing) return { status: "claude-missing", manual };
  let replaced = false;
  const notes: string[] = [];
  if (result.status !== 0 && /already exists/i.test(result.stderr + result.stdout)) {
    // Look before replacing. The usual case is our own earlier registration
    // with a stale path, which is replaced quietly. A registration that runs
    // something else — a second checkout, a fork — is still replaced, because
    // one name can hold one server, but the user is told what it ran so they
    // can put it back.
    const previous = describeOtherRegistration(opts);
    if (previous) notes.push(previous);
    const removed = opts.run("claude", ["mcp", "remove", "--scope", "user", MCP_NAME]);
    if (removed.status !== 0) {
      return { status: "failed", manual, detail: (removed.stderr || removed.stdout).trim() };
    }
    replaced = true;
    result = add();
  }
  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout).trim();
    // Say so when the failure left the user worse off than before we started.
    const detail = replaced ? `the previous registration was removed, and re-adding it failed: ${reason}` : reason;
    return { status: "failed", manual, detail };
  }
  const legacy = removeLegacyRegistrations(opts);
  return { status: "registered", replaced, removedLegacy: legacy.removedLegacy, notes: [...notes, ...legacy.notes] };
}

/**
 * A note describing the registration about to be replaced, when it starts
 * something other than this install. Null when it is ours (same server script,
 * or the same npx launcher), or when it cannot be read — an unreadable listing
 * is not evidence of somebody else's server.
 */
function describeOtherRegistration(opts: { launch: string[]; serverPath: string; run: Runner }): string | null {
  const got = opts.run("claude", ["mcp", "get", MCP_NAME]);
  if (got.missing || got.status !== 0) return null;
  const { command, serverPath: args } = parseRegistration(got.stdout + got.stderr);
  if (args === null) return null;
  const sameScript = samePath(args, opts.serverPath);
  const sameNpx = args === NPX_SERVE_ARGS.join(" ");
  if (sameScript || sameNpx) return null;
  return `replaced an existing "${MCP_NAME}" registration that ran something else: ${[command, args].filter(Boolean).join(" ")} — re-register that one under a different name if you still need it`;
}

/**
 * Drop a registration left under a pre-rename name — but only one that points
 * at THIS server. Left in place it loads the same engine twice, and the agent
 * sees every tool in duplicate. A same-named server pointing anywhere else is
 * somebody's own and is not touched. Best-effort: a failure here leaves a
 * working (if duplicated) setup, so it never fails the install.
 */
function removeLegacyRegistrations(opts: { serverPath: string; run: Runner }): { removedLegacy: string[]; notes: string[] } {
  const removedLegacy: string[] = [];
  const notes: string[] = [];
  for (const name of LEGACY_MCP_NAMES) {
    const got = opts.run("claude", ["mcp", "get", name]);
    if (got.missing || got.status !== 0) continue;
    const listing = got.stdout + got.stderr;
    const { serverPath } = parseRegistration(listing);
    if (serverPath === null || !samePath(serverPath, opts.serverPath)) continue;
    // Name the scope `get` reported: an unscoped remove is refused when the
    // same name exists in more than one.
    const scope = /^[ \t]*Scope:[ \t]*(User|Local|Project)\b/im.exec(listing)?.[1].toLowerCase();
    const removed = opts.run("claude", ["mcp", "remove", ...(scope ? ["--scope", scope] : []), name]);
    if (removed.status === 0) removedLegacy.push(name);
    else
      notes.push(
        `the pre-rename MCP registration "${name}" points at this same server and could not be removed — every tool will appear twice until you run: claude mcp remove ${name}`,
      );
  }
  return { removedLegacy, notes };
}

/**
 * Do two paths name the same file? A stored registration is compared by real
 * path, not by spelling: the same install is routinely reachable through a
 * symlink, and on a case-insensitive filesystem through a differently-cased
 * path. Comparing strings reported both as "pointing elsewhere".
 */
export function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** The launch command and server script a `claude mcp get` listing names; null for whatever it does not show. */
export function parseRegistration(listing: string): { command: string | null; serverPath: string | null } {
  const field = (name: string) => new RegExp(`^[ \\t]*${name}:[ \\t]*(\\S.*?)[ \\t]*$`, "m").exec(listing)?.[1] ?? null;
  return { command: field("Command"), serverPath: field("Args") };
}

/** The command the package's `bin` entry provides. */
export const CLI_NAME = "scenescout";

const isCheckoutRoot = (packageRoot: string): boolean => fs.existsSync(path.join(packageRoot, "tsconfig.json")) && fs.existsSync(path.join(packageRoot, "src"));

/**
 * Where a command resolves in the user's own shell, or null.
 *
 * npm and npx put `node_modules/.bin` directories on PATH for the length of a
 * run. Under `npx scenescout install` that makes the command appear installed
 * when it will be gone the moment the run ends, so those entries are skipped.
 */
export function findOnUserPath(opts: { names: readonly string[]; pathValue: string; delimiter?: string; exists?: (p: string) => boolean }): string | null {
  const exists = opts.exists ?? fs.existsSync;
  for (const dir of opts.pathValue.split(opts.delimiter ?? path.delimiter).filter(Boolean)) {
    if (/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(dir)) continue;
    for (const name of opts.names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export type CommandPlan =
  | { action: "present"; at: string }
  | { action: "run"; how: "link" | "global"; command: string; args: string[]; cwd?: string; manual: string; replaces: string | null }
  | { action: "manual"; manual: string; why: string };

/**
 * What it takes for `scenescout` to work as a command in a terminal.
 *
 * The MCP registration never needed that: it stores an absolute launcher. But
 * `scenescout status` and `scenescout watch` are typed by a person, and both a
 * source checkout and an npx run leave nothing on PATH, so the commands the
 * tool itself recommends answered "command not found".
 *
 * A checkout is linked, so the command always runs what was last built. Any
 * other install gets the same version installed globally. A checkout takes the
 * name over from another copy, the way it takes over the MCP registration; a
 * packaged install leaves an existing command alone.
 */
export function planCommand(opts: { packageRoot: string; nodePath: string; version: string; resolved: string | null; platform: NodeJS.Platform }): CommandPlan {
  const checkout = isCheckoutRoot(opts.packageRoot);
  const manual = checkout ? `npm link   (run in ${opts.packageRoot})` : `npm install -g ${CLI_NAME}@${opts.version}`;
  if (opts.resolved !== null) {
    const mine = samePath(opts.resolved, path.join(opts.packageRoot, "dist", "cli.js"));
    if (mine || !checkout) return { action: "present", at: opts.resolved };
  }
  // npm on Windows is a .cmd shim, which node cannot start directly.
  if (opts.platform === "win32") return { action: "manual", manual, why: "this step cannot start npm on Windows" };
  const beside = path.join(path.dirname(opts.nodePath), "npm");
  // The npm beside the running node installs into that node's prefix, which is
  // the one whose bin directory the shell that started us already has on PATH.
  const npm = fs.existsSync(beside) ? beside : "npm";
  return checkout
    ? { action: "run", how: "link", command: npm, args: ["link"], cwd: opts.packageRoot, manual, replaces: opts.resolved }
    : { action: "run", how: "global", command: npm, args: ["install", "-g", `${CLI_NAME}@${opts.version}`], manual, replaces: null };
}

export type CommandResult =
  | { status: "present"; at: string }
  | { status: "installed"; how: "link" | "global"; replaced: string | null }
  | { status: "failed"; manual: string; detail: string };

export function ensureCommand(plan: CommandPlan, run: Runner): CommandResult {
  if (plan.action === "present") return { status: "present", at: plan.at };
  if (plan.action === "manual") return { status: "failed", manual: plan.manual, detail: plan.why };
  const r = run(plan.command, plan.args, { cwd: plan.cwd });
  if (r.missing) return { status: "failed", manual: plan.manual, detail: "npm was not found" };
  if (r.status !== 0) {
    // A system-wide node owns its prefix as root; that is the usual reason, and
    // the last line of npm's output names it. With no output at all (a timeout,
    // a kill) the exit is all there is to say.
    const lines = (r.stderr || r.stdout).trim().split("\n");
    return {
      status: "failed",
      manual: plan.manual,
      detail: lines.find((l) => /EACCES|EPERM|ERR!/.test(l))?.trim() || lines[lines.length - 1] || `npm exited ${r.status ?? "without finishing"}`,
    };
  }
  return { status: "installed", how: plan.how, replaced: plan.replaces };
}

/**
 * The command that repairs a setup, for THIS kind of install. A source checkout
 * has `npm run setup`; someone who installed from npm has no such script, and
 * telling them to run it sends them looking for a package.json they never had.
 */
export function repairCommands(packageRoot: string): { setup: string; build: string; browser: (target: InstallTarget) => string } {
  const isCheckout = isCheckoutRoot(packageRoot);
  // Installing "chromium" brings the headless shell with it, so the plain
  // setup command already repairs either Chromium build.
  const browserFlags = (target: InstallTarget) => (engineOf(target) === "chromium" ? "" : ` --browser-only --browsers ${target}`);
  return isCheckout
    ? {
        setup: "npm run setup",
        build: "npm run build",
        browser: (target) => (browserFlags(target) ? `node dist/cli.js install${browserFlags(target)}` : "npm run setup"),
      }
    : {
        setup: "npx -y scenescout install",
        build: "npx -y scenescout@latest install   (the installed package is incomplete; fetch it again)",
        browser: (target) => `npx -y scenescout install${browserFlags(target)}`,
      };
}

export type Check = { name: string; ok: boolean; detail: string; fix?: string };

/** Everything a working setup needs, each with the command that repairs it. */
export function diagnose(opts: {
  /**
   * "engine" checks only what every install needs (node, the build, the
   * browser). The skill and the `claude mcp` registration are checked for the
   * default "claude-code" scope only: a plugin install gets both from the
   * plugin, and another MCP client has neither, so reporting them as failures
   * there would send the user to fix something that is not broken.
   */
  scope?: "claude-code" | "engine";
  packageRoot: string;
  claudeDir: string;
  nodeVersion: string;
  /**
   * The build a default attach launches, and where it was found. `path` is null
   * when it is not on disk; `expected` is where Playwright looks for it.
   */
  defaultBrowser: { target: InstallTarget; path: string | null; expected?: string | null };
  run: Runner;
}): Check[] {
  const checks: Check[] = [];
  const repair = repairCommands(opts.packageRoot);
  const major = Number(opts.nodeVersion.replace(/^v/, "").split(".")[0]);
  checks.push({ name: "node >= 20", ok: major >= 20, detail: opts.nodeVersion, fix: "install Node 20 or newer" });

  const server = path.join(opts.packageRoot, "dist", "mcp-server.js");
  checks.push({ name: "engine built", ok: fs.existsSync(server), detail: server, fix: repair.build });

  const browser = opts.defaultBrowser;
  checks.push({
    name: `browser downloaded (${browser.target})`,
    ok: browser.path !== null,
    detail: browser.path ?? (browser.expected ? `not found at ${browser.expected}` : "playwright could not name a browser path"),
    fix: `${repair.browser(browser.target)}   (or: npx playwright install ${browser.target})`,
  });

  if (opts.scope === "engine") return checks;

  const skill = path.join(opts.claudeDir, "skills", SKILL_NAME, "SKILL.md");
  checks.push({ name: "skill installed", ok: fs.existsSync(skill), detail: skill, fix: repair.setup });

  const got = opts.run("claude", ["mcp", "get", MCP_NAME]);
  if (got.missing) {
    checks.push({
      name: "claude CLI on PATH",
      ok: false,
      detail: "`claude` not found",
      fix: "install Claude Code, or register the server by hand (see README)",
    });
  } else {
    const listing = got.stdout + got.stderr;
    if (got.status !== 0) {
      checks.push({ name: "MCP server registered", ok: false, detail: "no server named scenescout", fix: repair.setup });
    } else {
      const { command, serverPath } = parseRegistration(listing);
      if (serverPath === null) {
        // An unreadable listing is not evidence of a wrong install; claiming so
        // would produce a failure that re-running install can never clear.
        checks.push({ name: "MCP server registered", ok: true, detail: "registered (could not read its path from `claude mcp get` to verify it)" });
      } else if (serverPath === NPX_SERVE_ARGS.join(" ")) {
        // Registered through npx: there is no script path to compare, only the launcher to vet.
        const absolute = command !== null && path.isAbsolute(command);
        checks.push({
          name: "MCP server registered",
          ok: absolute,
          detail: absolute ? `via ${command} ${serverPath}` : `registered with a bare \`${command}\` command, which Claude Code may not find on its PATH`,
          fix: repair.setup,
        });
      } else if (!samePath(serverPath, server)) {
        // The usual aftermath of moving or deleting a checkout.
        checks.push({ name: "MCP server registered", ok: false, detail: `registered, but pointing at ${serverPath} — not this install`, fix: repair.setup });
      } else if (command !== null && !path.isAbsolute(command)) {
        // A bare "node" resolves in your shell and then fails inside Claude
        // Code, whose launch environment often lacks the nvm/fnm PATH.
        checks.push({
          name: "MCP server registered",
          ok: false,
          detail: `registered with a bare \`${command}\` command, which Claude Code may not find on its PATH`,
          fix: repair.setup,
        });
      } else {
        checks.push({ name: "MCP server registered", ok: true, detail: server });
      }
    }
  }
  return checks;
}
