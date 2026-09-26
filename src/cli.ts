#!/usr/bin/env node
/**
 * SceneScout CLI.
 *
 *   scenescout scan <projectPath>   Print project discovery results
 *   scenescout serve                Run the MCP server on stdio
 *   scenescout install              Install the skill, download the browser, register the MCP server
 *   scenescout doctor               Check every piece of the setup and say how to fix what is missing
 *   scenescout check <url>          Visit every route, measure it, and pass or fail (no model involved)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROX_DISK_MB,
  BROWSER_ENGINES,
  browserPresence,
  defaultAttachNote,
  defaultEngine,
  launchTarget,
  parseBrowserSelection,
  playwrightInstallArgs,
  type BrowserEngineName,
  type BrowserPresence,
  type InstallTarget,
} from "./browsers.js";
import { CLIENT_LABELS, firstMessageHint, manualFor, parseClients, registerWithClient, vscodeBinary, type CodeOnPath, type OtherClient } from "./clients.js";
import {
  CLI_NAME,
  diagnose,
  ensureCommand,
  findOnUserPath,
  installSkill,
  isEphemeralRoot,
  launchCommand,
  manualRegisterCommand,
  planCommand,
  registerMcp,
  resolveClaudeDir,
  spawnRunner,
} from "./installer.js";
import { defaultCheckDir, runCheck } from "./check-run.js";
import { EXIT, formatCheck, parseCheckArgs, summarise, toSarif, toSummaryJson, unmeasuredReason } from "./engine/check.js";
import { LEGACY_MEMORY_DIRNAME, MEMORY_DIRNAME, writeSelfIgnore } from "./engine/memory.js";
import {
  formatStatus,
  liveEngines,
  liveTokenFileName,
  localClock,
  LIVE_TOKEN_FILE,
  pidAlive,
  watchTarget,
  wholeSessions,
  type SessionStatus,
  type StatusFile,
} from "./engine/live.js";
import { formatScan, scanProject } from "./scan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

/** This package's version, as published. */
function packageVersion(): string {
  return (JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string }).version;
}

function usage(exitCode = 1): never {
  // The version beside the name: an old global install is otherwise easy to mistake for this one.
  console.log(`SceneScout ${packageVersion()} — AI exploratory UI testing engine (MCP)

Usage:
  scenescout scan <projectPath>     Discover framework, routes, auth states
  scenescout serve                  Run the MCP server (stdio)
  scenescout install                One-step setup: skill + Chromium + MCP registration
                                    It also puts the \`scenescout\` command on your PATH.
                                    (--skip-browser, --no-register, --no-command to opt out of a step;
                                     --browser-only when the skill and server came from a plugin;
                                     --browsers <list> to choose what to download: chromium (default),
                                     chromium-headless-shell, firefox, webkit, all — comma-separated)
                                    (--client <list> to set up another MCP client instead of, or as well as,
                                     Claude Code: claude-code (default), cursor, vscode, codex, gemini,
                                     copilot, windsurf — comma-separated)
  scenescout doctor                 Check the setup and print the fix for anything missing
                                    (--engine: only node, the build and the browser — for plugin
                                     installs and other MCP clients)
  scenescout check <url>            Visit every route, measure each one, and pass or fail — no model involved,
                                    so it can gate a pull request. Writes report.md, check.sarif and check.json.
                                    (--fail-on high|medium|low|never (default high); --mode observe|read-only;
                                     --max-routes N (default 50); --paths /a,/b to check only those;
                                     --ignore rule,rule; --storage-state file to check signed in;
                                     --project dir (default: here); --out dir (default: .scenescout/check);
                                     --browser chromium|firefox|webkit)
                                    Exit code: 0 passed, 1 failed the gate, 2 could not run.
  scenescout status [projectPath]   What is the engine doing right now? (every session + recent actions)
  scenescout watch [projectPath]    Open the live view in a browser: what each session is doing, a thumbnail
                                    of its page, and a live stream you can switch on per session
                                    (--no-open to print the address only)
`);
  process.exit(exitCode);
}

/**
 * A project last touched before the rename (or one a pre-rename engine is using
 * right now) still keeps its status under the legacy directory.
 */
function statusDir(projectPath: string): string {
  return (
    [MEMORY_DIRNAME, LEGACY_MEMORY_DIRNAME]
      .map((name) => path.join(projectPath, name))
      .find((candidate) => fs.existsSync(path.join(candidate, "status.json"))) ?? path.join(projectPath, MEMORY_DIRNAME)
  );
}

/** null when there is no file; "unreadable" when there is one and it does not parse. */
function readStatusFile(dir: string): StatusFile | "unreadable" | null {
  const statusPath = path.join(dir, "status.json");
  if (!fs.existsSync(statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8")) as StatusFile;
  } catch {
    // status.json is written fire-and-forget on every tool call, so a process
    // killed mid-write leaves a truncated file. That is a diagnosable state,
    // not a reason for the diagnostic tool itself to crash.
    return "unreadable";
  }
}

/** Realtime observability: read the status file + recent action log the running engine maintains. */
function status(projectPath: string): void {
  const dir = statusDir(projectPath);
  const statusPath = path.join(dir, "status.json");
  const st = readStatusFile(dir);
  if (st === null) {
    console.log(`No status file at ${statusPath} — no SceneScout engine has attached to this project (or it predates v0.8).`);
    return;
  }
  if (st === "unreadable") {
    console.log(`Status file at ${statusPath} is unreadable or truncated — the engine was probably killed mid-write. Re-attach to refresh it.`);
    return;
  }
  const alive = pidAlive(st.pid);
  for (const line of formatStatus(st, alive, Date.now())) console.log(line);
  // Recent actions from the newest session log — the "what has it been doing" trail.
  const logs = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.startsWith("session-") && f.endsWith(".jsonl"))
        .sort()
    : [];
  const newest = logs[logs.length - 1];
  if (newest) {
    // Tail-read: the action log grows by one line per engine action (MBs on a
    // long run) and status is a poll target — read only the final chunk.
    const logPath = path.join(dir, newest);
    const size = fs.statSync(logPath).size;
    const buf = Buffer.alloc(Math.min(16384, size));
    const fd = fs.openSync(logPath, "r");
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    const raw = buf.toString("utf8");
    // When the chunk starts mid-file, the first line is probably partial — drop it.
    const text = size > buf.length ? raw.slice(raw.indexOf("\n") + 1) : raw;
    const lines = text.trim().split("\n").slice(-8);
    console.log(`\nRecent actions (${newest}):`);
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { at: string; action: string; target?: string; url: string };
        console.log(`  ${localClock(e.at)} ${e.action}${e.target ? ` ${e.target}` : ""} @ ${e.url}`);
      } catch {
        /* skip malformed line */
      }
    }
  }
}

/** Open the engine's live view. The engine serves it; this only finds the address and hands it to a browser. */
function watch(projectPath: string, open: boolean): void {
  const dir = statusDir(projectPath);
  // Several engines can be attached to one project at once — one per client,
  // say. Each writes its own status and token, so every live board is
  // reachable instead of only whichever attached last.
  const engines = liveEngines(dir, pidAlive);
  const tokenFor = (pid: number): string | null => {
    for (const name of [liveTokenFileName(pid), LIVE_TOKEN_FILE]) {
      try {
        return fs.readFileSync(path.join(dir, name), "utf8");
      } catch {
        // Try the shared name next; watchTarget explains a missing token.
      }
    }
    return null;
  };

  if (engines.length > 1) {
    console.log(`${engines.length} engines are attached to this project:`);
    let shown = 0;
    for (const { pid, status } of engines) {
      const one = watchTarget({ status, alive: true, token: tokenFor(pid) });
      const sessions = wholeSessions(status.detail);
      const who = sessions.length > 0 ? sessions.map((x: SessionStatus) => x.session).join(", ") : (status.session ?? "no session");
      console.log(`\n  pid ${pid} — ${who}`);
      console.log("problem" in one ? `    ${one.problem}` : `    ${one.url}`);
      if (!("problem" in one)) shown += 1;
    }
    console.log("\nEach address holds its own access token: treat them like passwords.");
    if (shown === 0) process.exitCode = 1;
    return;
  }

  const only = engines[0];
  const st = only ? only.status : readStatusFile(dir);
  const target = watchTarget({
    status: st,
    alive: only ? true : st !== null && st !== "unreadable" && pidAlive(st.pid),
    token: tokenFor(only?.pid ?? (typeof st === "object" && st !== null ? (st.pid ?? 0) : 0)),
  });
  if ("problem" in target) {
    console.log(target.problem);
    process.exitCode = 1;
    return;
  }
  console.log(`Live view: ${target.url}`);
  console.log("It is served on this machine only, and the address holds its access token: treat it like a password.");
  if (!open) return;
  const { command, args } = browserOpener(target.url);
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.error || result.status !== 0) console.log("Could not open a browser from here. Open the address above yourself.");
}

/** The platform's own "open this URL" command. */
function browserOpener(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/** Which browser builds are on disk, going by the paths Playwright reports for the version we depend on. */
async function presentBrowsers(): Promise<BrowserPresence> {
  const executables: Record<BrowserEngineName, string | null> = { chromium: null, firefox: null, webkit: null };
  try {
    const playwright = await import("playwright");
    for (const name of BROWSER_ENGINES) executables[name] = playwright[name].executablePath() || null;
  } catch {
    // Playwright cannot be loaded: every build reads as absent, which is what doctor should say.
  }
  return browserPresence(executables);
}

/** Download browser builds through the playwright CLI that ships with our own dependency. */
function downloadBrowsers(targets: readonly InstallTarget[]): boolean {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  const r = spawnSync(process.execPath, [cli, ...playwrightInstallArgs(targets)], { stdio: "inherit" });
  return r.status === 0;
}

/**
 * The value of a flag written as `--name x` or `--name=x`. Undefined when the
 * flag is absent; empty when it was given no value, which includes being
 * followed by another flag.
 */
function flagValue(flags: string[], name: string): string | undefined {
  const inline = flags.find((f) => f.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const at = flags.indexOf(name);
  if (at < 0) return undefined;
  const next = flags[at + 1];
  return next === undefined || next.startsWith("--") ? "" : next;
}

function browsersFlag(flags: string[]): string | undefined {
  // `--browser-only` is a different flag; a bare `--browser` is a slip that would otherwise be ignored and download Chromium.
  const slip = flags.find((f) => f === "--browser" || f.startsWith("--browser="));
  if (slip) throw new Error(`unknown flag ${slip.split("=")[0]} — did you mean --browsers?`);
  return flagValue(flags, "--browsers");
}

/** The `code` command on PATH, with its real path: the real path is what tells VS Code from a fork. */
function codeOnPath(): CodeOnPath | null {
  const names = process.platform === "win32" ? ["code.cmd", "code.exe"] : ["code"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return { command: candidate, realPath: fs.realpathSync(candidate) };
      } catch {
        // An unreadable PATH entry is not a VS Code install.
      }
    }
  }
  return null;
}

/** Every value given for a flag, across repeats and both spellings, joined the way one comma-separated value would be. */
function flagValues(flags: string[], names: string[]): string | undefined {
  const values: string[] = [];
  flags.forEach((f, i) => {
    for (const name of names) {
      if (f.startsWith(`${name}=`)) values.push(f.slice(name.length + 1));
      else if (f === name) {
        const next = flags[i + 1];
        values.push(next === undefined || next.startsWith("--") ? "" : next);
      }
    }
  });
  if (values.length === 0) return undefined;
  // One occurrence without a value is a mistake even when another has one.
  return values.some((v) => v.trim() === "") ? "" : values.join(",");
}

async function install(flags: string[]): Promise<void> {
  const serverPath = path.join(packageRoot, "dist", "mcp-server.js");
  if (!fs.existsSync(serverPath)) {
    throw new Error(`${serverPath} is missing — run \`npm run build\` first.`);
  }

  // A step that fails is reported AND fails the command: `setup && next-step`
  // must not carry on past a missing browser or an unregistered server.
  let failed = false;
  // A plugin install already brings the skill and the server registration; the
  // only thing it cannot bring is the browser download.
  const browserOnly = flags.includes("--browser-only");
  // Read the choice before doing anything, so a typo costs nothing.
  const selection = parseBrowserSelection(browsersFlag(flags));
  if ("error" in selection) throw new Error(selection.error);
  const chosen = parseClients(flagValues(flags, ["--client", "--clients"]));
  if ("error" in chosen) throw new Error(chosen.error);
  const forClaude = chosen.clients.includes("claude-code");
  const others = chosen.clients.filter((c): c is OtherClient => c !== "claude-code");
  // The skill is Claude Code's way of receiving the method; every other client gets it from the server.
  if (!browserOnly && forClaude) {
    const skill = installSkill({ packageRoot, claudeDir: resolveClaudeDir(process.env, os.homedir()) });
    for (const note of skill.notes) console.log(`· ${note}`);
    console.log(
      skill.mode === "symlink"
        ? `✓ Skill installed (symlink): ${skill.dest} → ${skill.src}`
        : `✓ Skill installed (copy): ${skill.dest} — re-run install after upgrading SceneScout.`,
    );
  }

  if (flags.includes("--skip-browser")) {
    console.log("· Browser download skipped (--skip-browser).");
  } else {
    const present = await presentBrowsers();
    const missing = selection.targets.filter((t) => !present[t].installed);
    for (const t of selection.targets) if (present[t].installed) console.log(`✓ ${t} already present: ${present[t].path}`);
    if (missing.length > 0) {
      const size = missing.reduce((sum, t) => sum + APPROX_DISK_MB[t], 0);
      console.log(`· Downloading ${missing.join(", ")} (one-time, about ${size} MB on disk)…`);
      if (downloadBrowsers(missing)) console.log(`✓ Downloaded: ${missing.join(", ")}.`);
      else {
        failed = true;
        console.log(`✗ Browser download failed — run \`npx playwright install ${missing.join(" ")}\` and check your network/proxy.`);
      }
    }
  }

  // Downloading a browser the server will not launch leaves the first attach failing with no hint why.
  const engine = defaultEngine(process.env);
  const note = defaultAttachNote({
    selected: flags.includes("--skip-browser") ? [] : selection.targets,
    defaultEngine: engine,
    defaultInstalled: (await presentBrowsers())[launchTarget(engine, false)].installed,
  });
  if (note) console.log(`· Note: ${note}`);

  const launch = launchCommand({ packageRoot, nodePath: process.execPath, serverPath });
  if (browserOnly) {
    // nothing to register
  } else if (flags.includes("--no-register")) {
    console.log("· MCP registration skipped (--no-register). To do it by hand:\n");
    if (forClaude) console.log(`  ${manualRegisterCommand(launch)}`);
    for (const client of others) console.log(`  ${CLIENT_LABELS[client]}: ${manualFor(client, launch, os.homedir())}`);
    console.log("");
  } else {
    if (forClaude) {
      const reg = registerMcp({ launch, serverPath, run: spawnRunner });
      if (reg.status === "registered") {
        console.log(`✓ MCP server ${reg.replaced ? "re-registered (paths refreshed)" : "registered"} with Claude Code at user scope.`);
        for (const name of reg.removedLegacy) console.log(`· removed the pre-rename MCP registration "${name}" (it pointed at this same server).`);
        for (const note of reg.notes) console.log(`· ${note}`);
      } else {
        failed = true;
        console.log(
          reg.status === "claude-missing"
            ? "· `claude` is not on this shell's PATH, so the MCP server was not registered."
            : `✗ \`claude mcp add\` failed: ${reg.detail}`,
        );
        console.log(`  Run this once from a terminal where \`claude\` works:\n\n  ${reg.manual}\n`);
      }
    }
    const vscode = others.includes("vscode")
      ? vscodeBinary({ platform: process.platform, home: os.homedir(), exists: fs.existsSync, codeOnPath: codeOnPath() })
      : null;
    for (const client of others) {
      const reg = registerWithClient(client, { launch, home: os.homedir(), run: spawnRunner, vscode });
      const label = CLIENT_LABELS[client];
      if (reg.status === "registered") {
        console.log(`✓ MCP server ${reg.replaced ? "re-registered" : "registered"} with ${label} (${reg.where}).`);
        for (const note of reg.notes) console.log(`· ${note}`);
      } else {
        failed = true;
        // On Windows a client installed through npm is a .cmd shim, which node cannot start directly.
        const windowsNote = process.platform === "win32" ? " (or it is installed as a .cmd shim, which cannot be started from here)" : "";
        console.log(
          reg.status === "client-missing"
            ? `· ${label} was not found on this machine${windowsNote}, so nothing was registered with it.`
            : `✗ Registering with ${label} failed: ${reg.detail}`,
        );
        console.log(`  To do it by hand, ${reg.manual}\n`);
      }
    }
  }

  // `scenescout status`, `watch` and `doctor` are typed by a person, and neither
  // a checkout nor an npx run leaves the command on PATH. Not having it costs
  // convenience, never a working setup, so this step reports and does not fail.
  let cli = isEphemeralRoot(packageRoot) ? `npx -y ${CLI_NAME}` : `node ${path.join(packageRoot, "dist", "cli.js")}`;
  if (browserOnly) {
    // a plugin install has no package of its own to put on PATH
  } else if (flags.includes("--no-command")) {
    console.log(`· Putting \`${CLI_NAME}\` on PATH skipped (--no-command). Until then the command is:  ${cli}`);
  } else {
    const onPath = (): string | null =>
      findOnUserPath({ names: process.platform === "win32" ? [`${CLI_NAME}.cmd`] : [CLI_NAME], pathValue: process.env.PATH ?? "" });
    const done = ensureCommand(
      planCommand({ packageRoot, nodePath: process.execPath, version: packageVersion(), resolved: onPath(), platform: process.platform }),
      spawnRunner,
    );
    if (done.status === "present") {
      cli = CLI_NAME;
      console.log(`✓ \`${CLI_NAME}\` command already on PATH: ${done.at}`);
    } else if (done.status === "installed") {
      const at = onPath();
      if (at) cli = CLI_NAME;
      const what = done.how === "link" ? "linked to this checkout, so it runs whatever was last built" : "installed globally";
      console.log(
        at
          ? `✓ \`${CLI_NAME}\` command ${what}: ${at}${done.replaced ? `   (it replaces ${done.replaced})` : ""}`
          : `· \`${CLI_NAME}\` was ${what}, but npm's global bin directory is not on this shell's PATH. Add it (\`npm prefix -g\` names it; the commands are in its bin folder), or use:  ${cli}`,
      );
    } else {
      console.log(`· \`${CLI_NAME}\` was not put on PATH (${done.detail}). To do it by hand:  ${done.manual}\n  Until then the command is:  ${cli}`);
    }
  }

  if (failed) {
    console.log(`\nSetup is incomplete — fix the lines marked ✗ or · above, then run:  ${cli} doctor${forClaude ? "" : " --engine"}`);
    process.exitCode = 1;
    return;
  }
  if (browserOnly) {
    console.log("\nThe browser is ready — attach again.");
    return;
  }
  if (forClaude) console.log("\nStart a FRESH Claude Code session, then in any project run:  /scenescout");
  // Telling someone to restart a client nothing was registered with sends them looking for a server that is not there.
  if (others.length > 0 && !flags.includes("--no-register")) console.log(`\n${firstMessageHint(others)}`);
  console.log(`Something off? Run:  ${cli} doctor${forClaude ? "" : " --engine"}`);
}

async function doctor(flags: string[]): Promise<void> {
  const checks = diagnose({
    scope: flags.includes("--engine") ? "engine" : "claude-code",
    packageRoot,
    claudeDir: resolveClaudeDir(process.env, os.homedir()),
    nodeVersion: process.version,
    // What a default attach launches: the headless build of the default browser.
    defaultBrowser: await (async () => {
      const target = launchTarget(defaultEngine(process.env), false);
      const found = (await presentBrowsers())[target];
      return { target, path: found.installed ? found.path : null, expected: found.path };
    })(),
    run: spawnRunner,
  });
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
    if (!c.ok && c.fix) console.log(`    fix: ${c.fix}`);
  }
  if (checks.some((c) => !c.ok)) process.exit(1);
  console.log(
    flags.includes("--engine")
      ? "\nAll good. Ask your agent:  Use SceneScout to test http://localhost:3000"
      : "\nAll good. In any project, run:  /scenescout   (or ask: Use SceneScout to test http://localhost:3000)",
  );
}

/** `scenescout check`: exit 0 passed, 1 failed the gate, 2 could not run. */
async function check(args: string[]): Promise<never> {
  if (args.includes("--help") || args.includes("-h")) usage(0);
  const parsed = parseCheckArgs(args, process.cwd());
  if (!parsed.ok) {
    console.error(`scenescout check: ${parsed.error}`);
    process.exit(EXIT.error);
  }
  const options = parsed.options;
  const outDir = options.outDir ?? defaultCheckDir(options.projectDir);
  let result;
  try {
    console.log(`Checking ${options.url} …`);
    result = await runCheck(options, (line) => console.log(line));
  } catch (err) {
    console.error(`scenescout check: could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT.error);
  }
  const unmeasured = unmeasuredReason(result.routes, !options.paths);
  if (unmeasured) {
    console.error(`scenescout check: could not measure ${options.url}: ${unmeasured}`);
    process.exit(EXIT.error);
  }
  const markdown = formatCheck(result);
  try {
    const version = packageVersion();
    if (!options.outDir) writeSelfIgnore(path.dirname(outDir));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "report.md"), markdown);
    fs.writeFileSync(path.join(outDir, "check.sarif"), JSON.stringify(toSarif(result, version), null, 2) + "\n");
    fs.writeFileSync(path.join(outDir, "check.json"), JSON.stringify(toSummaryJson(result, version), null, 2) + "\n");
    // On GitHub Actions the verdict also goes on the run's summary page.
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  } catch (err) {
    // A verdict nobody can read is not a pass or a fail: exit as "could not run", never as the gate's 1.
    console.error(`scenescout check: could not write the results to ${outDir}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT.error);
  }
  console.log("\n" + markdown);
  console.log(`Wrote report.md, check.sarif and check.json to ${outDir}`);
  process.exit(summarise(result).passed ? EXIT.pass : EXIT.gateFailed);
}

const [, , command, ...args] = process.argv;

// A CLI's failure mode should be a sentence, not a stack trace. `scan` on a
// path that does not exist and `status` on a half-written status.json both
// throw ordinary Errors; unguarded, they printed a V8 trace that buries the
// one line the user needs. `serve` is deliberately outside this: it hands off
// to the MCP server, whose own transport owns error reporting from then on.
try {
  switch (command) {
    // Asking for help is not an error; scripts and shells treat a non-zero
    // exit as one.
    case "--help":
    case "-h":
    case "help":
      usage(0);
    case "--version":
    case "-v": {
      console.log(packageVersion());
      break;
    }
    case "scan": {
      const target = args[0];
      if (!target) usage();
      console.log(formatScan(scanProject(target)));
      break;
    }
    case "serve": {
      await import("./mcp-server.js");
      break;
    }
    case "install": {
      await install(args);
      break;
    }
    case "doctor": {
      await doctor(args);
      break;
    }
    case "check": {
      await check(args);
      break;
    }
    case "status": {
      status(path.resolve(args[0] ?? process.cwd()));
      break;
    }
    case "watch": {
      const positional = args.filter((a) => !a.startsWith("--"));
      watch(path.resolve(positional[0] ?? process.cwd()), !args.includes("--no-open"));
      break;
    }
    default:
      usage();
  }
} catch (err) {
  console.error(`scenescout ${command ?? ""}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
