#!/usr/bin/env node
/**
 * SceneScout CLI.
 *
 *   scenescout <url>                A first look with no setup: observe mode, capped, never a gate
 *   scenescout scan <projectPath>   Print project discovery results
 *   scenescout serve                Run the MCP server on stdio
 *   scenescout install              Install the skill, download the browser, register the MCP server
 *   scenescout doctor               Check every piece of the setup and say how to fix what is missing
 *   scenescout check <url>          Visit every route, measure it, and pass or fail (no model involved)
 *   scenescout ci <url>             An exploratory run driven by a model's API, unattended, that reports
 *   scenescout login <url> --role r Sign in once in a visible browser and save it as a named role
 *   scenescout export --to github   File the project's findings as GitHub or Jira issues, each once
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPROX_DISK_MB, defaultAttachNote, defaultEngine, launchTarget, parseBrowserSelection, type InstallTarget } from "./browsers.js";
import { CLIENT_LABELS, firstMessageHint, manualFor, parseClients, registerWithClient, vscodeBinary, type CodeOnPath, type OtherClient } from "./clients.js";
import {
  CLAUDE_CODE_NOT_NEEDED,
  CLI_NAME,
  desktopExtensionRoots,
  diagnose,
  doctorAllGood,
  findDesktopExtension,
  installClosing,
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
import { downloadBrowsers, presentBrowsers } from "./installer.js";
import { baselinesDirOf, defaultCheckDir, readCheckInputs, runCheck, type CheckInputs } from "./check-run.js";
import { httpClient, httpJudgeAsk, runCi } from "./ci-run.js";
import { runExport } from "./export-run.js";
import { runLogin, runScriptedLogin, savedLine } from "./login-run.js";
import { credentialRedactor, LOGIN_ENV, readScriptedLogin } from "./engine/scripted-login.js";
import { parseLoginArgs } from "./engine/profiles.js";
import { detectProvider, EXIT_CI, judgeEffort, KEY_ENV, parseCiArgs, redactKeys, secretValues } from "./engine/ci.js";
import { VISUAL_DIRNAME } from "./engine/baseline.js";
import {
  EXIT,
  exitCodeOf,
  formatCheck,
  parseCheckArgs,
  refusedFlowReason,
  toSarif,
  toSummaryJson,
  unmeasuredReason,
  type CheckResult,
} from "./engine/check.js";
import {
  downloadLine,
  EXIT_FIRST_RUN,
  FIRST_RUN_DIRNAME,
  firstRunCheckOptions,
  firstRunDownloads,
  firstRunSummary,
  formatFirstRun,
  modeSentence,
  parseFirstRunArgs,
  reportFolderProblem,
  unreachableReason,
  writeFirstRunReport,
  type FirstRunFacts,
} from "./first-run.js";
import { credentialSecrets, EXIT_EXPORT, parseExportArgs } from "./engine/export.js";
import { LEGACY_MEMORY_DIRNAME, MEMORY_DIRNAME, writeSelfIgnore } from "./engine/memory.js";
import { sarifFilesFor } from "./engine/sarif.js";
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
import { dispatch } from "./commands.js";

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
  scenescout <url> [options]        A first look, with no setup: visits the app's pages and measures them (no
                                    model, no API key), writes ${FIRST_RUN_DIRNAME}/ in this folder and prints
                                    the three issues to look at first. Downloads Chromium if it is missing and
                                    changes nothing else: no skill, no MCP registration, nothing on PATH.
                                    The address comes first, its options after it.
                                    (--max-routes N (default 20), --max-minutes N (default 3): no page is started
                                     past either; --mode observe|read-only (default observe: nothing but reads
                                     leaves the page, sign-in and token refresh apart; read-only lets a plain POST
                                     through); --out dir: where the report goes. ${FIRST_RUN_DIRNAME}/ is written
                                     only when it is new, empty or an earlier first look's)
                                    Exit code: 0 it looked, whatever it found; 2 could not run (the URL could
                                    not be reached, a bad argument, no browser) or could not write the report.
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
                                     --ignore rule,rule; --ignore-path /a,rule:/b to exempt a path, or one rule on it;
                                     --storage-state file to check signed in;
                                     --project dir (default: here); --out dir (default: .scenescout/check);
                                     --browser chromium|firefox|webkit;
                                     --action-timeout-ms N (default 5000), --nav-timeout-ms N (default 20000;
                                      15000 per crawled route): raise on a loaded runner, or set
                                      SCENESCOUT_ACTION_TIMEOUT_MS / SCENESCOUT_NAV_TIMEOUT_MS;
                                     --flows dir|off: replay the flows saved there (default: .scenescout/flows);
                                     --retest on|off: re-test open findings a page load reproduces (default on);
                                     --flow-writes never|allow: never (default) replays flows under observe's
                                      rule whatever --mode says; allow replays them under --mode, so their
                                      form submissions are sent;
                                     --on-refused-step report|stop: report (default) marks a flow whose step was
                                      refused "could not run", keeps every other verdict and exits 2; stop exits 2 there;
                                     --gate-retests never|high|all: which still-reproducing findings fail the gate
                                      (default high: those filed high);
                                     --baseline off|compare|update: compare each page or element listed in the
                                      baselines' targets.json with its baseline picture, or write new baselines
                                      (update; only when asked) (default off);
                                     --baselines dir: where targets.json and the baselines are (default
                                      .scenescout/baselines, which git ignores; name a folder you commit to share
                                      them); --baseline-threshold N: the % of a picture's pixels that may change
                                      before its baseline is not met; update rewrites those past it, and any taken
                                      on another OS (default 0.1, so small anti-aliasing noise between machines
                                      passes; 0 counts every changed pixel);
                                     --sarif-file-anchor path: the repository file a SARIF result points at when
                                      no saved flow raised it (default: the running workflow's file on GitHub
                                      Actions, else package.json, else README.md))
                                    Exit code: 0 passed, 1 failed the gate, 2 could not run.
  scenescout ci <url>               An exploratory run with no person present: a model reached through its API
                                    drives the tools by the SceneScout method and the run ends in the report.
                                    It reports and never gates. The key is read from ANTHROPIC_API_KEY or
                                    OPENAI_API_KEY only. Writes report.md, summary.md, ci.json and ci.sarif.
                                    (--provider anthropic|openai: needed only when both keys are set;
                                     --model id (default claude-sonnet-5 / gpt-6-luna); --effort none|low|medium|
                                      high|xhigh|max (default low; none is OpenAI only); --base-url https://…/v1 for
                                      another endpoint that implements the same API;
                                     --max-turns N (default 40); --max-tokens N (default 1500000);
                                     --max-minutes N (default 20): the run stops at the first cap reached and still
                                      writes the report;
                                     --lanes N (default 1, at most 8): split the app between N model loops that
                                      explore at once, each in its own browser, sharing those caps;
                                     --price-in, --price-cached-in, --price-out: US dollars per million tokens,
                                      over the built-in prices, for the cost estimate of any model;
                                     --mode observe|read-only|safe-write|destructive (default read-only;
                                      destructive only with --allow-destructive as well); --level minimal|medium|
                                      extensive (default medium); --focus "an area or flow";
                                     --storage-state file; --browser chromium|firefox|webkit;
                                     --action-timeout-ms N, --nav-timeout-ms N: as for check;
                                     --project dir (default: here); --out dir (default: .scenescout/ci);
                                     --show "the Save button": instead of exploring, capture that element as a PNG
                                      under shots/; --compare-url https://…: with --show, capture it there too and
                                      write a diff picture;
                                     --dedup judge|rule: judge (default) also asks the run's model, at its lowest
                                      effort, whether a filed finding the rule keeps apart is one already on its
                                      page (titles, categories, evidence and the page's path are sent);
                                      rule asks nothing;
                                     --sarif-file-anchor path: the repository file each SARIF result points at,
                                      as for check)
                                    Exit code: 0 the run ran (findings never change it), 2 could not run.
  scenescout login <url> --role <name>
                                    Open a visible browser at the URL and sign in there (SSO, MFA, anything). Once
                                    you are back on the app with a new session, the window saves it as that role's
                                    profile, in .scenescout/auth/<name>.json (owner-only; never printed, never
                                    committed), and closes. Enter in this terminal saves at once. Closing the window
                                    or Ctrl+C saves nothing. Agents then attach with scout_attach { role: "<name>" },
                                    as many sessions as they like from one login. From a conversation, scout_login
                                    opens the same window.
                                    (--project dir (default: here); --browser chromium|firefox|webkit;
                                    --save auto|enter (default auto; enter: save on Enter only, as before);
                                    --success-url text|url: signed in once the URL's path contains this, or the URL
                                    starts with it, instead of when a new session appears)
  scenescout login <url> --role <name> --script
                                    For CI: sign in headless from SCENESCOUT_LOGIN_USERNAME, SCENESCOUT_LOGIN_PASSWORD
                                    and, if the form asks for a code, SCENESCOUT_LOGIN_TOTP_SECRET (base32 or an
                                    otpauth:// URI) or SCENESCOUT_LOGIN_OTP_CODE (a fixed code a test environment
                                    accepts), then save the profile as above. With a code and no password, a
                                    passwordless sign-in (the username, then the code). A test user only. No value
                                    is ever printed. Exit 0 signed in and saved, 1 not.
                                    (--success-url text|url; --success-selector css; --username-selector,
                                    --password-selector, --otp-selector, --submit-selector css; each of these also
                                    from SCENESCOUT_LOGIN_<FLAG>, e.g. SCENESCOUT_LOGIN_SUCCESS_URL;
                                    --timeout seconds (default 60))
  scenescout export --to github|jira
                                    File the project's open findings (from .scenescout/memory.json, or from a
                                    check.json or ci.json given with --from file) as issues, each once: a finding
                                    whose marker is already on an issue is skipped. A dry run
                                    that lists what it would file unless --yes is given. Credentials come from the
                                    environment only: GH_TOKEN or GITHUB_TOKEN; JIRA_EMAIL and JIRA_API_TOKEN.
                                    (--repo owner/name for GitHub (GITHUB_API_URL for GitHub Enterprise Server);
                                     --jira-url https://…, --jira-project KEY, --jira-issue-type name (default Bug),
                                      --jira-link-type name|none (default Relates), or JIRA_BASE_URL,
                                      JIRA_PROJECT_KEY, JIRA_ISSUE_TYPE, JIRA_LINK_TYPE, for Jira Cloud: an issue
                                      is linked to each ticket whose criterion its finding fails;
                                     --jira-update on|off (default on): update an open Jira issue filed earlier,
                                      leaving a summary or description edited in Jira as it is;
                                     --min-severity high|medium|low (default low); --only id,id;
                                     --max-issues N (default 20, at most 100): the most one export files;
                                     --refile-closed: file a finding again when its issue was closed (by default
                                      an issue open or closed counts as filed); --include-worth-a-look;
                                     --severity-map high=…,medium=…,low=… or none: a label on GitHub, a priority
                                      in Jira (default severity: high… / High, Medium, Low); --labels a,b;
                                     --screenshots on|off (default on: the finding's picture and the run's frames,
                                      attached in Jira, named on GitHub);
                                     --project dir (default: here; its .scenescout folder keeps the record of
                                      filed issues); --from check.json|ci.json; --dry-run; --yes)
                                    Exit code: 0 done (findings over the cap wait for the next export), 2 could not
                                    export (it lists what it filed before it stopped), or a screenshot was not
                                    attached or a ticket not linked.
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
  const selection = parseBrowserSelection(flagValue(flags, "--browsers"));
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
      if ((await downloadBrowsers(missing, "inherit")).ok) console.log(`✓ Downloaded: ${missing.join(", ")}.`);
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
        console.log(
          reg.status === "client-missing"
            ? `· ${label} was not found on this machine, so nothing was registered with it.`
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
  const closing = installClosing({ browserOnly, forClaude });
  if (closing) console.log(`\n${closing}`);
  if (browserOnly) return;
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
    version: packageVersion(),
    // What a default attach launches: the headless build of the default browser.
    defaultBrowser: await (async () => {
      const target = launchTarget(defaultEngine(process.env), false);
      const found = (await presentBrowsers())[target];
      return { target, path: found.installed ? found.path : null, expected: found.path };
    })(),
    desktopExtension: findDesktopExtension(desktopExtensionRoots({ platform: process.platform, home: os.homedir(), env: process.env })),
    headlessShellDir: (await presentBrowsers())["chromium-headless-shell"].path,
    run: spawnRunner,
  });
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
    if (!c.ok && c.fix) console.log(`    fix: ${c.fix}`);
  }
  if (checks.some((c) => !c.ok)) process.exit(1);
  console.log(`\n${doctorAllGood({ engineOnly: flags.includes("--engine"), desktopOnly: checks.some((c) => c.name === CLAUDE_CODE_NOT_NEEDED) })}`);
}

/** `scenescout check`: exit 0 passed, 1 failed the gate, 2 could not run. */
async function check(args: string[]): Promise<never> {
  const parsed = parseCheckArgs(args, process.cwd());
  if (!parsed.ok) {
    console.error(`scenescout check: ${parsed.error}`);
    process.exit(EXIT.error);
  }
  const options = parsed.options;
  const outDir = options.outDir ?? defaultCheckDir(options.projectDir);
  let inputs: CheckInputs;
  try {
    inputs = readCheckInputs(options);
  } catch (err) {
    console.error(`scenescout check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT.error);
  }
  let result;
  try {
    console.log(`Checking ${options.url} …${inputs.flows.length > 0 ? ` (and ${inputs.flows.length} saved flow(s))` : ""}`);
    result = await runCheck(options, (line) => console.log(line), inputs);
  } catch (err) {
    console.error(`scenescout check: could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT.error);
  }
  const unmeasured = unmeasuredReason(result.routes, !options.paths, result.unvisited);
  if (unmeasured) {
    console.error(`scenescout check: could not measure ${options.url}: ${unmeasured}`);
    process.exit(EXIT.error);
  }
  const refused = refusedFlowReason(result);
  // --on-refused-step stop: no verdict is written at all.
  if (refused && options.onRefusedStep === "stop") {
    console.error(`scenescout check: could not run a saved flow: ${refused}`);
    process.exit(EXIT.error);
  }
  const markdown = formatCheck(result);
  try {
    const version = packageVersion();
    if (!options.outDir) writeSelfIgnore(path.dirname(outDir));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "report.md"), markdown);
    const sarifFiles = sarifFilesFor({
      option: options.sarifFileAnchor,
      env: process.env,
      projectDir: options.projectDir,
      flowsDir: inputs.flowsDir,
      exists: (p) => fs.existsSync(p),
    });
    if (sarifFiles.warning) console.error(`scenescout check: ${sarifFiles.warning}`);
    fs.writeFileSync(path.join(outDir, "check.sarif"), JSON.stringify(toSarif(result, version, sarifFiles), null, 2) + "\n");
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
  const pictured = result.baselines?.results.filter((r) => r.files).length ?? 0;
  if (pictured > 0) console.log(`Wrote the pictures of ${pictured} changed baseline(s) under ${path.join(outDir, VISUAL_DIRNAME)}`);
  const written = result.baselines?.results.filter((r) => r.status === "updated").length ?? 0;
  if (written > 0) console.log(`Wrote ${written} baseline(s) to ${baselinesDirOf(options)}`);
  // --on-refused-step report: everything else has its verdict in the files, and the exit code still says the run was incomplete.
  if (refused) console.error(`scenescout check: could not run a saved flow: ${refused}`);
  process.exit(exitCodeOf(result));
}

/** `scenescout <url>`: a first look. Exit 0 once it has looked, whatever it found; 2 when it could not look or could not write its report. */
async function firstRun(args: string[]): Promise<never> {
  const fail = (message: string): never => {
    console.error(`scenescout: ${message}`);
    process.exit(EXIT_FIRST_RUN.couldNotRun);
  };
  const parsed = parseFirstRunArgs(args, process.cwd());
  if (!parsed.ok) return fail(parsed.error);
  const options = parsed.options;
  // Found out now, not after the look; and nothing is created until the look has something to write.
  const folderProblem = reportFolderProblem(options.outDir ?? path.join(process.cwd(), FIRST_RUN_DIRNAME), options.outDir !== undefined);
  if (folderProblem) return fail(folderProblem);
  console.log(`SceneScout ${packageVersion()} — a first look at ${options.url}`);
  console.log(
    `It opens pages and measures them and submits no form: up to ${options.maxRoutes} pages, starting none after ${options.maxMinutes} minute(s). No model, no API key.`,
  );
  console.log(modeSentence(options.mode));
  // Only the build a headless Chromium launch needs. Nothing else install does happens here: no skill, no registration, nothing on PATH.
  const downloads = firstRunDownloads(await presentBrowsers());
  if (downloads.length > 0) {
    console.log(downloadLine(downloads));
    const began = Date.now();
    if (!(await downloadBrowsers(downloads, "inherit")).ok) {
      return fail(
        `Chromium could not be downloaded. Check the network or proxy and run this again, or download it by hand: npx playwright install ${downloads.join(" ")}`,
      );
    }
    // The installer's exit code is not the build: look again before saying it is there.
    const still = firstRunDownloads(await presentBrowsers());
    if (still.length > 0)
      return fail(`the download finished, but ${still.join(", ")} is still not where Playwright looks for it. Run: npx playwright install ${still.join(" ")}`);
    console.log(`✓ Chromium downloaded in ${Math.round((Date.now() - began) / 1000)} s.`);
  }
  // An empty project of its own: nothing is read from, or written to, the folder this runs in except the report.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-first-run-"));
  // Also on an exit the finally below never reaches, such as Ctrl+C, which the browser's driver answers with process.exit.
  const removeProject = (): void => fs.rmSync(projectDir, { recursive: true, force: true });
  process.once("exit", removeProject);
  const began = Date.now();
  let result: CheckResult | undefined;
  let error = "";
  try {
    console.log(`\nLooking at ${options.url} …`);
    result = await runCheck(firstRunCheckOptions(options, projectDir), (line) => console.log(line));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    process.off("exit", removeProject);
    removeProject();
  }
  if (!result) return fail(`could not run: ${error}`);
  const unreachable = unreachableReason(result.routes);
  if (unreachable) return fail(`could not reach ${options.url}: ${unreachable}`);
  const facts: FirstRunFacts = { result, options, elapsedMs: Date.now() - began };
  const files = {
    "report.md": formatFirstRun(facts),
    "check.json": JSON.stringify(toSummaryJson(result, packageVersion()), null, 2) + "\n",
  };
  // The look is done whatever happens to the files: its summary is printed either way.
  let written: { dir: string; note?: string } | undefined;
  let notWritten = "";
  try {
    written = writeFirstRunReport(files, { cwd: process.cwd(), tmpdir: os.tmpdir(), outDir: options.outDir });
  } catch (err) {
    notWritten = err instanceof Error ? err.message : String(err);
  }
  if (written?.note) console.log(written.note);
  let where = `not written: ${notWritten}`;
  if (written) {
    const report = path.join(written.dir, "report.md");
    const relative = path.relative(process.cwd(), report);
    where = relative.startsWith("..") || path.isAbsolute(relative) ? report : relative;
  }
  console.log("");
  for (const line of firstRunSummary(facts, where)) console.log(line);
  if (!written) return fail(`could not write the report: ${notWritten}`);
  process.exit(EXIT_FIRST_RUN.ran);
}

/** `scenescout ci`: exit 0 when the run ran, 2 when it could not. Findings never change the exit code. */
async function ci(args: string[]): Promise<never> {
  const secrets = secretValues(process.env);
  const say = (line: string): void => console.log(redactKeys(line, secrets));
  const fail = (message: string): never => {
    console.error(redactKeys(`scenescout ci: ${message}`, secrets));
    process.exit(EXIT_CI.couldNotRun);
  };
  const parsed = parseCiArgs(args, process.cwd(), process.env);
  if (!parsed.ok) return fail(parsed.error);
  const options = parsed.options;
  const provider = detectProvider(process.env, options);
  if (!provider.ok) return fail(provider.error);
  const resolved = provider.resolved;
  const key = (process.env[KEY_ENV[resolved.provider]] ?? "").trim();
  // The dedup judge asks the run's model at the lowest effort its API takes; --dedup rule asks nothing.
  const judge = options.dedup === "judge" && !options.show ? { ...resolved, effort: judgeEffort(resolved.provider) } : null;
  say(
    `Exploring ${options.url} with ${resolved.provider} ${resolved.model} (effort ${resolved.effort}), ${options.mode} mode, level ${options.level}` +
      `${judge ? `, duplicates judged by the model at effort ${judge.effort}` : ""} …`,
  );
  let run;
  try {
    run = await runCi(options, resolved, {
      makeClient: (system, tools, kickoff) => httpClient(resolved, key, system, tools, kickoff),
      ...(judge ? { judge: httpJudgeAsk(judge, key), judgeEffort: judge.effort } : {}),
      log: say,
      secrets,
      version: packageVersion(),
    });
  } catch (err) {
    return fail(`could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { result, exitCode, written } = run;
  if (written.length > 0) say(`Wrote ${written.join(", ")} to ${options.outDir ?? path.join(options.projectDir, MEMORY_DIRNAME, "ci")}`);
  if (exitCode !== EXIT_CI.completed) {
    const why =
      result.stop === "could-not-start" || result.stop === "provider-error"
        ? `${result.stop === "provider-error" ? "the model's API failed" : "could not start"}${result.stopDetail ? `: ${result.stopDetail}` : ""}`
        : "the report could not be written";
    fail(`could not run: ${why}`);
  }
  process.exit(exitCode);
}

/** `scenescout login`: exit 0 saved, 1 nothing saved. */
async function login(args: string[]): Promise<never> {
  const parsed = parseLoginArgs(args, process.cwd());
  if (!parsed.ok) {
    console.error(`scenescout login: ${parsed.error}`);
    process.exit(1);
  }
  const options = parsed.options;
  if (options.script) {
    // Everything is checked before a browser launches; each problem names a variable, never a value.
    const read = readScriptedLogin(options.script, process.env);
    if (!read.ok) {
      for (const e of read.errors) console.error(`scenescout login: ${e}`);
      process.exit(1);
    }
    const redactor = credentialRedactor(read.config, process.env[LOGIN_ENV.totpSecret]);
    try {
      const saved = await runScriptedLogin(options, read.config, redactor, (line) => console.log(line));
      console.log(redactor.redact(savedLine(options, saved)));
    } catch (err) {
      // Redacted again here: an error thrown by the browser itself has not been through the run's redaction.
      console.error(redactor.redact(`scenescout login: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
    process.exit(0);
  }
  try {
    const saved = await runLogin(options, (line) => console.log(line));
    console.log(savedLine(options, saved));
  } catch (err) {
    console.error(`scenescout login: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  process.exit(0);
}

/** `scenescout export`: exits as EXIT_EXPORT says. */
async function exportFindings(args: string[]): Promise<never> {
  const parsed = parseExportArgs(args, process.cwd(), process.env);
  if (!parsed.ok) {
    // A refusal can quote the value it refused, and a credential pasted into an option is still a credential.
    console.error(redactKeys(`scenescout export: ${parsed.error}`, credentialSecrets(process.env)));
    process.exit(EXIT_EXPORT.couldNotExport);
  }
  const outcome = await runExport(parsed.options, {
    env: process.env,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
  process.exit(outcome.exitCode);
}

const [, , command, ...args] = process.argv;

// A CLI's failure mode should be a sentence, not a stack trace. `scan` on a
// path that does not exist and `status` on a half-written status.json both
// throw ordinary Errors; unguarded, they printed a V8 trace that buries the
// one line the user needs. `serve` is deliberately outside this: it hands off
// to the MCP server, whose own transport owns error reporting from then on.
try {
  await dispatch(command, args, {
    usage,
    version: () => console.log(packageVersion()),
    refuse: (message) => {
      console.error(`scenescout ${command}: ${message}`);
      console.error("Run `scenescout --help` for the options.");
      process.exit(1);
    },
    commands: {
      scan: (a) => {
        if (!a[0]) usage();
        console.log(formatScan(scanProject(a[0])));
      },
      serve: async () => {
        await import("./mcp-server.js");
      },
      install,
      doctor,
      check,
      ci,
      login,
      export: exportFindings,
      status: (a) => status(path.resolve(a[0] ?? process.cwd())),
      watch: (a) => {
        const positional = a.filter((x) => !x.startsWith("--"));
        watch(path.resolve(positional[0] ?? process.cwd()), !a.includes("--no-open"));
      },
    },
    // Anything unforeseen is still "could not run" (2), not the exit 1 the other commands share below.
    firstRun: (a) =>
      firstRun(a).catch((err: unknown) => {
        console.error(`scenescout: could not run: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(EXIT_FIRST_RUN.couldNotRun);
      }),
  });
} catch (err) {
  console.error(`scenescout ${command ?? ""}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
