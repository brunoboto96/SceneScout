#!/usr/bin/env node
/**
 * SceneScout CLI.
 *
 *   scenescout scan <projectPath>   Print project discovery results
 *   scenescout serve                Run the MCP server on stdio
 *   scenescout install              Install the skill, download the browser, register the MCP server
 *   scenescout doctor               Check every piece of the setup and say how to fix what is missing
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
  defaultEngine,
  launchTarget,
  parseBrowserSelection,
  playwrightInstallArgs,
  type BrowserEngineName,
  type BrowserPresence,
  type InstallTarget,
} from "./browsers.js";
import { diagnose, installSkill, launchCommand, manualRegisterCommand, registerMcp, resolveClaudeDir, spawnRunner } from "./installer.js";
import { LEGACY_MEMORY_DIRNAME, MEMORY_DIRNAME } from "./engine/memory.js";
import { formatScan, scanProject } from "./scan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

function usage(exitCode = 1): never {
  console.log(`SceneScout — AI exploratory UI testing engine (MCP)

Usage:
  scenescout scan <projectPath>     Discover framework, routes, auth states
  scenescout serve                  Run the MCP server (stdio)
  scenescout install                One-step setup: skill + Chromium + MCP registration
                                    (--skip-browser, --no-register to opt out of a step;
                                     --browser-only when the skill and server came from a plugin;
                                     --browsers <list> to choose what to download: chromium (default),
                                     chromium-headless-shell, firefox, webkit, all — comma-separated)
  scenescout doctor                 Check the setup and print the fix for anything missing
                                    (--engine: only node, the build and the browser — for plugin
                                     installs and other MCP clients)
  scenescout status [projectPath]   What is the engine doing right now? (live status + recent actions)
`);
  process.exit(exitCode);
}

/** Realtime observability: read the status file + recent action log the running engine maintains. */
function status(projectPath: string): void {
  // A project last touched before the rename (or one a pre-rename engine is
  // using right now) still keeps its status under the legacy directory.
  const dir =
    [MEMORY_DIRNAME, LEGACY_MEMORY_DIRNAME]
      .map((name) => path.join(projectPath, name))
      .find((candidate) => fs.existsSync(path.join(candidate, "status.json"))) ?? path.join(projectPath, MEMORY_DIRNAME);
  const statusPath = path.join(dir, "status.json");
  if (!fs.existsSync(statusPath)) {
    console.log(`No status file at ${statusPath} — no SceneScout engine has attached to this project (or it predates v0.8).`);
    return;
  }
  type Status = {
    pid?: number;
    phase?: string;
    tool?: string;
    session?: string;
    role?: string;
    sessions?: string[];
    url?: string;
    at?: string;
  };
  let st: Status;
  try {
    st = JSON.parse(fs.readFileSync(statusPath, "utf8")) as Status;
  } catch {
    // status.json is written fire-and-forget on every tool call, so a process
    // killed mid-write leaves a truncated file. That is a diagnosable state,
    // not a reason for the diagnostic tool itself to crash.
    console.log(`Status file at ${statusPath} is unreadable or truncated — the engine was probably killed mid-write. Re-attach to refresh it.`);
    return;
  }
  let alive = false;
  if (st.pid) {
    try {
      process.kill(st.pid, 0);
      alive = true;
    } catch (err) {
      // EPERM means the process EXISTS but belongs to another user — only
      // ESRCH actually means "no such process". Treating both as dead reported
      // a live engine as stale.
      alive = (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
  }
  const age = st.at ? Math.round((Date.now() - new Date(st.at).getTime()) / 1000) : null;
  console.log(`Engine pid ${st.pid ?? "?"} — ${alive ? "ALIVE" : "not running (stale status)"}`);
  console.log(`${st.phase === "running" ? "⏳ running" : "· idle after"}: ${st.tool ?? "?"}${age !== null ? ` (as of ${age}s ago)` : ""}`);
  console.log(`Session: ${st.session ?? "?"} (${st.role ?? "?"})${st.sessions && st.sessions.length > 1 ? ` · all sessions: ${st.sessions.join(", ")}` : ""}`);
  if (st.url) console.log(`URL: ${st.url}`);
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
        console.log(`  ${e.at.slice(11, 19)} ${e.action}${e.target ? ` ${e.target}` : ""} @ ${e.url}`);
      } catch {
        /* skip malformed line */
      }
    }
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

/** The value of `--browsers`, written as `--browsers x` or `--browsers=x`. Undefined when the flag is absent. */
function browsersFlag(flags: string[]): string | undefined {
  const inline = flags.find((f) => f.startsWith("--browsers="));
  if (inline) return inline.slice("--browsers=".length);
  const at = flags.indexOf("--browsers");
  return at < 0 ? undefined : (flags[at + 1] ?? "");
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
  if (!browserOnly) {
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

  if (browserOnly) {
    // nothing to register
  } else if (flags.includes("--no-register")) {
    console.log(
      `· MCP registration skipped (--no-register). To do it by hand:\n\n  ${manualRegisterCommand(launchCommand({ packageRoot, nodePath: process.execPath, serverPath }))}\n`,
    );
  } else {
    const reg = registerMcp({ launch: launchCommand({ packageRoot, nodePath: process.execPath, serverPath }), serverPath, run: spawnRunner });
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

  if (failed) {
    console.log("\nSetup is incomplete — fix the lines marked ✗ or · above, then run:  scenescout doctor");
    process.exitCode = 1;
    return;
  }
  if (browserOnly) {
    console.log("\nThe browser is ready — attach again.");
    return;
  }
  console.log("\nStart a FRESH Claude Code session, then in any project run:  /scenescout");
  console.log("Something off? Run:  scenescout doctor");
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
  console.log("\nAll good. In any project, run:  /scenescout");
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
      const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
      console.log(pkg.version);
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
    case "status": {
      status(path.resolve(args[0] ?? process.cwd()));
      break;
    }
    default:
      usage();
  }
} catch (err) {
  console.error(`scenescout ${command ?? ""}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
