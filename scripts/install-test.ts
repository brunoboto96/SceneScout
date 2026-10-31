/**
 * Unit tests for the setup logic behind `scenescout install` / `doctor`.
 *
 * Install mutates a home directory and shells out to another CLI — exactly the
 * kind of code that only ever gets tested by hand, on the author's machine,
 * once. So every function takes its home dir and its command runner as
 * arguments, and these tests hand it a temp dir and a scripted fake `claude`.
 *
 *   npx tsx --test scripts/install-test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asLf } from "./checkout.ts";
import {
  CLAUDE_CODE_NOT_NEEDED,
  DESKTOP_EXTENSION_NAME,
  desktopExtensionRoots,
  diagnose,
  doctorAllGood,
  commandSpawnPlan,
  ensureCommand,
  findDesktopExtension,
  isBatchShim,
  planSpawn,
  resolveWindowsCommand,
  installClosing,
  findOnUserPath,
  installSkill,
  isEphemeralRoot,
  launchCommand,
  manualRegisterCommand,
  npxServeArgs,
  isNpxServeArgs,
  pinnedVersion,
  spawnRunner,
  parseRegistration,
  planCommand,
  registerMcp,
  repairCommands,
  resolveClaudeDir,
  type DesktopExtension,
  type Runner,
  type RunResult,
} from "../src/installer.ts";
import { atLeastVersion, downloadEnv, installerFailure, NODE_FLOOR } from "../src/installer.ts";
import { FULL_PLATFORMS } from "./test-plan.mjs";
import { NODE_LTS_END_OF_LIFE, ltsProblems, maintainedLtsLines } from "./node-lts.ts";
import { parse as parseYaml } from "yaml";
import { distTagFor, parseVersions, releasePlan } from "./release-plan.mjs";
import {
  attachDownloadLine,
  BROWSER_DOWNLOAD_ENV,
  browserDownloadDecision,
  browserPresence,
  defaultAttachNote,
  defaultEngine,
  beaconResourceType,
  echoesFailedLoads,
  requestCancelled,
  focusAdvanceKey,
  headlessShellDir,
  launchTarget,
  parseBrowserSelection,
  playwrightInstallArgs,
  screencastSupport,
  serviceWorkerPolicy,
  sharedWorkersAllowed,
  unloadWriteInterception,
  allowedUnloadWritesMayBeLost,
  writeRedirectHopsJudged,
  hostRedirectHops,
  frameUnloadWritesMayGoUnissued,
  closeWaitsForLeavingWrites,
  awaitsDroppedNavigationErrorPage,
  droppedNavigationErrorPage,
  errorPageExit,
} from "../src/browsers.ts";

import { INTAKE_QUESTIONS, introQuestions } from "../src/intake.ts";
import { explorePrompt, loadPlaybook, PLAYBOOK_RELATIVE_PATH, SERVER_INSTRUCTIONS, stripFrontMatter } from "../src/playbook.ts";
import { trackerCredentials } from "../src/engine/export.ts";
import { trackerEnv } from "../src/engine/ticket-preview.ts";
import { GUIDED_PROMPTS, guidedPromptText, livePrompt, loginPrompt, LOGIN_PROMPT_ARGUMENTS, LIVE_PROMPT_ARGUMENTS } from "../src/prompts.ts";

import { dispatch, HAND_PARSED, looksLikeUrl, SUBCOMMANDS, type CliHandlers, type Subcommand } from "../src/commands.ts";
import { EXIT_CONFIG, runConfigCommand } from "../src/engine/config-explain.ts";
import { CONFIG_KEYS } from "../src/engine/project-config.ts";
import { EXIT_POLICY, policySettingsFrom, runPolicyCommand } from "../src/engine/policy-explain.ts";
import {
  downloadLine,
  FIRST_RUN_DEFAULTS,
  FIRST_LOOK_MARKER,
  FIRST_RUN_DIRNAME,
  firstRunCheckOptions,
  firstRunDownloads,
  MAX_FIRST_RUN_MINUTES,
  parseFirstRunArgs,
  reportFolderProblem,
  writeFirstRunReport,
} from "../src/first-run.ts";
import { MAX_CHECK_ROUTES, parseCheckArgs } from "../src/engine/check.ts";
import { firstMessageHint, manualFor, parseClients, registerInFile, registerWithClient, vscodeAddArgs, vscodeBinary } from "../src/clients.ts";

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A package root with just enough in it to install from. */
function fakePackage(root = tmp("sc-pkg-")): string {
  fs.mkdirSync(path.join(root, "skills", "scenescout"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "scenescout", "SKILL.md"), "# skill v1");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "mcp-server.js"), "");
  return root;
}

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "", missing: false });
const fail = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr, missing: false });
const notRegistered = fail('No MCP server named "scenecraft".');
const absent: RunResult = { status: null, stdout: "", stderr: "spawn claude ENOENT", missing: true };

/** Scripted runner: replies in order, records every call. */
function scripted(replies: RunResult[]): { run: Runner; calls: string[][]; options: Array<Parameters<Runner>[2]> } {
  const calls: string[][] = [];
  const options: Array<Parameters<Runner>[2]> = [];
  return {
    calls,
    options,
    run: (command, args, opts) => {
      calls.push([command, ...args]);
      options.push(opts);
      const next = replies.shift();
      if (!next) throw new Error(`unexpected extra call: ${command} ${args.join(" ")}`);
      return next;
    },
  };
}

test("installSkill links the skill into the given home, not the real one", () => {
  const packageRoot = fakePackage();
  const claudeDir = tmp("sc-claude-");
  const result = installSkill({ packageRoot, claudeDir });
  assert.equal(result.dest, path.join(claudeDir, "skills", "scenescout"));
  assert.equal(result.mode, "symlink");
  assert.equal(fs.readFileSync(path.join(result.dest, "SKILL.md"), "utf8"), "# skill v1");
  // A symlink means an edit in the checkout is live without reinstalling.
  fs.writeFileSync(path.join(packageRoot, "skills", "scenescout", "SKILL.md"), "# skill v2");
  assert.equal(fs.readFileSync(path.join(result.dest, "SKILL.md"), "utf8"), "# skill v2");
});

test("installSkill replaces its OWN earlier installs: a symlink, and a marked copy", () => {
  const claudeDir = tmp("sc-claude-");
  const skills = path.join(claudeDir, "skills");
  // First a copy-mode install (from an npx cache), then a normal one over it.
  const cached = fakePackage(path.join(tmp("sc-npm-"), "_npx", "abc", "node_modules", "scenescout"));
  assert.equal(installSkill({ packageRoot: cached, claudeDir }).mode, "copy");
  const packageRoot = fakePackage();
  fs.writeFileSync(path.join(packageRoot, "skills", "scenescout", "SKILL.md"), "# skill v2");
  const second = installSkill({ packageRoot, claudeDir });
  assert.equal(second.mode, "symlink");
  assert.deepEqual(second.notes, [], "replacing our own install needs no warning");
  // ...and a symlink is replaced by the next install just as quietly.
  const third = installSkill({ packageRoot, claudeDir });
  assert.deepEqual(third.notes, []);
  assert.equal(fs.readFileSync(path.join(skills, "scenescout", "SKILL.md"), "utf8"), "# skill v2");
  assert.deepEqual(fs.readdirSync(skills), ["scenescout"], "no backups pile up from our own reinstalls");
});

test("a copy installed under the tool's earlier name is still recognised as ours", () => {
  const claudeDir = tmp("sc-claude-");
  const old = path.join(claudeDir, "skills", "scenecraft");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "SKILL.md"), "# pre-rename copy");
  fs.writeFileSync(path.join(old, ".installed-by-scenecraft"), "");
  const result = installSkill({ packageRoot: fakePackage(), claudeDir });
  assert.equal(fs.existsSync(old), false, "otherwise a dead /scenecraft command lingers, pointing at tools that no longer exist");
  assert.match(result.notes.join("\n"), /removed the pre-rename skill/);
});

test("installSkill never deletes a directory it did not install", () => {
  // The names it writes to are ordinary words. On a stranger's machine,
  // ~/.claude/skills/frontend-tester or a hand-made scenescout/ may be their
  // own uncommitted work; an installer that rm -rf's it has no undo.
  const packageRoot = fakePackage();
  const claudeDir = tmp("sc-claude-");
  const skills = path.join(claudeDir, "skills");
  fs.mkdirSync(path.join(skills, "frontend-tester"), { recursive: true });
  fs.writeFileSync(path.join(skills, "frontend-tester", "SKILL.md"), "# someone's own skill");
  fs.mkdirSync(path.join(skills, "scenescout"), { recursive: true });
  fs.writeFileSync(path.join(skills, "scenescout", "SKILL.md"), "# hand-edited");

  const result = installSkill({ packageRoot, claudeDir, now: () => 42 });
  assert.equal(fs.readFileSync(path.join(skills, "frontend-tester", "SKILL.md"), "utf8"), "# someone's own skill", "a foreign legacy-named skill survives");
  assert.equal(
    fs.readFileSync(path.join(skills, "scenescout.backup-42", "SKILL.md"), "utf8"),
    "# hand-edited",
    "an unowned scenescout/ is moved aside, not deleted",
  );
  assert.equal(fs.readFileSync(path.join(skills, "scenescout", "SKILL.md"), "utf8"), "# skill v1", "the install still completes");
  assert.equal(result.notes.length, 2, "both decisions are reported to the user");
  assert.match(result.notes.join("\n"), /left .*frontend-tester alone/);
  assert.match(result.notes.join("\n"), /moved it to .*scenescout\.backup-42/);
});

test("installSkill drops the pre-rename skill when it is provably its own link", () => {
  const packageRoot = fakePackage();
  const claudeDir = tmp("sc-claude-");
  const skills = path.join(claudeDir, "skills");
  fs.mkdirSync(skills, { recursive: true });
  // What the pre-rename installer left behind: a link into the checkout, now dangling.
  // One per earlier name of the tool.
  fs.symlinkSync(path.join(packageRoot, "skills", "frontend-tester"), path.join(skills, "frontend-tester"), "dir");
  fs.symlinkSync(path.join(packageRoot, "skills", "scenecraft"), path.join(skills, "scenecraft"), "dir");
  const result = installSkill({ packageRoot, claudeDir });
  assert.equal(fs.lstatSync(path.join(skills, "frontend-tester"), { throwIfNoEntry: false }), undefined);
  assert.equal(fs.lstatSync(path.join(skills, "scenecraft"), { throwIfNoEntry: false }), undefined);
  assert.equal(result.notes.filter((n) => /removed the pre-rename skill/.test(n)).length, 2);
  assert.deepEqual(fs.readdirSync(skills), ["scenescout"]);
});

test("installSkill reinstalls over its own DANGLING link (the checkout was moved)", () => {
  const claudeDir = tmp("sc-claude-");
  const skills = path.join(claudeDir, "skills");
  fs.mkdirSync(skills, { recursive: true });
  fs.symlinkSync(path.join(tmp("sc-gone-"), "skills", "scenescout"), path.join(skills, "scenescout"), "dir");
  const result = installSkill({ packageRoot: fakePackage(), claudeDir });
  assert.equal(fs.readFileSync(path.join(result.dest, "SKILL.md"), "utf8"), "# skill v1");
  assert.deepEqual(result.notes, []);
});

test("the skill goes where Claude Code actually looks: CLAUDE_CONFIG_DIR wins over ~/.claude", () => {
  assert.equal(resolveClaudeDir({}, "/home/u"), path.join("/home/u", ".claude"));
  assert.equal(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "/work/claude" }, "/home/u"), "/work/claude");
  assert.equal(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "  " }, "/home/u"), path.join("/home/u", ".claude"), "a blank value is not a directory");
});

test("installSkill COPIES when run from an npx cache, where a symlink would dangle", () => {
  const packageRoot = fakePackage(path.join(tmp("sc-npm-"), "_npx", "abc123", "node_modules", "scenescout"));
  assert.equal(isEphemeralRoot(packageRoot), true);
  assert.equal(isEphemeralRoot("/opt/tools/scenescout"), false);
  const claudeDir = tmp("sc-claude-");
  const result = installSkill({ packageRoot, claudeDir });
  assert.equal(result.mode, "copy");
  assert.equal(fs.lstatSync(result.dest).isSymbolicLink(), false);
  // The copy must survive npm clearing the cache.
  fs.rmSync(packageRoot, { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(result.dest, "SKILL.md"), "utf8"), "# skill v1");
});

test("installSkill refuses an incomplete package instead of wiping the existing skill", () => {
  const claudeDir = tmp("sc-claude-");
  const skills = path.join(claudeDir, "skills", "scenescout");
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, "SKILL.md"), "# working install");
  assert.throws(() => installSkill({ packageRoot: tmp("sc-empty-"), claudeDir }), /skill source not found/);
  assert.equal(fs.readFileSync(path.join(skills, "SKILL.md"), "utf8"), "# working install", "a failed install must not destroy a working one");
});

test("registerMcp registers at user scope with the absolute node path", () => {
  const { run, calls } = scripted([ok(), notRegistered]);
  const result = registerMcp({ launch: ["/opt/node/bin/node", "/opt/sc/dist/mcp-server.js"], serverPath: "/opt/sc/dist/mcp-server.js", run });
  assert.deepEqual(result, { status: "registered", replaced: false, removedLegacy: [], notes: [] });
  assert.deepEqual(calls.slice(0, 1), [["claude", "mcp", "add", "--scope", "user", "scenescout", "--", "/opt/node/bin/node", "/opt/sc/dist/mcp-server.js"]]);
});

test("registerMcp is idempotent: an existing registration is replaced so moved paths heal", () => {
  const { run, calls } = scripted([
    fail("MCP server scenescout already exists in user config"),
    ok("scenescout:\n  Command: /n\n  Args: /s.js\n"),
    ok(),
    ok(),
    notRegistered,
  ]);
  const result = registerMcp({ launch: ["/n", "/s.js"], serverPath: "/s.js", run });
  assert.deepEqual(result, { status: "registered", replaced: true, removedLegacy: [], notes: [] });
  assert.deepEqual(calls.map((c) => c.slice(1, 3).join(" ")).slice(0, 4), ["mcp add", "mcp get", "mcp remove", "mcp add"]);
});

test("registerMcp removes a pre-rename registration that points at this same server", () => {
  // Left in place, the old name loads the same engine a second time and the
  // agent sees every tool twice.
  const packageRoot = fakePackage();
  const serverPath = path.join(packageRoot, "dist", "mcp-server.js");
  const { run, calls } = scripted([ok(), ok(`scenecraft:\n  Command: /usr/bin/node\n  Args: ${serverPath}\n`), ok()]);
  const result = registerMcp({ launch: ["/n", serverPath], serverPath, run });
  assert.deepEqual(result, { status: "registered", replaced: false, removedLegacy: ["scenecraft"], notes: [] });
  assert.deepEqual(calls[2], ["claude", "mcp", "remove", "scenecraft"]);
});

test("the legacy removal names the scope `get` reported, and owns up when it fails", () => {
  const packageRoot = fakePackage();
  const serverPath = path.join(packageRoot, "dist", "mcp-server.js");
  const listing = `scenecraft:\n  Scope: User config (available in all your projects)\n  Command: /usr/bin/node\n  Args: ${serverPath}\n`;
  const scoped = scripted([ok(), ok(listing), ok()]);
  registerMcp({ launch: ["/n", serverPath], serverPath, run: scoped.run });
  assert.deepEqual(scoped.calls[2], ["claude", "mcp", "remove", "--scope", "user", "scenecraft"]);

  // A removal that should have happened and did not leaves every tool
  // duplicated; install must say so, not report a clean success.
  const refused = scripted([ok(), ok(listing), fail("exists in multiple scopes")]);
  const result = registerMcp({ launch: ["/n", serverPath], serverPath, run: refused.run });
  assert.equal(result.status, "registered", "a duplicate registration is a nuisance, not a failed install");
  assert.deepEqual(result.status === "registered" && result.removedLegacy, []);
  assert.match(result.status === "registered" ? result.notes.join("\n") : "", /could not be removed.*claude mcp remove scenecraft/);
});

test("registerMcp leaves a same-named server alone when it is not this one", () => {
  // "scenecraft" is an ordinary word; a registration under it that points
  // somewhere else belongs to the user, and the scripted runner throws on any
  // call beyond the get — so a stray `remove` fails this test.
  const packageRoot = fakePackage();
  const serverPath = path.join(packageRoot, "dist", "mcp-server.js");
  const { run } = scripted([ok(), ok("scenecraft:\n  Command: /usr/bin/node\n  Args: /somewhere/else/server.js\n")]);
  assert.deepEqual(registerMcp({ launch: ["/n", serverPath], serverPath, run }), { status: "registered", replaced: false, removedLegacy: [], notes: [] });
  const http = scripted([ok(), ok("scenecraft:\n  Type: http\n  URL: https://example.test/mcp\n")]);
  assert.deepEqual(registerMcp({ launch: ["/n", serverPath], serverPath, run: http.run }).status, "registered");
});

test("registerMcp says so when a failed re-add left the user with NO registration", () => {
  // remove succeeded, the second add did not: the machine is now worse off
  // than before install ran, and the message must not hide that.
  const { run } = scripted([fail("MCP server scenescout already exists in user config"), notRegistered, ok(), fail("config is locked")]);
  const result = registerMcp({ launch: ["/n", "/s.js"], serverPath: "/s.js", run });
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /previous registration was removed.*config is locked/);
  assert.equal(result.status === "failed" && result.manual, "claude mcp add --scope user scenescout -- /n /s.js");
});

test("registerMcp without the claude CLI hands back the command instead of failing silently", () => {
  const { run } = scripted([absent]);
  const result = registerMcp({ launch: ["/n", "/s.js"], serverPath: "/s.js", run });
  assert.equal(result.status, "claude-missing");
  assert.equal(result.status === "claude-missing" && result.manual, "claude mcp add --scope user scenescout -- /n /s.js");
});

test("registerMcp reports a real failure with its reason and does not retry blindly", () => {
  const { run, calls } = scripted([fail("error: unknown option '--scope'")]);
  const result = registerMcp({ launch: ["/n", "/s.js"], serverPath: "/s.js", run });
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /unknown option/);
  assert.equal(calls.length, 1);
});

test("the printed command survives paths with spaces", () => {
  assert.equal(
    manualRegisterCommand(["/Applications/My Tools/node", "/home/a b/dist/mcp-server.js"]),
    'claude mcp add --scope user scenescout -- "/Applications/My Tools/node" "/home/a b/dist/mcp-server.js"',
  );
});

test("diagnose names each broken piece and its fix", () => {
  const packageRoot = tmp("sc-bare-"); // nothing built, no skill source
  const claudeDir = tmp("sc-claude-");
  const checks = diagnose({
    packageRoot,
    claudeDir,
    nodeVersion: "v18.19.0",
    defaultBrowser: { target: "chromium-headless-shell", path: null, expected: path.join(packageRoot, "no-such-chromium") },
    run: scripted([absent]).run,
  });
  const failing = checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failing, ["node >= 22.19", "engine built", "browser downloaded (chromium-headless-shell)", "skill installed", "claude CLI on PATH"]);
  assert.ok(
    checks.every((c) => c.ok || c.fix),
    "every failure says how to fix it",
  );
});

test("diagnose holds Node to the engines floor by minor, not by major: 22.18 fails where 22.19 and every later line pass", () => {
  const packageRoot = tmp("sc-bare-");
  const nodeCheck = (nodeVersion: string) =>
    diagnose({
      packageRoot,
      claudeDir: tmp("sc-claude-"),
      nodeVersion,
      defaultBrowser: { target: "chromium-headless-shell", path: null },
      run: scripted([absent]).run,
    }).find((c) => c.name === "node >= 22.19");
  for (const [version, ok] of [
    ["v20.19.6", false],
    ["v22.18.0", false],
    ["v22.19.0", true],
    ["v22.23.4", true],
    ["v24.11.1", true],
    ["v26.13.0", true],
  ] as const)
    assert.equal(nodeCheck(version)?.ok, ok, version);
  assert.equal(nodeCheck("v22.18.0")?.fix, "install Node 22.19 or newer");
});

test("diagnose passes a complete setup and flags a registration pointing elsewhere", () => {
  const packageRoot = fakePackage();
  const claudeDir = tmp("sc-claude-");
  installSkill({ packageRoot, claudeDir });
  const chromiumPath = path.join(packageRoot, "chromium");
  fs.writeFileSync(chromiumPath, "");
  const server = path.join(packageRoot, "dist", "mcp-server.js");

  const healthy = diagnose({
    packageRoot,
    claudeDir,
    nodeVersion: "v22.19.0",
    defaultBrowser: { target: "chromium-headless-shell", path: chromiumPath },
    run: scripted([ok(`scenescout:\n  Command: ${process.execPath}\n  Args: ${server}`)]).run,
  });
  assert.deepEqual(
    healthy.filter((c) => !c.ok),
    [],
  );

  const moved = diagnose({
    packageRoot,
    claudeDir,
    nodeVersion: "v22.19.0",
    defaultBrowser: { target: "chromium-headless-shell", path: chromiumPath },
    run: scripted([ok(`scenescout:\n  Command: ${process.execPath}\n  Args: /old/place/dist/mcp-server.js`)]).run,
  });
  const bad = moved.filter((c) => !c.ok);
  assert.equal(bad.length, 1);
  assert.match(bad[0].detail, /pointing at \/old\/place\/dist\/mcp-server\.js — not this install/);
});

test("diagnose fails a registration that names a bare `node`, which Claude Code may not find", () => {
  const packageRoot = fakePackage();
  const claudeDir = tmp("sc-claude-");
  installSkill({ packageRoot, claudeDir });
  const chromiumPath = path.join(packageRoot, "chromium");
  fs.writeFileSync(chromiumPath, "");
  const server = path.join(packageRoot, "dist", "mcp-server.js");
  const checks = diagnose({
    packageRoot,
    claudeDir,
    nodeVersion: "v22.19.0",
    defaultBrowser: { target: "chromium-headless-shell", path: chromiumPath },
    run: scripted([ok(`scenescout:\n  Command: node\n  Args: ${server}\n`)]).run,
  });
  const bad = checks.filter((c) => !c.ok);
  assert.equal(bad.length, 1);
  assert.match(bad[0].detail, /bare `node`/);
});

test("diagnose separates 'not registered' from 'registered but unreadable'", () => {
  const packageRoot = fakePackage();
  const claudeDir = tmp("sc-claude-");
  installSkill({ packageRoot, claudeDir });
  const chromiumPath = path.join(packageRoot, "chromium");
  fs.writeFileSync(chromiumPath, "");
  const base = { packageRoot, claudeDir, nodeVersion: "v22.19.0", defaultBrowser: { target: "chromium-headless-shell" as const, path: chromiumPath } };

  const unregistered = diagnose({ ...base, run: scripted([fail('No MCP server named "scenescout".')]).run }).filter((c) => !c.ok);
  assert.equal(unregistered.length, 1);
  assert.match(unregistered[0].detail, /no server named scenescout/);

  // A listing we cannot parse (a future layout) is not proof of a wrong
  // install — flagging it would be a failure `install` can never clear.
  const unreadable = diagnose({ ...base, run: scripted([ok("scenescout — stdio — connected")]).run });
  assert.deepEqual(
    unreadable.filter((c) => !c.ok),
    [],
  );
  assert.match(unreadable.find((c) => c.name === "MCP server registered")!.detail, /could not read its path/);
});

test("parseRegistration keeps a path with spaces whole and ignores an empty field", () => {
  const parsed = parseRegistration("scenescout:\n  Command: /Applications/My Tools/node\n  Args: /home/a b/dist/mcp-server.js\n  Environment:\n");
  assert.deepEqual(parsed, { command: "/Applications/My Tools/node", serverPath: "/home/a b/dist/mcp-server.js" });
  assert.deepEqual(parseRegistration("scenescout:\n  Args:\n  Environment:\n"), { command: null, serverPath: null });
});

test("diagnose compares the registration by real path, not by spelling", () => {
  // The same install reached through a symlink (or, on a case-insensitive
  // filesystem, through a differently-cased path) is not "somewhere else".
  // A string compare flagged a perfectly healthy setup as stale.
  const packageRoot = fakePackage();
  const claudeDir = tmp("sc-claude-");
  installSkill({ packageRoot, claudeDir });
  const chromiumPath = path.join(packageRoot, "chromium");
  fs.writeFileSync(chromiumPath, "");
  const alias = path.join(tmp("sc-alias-"), "link");
  fs.symlinkSync(packageRoot, alias, "dir");
  const listing = `scenescout:\n  Scope: User config\n  Command: ${process.execPath}\n  Args: ${path.join(alias, "dist", "mcp-server.js")}\n  Environment:\n`;
  const checks = diagnose({
    packageRoot,
    claudeDir,
    nodeVersion: "v22.19.0",
    defaultBrowser: { target: "chromium-headless-shell", path: chromiumPath },
    run: scripted([ok(listing)]).run,
  });
  assert.deepEqual(
    checks.filter((c) => !c.ok),
    [],
  );
});

/** `owner/name` of the GitHub repository package.json names. */
function githubRepo(pkg: { repository?: { url?: string } }): string {
  const match = /github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/.exec(pkg.repository?.url ?? "");
  assert.ok(match, "package.json names its GitHub repository");
  return match[1];
}

/** The marketplace reads the major tag of a stable version; a pre-release leaves it on the last stable major, which release.yml never moves for a pre-release. */
function assertMajorTag(ref: unknown, version: string): void {
  const [, major] = /^(\d+)\.\d+\.\d+(-.*)?$/.exec(version) ?? [];
  if (/^\d+\.\d+\.\d+$/.test(version)) assert.equal(ref, `v${major}`, "the marketplace reads the major tag of this version");
  else
    assert.ok(
      typeof ref === "string" && /^v\d+$/.test(ref) && Number(ref.slice(1)) <= Number(major),
      `a major tag no later than the pre-release's: ${String(ref)}`,
    );
}

test("the plugin manifest ships the same version and starts the published server", () => {
  // Claude Code offers a plugin update only when plugin.json's own version
  // changes, so a release that bumps package.json alone never reaches plugin
  // users. `npm run version-packages` keeps them together; this pins it.
  // fileURLToPath, not URL.pathname: on Windows the latter is "/D:/…", which resolves to "D:\\D:\\…".
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version: string;
    name: string;
    bin: Record<string, string>;
    repository?: { url?: string };
  };
  const plugin = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")) as {
    version: string;
    name: string;
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8")) as {
    name: string;
    plugins: Array<{ name: string; source: unknown }>;
  };

  assert.equal(plugin.version, pkg.version);
  // The server entry must run the package that is actually published, through a bin it actually has.
  const server = plugin.mcpServers.scenescout;
  // Pinned to the release the plugin ships with: an unpinned `npx -y scenescout` would run whatever npm calls latest on every launch.
  assert.deepEqual([server.command, ...server.args], ["npx", "-y", `${pkg.name}@${pkg.version}`, "serve"]);
  assert.ok("scenescout" in pkg.bin);
  // The install command in the README is `scenescout@<marketplace name>`; the
  // optional mod is listed after it as a plugin of its own.
  assert.deepEqual(
    marketplace.plugins.map((p) => p.name),
    [plugin.name, "scenescout-mod"],
  );
  // The plugin is read from the major tag, which release.yml moves only after
  // npm has the version: a source of `./` would read main, whose plugin.json
  // pins the new version from the Version Packages merge until publish ends.
  const { ref, ...source } = marketplace.plugins[0].source as { ref: unknown };
  assert.deepEqual(source, { source: "github", repo: githubRepo(pkg) });
  assertMajorTag(ref, pkg.version);
  assert.notEqual(marketplace.name, plugin.name, "a marketplace may not share its plugin's name");
  assert.ok(fs.existsSync(path.join(root, "skills", "scenescout", "SKILL.md")), "plugins load skills from skills/<name>/SKILL.md");
});

test("the optional mod is a plugin of its own: listed, versioned with the package, and adding no server", () => {
  // Organisations that block mods must lose nothing: the main plugin keeps the
  // skill and the server, and the mod's own directory holds only the mod.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (relative: string) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  const pkg = read("package.json") as { version: string };
  const marketplace = read(".claude-plugin/marketplace.json") as {
    plugins: Array<{ name: string; source: { source: string; url: string; path: string; ref: string }; description: string }>;
  };
  const entry = marketplace.plugins.find((p) => p.name === "scenescout-mod");
  assert.ok(entry, "the marketplace lists the mod");
  // Read from the same major tag as the server it drives, so the two move together.
  const { ref, ...source } = entry.source;
  assert.deepEqual(source, { source: "git-subdir", url: `https://github.com/${githubRepo(read("package.json"))}.git`, path: "mods/scenescout-mod" });
  assert.equal(ref, marketplace.plugins[0].source.ref, "the mod is read from the same tag as the server it drives");
  assert.match(entry.description, /optional/i, "the listing says the mod is optional");
  const dir = path.join(root, entry.source.path);
  const mod = read(path.join(entry.source.path, ".claude-plugin", "plugin.json")) as {
    name: string;
    version: string;
    mcpServers?: unknown;
    userConfig: Record<string, { type: string; title: string; description: string; default?: unknown; sensitive?: boolean }>;
  };
  assert.equal(mod.name, entry.name, "the plugin's name is the one the marketplace installs");
  assert.equal(mod.version, pkg.version, "Claude Code offers the mod's update only when its own version moves");
  assert.equal(mod.mcpServers, undefined, "the mod polls the scenescout plugin's server; a second server would be a second engine");
  // userConfig options are strict objects: an unknown key stops the plugin loading.
  const allowed = new Set(["type", "title", "description", "required", "default", "options", "multiple", "sensitive", "min", "max"]);
  assert.deepEqual(Object.keys(mod.userConfig).sort(), ["game", "lane_model", "mcp_server"]);
  for (const [key, option] of Object.entries(mod.userConfig)) {
    assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/, `${key}: a userConfig key is an identifier`);
    for (const field of Object.keys(option)) assert.ok(allowed.has(field), `${key}.${field} is not a userConfig field`);
    assert.equal(option.type, "string");
    assert.ok(option.title && option.description, `${key} has the title and description the dialog shows`);
    assert.notEqual(option.sensitive, true, `${key}: the mod asks for no secret`);
    // The game layer is a picker whose default is off; every other option is empty, so the mod does nothing until it is set.
    if (key === "game")
      assert.deepEqual([option.default, (option as { options?: unknown }).options], ["off", ["off", "on"]], "the game layer is off by default");
    else assert.equal(option.default, "", `${key}: empty by default, so the mod does nothing until it is set`);
  }
  // hooks.json names one module, inside the plugin, and that module exists.
  const hooks = read(path.join(entry.source.path, "hooks", "hooks.json")) as { modules: string[]; hooks?: unknown };
  assert.deepEqual(hooks.modules, ["./register.js"]);
  assert.equal(hooks.hooks, undefined, "no settings hooks: everything is in the module");
  const register = fs.readFileSync(path.join(dir, "hooks", "register.js"), "utf8");
  // A hooks module may import only its own files by relative path, and the bare `claude-code`.
  const imports = [...register.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./pane.js", "./guided.js", "./run.js", "./game.js"], "register.js imports only its own rules, by relative path");
  // The mod presents itself in plain words, with somewhere to ask for help and to read what it reaches.
  const shown = read(path.join(entry.source.path, ".claude-plugin", "plugin.json")) as Record<string, unknown>;
  assert.equal(typeof shown.displayName, "string");
  assert.match(String(shown.description), /\/scenescout-guided/);
  assert.ok(fs.existsSync(path.join(dir, String(shown.icon))), "the icon the manifest names is in the mod");
  for (const key of ["supportUrl", "privacyPolicyUrl", "homepage"]) assert.match(String(shown[key]), /^https:\/\/github\.com\/brunoboto96\/SceneScout\//, key);
  assert.match(String(shown.privacyPolicyUrl), /#what-it-reaches$/, "the privacy link lands on the What it reaches table");
  // Claude Code refuses a mod whose name takes a reserved prefix.
  assert.doesNotMatch(mod.name, /^(claude-|anthropic-|cc-plugin-)/);
  // Its $.state values are declared in the contract the manifest names.
  assert.equal(shown.types, "./types/index.d.ts");
  const contract = fs.readFileSync(path.join(dir, "types", "index.d.ts"), "utf8");
  for (const key of ["wizard", "status", "picture", "confirmed", "tickets", "cost", "recap"]) {
    assert.match(contract, new RegExp(`\\b${key}: `), `the contract declares ${key}`);
    assert.ok(register.includes(`{ plugin: "scenescout-mod", key: "${key}" }`), `register.js keeps ${key} in $.state`);
  }
  // The rules modules use no mods API, so live-test can run them in Node.
  for (const file of ["pane.js", "guided.js", "run.js", "game.js"]) {
    const code = fs
      .readFileSync(path.join(dir, "hooks", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\$\.|from "claude-code"/, file);
  }
  // Nothing in the main plugin's default component directories comes from the mod.
  assert.ok(!fs.existsSync(path.join(root, "hooks")), "the main plugin carries no hooks of its own, so blocking mods costs it nothing");
});

test("the mod registers its hooks as the settings say: the panel and its guard always, the spawn hook only with a lane model", async () => {
  // Calls the module's own register with a stand-in `on`, so what is checked is what Claude Code would be handed.
  const { register } = (await import("../mods/scenescout-mod/hooks/register.js")) as { register: (on: unknown, options: unknown) => void };
  const { COMMAND, PANE_ID } = (await import("../mods/scenescout-mod/hooks/pane.js")) as { COMMAND: string; PANE_ID: string };
  const hooksFor = (options: unknown): Array<[string, unknown]> => {
    const seen: Array<[string, unknown]> = [];
    register((event: string, matcherOrHook: unknown) => {
      seen.push([event, typeof matcherOrHook === "function" ? null : matcherOrHook]);
      return { catch: () => undefined };
    }, options);
    return seen;
  };
  const { GUIDED_COMMAND } = (await import("../mods/scenescout-mod/hooks/guided.js")) as { GUIDED_COMMAND: string };
  const pane: Array<[string, unknown]> = [
    ["session.start", null],
    ["command.run", { command: GUIDED_COMMAND }],
    ["command.run", { command: COMMAND }],
    ["ui.close", null],
    ["turn.start", null],
    ["turn.complete", null],
    ["ui.render", { component: "Pane" }],
    // The band above the prompt while a guided check runs; a build without the band never raises it.
    ["ui.render", { component: "AbovePrompt" }],
    // The question before Claude's own SceneScout call that would send things to a site.
    ["tool.call", null],
    // Each change in the session's usage, for the limit the person set on a check.
    ["session.measure", null],
  ];
  assert.equal(COMMAND, "scenescout-pane");
  assert.equal(GUIDED_COMMAND, "scenescout-guided");
  assert.match(PANE_ID, /^[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual(hooksFor({ lane_model: "", mcp_server: "" }), pane, "the default: no spawn hook");
  assert.deepEqual(hooksFor({}), pane, "settings absent: no spawn hook");
  assert.deepEqual(hooksFor({ lane_model: "sonnet; rm -rf" }), pane, "a value that is not a model name: no spawn hook");
  assert.deepEqual(hooksFor({ lane_model: "sonnet", mcp_server: "" }), [...pane, ["agent.spawn", null]]);
});

test("the versioning step formats the files it rewrites", () => {
  // sync-plugin-version writes plugin.json with JSON.stringify, which lays
  // arrays out differently from Prettier. If `version-packages` does not format
  // afterwards, the generated version pull request fails the format check and a
  // release cannot merge. The step was lost once in a rebase; this pins it.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const steps = pkg.scripts["version-packages"].split("&&").map((s) => s.trim());
  const sync = steps.findIndex((s) => s.includes("sync-plugin-version"));
  const format = steps.findIndex((s) => s.startsWith("prettier --write") && s.includes(".claude-plugin/plugin.json") && s.includes("package.json"));
  assert.ok(sync >= 0, "version-packages must sync the plugin version");
  assert.ok(format > sync, "version-packages must run Prettier over plugin.json and package.json after the sync");
  assert.ok(steps[format].includes("desktop-extension/manifest.json"), "and over the desktop extension's manifest, which the sync rewrites too");
  assert.ok(steps[format].includes("mods/scenescout-mod/.claude-plugin/plugin.json"), "and over the mod's manifest, which the sync rewrites too");
  assert.ok(steps[format].includes(".claude-plugin/marketplace.json"), "and over the marketplace, whose tag the sync moves on a new major");
  const syncScript = fs.readFileSync(path.join(root, "scripts", "sync-plugin-version.mjs"), "utf8");
  assert.match(syncScript, /path\.join\("desktop-extension", "manifest\.json"\)/, "the sync moves the desktop extension's version with the package");
  assert.match(syncScript, /path\.join\("mods", "scenescout-mod", "\.claude-plugin", "plugin\.json"\)/, "the sync moves the mod's version with the package");
});

const LAUNCH_COPIES = ["README.md", path.join("docs", "guide", "Start-here.md"), path.join("skills", "scenescout", "SKILL.md")];
const LAUNCH_LINE = /scenescout(@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?(?="?,? ?"?serve)/g;
const FOLLOW_LATEST = "To follow the latest npm release instead";

test("the versioning step moves the plugin's pinned server with the package version", () => {
  // Run the real sync script over a copy of the three manifests with a new
  // package version: the plugin's launch line must follow it, or the version
  // pull request ships a plugin that still starts the previous release.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const work = tmp("sc-sync-");
  const files = [
    path.join(".claude-plugin", "plugin.json"),
    path.join("mods", "scenescout-mod", ".claude-plugin", "plugin.json"),
    path.join("desktop-extension", "manifest.json"),
    path.join("scripts", "sync-plugin-version.mjs"),
    path.join(".claude-plugin", "marketplace.json"),
    ...LAUNCH_COPIES,
  ];
  for (const relative of files) {
    fs.mkdirSync(path.dirname(path.join(work, relative)), { recursive: true });
    fs.copyFileSync(path.join(repo, relative), path.join(work, relative));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { name: string; version: string };
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ ...pkg, version: "99.1.2" }));
  execFileSync(process.execPath, [path.join(work, "scripts", "sync-plugin-version.mjs")], { stdio: "pipe" });
  const read = (relative: string) => JSON.parse(fs.readFileSync(path.join(work, relative), "utf8"));
  const plugin = read(files[0]);
  assert.equal(plugin.version, "99.1.2");
  assert.deepEqual(plugin.mcpServers[pkg.name].args, ["-y", `${pkg.name}@99.1.2`, "serve"], "the launch line moves with the version");
  assert.equal(read(files[1]).version, "99.1.2");
  assert.equal(read(files[2]).version, "99.1.2");
  // A new major moves the tag the marketplace reads both plugins from.
  const marketplace = read(path.join(".claude-plugin", "marketplace.json")) as { plugins: Array<{ source: { ref?: string } }> };
  assert.deepEqual(
    marketplace.plugins.map((p) => p.source.ref),
    ["v99", "v99"],
  );
});

test("every copy-paste launch line is pinned to the package version", () => {
  // An unpinned `npx -y scenescout serve` runs whatever npm calls latest on
  // each launch. The README, the guide's client setups and the skill's by-hand
  // line carry the release's own version, as the plugin does. The one unpinned
  // line is the guide's opt-in to follow the latest release, which must stay
  // unpinned for that sentence to mean what it says.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  let seen = 0;
  const optIns: string[] = [];
  for (const relative of LAUNCH_COPIES) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    const matches = [...text.matchAll(LAUNCH_LINE)];
    assert.ok(matches.length > 0, `${relative} has a launch line`);
    for (const match of matches) {
      const line = text.slice(text.lastIndexOf("\n", match.index) + 1, text.indexOf("\n", match.index));
      if (match[0] === "scenescout" && line.includes(FOLLOW_LATEST)) {
        optIns.push(relative);
        continue;
      }
      seen++;
      assert.equal(match[0], `scenescout@${pkg.version}`, `${relative}: a launch line must name the package version: ${line.trim()}`);
    }
  }
  assert.ok(seen >= 7, `README, three JSON setups, Codex, Zed and the skill: found ${seen}`);
  assert.deepEqual(optIns, [path.join("docs", "guide", "Start-here.md")], "the guide's opt-in to follow the latest release names the unpinned launcher");
});

test("every npx launch line in the repository's documents is one the versioning step moves", () => {
  // A launch line in a file the sync does not rewrite would keep the version it
  // was written with, and drift from the release on the next version bump.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md", "*.json", "*.toml", "*.yml", "*.yaml", "*.html"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  // A placeholder such as `scenescout@<version>` is prose, not a line to copy.
  const npxLaunch = /(?:-y|--yes)"?,? ?"?scenescout(?:@[0-9A-Za-z.-]+)?"?,? ?"?serve\b/;
  const holders = tracked.filter((relative) => npxLaunch.test(fs.readFileSync(path.join(root, relative), "utf8")));
  // CHANGELOG.md is history; plugin.json's launch line is written by the sync as JSON.
  const moved = new Set([...LAUNCH_COPIES, path.join(".claude-plugin", "plugin.json"), "CHANGELOG.md"].map((p) => p.split(path.sep).join("/")));
  assert.deepEqual(
    holders.filter((relative) => !moved.has(relative)),
    [],
    "add the file to the sync's list and to LAUNCH_COPIES",
  );
});

test("the versioning step moves the copy-paste launch lines with the package version", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const work = tmp("sc-sync-docs-");
  const files = [
    path.join(".claude-plugin", "plugin.json"),
    path.join("mods", "scenescout-mod", ".claude-plugin", "plugin.json"),
    path.join("desktop-extension", "manifest.json"),
    path.join("scripts", "sync-plugin-version.mjs"),
    path.join(".claude-plugin", "marketplace.json"),
    ...LAUNCH_COPIES,
  ];
  for (const relative of files) {
    fs.mkdirSync(path.dirname(path.join(work, relative)), { recursive: true });
    fs.copyFileSync(path.join(repo, relative), path.join(work, relative));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "scenescout", version: "99.1.2-beta.1" }));
  execFileSync(process.execPath, [path.join(work, "scripts", "sync-plugin-version.mjs")], { stdio: "pipe" });
  const first = files.map((relative) => fs.readFileSync(path.join(work, relative), "utf8"));
  execFileSync(process.execPath, [path.join(work, "scripts", "sync-plugin-version.mjs")], { stdio: "pipe" });
  assert.deepEqual(
    files.map((relative) => fs.readFileSync(path.join(work, relative), "utf8")),
    first,
    "a second run changes nothing",
  );
  // release.yml never moves a major tag for a pre-release, so the marketplace stays on the one it reads.
  const marketplace = (relative: string) => JSON.parse(fs.readFileSync(path.join(relative, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.deepEqual(marketplace(work), marketplace(repo), "a pre-release leaves the marketplace's tag where it is");
  for (const relative of LAUNCH_COPIES) {
    const before = fs.readFileSync(path.join(repo, relative), "utf8");
    const after = fs.readFileSync(path.join(work, relative), "utf8");
    assert.equal(after, before.split(`scenescout@${pkg.version}`).join("scenescout@99.1.2-beta.1"), `${relative}: only the pinned versions change`);
  }
});

// ── The desktop extension (.mcpb) ────────────────────────────────────────────
// Spec: the MCPB manifest.json format, manifest_version 0.3.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type Manifest = {
  manifest_version: string;
  name: string;
  display_name?: string;
  version: string;
  description: string;
  author: { name: string };
  server: { type: string; entry_point: string; mcp_config: { command: string; args: string[]; env?: Record<string, string> } };
  compatibility?: { runtimes?: { node?: string } };
  user_config?: Record<string, unknown>;
  long_description?: string;
  prompts?: Array<{ name: string; description?: string; arguments?: string[]; text: string }>;
  prompts_generated?: boolean;
};
const readManifest = (): Manifest => JSON.parse(fs.readFileSync(path.join(repoRoot, "desktop-extension", "manifest.json"), "utf8")) as Manifest;

test("the desktop extension's manifest has every required field, the package's version, and starts the built server", () => {
  const manifest = readManifest();
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string; main: string; engines: { node: string } };
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.name, DESKTOP_EXTENSION_NAME, "doctor finds the install by this name");
  assert.equal(manifest.display_name, "SceneScout");
  assert.equal(manifest.version, pkg.version, "a desktop extension shows its manifest's version; it must be the package's");
  assert.ok(manifest.description.trim().length > 0);
  assert.ok(manifest.author.name.trim().length > 0);
  // A Node server: the desktop app runs the entry point with its own node, from the unpacked bundle.
  assert.equal(manifest.server.type, "node");
  assert.equal(manifest.server.entry_point, "dist/mcp-server.js");
  assert.equal(manifest.server.entry_point, pkg.main, "the same server the npm package starts");
  assert.ok(fs.existsSync(path.join(repoRoot, "src", "mcp-server.ts")), "which the build compiles from src/mcp-server.ts");
  assert.equal(manifest.server.mcp_config.command, "node");
  assert.deepEqual(
    manifest.server.mcp_config.args,
    ["${__dirname}/dist/mcp-server.js"],
    "an absolute path inside the bundle, whatever folder the app starts it from",
  );
  assert.equal(manifest.compatibility?.runtimes?.node, pkg.engines.node, "the Node it needs is the package's");
  // The only settings are the trackers' sign-ins for filing tickets, each optional: with none the engine starts as it is.
  assert.deepEqual(Object.keys(manifest.user_config ?? {}), ["github_token", "jira_base_url", "jira_email", "jira_api_token"]);
});

test("the desktop extension's settings are the trackers' sign-ins, optional, the secrets marked sensitive, reaching the server as the variables export reads", () => {
  const manifest = readManifest();
  const config = (manifest.user_config ?? {}) as Record<string, { type: string; title: string; sensitive?: boolean; required?: boolean }>;
  const env = manifest.server.mcp_config.env ?? {};
  const wanted: Record<string, { variable: string; sensitive: boolean }> = {
    github_token: { variable: "GH_TOKEN", sensitive: true },
    jira_base_url: { variable: "JIRA_BASE_URL", sensitive: false },
    jira_email: { variable: "JIRA_EMAIL", sensitive: false },
    jira_api_token: { variable: "JIRA_API_TOKEN", sensitive: true },
  };
  for (const [key, w] of Object.entries(wanted)) {
    assert.equal(config[key]?.type, "string", key);
    assert.equal(config[key]?.required, false, `${key}: SceneScout works without it`);
    assert.equal(config[key]?.sensitive, w.sensitive, `${key}: a secret is kept by the host and never shown`);
    assert.equal(env[w.variable], `\${user_config.${key}}`, `${key} reaches the server as ${w.variable}`);
  }
  assert.deepEqual(
    Object.keys(env).sort(),
    Object.values(wanted)
      .map((w) => w.variable)
      .sort(),
    "no other variable is set",
  );
  // Filled in, they are the credentials an export reads; left empty, or passed as the bare placeholder, they are none.
  const filled = trackerEnv({
    GH_TOKEN: "ghp_0123456789abcdef",
    JIRA_EMAIL: "qa@example.com",
    JIRA_API_TOKEN: "jira-0123456789",
    JIRA_BASE_URL: "https://x.atlassian.net",
  });
  assert.equal(trackerCredentials("github", filled).ok, true);
  assert.equal(trackerCredentials("jira", filled).ok, true);
  const empty = trackerEnv(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v])));
  assert.deepEqual(empty, {}, "an unfilled placeholder is not a value");
  assert.equal(trackerCredentials("github", trackerEnv({ GH_TOKEN: "" })).ok, false);
});

test("the desktop extension declares the guided prompts the server lists, each with the text it sends when given nothing", () => {
  const manifest = readManifest();
  assert.deepEqual(
    manifest.prompts?.map((p) => p.name),
    GUIDED_PROMPTS.map((p) => p.name),
    "the chat's guided entry points, in the server's order",
  );
  for (const listed of GUIDED_PROMPTS) {
    const declared: NonNullable<Manifest["prompts"]>[number] | undefined = manifest.prompts?.find((p) => p.name === listed.name);
    assert.equal(declared?.description, listed.description, `${listed.name}: the server's description`);
    assert.deepEqual(
      declared?.arguments ?? [],
      listed.arguments.map((a) => a.name),
      `${listed.name}: the server's arguments`,
    );
    assert.equal(declared?.text, guidedPromptText(listed.name, undefined), `${listed.name}: what the server sends for it with no arguments`);
  }
  // explore, live and login, and the text a prompt's arguments change, come from the server as it runs.
  assert.equal(manifest.prompts_generated, true);
});

test("the desktop extension's description claims no more than the write policy enforces", () => {
  const text = readManifest().long_description ?? "";
  // read-only lets a plain POST through, and observe lets sign-in, refresh and named read POSTs out (Safety model).
  assert.doesNotMatch(text, /blocks edits and deletions|nothing but reads|nothing (?:existing )?is changed|reads only/i);
  assert.match(text, /plain POST/, "says an ordinary form submission goes through in the default mode");
  assert.match(text, /can still create a record or change one/, "and what that means for what was there");
  assert.match(text, /signing in, signing out and refreshing a token/, "says what observe lets out besides page loads");
  assert.match(text, /WebSocket/, "and that only HTTP is inspected");
  assert.match(text, /Check my site/, "names the guided prompt a person starts from");
  assert.match(text, /unsubscribe link/, "says a link that acts when opened is followed");
});

test("the website's tour names each part's file once, under one address, with a transcript per part", () => {
  const html = fs.readFileSync(path.join(repoRoot, "site/index.html"), "utf8");
  const list = /<ol class="tour-parts"[^>]*data-base="([^"]+)"[^>]*>([\s\S]*?)<\/ol>/.exec(html);
  assert.ok(list, "the tour's part list carries its base address");
  const base = list[1];
  assert.match(base, /^https:\/\/[^/]+\/.+\/$/, "the base is an https address ending in a folder");
  const buttons = [...list[2].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
  assert.equal(buttons.length, 9, "the whole tour and its eight parts");
  const attr = (b: { attrs: string }, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(b.attrs)?.[1] ?? "";
  const srcs = buttons.map((b) => attr(b, "data-src"));
  for (const [i, src] of srcs.entries()) {
    assert.ok(new URL(src, base).href.startsWith(base), `part ${i} resolves inside the base: ${src}`);
  }
  assert.equal(new Set(srcs).size, srcs.length, "no two parts play the same file");
  const ids = buttons.map((b) => attr(b, "data-testid"));
  assert.ok(
    ids.every((id) => /^tour-part-[\w-]+$/.test(id)),
    "every part has a test id",
  );
  assert.equal(new Set(ids).size, ids.length, "and no two share one");
  assert.equal(attr(buttons[0], "aria-current"), "true", "the whole tour is the part shown first");
  const seconds = (len: string) => Number(len.split(":")[0]) * 60 + Number(len.split(":")[1]);
  const lens = buttons.map((b, i) => {
    const shown = /<\/span>([^<]+)<span class="len">(\d+:\d\d)<\/span>/.exec(b.body);
    assert.ok(shown, `part ${i} shows its title and length`);
    assert.equal(attr(b, "aria-label"), `${shown[1].trim()}, ${shown[2]}`, `part ${i}'s accessible name is its title and length as shown`);
    return seconds(shown[2]);
  });
  // Lengths are shown rounded down, so the parts' sum may fall short of the whole by under a second each.
  const partsSum = lens.slice(1).reduce((a, b) => a + b, 0);
  assert.ok(lens[0] >= partsSum && lens[0] < partsSum + lens.length - 1, `the whole tour (${lens[0]} s) is its parts' length (${partsSum} s)`);
  const video = /<video\b[^>]*>/.exec(html)?.[0] ?? "";
  assert.equal(/\ssrc="([^"]+)"/.exec(video)?.[1], new URL(srcs[0], base).href, "the player starts on the whole tour");
  assert.match(video, /\sid="tour-video"/, "the player has the id the script finds it by");
  assert.match(html, /class="tour-error"/, "and the line the script shows when a part will not load is there");
  assert.equal(html.split(new URL(base).host).length - 1, 2, "the bucket's host is written in the base and the player's first file only");
  const poster = /\sposter="([^"]+)"/.exec(video)?.[1] ?? "";
  assert.ok(poster && fs.statSync(path.join(repoRoot, "site", poster)).size > 0, "the player's poster is a file in the site");
  // Each part's number, title and file agree with its heading in the transcript, so a reorder or rename in one place fails.
  const transcript = /<details class="tour-transcript"[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
  const headings = [...transcript.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.equal(headings.length, buttons.length - 1, "the transcript has a heading per part");
  for (const [k, b] of buttons.slice(1).entries()) {
    const n = k + 1;
    const title = /<\/span>([^<]+)<span class="len">/.exec(b.body)?.[1].trim();
    assert.equal(headings[k], `${n}. ${title}`, `part ${n}'s transcript heading`);
    assert.ok(srcs[n].startsWith(`chapters/${String(n).padStart(2, "0")}-`), `part ${n} plays its own chapter file`);
  }
});

/**
 * Wording that claims more than the write policy enforces (Safety model, "What is a guarantee and what is best effort").
 * Each phrase is tied to a mode or a page, so an ordinary "changes nothing" or "reads only" elsewhere is not caught.
 */
const OVERCLAIM_RE =
  /nothing (?:existing )?is changed|(?:reads|loads|opens) pages, changes nothing|nothing but `?(?:GETs?|reads)`?(?: requests)? leaves?|(?:<p>|\| )reads only\b|blocks edits and deletions|blocks mutations on anything else|scout_network`?[^\n]*read-only, with credentials redacted/i;

test("the README, the website and the skill claim no more than the write policy enforces", () => {
  for (const file of ["README.md", "site/index.html", "skills/scenescout/SKILL.md"]) {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(text, OVERCLAIM_RE, `${file} claims more than the policy enforces`);
    assert.match(text, /WebSocket/, `${file} says messages over a WebSocket are not inspected`);
    assert.match(text, /unsubscribe link/, `${file} says a link that acts when opened is followed`);
  }
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const observe = readme.split("\n").find((l) => l.startsWith("| 🔵 `observe` |")) ?? "";
  assert.match(observe, /`HEAD` and `OPTIONS`/, "the README's observe row names every method it lets out");
  assert.match(observe, /signing in, signing out and refreshing a token/, "and the sign-in exemption");
  assert.match(observe, /name as a read/, "and the POSTs named as reads");
  const readOnly = readme.split("\n").find((l) => l.startsWith("| 🟢 `read-only` |")) ?? "";
  assert.match(readOnly, /can create a record or change one that was there/, "the README says what a plain POST in read-only can do");
  // Each row names the commands it is the default for, as the parsers default them.
  const check = parseCheckArgs(["http://127.0.0.1:3000"], "/p");
  assert.ok(check.ok);
  assert.ok(
    (check.options.mode === "observe" ? observe : readOnly).includes("`scenescout check`"),
    `the README names check under its default, ${check.options.mode}`,
  );
  assert.ok(!(check.options.mode === "observe" ? readOnly : observe).includes("`scenescout check`"), "and under no other mode");
  // The guide's own summaries of the modes hold to the same rule.
  for (const page of ["Start-here.md", "Ways-to-use-it.md"]) {
    const text = fs.readFileSync(path.join(repoRoot, "docs", "guide", page), "utf8");
    assert.doesNotMatch(text, OVERCLAIM_RE, `${page} claims more than the policy enforces`);
  }
});

test("the plugin and the desktop extension link to what they reach", () => {
  const anchor = "https://github.com/brunoboto96/SceneScout/blob/main/docs/guide/Ways-to-use-it.md#what-it-reaches";
  const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
  assert.equal(plugin.privacyPolicyUrl, anchor, "the plugin's privacy link lands on the What it reaches table");
  assert.ok((readManifest().long_description ?? "").includes(anchor), "the extension's description links to it");
  // A Windows checkout ends lines with \r\n; the heading is found on either.
  const guide = fs.readFileSync(path.join(repoRoot, "docs", "guide", "Ways-to-use-it.md"), "utf8").replace(/\r\n/g, "\n");
  const reach = guide.slice(guide.indexOf("\n## What it reaches\n"));
  assert.ok(reach.length > 1 && guide.includes("\n## What it reaches\n"), "the heading the links name is there");
  const header = reach.split("\n").find((l) => l.startsWith("| |")) ?? "";
  for (const install of ["The plugin", "The desktop extension", "The mod"]) assert.ok(header.includes(install), `its table has a column for ${install}`);
  for (const row of ["Network: the app", "Network: downloads", "Network: a model", "A port", "Processes", "Files written", "Files read", "The project folder"])
    assert.match(reach, new RegExp(`^\\| ${row} \\|`, "m"), `and a row for ${row}`);
});

test("the build's declaration files stay out of the npm package and the bundle", () => {
  // The build writes .d.ts files so the test scripts can be type-checked against the built engine.
  // They are not part of what the package offers (it names no "types"), so neither it nor the bundle carries them.
  const tsconfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8")) as { compilerOptions: { declaration?: boolean } };
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { files: string[]; types?: string };
  assert.equal(pkg.types, undefined, "the package promises no typed API");
  if (tsconfig.compilerOptions.declaration) {
    assert.ok(pkg.files.includes("!dist/**/*.d.ts"), 'package.json "files" leaves out dist/**/*.d.ts');
    const script = fs.readFileSync(path.join(repoRoot, "scripts", "build-mcpb.mjs"), "utf8");
    assert.match(script, /filter: \(src\) => !src\.endsWith\("\.d\.ts"\)/, "the bundle build leaves out the declaration files too");
  }
});

test("the bundle build ships what the server reads at runtime, and the release attaches it from a job that runs no repository code", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "build-mcpb.mjs"), "utf8");
  const shipped =
    /for \(const entry of \[([^\]]+)\]\)/
      .exec(script)?.[1]
      .match(/"([^"]+)"/g)
      ?.map((s) => s.slice(1, -1)) ?? [];
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { files: string[]; scripts: Record<string, string> };
  for (const entry of pkg.files.filter((f) => f !== "CHANGELOG.md" && !f.startsWith("!")))
    assert.ok(shipped.includes(entry), `the bundle ships ${entry}, as the npm package does`);
  assert.ok(shipped.includes(PLAYBOOK_RELATIVE_PATH.split(path.sep)[0]), "the server reads its playbook from skills/");
  assert.match(script, /"ci", "--omit=dev", "--ignore-scripts"/, "production dependencies only, and no install scripts");
  assert.equal(pkg.scripts.mcpb, "node scripts/build-mcpb.mjs");

  type Step = { uses?: string; run?: string; with?: Record<string, string | boolean> };
  type Job = { needs?: string | string[]; if?: string; permissions?: Record<string, string>; steps: Step[] };
  const wf = parseYaml(fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8")) as { jobs: Record<string, Job> };
  const build = wf.jobs["desktop-extension"];
  assert.ok(build, "release.yml builds the bundle");
  assert.equal(build.needs, "release", "only for a version npm has: the release job runs after the publish");
  assert.match(build.if ?? "", /needs\.release\.outputs\.ref != ''/, "and only when it handed on what to build");
  assert.deepEqual(build.permissions, { contents: "read" }, "the job that runs repository code can change nothing");
  assert.equal(build.steps.find((s) => s.uses?.startsWith("actions/checkout"))?.with?.ref, "${{ needs.release.outputs.ref }}", "built from the release's tag");
  assert.ok(build.steps.some((s) => s.run === "npm run mcpb"));
  assert.ok(
    build.steps.some((s) => /npx -y @anthropic-ai\/mcpb@\d+\.\d+\.\d+ validate/.test(s.run ?? "")),
    "validated against the manifest schema with a pinned MCPB tool",
  );
  const upload = build.steps.find((s) => /^actions\/upload-artifact@/.test(s.uses ?? ""));
  assert.equal(upload?.with?.path, ".mcpb-build/*.mcpb", "the bundle the build writes");
  assert.equal(String(upload?.with?.["include-hidden-files"]), "true", ".mcpb-build is a hidden directory, which the upload skips unless asked");
  const attach = wf.jobs["attach-desktop-extension"];
  assert.ok(attach, "release.yml attaches the bundle");
  assert.deepEqual(attach.permissions, { contents: "write" });
  assert.ok(!attach.steps.some((s) => s.uses?.startsWith("actions/checkout")), "no checkout where the token can write");
  assert.ok(!attach.steps.some((s) => /\b(node|npm|npx|tsx)\b/.test(s.run ?? "")), "and no repository code");
  assert.ok(attach.steps.some((s) => /^gh release upload "\$TAG" \*\.mcpb\b/.test(s.run ?? "")));
});

/** A desktop extension folder as Claude Desktop unpacks one. */
function fakeExtension(
  root: string,
  folder: string,
  manifest: Record<string, unknown> | string,
  opts: { entry?: boolean; shellRevision?: string } = {},
): string {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  if (opts.entry !== false) {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "mcp-server.js"), "");
  }
  if (opts.shellRevision) {
    // The shape of playwright-core's browsers.json, cut down to what is read.
    const browsers = [
      { name: "chromium", revision: opts.shellRevision },
      { name: "chromium-headless-shell", revision: opts.shellRevision },
    ];
    fs.mkdirSync(path.join(dir, "node_modules", "playwright-core"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "playwright-core", "browsers.json"), JSON.stringify({ comment: "", browsers }));
  }
  return dir;
}
const ourManifest = (version = "3.15.0") => ({ name: DESKTOP_EXTENSION_NAME, version, server: { type: "node", entry_point: "dist/mcp-server.js" } });

test("doctor looks for desktop extensions where Claude Desktop keeps them on each platform", () => {
  const home = tmp("sc-home-");
  assert.deepEqual(desktopExtensionRoots({ platform: "darwin", home, env: {} }), [
    path.join(home, "Library", "Application Support", "Claude", "Claude Extensions"),
  ]);
  assert.deepEqual(desktopExtensionRoots({ platform: "linux", home, env: {} }), [path.join(home, ".config", "Claude", "Claude Extensions")]);
  assert.deepEqual(desktopExtensionRoots({ platform: "linux", home, env: { XDG_CONFIG_HOME: path.join(home, "xdg") } }), [
    path.join(home, "xdg", "Claude", "Claude Extensions"),
  ]);
  // Windows: the installer build under APPDATA, and the Store build in its package folder.
  const appData = path.join(home, "AppData", "Roaming");
  const local = path.join(home, "AppData", "Local");
  fs.mkdirSync(path.join(local, "Packages", "Claude_abc123"), { recursive: true });
  fs.mkdirSync(path.join(local, "Packages", "SomeOtherApp_xyz"), { recursive: true });
  assert.deepEqual(desktopExtensionRoots({ platform: "win32", home, env: { APPDATA: appData, LOCALAPPDATA: local } }), [
    path.join(appData, "Claude", "Claude Extensions"),
    path.join(local, "Packages", "Claude_abc123", "LocalCache", "Roaming", "Claude", "Claude Extensions"),
  ]);
});

test("the extension is found by its manifest's name, whatever its folder is called, and other extensions are left out", () => {
  const root = tmp("sc-ext-");
  assert.equal(findDesktopExtension([path.join(root, "missing")]), null, "no Claude Desktop, no extension");
  fakeExtension(root, "a-broken-one", "{ not json");
  fs.writeFileSync(path.join(root, ".DS_Store"), "");
  fakeExtension(root, "another-tool", { name: "another-tool", version: "1.0.0", server: { type: "node", entry_point: "dist/mcp-server.js" } });
  assert.equal(findDesktopExtension([root]), null, "another extension's manifest, or a broken one, is not SceneScout");
  const dir = fakeExtension(root, "local.mcpb.someone.scenescout", ourManifest("3.15.0"), { shellRevision: "1243" });
  assert.deepEqual(findDesktopExtension([path.join(root, "missing"), root]), {
    dir,
    version: "3.15.0",
    entry: path.join(dir, "dist", "mcp-server.js"),
    entryPresent: true,
    headlessShellRevision: "1243",
  } satisfies DesktopExtension);
  // Unpacked without its server: found, and said to be incomplete.
  const bare = tmp("sc-ext-");
  fakeExtension(bare, "x", ourManifest(), { entry: false });
  assert.equal(findDesktopExtension([bare])?.entryPresent, false);
});

test("doctor passes a Claude Desktop-only install, and still checks Claude Code where it is set up", () => {
  const packageRoot = fakePackage();
  const chromiumPath = path.join(packageRoot, "chromium");
  fs.writeFileSync(chromiumPath, "");
  const extRoot = tmp("sc-ext-");
  fakeExtension(extRoot, "ext", ourManifest(), { shellRevision: "1243" });
  const desktopExtension = findDesktopExtension([extRoot]);
  assert.ok(desktopExtension);
  const base = {
    packageRoot,
    nodeVersion: "v22.19.0",
    defaultBrowser: { target: "chromium-headless-shell" as const, path: chromiumPath },
    desktopExtension,
    // The same revision as this copy's: the browser check above is the extension's too.
    headlessShellDir: path.join(tmp("sc-cache-"), "chromium_headless_shell-1243"),
  };

  // No `claude`, no skill: before, this failed twice and sent a Claude Desktop user to set up Claude Code.
  const desktopOnly = diagnose({ ...base, claudeDir: tmp("sc-claude-"), run: scripted([absent]).run });
  assert.deepEqual(
    desktopOnly.filter((c) => !c.ok),
    [],
  );
  assert.deepEqual(
    desktopOnly.map((c) => c.name),
    ["node >= 22.19", "engine built", "browser downloaded (chromium-headless-shell)", "desktop extension installed", CLAUDE_CODE_NOT_NEEDED],
  );
  assert.match(desktopOnly[3].detail, /SceneScout 3\.15\.0 in Claude Desktop/);
  assert.equal(
    doctorAllGood({ engineOnly: false, desktopOnly: true }),
    "All good. In Claude Desktop, start a new chat and ask:  Use SceneScout to test http://localhost:3000",
  );
  // `claude` present but nothing registered, no skill: still nothing to fix.
  assert.deepEqual(
    diagnose({ ...base, claudeDir: tmp("sc-claude-"), run: scripted([notRegistered]).run }).filter((c) => !c.ok),
    [],
  );

  // Someone who set up Claude Code too is checked as before: here the registration is missing.
  const claudeDir = tmp("sc-claude-");
  installSkill({ packageRoot, claudeDir });
  const both = diagnose({ ...base, claudeDir, run: scripted([notRegistered]).run });
  assert.deepEqual(
    both.filter((c) => !c.ok).map((c) => c.name),
    ["MCP server registered"],
  );
  assert.ok(!both.some((c) => c.name === CLAUDE_CODE_NOT_NEEDED));

  // Without an extension, the default doctor is unchanged: no skill and no `claude` are failures.
  const none = diagnose({ ...base, desktopExtension: null, claudeDir: tmp("sc-claude-"), run: scripted([absent]).run });
  assert.deepEqual(
    none.filter((c) => !c.ok).map((c) => c.name),
    ["skill installed", "claude CLI on PATH"],
  );
});

test("doctor flags an extension missing its server, and one whose browser build is not downloaded", () => {
  const packageRoot = fakePackage();
  const chromiumPath = path.join(packageRoot, "chromium");
  fs.writeFileSync(chromiumPath, "");
  // A Playwright download folder holding this copy's headless build, revision 1243.
  const cache = tmp("sc-cache-");
  const ownShell = path.join(cache, "chromium_headless_shell-1243");
  fs.mkdirSync(ownShell);
  fs.writeFileSync(path.join(ownShell, "INSTALLATION_COMPLETE"), "");
  const base = {
    packageRoot,
    claudeDir: tmp("sc-claude-"),
    nodeVersion: "v22.19.0",
    defaultBrowser: { target: "chromium-headless-shell" as const, path: ownShell },
    scope: "engine" as const,
    headlessShellDir: ownShell,
    run: scripted([]).run,
  };
  const failing = (extensionRoot: string) => diagnose({ ...base, desktopExtension: findDesktopExtension([extensionRoot]) }).filter((c) => !c.ok);

  const broken = tmp("sc-ext-");
  fakeExtension(broken, "ext", ourManifest(), { entry: false, shellRevision: "1243" });
  const missing = failing(broken);
  assert.deepEqual(
    missing.map((c) => c.name),
    ["desktop extension installed"],
  );
  assert.match(missing[0].fix ?? "", /Settings > Extensions/);

  // An older extension launches an older build, which this copy's download does not provide.
  const older = tmp("sc-ext-");
  fakeExtension(older, "ext", ourManifest("3.9.0"), { shellRevision: "1194" });
  assert.deepEqual(
    failing(older).map((c) => [c.name, c.fix]),
    [["browser downloaded (desktop extension)", "npx -y scenescout@3.9.0 install --browser-only"]],
  );
  // Running that fix downloads the build beside this one, and the check clears.
  fs.mkdirSync(path.join(cache, "chromium_headless_shell-1194"));
  fs.writeFileSync(path.join(cache, "chromium_headless_shell-1194", "INSTALLATION_COMPLETE"), "");
  assert.deepEqual(failing(older), []);
  const passed = diagnose({ ...base, desktopExtension: findDesktopExtension([older]) });
  assert.ok(passed.some((c) => c.name === "browser downloaded (desktop extension)" && c.ok));

  // The same revision as this copy's adds no second check, and an unreadable revision skips it rather than guessing.
  const same = tmp("sc-ext-");
  fakeExtension(same, "ext", ourManifest(), { shellRevision: "1243" });
  assert.ok(!diagnose({ ...base, desktopExtension: findDesktopExtension([same]) }).some((c) => c.name === "browser downloaded (desktop extension)"));
  const unread = tmp("sc-ext-");
  fakeExtension(unread, "ext", ourManifest("3.9.0"));
  assert.deepEqual(failing(unread), []);
});

test("doctor does not fail an extension that downloads its browser on first use, and still names the command", () => {
  const packageRoot = fakePackage();
  const cache = tmp("sc-cache-");
  const ownShell = path.join(cache, "chromium_headless_shell-1243");
  fs.mkdirSync(ownShell);
  fs.writeFileSync(path.join(ownShell, "INSTALLATION_COMPLETE"), "");
  const check = (extensionVersion: string, version?: string) => {
    const root = tmp("sc-ext-");
    fakeExtension(root, "ext", ourManifest(extensionVersion), { shellRevision: "1300" });
    return diagnose({
      packageRoot,
      claudeDir: tmp("sc-claude-"),
      nodeVersion: "v22.19.0",
      defaultBrowser: { target: "chromium-headless-shell", path: ownShell },
      scope: "engine",
      headlessShellDir: ownShell,
      desktopExtension: findDesktopExtension([root]),
      version,
      run: scripted([]).run,
    }).find((c) => c.name === "browser downloaded (desktop extension)");
  };
  // As new as this copy, or newer: it downloads on its first test, so nothing is wrong.
  for (const ext of ["3.16.0", "3.17.2", "4.0.0"]) {
    const c = check(ext, "3.16.0");
    assert.equal(c?.ok, true, ext);
    assert.match(
      c?.detail ?? "",
      /the test browser downloads on first use \(one-time, about 200 MB\)\. To have it ready now: npx -y scenescout@[\d.]+ install --browser-only/,
    );
  }
  // Older than this copy, or a version doctor cannot tell: it may not, so the check fails with the command.
  for (const [ext, own] of [
    ["3.15.9", "3.16.0"],
    ["3.16.0", undefined],
  ] as const) {
    const c = check(ext, own);
    assert.equal(c?.ok, false, `${ext} against ${own}`);
    assert.equal(c?.fix, `npx -y scenescout@${ext} install --browser-only`);
  }
});

test("versions compare by number, and an unknown one is never taken as new", () => {
  assert.equal(atLeastVersion("3.16.0", "3.16.0"), true);
  assert.equal(atLeastVersion("3.16.10", "3.16.9"), true);
  assert.equal(atLeastVersion("3.9.0", "3.16.0"), false);
  assert.equal(atLeastVersion("4.0.0-beta.1", "3.16.0"), true);
  assert.equal(atLeastVersion(null, "3.16.0"), false);
  assert.equal(atLeastVersion("3.16.0", undefined), false);
  assert.equal(atLeastVersion("latest", "3.16.0"), false);
});

test("after a plugin install, install says to start a new chat, in plain words", () => {
  const plugin = installClosing({ browserOnly: true, forClaude: true });
  assert.ok(plugin?.includes("Start a new chat to use SceneScout."));
  const claude = installClosing({ browserOnly: false, forClaude: true });
  assert.ok(claude?.startsWith("Start a new chat in Claude Code to use SceneScout."));
  for (const line of [plugin, claude]) {
    assert.doesNotMatch(line ?? "", /\b(session|MCP|server|restart|reload|tools?)\b/i, "the mechanism stays out of it");
  }
  assert.equal(installClosing({ browserOnly: false, forClaude: false }), null, "another client gets its own hint instead");
});

test("an install run through npx registers the npx launcher, never a path inside npm's cache", () => {
  // The cache is npm's to clear. A registration pointing into it works today
  // and stops silently some weeks later, with no error the user can connect to
  // the cause.
  const cached = path.join(path.sep, "home", "u", ".npm", "_npx", "ab12", "node_modules", "scenescout");
  // A node install with npx beside it, as nvm, fnm and the official installers lay it out.
  const bin = tmp("sc-nodebin-");
  const nodePath = path.join(bin, "node");
  fs.writeFileSync(path.join(bin, process.platform === "win32" ? "npx.cmd" : "npx"), "");
  const launch = launchCommand({ packageRoot: cached, nodePath, serverPath: path.join(cached, "dist", "mcp-server.js"), version: "3.25.0" });
  assert.deepEqual(
    launch.slice(1),
    ["-y", "scenescout@3.25.0", "serve"],
    "the registration runs the version that registered it, not whatever npm calls latest",
  );
  assert.deepEqual(npxServeArgs("3.25.0"), launch.slice(1));
  // A registration made before the pin (unpinned, or pinned to an older release) is still this launcher.
  assert.equal(isNpxServeArgs("-y scenescout serve"), true);
  assert.equal(isNpxServeArgs("-y scenescout@3.24.0 serve"), true);
  assert.equal(isNpxServeArgs("-y scenescout@3.25.0 serve"), true);
  assert.equal(isNpxServeArgs("-y other-pkg serve"), false);
  assert.equal(isNpxServeArgs("-y scenescout@evil serve"), false);
  // A pre-release pin is this launcher too, so a registration made from one is replaced, not reported as something else.
  assert.equal(isNpxServeArgs("-y scenescout@3.26.0-beta.1 serve"), true);
  assert.equal(isNpxServeArgs("-y scenescout@3.26.0-beta.1; rm serve"), false);
  assert.equal(pinnedVersion("-y scenescout@3.26.0-beta.1 serve"), "3.26.0-beta.1");
  assert.equal(pinnedVersion("-y scenescout@3.26.0 serve"), "3.26.0");
  assert.equal(pinnedVersion("-y scenescout serve"), null);
  assert.ok(path.isAbsolute(launch[0]) && /npx(\.cmd)?$/.test(launch[0]), "an absolute npx beside the running node, so it starts under nvm too");
  assert.ok(!launch.join(" ").includes("_npx"), "nothing in the registration points into the cache");
  // A node that ships without npm: a bare npx on PATH beats an absolute path to nothing.
  assert.equal(launchCommand({ packageRoot: cached, nodePath: path.join(tmp("sc-bare-"), "node"), serverPath: "x", version: "3.25.0" })[0], "npx");

  // A clone or a global install is stable: register the script directly.
  const stable = path.join(path.sep, "opt", "tools", "scenescout");
  const server = path.join(stable, "dist", "mcp-server.js");
  assert.deepEqual(launchCommand({ packageRoot: stable, nodePath, serverPath: server, version: "3.25.0" }), [nodePath, server]);
});

test("diagnose accepts an npx registration and vets its launcher", () => {
  const packageRoot = fakePackage();
  const claudeDir = tmp("sc-claude-");
  installSkill({ packageRoot, claudeDir });
  const chromiumPath = path.join(packageRoot, "chromium");
  fs.writeFileSync(chromiumPath, "");
  const base = { packageRoot, claudeDir, nodeVersion: "v22.19.0", defaultBrowser: { target: "chromium-headless-shell" as const, path: chromiumPath } };
  const good = diagnose({ ...base, run: scripted([ok("scenescout:\n  Command: /opt/node/bin/npx\n  Args: -y scenescout serve\n")]).run });
  assert.deepEqual(
    good.filter((c) => !c.ok),
    [],
  );
  const bare = diagnose({ ...base, run: scripted([ok("scenescout:\n  Command: npx\n  Args: -y scenescout serve\n")]).run }).filter((c) => !c.ok);
  assert.equal(bare.length, 1);
  assert.match(bare[0].detail, /bare `npx`/);
});

test("diagnose fails a registration that pins a version npm does not have, and only on a definite answer", () => {
  const packageRoot = fakePackage();
  const claudeDir = tmp("sc-claude-");
  installSkill({ packageRoot, claudeDir });
  const chromiumPath = path.join(packageRoot, "chromium");
  fs.writeFileSync(chromiumPath, "");
  const base = { packageRoot, claudeDir, nodeVersion: "v22.19.0", defaultBrowser: { target: "chromium-headless-shell" as const, path: chromiumPath } };
  const listing = ok("scenescout:\n  Command: /opt/node/bin/npx\n  Args: -y scenescout@9.9.9 serve\n");
  const names = (checks: ReturnType<typeof diagnose>) => checks.filter((c) => !c.ok).map((c) => c.name);

  // Contrastive pair: the same pin, once unknown to npm and once published.
  const unpublished = scripted([listing, fail("npm error code E404\nnpm error 404 No match found for version 9.9.9")]);
  const missingPin = diagnose({ ...base, run: unpublished.run });
  assert.deepEqual(names(missingPin), ["registered version is published"]);
  assert.deepEqual(unpublished.calls[1], ["npm", "view", "scenescout@9.9.9", "version"]);
  assert.match(missingPin.find((c) => !c.ok)!.detail, /scenescout@9\.9\.9.*npm does not have/);
  // A registry that never answers (a firewall that drops the packets) must not hold the doctor for the runner's default minute.
  const bound = unpublished.options[1]?.timeoutMs;
  assert.ok(bound !== undefined && bound <= 15_000, `the npm lookup is given a short bound, got ${bound}`);

  assert.deepEqual(names(diagnose({ ...base, run: scripted([listing, ok("9.9.9\n")]).run })), []);
  // No npm, or an npm that failed for another reason (offline), is not evidence of a missing release.
  assert.deepEqual(names(diagnose({ ...base, run: scripted([listing, absent]).run })), []);
  assert.deepEqual(names(diagnose({ ...base, run: scripted([listing, fail("npm error network request failed ENOTFOUND")]).run })), []);
});

test("the real runner stops a command at the bound it is given and says so", () => {
  const started = Date.now();
  const r = spawnRunner(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { timeoutMs: 300 });
  assert.ok(Date.now() - started < 10_000, "stopped at the bound, not after the command's own 20 s");
  assert.equal(r.missing, false);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /did not finish within 0\.3 s/);
});

test("the engine-only doctor does not fail a plugin install for lacking a skill link or a registration", () => {
  // A plugin supplies the skill and the server itself, and another MCP client
  // has neither. The default doctor reported both as broken and told the user
  // to install a second, competing copy.
  const packageRoot = fakePackage();
  const chromiumPath = path.join(packageRoot, "chromium");
  fs.writeFileSync(chromiumPath, "");
  const base = {
    packageRoot,
    claudeDir: tmp("sc-claude-"),
    nodeVersion: "v22.19.0",
    defaultBrowser: { target: "chromium-headless-shell" as const, path: chromiumPath },
  };
  const engine = diagnose({ ...base, scope: "engine", run: scripted([]).run });
  assert.deepEqual(
    engine.map((c) => c.name),
    ["node >= 22.19", "engine built", "browser downloaded (chromium-headless-shell)"],
  );
  assert.deepEqual(
    engine.filter((c) => !c.ok),
    [],
    "and it never shells out to `claude`",
  );
  // The default scope still checks everything.
  const full = diagnose({ ...base, run: scripted([absent]).run });
  assert.ok(full.some((c) => c.name === "skill installed" && !c.ok));
});

test("replacing a registration that ran something else says what it ran", () => {
  // One name holds one server, so install still replaces it — but a second
  // checkout or a fork registered under the same name must not vanish silently.
  const packageRoot = fakePackage();
  const serverPath = path.join(packageRoot, "dist", "mcp-server.js");
  const launch = ["/opt/node/bin/node", serverPath];
  const exists = fail("MCP server scenescout already exists in user config");

  const other = scripted([
    exists,
    ok("scenescout:\n  Scope: User config\n  Command: /usr/bin/node\n  Args: /home/u/fork/dist/mcp-server.js\n"),
    ok(),
    ok(),
    notRegistered,
  ]);
  const replacedOther = registerMcp({ launch, serverPath, run: other.run });
  assert.equal(replacedOther.status, "registered");
  assert.equal(replacedOther.status === "registered" && replacedOther.replaced, true);
  const notes = replacedOther.status === "registered" ? replacedOther.notes.join("\n") : "";
  assert.match(notes, /replaced an existing "scenescout" registration that ran something else: \/usr\/bin\/node \/home\/u\/fork\/dist\/mcp-server\.js/);

  // Our own earlier registration — same script, a stale node path — is the
  // routine case and is replaced without comment.
  const own = scripted([exists, ok(`scenescout:\n  Command: /old/node\n  Args: ${serverPath}\n`), ok(), ok(), notRegistered]);
  const replacedOwn = registerMcp({ launch, serverPath, run: own.run });
  assert.deepEqual(replacedOwn.status === "registered" && replacedOwn.notes, []);

  // So is an npx registration, which names no script at all.
  const npx = scripted([exists, ok("scenescout:\n  Command: npx\n  Args: -y scenescout serve\n"), ok(), ok(), notRegistered]);
  assert.deepEqual((registerMcp({ launch, serverPath, run: npx.run }) as { notes: string[] }).notes, []);

  // A listing that cannot be read is not evidence of somebody else's server.
  const unreadable = scripted([exists, ok("scenescout — stdio — connected"), ok(), ok(), notRegistered]);
  assert.deepEqual((registerMcp({ launch, serverPath, run: unreadable.run }) as { notes: string[] }).notes, []);
});

test("doctor names a repair command that exists for the way the tool was installed", () => {
  // From npm there is no package.json script to run; from a checkout there is,
  // and it registers that checkout rather than the published package.
  const fromNpm = fakePackage();
  assert.equal(repairCommands(fromNpm).setup, "npx -y scenescout install");
  const checkout = fakePackage();
  fs.writeFileSync(path.join(checkout, "tsconfig.json"), "{}");
  fs.mkdirSync(path.join(checkout, "src"));
  const fromCheckout = repairCommands(checkout);
  assert.deepEqual([fromCheckout.setup, fromCheckout.build], ["npm run setup", "npm run build"]);
  // `npm run setup --browsers x` would hand the flag to npm, not to install.
  assert.equal(fromCheckout.browser("webkit"), "node dist/cli.js install --browser-only --browsers webkit");
  assert.equal(fromCheckout.browser("chromium"), "npm run setup");

  const fixes = diagnose({
    packageRoot: fromNpm,
    claudeDir: tmp("sc-claude-"),
    nodeVersion: "v22.19.0",
    defaultBrowser: { target: "chromium-headless-shell", path: null },
    run: scripted([fail('No MCP server named "scenescout".')]).run,
  })
    .filter((c) => !c.ok)
    .map((c) => c.fix ?? "");
  assert.ok(fixes.length >= 2);
  assert.ok(
    fixes.every((f) => !/npm run/.test(f)),
    `an npm install was told to run a checkout script: ${fixes.join(" | ")}`,
  );
});

test("--browsers picks what install downloads, and absent means what it always did", () => {
  assert.deepEqual(parseBrowserSelection(undefined), { targets: ["chromium"] });
  assert.deepEqual(parseBrowserSelection("chromium-headless-shell"), { targets: ["chromium-headless-shell"] });
  assert.deepEqual(parseBrowserSelection("firefox"), { targets: ["firefox"] });
  assert.deepEqual(parseBrowserSelection("all"), { targets: ["chromium", "firefox", "webkit"] });
  // Order and case do not matter, and the result is always in one order.
  assert.deepEqual(parseBrowserSelection(" WebKit, firefox "), { targets: ["firefox", "webkit"] });
  // "chromium" already brings the shell, so asking for both is not two downloads.
  assert.deepEqual(parseBrowserSelection("chromium-headless-shell,chromium"), { targets: ["chromium"] });

  // A typo is refused with the choices, before anything is downloaded.
  const typo = parseBrowserSelection("chrome");
  assert.ok("error" in typo);
  assert.match(typo.error, /"chrome" is not a browser.*chromium, chromium-headless-shell, firefox, webkit, all/);
  // `--browsers` as the last flag has no value; an empty list is not "install nothing".
  assert.ok("error" in parseBrowserSelection(""));
  assert.ok("error" in parseBrowserSelection(" , "));

  assert.deepEqual(playwrightInstallArgs(["chromium-headless-shell", "webkit"]), ["install", "chromium-headless-shell", "webkit"]);
});

test("a launch needs the headless shell unless it opens a window", () => {
  assert.equal(launchTarget("chromium", false), "chromium-headless-shell");
  assert.equal(launchTarget("chromium", true), "chromium");
  assert.equal(launchTarget("firefox", false), "firefox");
  assert.equal(launchTarget("webkit", true), "webkit");
});

test("the default browser comes from the environment, and a value that is not a browser is refused", () => {
  assert.equal(defaultEngine({}), "chromium");
  assert.equal(defaultEngine({ SCENESCOUT_BROWSER: "" }), "chromium");
  assert.equal(defaultEngine({ SCENESCOUT_BROWSER: " Firefox " }), "firefox");
  // Falling back to Chromium here would run the whole session in the wrong browser without a word.
  assert.throws(() => defaultEngine({ SCENESCOUT_BROWSER: "safari" }), /SCENESCOUT_BROWSER="safari".*chromium, firefox, webkit/);
});

test("the headless shell is found next to the full browser, on either path style", () => {
  assert.equal(headlessShellDir("/home/u/.cache/ms-playwright/chromium-1243/chrome-linux/chrome"), "/home/u/.cache/ms-playwright/chromium_headless_shell-1243");
  assert.equal(
    headlessShellDir("C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win\\chrome.exe"),
    "C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1243",
  );
  // A cache kept under a directory with the same kind of name: the build directory is the last one.
  assert.equal(headlessShellDir("/opt/chromium-1/cache/chromium-1243/chrome-linux/chrome"), "/opt/chromium-1/cache/chromium_headless_shell-1243");
  // A path that is not Playwright's layout (a system browser, say) names no shell.
  assert.equal(headlessShellDir("/usr/bin/chromium"), null);
  assert.equal(headlessShellDir(null), null);
});

test("a build counts as installed only when its files are there", () => {
  const exe = {
    chromium: "/c/ms-playwright/chromium-9/chrome",
    firefox: "/c/ms-playwright/firefox-7/firefox",
    webkit: null,
  };
  const shellMarker = path.join("/c/ms-playwright/chromium_headless_shell-9", "INSTALLATION_COMPLETE");
  const on = (...present: string[]) => browserPresence(exe, (p) => present.includes(p));

  // The shell alone: headless runs work, the full browser is still to download.
  const shellOnly = on(shellMarker);
  assert.equal(shellOnly["chromium-headless-shell"].installed, true);
  assert.equal(shellOnly.chromium.installed, false);

  // "chromium" means both builds, because that is what installing it brings.
  assert.equal(on(exe.chromium).chromium.installed, false);
  assert.equal(on(exe.chromium, shellMarker).chromium.installed, true);

  // Playwright naming a path is not the file being there.
  assert.equal(on().firefox.installed, false);
  assert.equal(on(exe.firefox).firefox.installed, true);
  assert.equal(on(exe.firefox).webkit.installed, false);
});

test("doctor names the download command for the browser that is actually missing", () => {
  const packageRoot = tmp("sc-pkg-");
  const base = { scope: "engine" as const, packageRoot, claudeDir: tmp("sc-claude-"), nodeVersion: "v22.19.0", run: scripted([]).run };
  const fixFor = (target: "chromium-headless-shell" | "firefox") =>
    diagnose({ ...base, defaultBrowser: { target, path: null } }).find((c) => c.name.startsWith("browser downloaded"))?.fix ?? "";
  // The plain install already brings the headless shell.
  assert.match(fixFor("chromium-headless-shell"), /^npx -y scenescout install {3}\(or: npx playwright install chromium-headless-shell\)$/);
  // Firefox as the default browser needs to be asked for by name.
  assert.match(fixFor("firefox"), /^npx -y scenescout install --browser-only --browsers firefox /);
});

test("service workers are allowed only where the write policy can see what they send", () => {
  // Request interception reaches worker-issued requests in Chromium alone. In
  // the other two a worker's DELETE went past read-only mode and reached the
  // server; the browser smoke suite holds the end-to-end proof for each browser.
  assert.equal(serviceWorkerPolicy("chromium"), "allow");
  assert.equal(serviceWorkerPolicy("firefox"), "block");
  assert.equal(serviceWorkerPolicy("webkit"), "block");
});

test("which failed request each browser reports as cancelled", () => {
  // Each engine's own words for a request it cancelled (its document leaving, or the page aborting it)...
  assert.equal(requestCancelled("chromium", "net::ERR_ABORTED"), true);
  assert.equal(requestCancelled("firefox", "NS_BINDING_ABORTED"), true);
  assert.equal(requestCancelled("webkit", "cancelled"), true);
  assert.equal(requestCancelled("webkit", "Load request cancelled"), true);
  // ...and, beside each, what the same engine says of a refusal or a lost connection, which is not one.
  assert.equal(requestCancelled("chromium", "net::ERR_BLOCKED_BY_CLIENT.Inspector"), false);
  assert.equal(requestCancelled("chromium", "net::ERR_EMPTY_RESPONSE"), false);
  assert.equal(requestCancelled("firefox", "NS_ERROR_FAILURE"), false);
  assert.equal(requestCancelled("firefox", "NS_ERROR_NET_RESET"), false);
  assert.equal(requestCancelled("webkit", "Blocked by Web Inspector"), false);
  assert.equal(requestCancelled("webkit", "The network connection was lost."), false);
  // One engine's word is not another's.
  assert.equal(requestCancelled("chromium", "cancelled"), false);
  assert.equal(requestCancelled("firefox", "net::ERR_ABORTED"), false);
});

test("the browsers that print their own console line for a failed load", () => {
  // Chromium and WebKit print "Failed to load resource: …" with the resource as
  // its location; Firefox prints nothing. The frames smoke suite asserts the
  // echo is charged to whoever sent the request only where there is one.
  assert.equal(echoesFailedLoads("chromium"), true);
  assert.equal(echoesFailedLoads("firefox"), false);
  assert.equal(echoesFailedLoads("webkit"), true);
});

test("the live view streams by push where the browser can, and by polling where it cannot", () => {
  // Only Chromium's driver exposes the DevTools screencast. Asking Firefox or
  // WebKit for it throws, which would turn every stream there into an error
  // instead of a slower picture.
  assert.equal(screencastSupport("chromium"), "cdp");
  assert.equal(screencastSupport("firefox"), "poll");
  assert.equal(screencastSupport("webkit"), "poll");
});

test("the focus audit presses the key that reaches buttons and links in that browser", () => {
  // Safari's rule, which WebKit on macOS follows: plain Tab stops only at text fields.
  assert.equal(focusAdvanceKey("webkit", "darwin"), "Alt+Tab");
  assert.equal(focusAdvanceKey("webkit", "linux"), "Tab");
  assert.equal(focusAdvanceKey("chromium", "darwin"), "Tab");
  assert.equal(focusAdvanceKey("firefox", "darwin"), "Tab");
});

test("only Chromium replaces a navigation the policy dropped with its own error page", () => {
  assert.equal(droppedNavigationErrorPage("chromium"), "chrome-error://");
  assert.equal(droppedNavigationErrorPage("firefox"), null);
  assert.equal(droppedNavigationErrorPage("webkit"), null);
});

test("an action waits for the error page of a navigation it had dropped, and only then", () => {
  const page = "http://127.0.0.1:4000/form.html";
  const base = { engine: "chromium" as const, url: page, refusedNavigationAt: 1050, actionStartedAt: 1000 };
  // The case that left a session on the error page: the navigation failed during this action and the page has not moved yet.
  assert.equal(awaitsDroppedNavigationErrorPage(base), true);
  // Refused in the same millisecond the action began still counts as this action's.
  assert.equal(awaitsDroppedNavigationErrorPage({ ...base, refusedNavigationAt: 1000 }), true);
  // Already there: nothing to wait for (the engine goes back from it).
  assert.equal(awaitsDroppedNavigationErrorPage({ ...base, url: "chrome-error://chromewebdata/" }), false);
  // Dropped during an earlier action, or never: this action did not drop one.
  assert.equal(awaitsDroppedNavigationErrorPage({ ...base, refusedNavigationAt: 999 }), false);
  assert.equal(awaitsDroppedNavigationErrorPage({ ...base, refusedNavigationAt: null }), false);
  // Firefox and WebKit stay on the page, so waiting would only cost the bound.
  assert.equal(awaitsDroppedNavigationErrorPage({ ...base, engine: "firefox" }), false);
  assert.equal(awaitsDroppedNavigationErrorPage({ ...base, engine: "webkit" }), false);
});

test("the error page is left by going back unless a POST loaded the page before it", () => {
  // Going back loads the entry with the request that loaded it, and Chromium re-sends a POST without asking.
  assert.equal(errorPageExit("POST"), "get");
  assert.equal(errorPageExit("post"), "get");
  assert.equal(errorPageExit("PUT"), "get");
  // A page a GET loaded (a form that redirected after its POST ends on a GET) is gone back to.
  assert.equal(errorPageExit("GET"), "back");
  assert.equal(errorPageExit("HEAD"), "back");
  // No load seen (the session went back onto the error page, or the page came from the back-forward cache): the entry
  // behind the error page may be one a POST loaded, so it is loaded with a GET rather than gone back to.
  assert.equal(errorPageExit(null), "get");
});

test("the error page is left for about:blank, with no GET, when the page's address reads as a destructive command", () => {
  // Contrastive pairs: the same method, an address that differs only in the command word or its place.
  assert.equal(errorPageExit("POST", "https://app.test/things/9/cancel"), "blank");
  assert.equal(errorPageExit("POST", "https://app.test/things/9"), "get");
  assert.equal(errorPageExit("POST", "https://app.test/things/9/delete"), "blank");
  assert.equal(errorPageExit("POST", "https://app.test/things?action=delete"), "blank");
  // Whole-segment commands (#538), each beside a page that only names the word.
  assert.equal(errorPageExit("POST", "https://app.test/things/9/void"), "blank");
  assert.equal(errorPageExit("POST", "https://app.test/avoid-list"), "get");
  assert.equal(errorPageExit("POST", "https://app.test/account/close"), "blank");
  assert.equal(errorPageExit("POST", "https://app.test/close"), "get");
  assert.equal(errorPageExit("POST", "https://app.test/things?action=list"), "get");
  // `archive` names a listing page unless a record's id comes just before it.
  assert.equal(errorPageExit("POST", "https://app.test/things/9/archive"), "blank");
  assert.equal(errorPageExit("POST", "https://app.test/blog/archive"), "get");
  // A method override in the query, and a command word percent-encoded in the path, read as what the server decodes.
  assert.equal(errorPageExit("POST", "https://app.test/api/things/9?_method=DELETE"), "blank");
  assert.equal(errorPageExit("POST", "https://app.test/api/things/9?_method=PATCH"), "get");
  assert.equal(errorPageExit("POST", "https://app.test/things/9/%64elete"), "blank");
  assert.equal(errorPageExit("POST", "https://app.test/things/9/%64etails"), "get");
  // A load this session did not see is judged the same way.
  assert.equal(errorPageExit(null, "https://app.test/unsubscribe?token=abc"), "blank");
  assert.equal(errorPageExit(null, "https://app.test/subscribe?token=abc"), "get");
  // Judged whether or not SCENESCOUT_REFUSE_DESTRUCTIVE_GETS is on: the rule takes no setting.
  const before = process.env.SCENESCOUT_REFUSE_DESTRUCTIVE_GETS;
  delete process.env.SCENESCOUT_REFUSE_DESTRUCTIVE_GETS;
  try {
    assert.equal(errorPageExit("PUT", "https://app.test/orders/3/cancel"), "blank");
  } finally {
    if (before !== undefined) process.env.SCENESCOUT_REFUSE_DESTRUCTIVE_GETS = before;
  }
  // A page a GET loaded is gone back to: the browser does not send a POST again, whatever the address says.
  assert.equal(errorPageExit("GET", "https://app.test/things/9/cancel"), "back");
});

test("shared workers are taken from the page in every mode that blocks anything", () => {
  // Their requests cannot be intercepted in any browser; the smoke suite proves the DELETE no longer arrives.
  assert.equal(sharedWorkersAllowed("observe"), false);
  assert.equal(sharedWorkersAllowed("read-only"), false);
  assert.equal(sharedWorkersAllowed("safe-write"), false);
  assert.equal(sharedWorkersAllowed("destructive"), true);
  // A browserHosts list holds in every mode, and a shared worker's requests would reach any host unseen.
  for (const mode of ["observe", "read-only", "safe-write", "destructive"] as const) assert.equal(sharedWorkersAllowed(mode, true), false, mode);
});

test("a browserHosts list meets a redirect's later hops at the browser level in Chromium, and by sending a page load itself elsewhere", () => {
  assert.deepEqual(
    (["chromium", "firefox", "webkit"] as const).map((e) => [e, hostRedirectHops(e)]),
    [
      ["chromium", "browser-level"],
      ["firefox", "page-loads"],
      ["webkit", "page-loads"],
    ],
  );
});

test("installing only a browser the default attach does not launch says so", () => {
  const note = defaultAttachNote({ selected: ["firefox"], defaultEngine: "chromium", defaultInstalled: false });
  assert.match(note ?? "", /drives chromium.*browser: "firefox".*SCENESCOUT_BROWSER=firefox/);
  // Nothing to say when the default is already there, when it is among what was asked for, or when nothing was downloaded.
  assert.equal(defaultAttachNote({ selected: ["firefox"], defaultEngine: "chromium", defaultInstalled: true }), null);
  assert.equal(defaultAttachNote({ selected: ["chromium-headless-shell", "webkit"], defaultEngine: "chromium", defaultInstalled: false }), null);
  assert.equal(defaultAttachNote({ selected: ["firefox"], defaultEngine: "firefox", defaultInstalled: false }), null);
  assert.equal(defaultAttachNote({ selected: [], defaultEngine: "chromium", defaultInstalled: false }), null);
});

test("the playbook served to other clients is the skill's body, and a missing one is an error", () => {
  assert.equal(stripFrontMatter("---\nname: x\ndescription: y\n---\n\n# Title\nbody\n"), "# Title\nbody\n");
  assert.equal(stripFrontMatter("---\r\nname: x\r\n---\r\n# Title\r\n"), "# Title\r\n");
  // A byte-order mark must not hide the opening fence, or the front matter is served as the method.
  assert.equal(stripFrontMatter("\uFEFF---\nname: x\n---\n# Title\n"), "# Title\n");
  // Front matter and nothing else, with or without a final newline, leaves an empty body for loadPlaybook to refuse.
  assert.equal(stripFrontMatter("---\nname: x\n---"), "");
  assert.equal(stripFrontMatter("---\n---\n"), "");
  // Only blank lines are dropped from the top; an indented first line keeps its indent.
  assert.equal(stripFrontMatter("---\nname: x\n---\n\n    code\n"), "    code\n");
  // No front matter: nothing is cut, and a horizontal rule further down is not mistaken for one.
  assert.equal(stripFrontMatter("# Title\n\n---\n\nmore\n"), "# Title\n\n---\n\nmore\n");

  const root = tmp("sc-pkg-");
  // An agent handed an empty method would carry on without one and never say so.
  assert.throws(() => loadPlaybook(root), /playbook is missing from this install/);
  fs.mkdirSync(path.dirname(path.join(root, PLAYBOOK_RELATIVE_PATH)), { recursive: true });
  fs.writeFileSync(path.join(root, PLAYBOOK_RELATIVE_PATH), "---\nname: scenescout\n---\n\n");
  assert.throws(() => loadPlaybook(root), /is empty/);
  fs.writeFileSync(path.join(root, PLAYBOOK_RELATIVE_PATH), "---\nname: scenescout\n---\n\n# Method\n");
  assert.equal(loadPlaybook(root), "# Method\n");

  // The file the server reads has to be in the published package.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { files: string[] };
  assert.ok(
    pkg.files.some((f) => PLAYBOOK_RELATIVE_PATH.split(path.sep).join("/").startsWith(f.replace(/\/$/, ""))),
    `package.json "files" must ship ${PLAYBOOK_RELATIVE_PATH}`,
  );
});

test("the server instructions stay short and the explore prompt states what was asked", () => {
  // Clients cut long instructions; one cut mid-sentence is worse than a pointer.
  assert.ok(SERVER_INSTRUCTIONS.length < 700, `instructions are ${SERVER_INSTRUCTIONS.length} characters`);
  assert.match(SERVER_INSTRUCTIONS, /scout_playbook/);
  assert.match(SERVER_INSTRUCTIONS, /destructive/);

  const asked = explorePrompt("# Method", { url: "http://localhost:3000", level: "minimal" });
  assert.ok(asked.startsWith("# Method"));
  assert.match(asked, /Target: http:\/\/localhost:3000\nLevel: minimal$/);
  // A client may send no arguments object at all, or an empty one: nothing was chosen, so the plain questions are asked.
  for (const none of [undefined, {}, { url: "  ", focus: "" }]) {
    const prompt = explorePrompt("# Method", none);
    assert.ok(prompt.endsWith(introQuestions()), "with no settings the prompt ends with the four questions");
    for (const q of INTAKE_QUESTIONS) assert.ok(prompt.includes(q.ask), `the prompt asks: ${q.ask}`);
    assert.doesNotMatch(prompt, /Target:/);
  }
  // A level the method does not know would leave the agent guessing.
  assert.throws(() => explorePrompt("# Method", { level: "deep" }), /"deep" is not one the method knows.*minimal, medium, extensive/);
  // Any setting given skips the questions; with no URL the agent is told to find one, not left with a blank target.
  for (const some of [{ level: "medium" }, { focus: "checkout" }]) {
    const prompt = explorePrompt("# Method", some);
    assert.match(prompt, /Target: ask me for the URL/);
    for (const q of INTAKE_QUESTIONS) assert.ok(!prompt.includes(q.ask), `a setting given skips: ${q.ask}`);
  }
});

test("the live prompt returns the loopback address and takes no password", () => {
  assert.deepEqual(LIVE_PROMPT_ARGUMENTS, []);
  for (const none of [undefined, {}]) {
    const prompt = livePrompt(none);
    assert.match(prompt, /127\.0\.0\.1/);
    assert.match(prompt, /scout_session with no arguments/);
    assert.match(prompt, /Do not ask for a password/);
    assert.doesNotMatch(prompt, /password\s*[:=]/i);
  }
  assert.throws(() => livePrompt({ session: "default" }), /the live prompt takes no arguments/);
  assert.throws(
    () => livePrompt({ password: "hunter2" }),
    (err: Error) => {
      assert.match(err.message, /does not take password/);
      assert.doesNotMatch(err.message, /hunter2/);
      return true;
    },
  );
});

test("the login prompt tells the model to call scout_login for the role and refuses a password", () => {
  assert.deepEqual(
    LOGIN_PROMPT_ARGUMENTS.map((arg) => [arg.name, arg.required]),
    [
      ["role", true],
      ["url", false],
    ],
  );
  assert.ok(!LOGIN_PROMPT_ARGUMENTS.some((arg) => /password|secret|token|credential/i.test(arg.name)));

  const asked = loginPrompt({ role: "Admin", url: "http://localhost:3000" });
  assert.match(asked, /scout_login/);
  assert.match(asked, /\{"role":"admin","url":"http:\/\/localhost:3000"\}/);
  assert.match(asked, /same role \("admin"\)/);
  assert.match(asked, /Never pass a password/);
  assert.doesNotMatch(asked, /password\s*[:=]/i);

  const noUrl = loginPrompt({ role: "admin" });
  assert.match(noUrl, /ask for the app's address/);
  assert.doesNotMatch(noUrl, /"url":/);

  assert.throws(() => loginPrompt(undefined), /give a role name/);
  assert.throws(() => loginPrompt({ role: "../admin" }), /not allowed/);
  assert.throws(
    () => loginPrompt({ role: "admin", password: "hunter2" }),
    (err: Error) => {
      assert.match(err.message, /does not take password/);
      assert.doesNotMatch(err.message, /hunter2/);
      return true;
    },
  );
  assert.throws(
    () => loginPrompt({ role: "admin", url: "http://user:hunter2@localhost" }),
    (err: Error) => {
      assert.match(err.message, /no credentials in the URL/);
      assert.doesNotMatch(err.message, /hunter2/);
      return true;
    },
  );
});

const LAUNCH = ["/opt/node/bin/npx", "-y", "scenescout", "serve"];

test("--client picks who gets the server, and absent means Claude Code", () => {
  assert.deepEqual(parseClients(undefined), { clients: ["claude-code"] });
  assert.deepEqual(parseClients("cursor"), { clients: ["cursor"] });
  assert.deepEqual(parseClients(" VSCode , claude-code,cursor "), { clients: ["claude-code", "cursor", "vscode"] });
  const typo = parseClients("vs-code");
  assert.ok("error" in typo);
  assert.match(typo.error, /"vs-code" is not a client.*claude-code, cursor, vscode, codex, gemini, copilot, windsurf/);
  assert.ok("error" in parseClients(""));
});

test("a client's JSON server list gains the entry and keeps everything else", () => {
  const file = path.join(tmp("sc-home-"), ".cursor", "mcp.json");
  // No file yet: it is created, along with its directory.
  const created = registerInFile(file, "mcpServers", LAUNCH);
  assert.deepEqual(created, { status: "registered", where: file, replaced: false, notes: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { mcpServers: { scenescout: { command: LAUNCH[0], args: LAUNCH.slice(1) } } });

  // Someone's existing servers and unrelated keys survive, untouched and in place.
  const theirs = {
    theme: "dark",
    mcpServers: { other: { command: "node", args: ["x.js"], env: { KEY: "v" } }, scenescout: { command: "node", args: ["/old/mcp-server.js"] } },
  };
  fs.writeFileSync(file, JSON.stringify(theirs));
  const replaced = registerInFile(file, "mcpServers", LAUNCH);
  assert.equal(replaced.status, "registered");
  assert.ok(replaced.status === "registered" && replaced.replaced);
  assert.match(replaced.status === "registered" ? replaced.notes.join(" ") : "", /previous "scenescout" entry was replaced; it ran: .*old\/mcp-server\.js/);
  const after = JSON.parse(fs.readFileSync(file, "utf8")) as typeof theirs;
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.mcpServers.other, theirs.mcpServers.other);
  assert.deepEqual(after.mcpServers.scenescout, { command: LAUNCH[0], args: LAUNCH.slice(1) });

  // Running it again changes nothing and says nothing was replaced with something different.
  const again = registerInFile(file, "mcpServers", LAUNCH);
  assert.deepEqual(again.status === "registered" ? again.notes : ["x"], []);
  // No temporary file is left beside it.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["mcp.json"]);
});

test("a server list that cannot be read as JSON is left exactly as it was", () => {
  const file = path.join(tmp("sc-home-"), "mcp.json");
  // Comments are common in hand-edited config; rewriting the file would throw their content away.
  const handEdited = '{\n  // my servers\n  "mcpServers": {}\n}\n';
  fs.writeFileSync(file, handEdited);
  const result = registerInFile(file, "mcpServers", LAUNCH);
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /not valid JSON.*left untouched/);
  assert.match(result.status === "failed" ? result.manual : "", /"scenescout"/);
  assert.equal(fs.readFileSync(file, "utf8"), handEdited);

  for (const wrongShape of ["[]", '{"mcpServers": []}', '{"mcpServers": "x"}']) {
    fs.writeFileSync(file, wrongShape);
    assert.equal(registerInFile(file, "mcpServers", LAUNCH).status, "failed", wrongShape);
    assert.equal(fs.readFileSync(file, "utf8"), wrongShape);
  }
  // A byte-order mark in front of valid JSON is not a reason to refuse it.
  fs.writeFileSync(file, '\uFEFF{"mcpServers":{}}');
  assert.equal(registerInFile(file, "mcpServers", LAUNCH).status, "registered");
  // An empty file is a server list with nothing in it yet.
  fs.writeFileSync(file, "");
  assert.equal(registerInFile(file, "mcpServers", LAUNCH).status, "registered");
});

test("clients with their own add command are registered through it", () => {
  const home = tmp("sc-home-");
  const codex = scripted([ok("Added global MCP server 'scenescout'.")]);
  assert.equal(registerWithClient("codex", { launch: LAUNCH, home, run: codex.run, vscode: null }).status, "registered");
  assert.deepEqual(codex.calls, [["codex", "mcp", "add", "scenescout", "--", ...LAUNCH]]);

  // The default scope there is the project; this belongs to the user.
  const gemini = scripted([ok('MCP server "scenescout" added to user settings. (stdio)')]);
  registerWithClient("gemini", { launch: LAUNCH, home, run: gemini.run, vscode: null });
  assert.deepEqual(gemini.calls, [["gemini", "mcp", "add", "--scope", "user", "scenescout", ...LAUNCH]]);

  // This one refuses a name that exists, so the old entry is removed first.
  const copilot = scripted([ok("Removed"), ok("Added")]);
  const added = registerWithClient("copilot", { launch: LAUNCH, home, run: copilot.run, vscode: null });
  assert.deepEqual(copilot.calls, [
    ["copilot", "mcp", "remove", "scenescout"],
    ["copilot", "mcp", "add", "scenescout", "--", ...LAUNCH],
  ]);
  assert.ok(added.status === "registered" && added.replaced);
  // Nothing of that name to remove is not a failure, and nothing was replaced.
  const fresh = registerWithClient("copilot", {
    launch: LAUNCH,
    home,
    run: scripted([fail('Error: Server "scenescout" not found'), ok("Added")]).run,
    vscode: null,
  });
  assert.ok(fresh.status === "registered" && !fresh.replaced);
  // Removed the old entry and then could not add the new one: the person has no registration left, and is told.
  const lost = registerWithClient("copilot", { launch: LAUNCH, home, run: scripted([ok("Removed"), fail("Error: could not write config")]).run, vscode: null });
  assert.equal(lost.status, "failed");
  assert.match(lost.status === "failed" ? lost.detail : "", /could not write config.*previous "scenescout" entry had already been removed/);

  // Not installed: say so, with the command to run once it is.
  const none = registerWithClient("codex", { launch: LAUNCH, home, run: scripted([absent]).run, vscode: null });
  assert.equal(none.status, "client-missing");
  assert.match(none.status === "client-missing" ? none.manual : "", /^codex mcp add scenescout -- /);
});

test("VS Code is registered through VS Code's own command, never a fork's", () => {
  const bundled = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
  // Another editor installs a `code` command too. Running that one reports
  // success and VS Code never sees the entry.
  const forkOnPath = { command: "/usr/local/bin/code", realPath: "/Applications/Cursor.app/Contents/Resources/app/bin/code" };
  assert.equal(vscodeBinary({ platform: "darwin", home: "/Users/u", exists: (p) => p === bundled, codeOnPath: forkOnPath }), bundled);
  assert.equal(vscodeBinary({ platform: "darwin", home: "/Users/u", exists: () => false, codeOnPath: forkOnPath }), null);
  assert.equal(vscodeBinary({ platform: "linux", home: "/home/u", exists: () => false, codeOnPath: null }), null);
  // What runs is the command as found, not where it points: a snap install links
  // `code` to a launcher that goes by the name it was called with.
  const snap = { command: "/snap/bin/code", realPath: "/usr/bin/snap" };
  assert.equal(vscodeBinary({ platform: "linux", home: "/home/u", exists: () => false, codeOnPath: snap }), "/snap/bin/code");
  // An account that happens to be called like another editor does not disqualify the VS Code under it.
  const underHome = { command: "/srv/accounts/cursor/bin/code", realPath: "/srv/accounts/cursor/apps/vscode/bin/code" };
  assert.equal(vscodeBinary({ platform: "linux", home: "/srv/accounts/cursor", exists: () => false, codeOnPath: underHome }), "/srv/accounts/cursor/bin/code");

  assert.deepEqual(vscodeAddArgs(LAUNCH), ["--add-mcp", JSON.stringify({ name: "scenescout", command: LAUNCH[0], args: LAUNCH.slice(1) })]);
  const run = scripted([ok("Added MCP servers: scenescout")]);
  assert.equal(registerWithClient("vscode", { launch: LAUNCH, home: "/Users/u", run: run.run, vscode: bundled }).status, "registered");
  assert.equal(run.calls[0][0], bundled);
  const missing = registerWithClient("vscode", { launch: LAUNCH, home: "/Users/u", run: scripted([]).run, vscode: null });
  assert.equal(missing.status, "client-missing");
  assert.match(missing.status === "client-missing" ? missing.manual : "", /MCP: Add Server/);
});

test("the closing hint names every client once and says what to ask the agent", () => {
  assert.match(firstMessageHint(["cursor"]), /^Restart Cursor \(/);
  assert.match(firstMessageHint(["cursor", "codex", "gemini"]), /^Restart Cursor, Codex CLI and Gemini CLI \(/);
  assert.match(firstMessageHint(["vscode"]), /Use SceneScout to test http:\/\/localhost:3000[\s\S]*scout_playbook/);
});

test(
  "a linked config is written through the link, keeps its permissions, and a failed write leaves nothing behind",
  { skip: process.platform === "win32" },
  () => {
    const home = tmp("sc-home-");
    const real = path.join(home, "dotfiles", "cursor-mcp.json");
    const link = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(real, '{"mcpServers":{}}', { mode: 0o644 });
    fs.symlinkSync(real, link);

    assert.equal(registerInFile(link, "mcpServers", LAUNCH).status, "registered");
    // Renaming over the link would have turned it into a plain file and left the real one unchanged.
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.ok("scenescout" in (JSON.parse(fs.readFileSync(real, "utf8")) as { mcpServers: object }).mcpServers);
    assert.equal(fs.statSync(real).mode & 0o777, 0o644);

    // A directory that cannot be written to: a failure with the entry to add by hand, not a thrown error,
    // and no temporary copy of the config left lying around.
    const locked = path.join(home, "locked");
    fs.mkdirSync(locked);
    const lockedFile = path.join(locked, "mcp.json");
    fs.writeFileSync(lockedFile, '{"mcpServers":{"other":{"command":"x"}}}');
    fs.chmodSync(locked, 0o555);
    try {
      const result = registerInFile(lockedFile, "mcpServers", LAUNCH);
      assert.equal(result.status, "failed");
      assert.match(result.status === "failed" ? result.detail : "", /could not be written/);
      assert.deepEqual(fs.readdirSync(locked), ["mcp.json"]);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  },
);

test("the by-hand text exists for every client, for when nothing is run", () => {
  assert.match(manualFor("codex", LAUNCH, "/home/u"), /^codex mcp add scenescout -- /);
  assert.match(manualFor("gemini", LAUNCH, "/home/u"), /^gemini mcp add --scope user scenescout /);
  assert.match(manualFor("vscode", LAUNCH, "/home/u"), /^code --add-mcp /);
  assert.match(manualFor("cursor", LAUNCH, "/home/u"), /"mcpServers".*\.cursor.*mcp\.json.*"scenescout"/);
});

// ---- the `scenescout` command on PATH --------------------------------------

/** A checkout is what repairCommands calls one: it has a tsconfig and a src folder. */
function fakeCheckout(): string {
  const root = fakePackage();
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "dist", "cli.js"), "");
  return root;
}

test("a command npm put on PATH for the length of a run does not count as installed", () => {
  // Under `npx scenescout install`, npx prepends its cache's node_modules/.bin,
  // and the command found there is gone when the run ends. Reading it as
  // "already on PATH" would skip the install for exactly the people who need it.
  // Candidates are joined with the platform's separator, so the fake disk is too: on Windows the join yields backslashes.
  const onDisk = new Set(["/cache/_npx/abc/node_modules/.bin", "/work/app/node_modules/.bin", "/usr/local/bin"].map((dir) => path.join(dir, "scenescout")));
  const find = (pathValue: string) => findOnUserPath({ names: ["scenescout"], pathValue, delimiter: ":", exists: (p) => onDisk.has(p) });
  assert.equal(find("/cache/_npx/abc/node_modules/.bin:/work/app/node_modules/.bin/:/usr/bin"), null);
  assert.equal(find("/cache/_npx/abc/node_modules/.bin:/usr/bin:/usr/local/bin"), path.join("/usr/local/bin", "scenescout"));
  assert.equal(find(""), null);
});

test("a checkout links the command, so it runs whatever was last built", () => {
  const root = fakeCheckout();
  const plan = planCommand({ packageRoot: root, nodePath: "/opt/node/bin/node", version: "9.9.9", resolved: null, platform: "darwin" });
  assert.equal(plan.action, "run");
  if (plan.action !== "run") return;
  assert.equal(plan.how, "link");
  assert.deepEqual(plan.args, ["link"]);
  assert.equal(plan.cwd, root, "npm link acts on the package in the working directory");
  assert.match(plan.manual, /npm link/);
});

test("a checkout that already owns the command is left alone, through a symlink too", () => {
  const root = fakeCheckout();
  const bin = path.join(tmp("sc-bin-"), "scenescout");
  fs.symlinkSync(path.join(root, "dist", "cli.js"), bin);
  assert.deepEqual(planCommand({ packageRoot: root, nodePath: process.execPath, version: "9.9.9", resolved: bin, platform: "darwin" }), {
    action: "present",
    at: bin,
  });
});

test("a checkout takes the command over from another copy, and says which", () => {
  // The same rule as the MCP registration: running install from a checkout
  // means this checkout is the one to use. A stale global copy answering
  // `scenescout watch` would run code without the command at all.
  const other = path.join(tmp("sc-other-"), "scenescout");
  fs.writeFileSync(other, "");
  const plan = planCommand({ packageRoot: fakeCheckout(), nodePath: process.execPath, version: "9.9.9", resolved: other, platform: "linux" });
  assert.equal(plan.action, "run");
  if (plan.action === "run") assert.equal(plan.replaces, other);
});

test("a packaged install gets the same version installed globally, and leaves an existing command alone", () => {
  const root = fakePackage(); // no tsconfig, no src: what npm or npx unpacks
  const plan = planCommand({ packageRoot: root, nodePath: "/opt/node/bin/node", version: "1.4.2", resolved: null, platform: "linux" });
  assert.equal(plan.action, "run");
  if (plan.action === "run") {
    assert.equal(plan.how, "global");
    assert.deepEqual(plan.args, ["install", "-g", "scenescout@1.4.2"], "the version that is running, not whatever is latest");
    assert.equal(plan.cwd, undefined);
  }
  const taken = planCommand({ packageRoot: root, nodePath: "/opt/node/bin/node", version: "1.4.2", resolved: "/usr/local/bin/scenescout", platform: "linux" });
  assert.deepEqual(taken, { action: "present", at: "/usr/local/bin/scenescout" });
});

test("the npm beside the running node is preferred: it installs where this shell already looks", () => {
  const nodeDir = tmp("sc-node-");
  fs.writeFileSync(path.join(nodeDir, "npm"), "");
  const beside = planCommand({ packageRoot: fakeCheckout(), nodePath: path.join(nodeDir, "node"), version: "1.0.0", resolved: null, platform: "darwin" });
  assert.equal(beside.action === "run" && beside.command, path.join(nodeDir, "npm"));
  const bare = planCommand({ packageRoot: fakeCheckout(), nodePath: "/nowhere/bin/node", version: "1.0.0", resolved: null, platform: "darwin" });
  assert.equal(bare.action === "run" && bare.command, "npm");
});

/** One cmd.exe caret pass: `^x` becomes `x`. */
function caretUnescape(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "^" && i + 1 < value.length) {
      out += value[++i];
    } else out += value[i];
  }
  return out;
}

/**
 * CommandLineToArgvW, the parse the program at the end of a shim performs.
 * Used to check that a batch command line still holds the original arguments.
 */
function commandLineArgv(line: string): string[] {
  const args: string[] = [];
  let cur = "";
  let quoted = false;
  let token = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      let slashes = 1;
      while (line[i + 1] === "\\") {
        slashes++;
        i++;
      }
      if (line[i + 1] === '"') {
        cur += "\\".repeat(Math.floor(slashes / 2));
        i++;
        token = true;
        if (slashes % 2 === 1) cur += '"';
        else quoted = !quoted;
      } else {
        cur += "\\".repeat(slashes);
        token = true;
      }
    } else if (c === '"') {
      quoted = !quoted;
      token = true;
    } else if (c === " " && !quoted) {
      if (token) args.push(cur);
      cur = "";
      token = false;
    } else {
      cur += c;
      token = true;
    }
  }
  if (token) args.push(cur);
  return args;
}

/** Arguments a double-escaped batch line carries, after both cmd parses and the final argv parse. */
function argsThroughBatch(line: string): string[] {
  assert.equal(line.startsWith('"') && line.endsWith('"'), true, "cmd /s strips one pair of wrapping quotes");
  const parsed = commandLineArgv(caretUnescape(caretUnescape(line.slice(1, -1))));
  return parsed.slice(1);
}

test("a Windows batch shim is started through cmd.exe; an executable with the same arguments is not", () => {
  const json = JSON.stringify({
    name: "scenescout",
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\Users\\A B\\mcp-server.js"],
  });
  const vscodeArgs = ["--add-mcp", json];
  const exe = planSpawn({ command: "D:\\App\\code.exe", args: vscodeArgs, platform: "win32", resolved: "D:\\App\\code.exe" });
  assert.deepEqual(exe, { command: "D:\\App\\code.exe", args: vscodeArgs }, "an .exe is spawned directly, so node quotes the JSON itself");

  const cmd = planSpawn({ command: "D:\\App\\code.cmd", args: vscodeArgs, platform: "win32", resolved: "D:\\App\\code.cmd" });
  assert.equal(cmd.command, "cmd.exe");
  assert.equal(cmd.windowsVerbatimArguments, true);
  assert.deepEqual(cmd.args.slice(0, 3), ["/d", "/s", "/c"]);
  const line = cmd.args[3];
  assert.deepEqual(argsThroughBatch(line), vscodeArgs, "the JSON argument, quotes and spaces included, is one argument after both parses");
  // Two caret escapes, not one: a single escape would leave a raw quote or a single caret.
  assert.match(line, /\^\^\^"/);
  assert.equal(line.includes('{"name"'), false, "the JSON's quotes are not left for cmd to split on");

  const spaced = ["C:\\Program Files (x86)\\nodejs\\node.exe", "C:\\Users\\A B\\mcp-server.js"];
  const client = planSpawn({
    command: "codex",
    args: ["mcp", "add", "scenescout", "--", ...spaced],
    platform: "win32",
    resolved: "D:\\npm\\codex.cmd",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.equal(client.command, "C:\\Windows\\System32\\cmd.exe");
  const clientLine = client.args[3];
  assert.deepEqual(argsThroughBatch(clientLine), ["mcp", "add", "scenescout", "--", ...spaced]);
  assert.match(clientLine, /\^\^\^\(/, "a parenthesis in a path is escaped for the shim's second parse");
  assert.equal(clientLine.includes("Program Files"), false);
  assert.ok(clientLine.includes("D:\\npm\\codex.cmd"), "cmd runs the resolved shim, not the bare name");

  assert.deepEqual(planSpawn({ command: "codex", args: ["mcp"], platform: "darwin", resolved: "D:\\npm\\codex.cmd" }), {
    command: "codex",
    args: ["mcp"],
  });
  assert.equal(isBatchShim("D:\\npm\\CODE.CMD"), true);
  assert.equal(isBatchShim("D:\\npm\\code.exe"), false);
});

test("Windows resolves a bare client name to the shim on PATH, and an executable ahead of it in PATHEXT wins", () => {
  const files = new Set([
    "C:\\cwd\\codex.cmd",
    "D:\\npm\\codex.cmd",
    "D:\\npm\\gemini.cmd",
    "D:\\apps\\code.cmd",
    "D:\\apps\\code.exe",
    "D:\\apps with space\\copilot.bat",
  ]);
  const exists = (file: string) => files.has(file);
  const base = { cwd: "C:\\cwd", pathEnv: 'D:\\npm;"D:\\apps with space";D:\\apps', pathExt: ".com;.exe;.bat;.cmd", exists };
  assert.equal(resolveWindowsCommand("codex", base), "C:\\cwd\\codex.cmd", "the current directory is searched before PATH");
  assert.equal(resolveWindowsCommand("gemini", base), "D:\\npm\\gemini.cmd");
  assert.equal(resolveWindowsCommand("copilot", base), "D:\\apps with space\\copilot.bat", "a quoted PATH entry is unquoted");
  assert.equal(resolveWindowsCommand("code", base), "D:\\apps\\code.exe", ".exe comes before .cmd in PATHEXT");
  assert.equal(resolveWindowsCommand("missing", base), null);
  assert.equal(resolveWindowsCommand("D:\\apps\\code.cmd", base), "D:\\apps\\code.cmd");

  const launch = ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\A B\\mcp-server.js"];
  const throughShim = commandSpawnPlan("codex", ["mcp", "add", "scenescout", "--", ...launch], {
    platform: "win32",
    cwd: "C:\\empty",
    pathEnv: "D:\\npm",
    pathExt: ".com;.exe;.bat;.cmd",
    exists,
  });
  assert.equal(throughShim.command, "cmd.exe");
  assert.deepEqual(argsThroughBatch(throughShim.args[3]), ["mcp", "add", "scenescout", "--", ...launch]);

  const throughExe = commandSpawnPlan("code", vscodeAddArgs(launch), {
    platform: "win32",
    cwd: "C:\\empty",
    pathEnv: "D:\\apps",
    pathExt: ".com;.exe;.bat;.cmd",
    exists,
  });
  assert.deepEqual(throughExe, { command: "code", args: vscodeAddArgs(launch) }, "code.exe is not wrapped, even though code.cmd sits beside it");

  const absentCmd = commandSpawnPlan("windsurf", ["mcp"], { platform: "win32", cwd: "C:\\empty", pathEnv: "D:\\npm", exists });
  assert.deepEqual(absentCmd, { command: "windsurf", args: ["mcp"] }, "an unknown name is spawned as given, so a missing binary stays ENOENT");
});

test("on Windows the step hands over the command instead of failing to start npm", () => {
  const plan = planCommand({ packageRoot: fakePackage(), nodePath: "C:\\node\\node.exe", version: "1.0.0", resolved: null, platform: "win32" });
  assert.equal(plan.action, "manual");
  if (plan.action === "manual") assert.match(plan.manual, /npm install -g scenescout@1\.0\.0/);
  const { run, calls } = scripted([]);
  assert.equal(ensureCommand(plan, run).status, "failed");
  assert.equal(calls.length, 0);
});

test("running the plan: npm link runs in the checkout, and a refusal comes back with the line that explains it", () => {
  const root = fakeCheckout();
  const plan = planCommand({ packageRoot: root, nodePath: "/nowhere/bin/node", version: "1.0.0", resolved: null, platform: "darwin" });
  const seen: Array<{ cwd?: string }> = [];
  const linked = ensureCommand(plan, (command, args, opts) => {
    seen.push({ cwd: opts?.cwd });
    assert.deepEqual([command, ...args], ["npm", "link"]);
    return ok();
  });
  assert.deepEqual(linked, { status: "installed", how: "link", replaced: null });
  assert.equal(seen[0]?.cwd, root);

  const refused = ensureCommand(plan, () => fail("npm warn something\nnpm ERR! code EACCES\nnpm ERR! path /usr/local/lib/node_modules"));
  assert.equal(refused.status, "failed");
  if (refused.status === "failed") {
    assert.match(refused.detail, /EACCES/, "a root-owned prefix is the usual cause, and the detail has to name it");
    assert.match(refused.manual, /npm link/);
  }
  const noNpm = ensureCommand(plan, () => absent);
  assert.equal(noNpm.status === "failed" && noNpm.detail, "npm was not found");

  const { run, calls } = scripted([]);
  assert.deepEqual(ensureCommand({ action: "present", at: "/usr/local/bin/scenescout" }, run), { status: "present", at: "/usr/local/bin/scenescout" });
  assert.equal(calls.length, 0, "a command that is already there costs no npm run");
});

test("npm failing with nothing on stderr is still given a reason", () => {
  // A timed-out npm yields "" for both streams; "".split("\n") is [""], so the
  // reason read as `was not put on PATH ()`.
  const plan = {
    action: "run" as const,
    how: "global" as const,
    command: "npm",
    args: ["install", "-g", "scenescout@1.0.0"],
    manual: "npm install -g scenescout@1.0.0",
    replaces: null,
  };
  const silent = ensureCommand(plan, () => ({ status: 1, stdout: "", stderr: "", missing: false }));
  assert.equal(silent.status, "failed");
  assert.equal(silent.status === "failed" ? silent.detail : "", "npm exited 1");
  const killed = ensureCommand(plan, () => ({ status: null, stdout: "", stderr: "", missing: false }));
  assert.equal(killed.status === "failed" ? killed.detail : "", "npm exited without finishing");
});

test("a beacon is a ping in Chromium and a beacon elsewhere; only Chromium needs its unload writes caught at the browser level and judges a redirect's later hops, only WebKit may lose an unload write it lets through, and only Firefox must wait for a left page's writes to be judged before closing it", () => {
  assert.deepEqual(
    (["chromium", "firefox", "webkit"] as const).map((e) => [
      e,
      beaconResourceType(e),
      unloadWriteInterception(e),
      allowedUnloadWritesMayBeLost(e),
      writeRedirectHopsJudged(e),
      frameUnloadWritesMayGoUnissued(e),
      closeWaitsForLeavingWrites(e),
    ]),
    [
      ["chromium", "ping", "browser-fetch", false, true, false, false],
      ["firefox", "beacon", "route", false, false, true, true],
      ["webkit", "beacon", "route", true, false, false, false],
    ],
  );
});

// ── The command line: help and unknown flags are settled before a command runs ──

/** A dispatch whose handlers only record what reached them; usage returns as the real one does, and refusal ends the run. */
async function dispatched(argv: string[]): Promise<{ ran: string[]; exit: number | null; said: string[] }> {
  const ran: string[] = [];
  const said: string[] = [];
  let exit: number | null = null;
  class Exit {
    constructor(readonly code: number) {}
  }
  const record = (name: Subcommand) => (args: string[]) => {
    ran.push([name, ...args].join(" "));
  };
  const commands = Object.fromEntries(SUBCOMMANDS.map((c) => [c, record(c)])) as CliHandlers["commands"];
  try {
    await dispatch(argv[0], argv.slice(1), {
      // It returns rather than throws, so a caller that does not return after it is seen running on.
      usage: (code) => {
        said.push("usage");
        exit = code;
      },
      version: () => {
        said.push("version");
      },
      refuse: (message) => {
        said.push(message);
        throw new Exit(1);
      },
      commands,
      firstRun: (args) => {
        ran.push(["(first run)", ...args].join(" "));
      },
    });
  } catch (err) {
    if (err instanceof Exit) return { ran, exit: err.code, said };
    throw err;
  }
  return { ran, exit, said };
}

test("`scenescout --help` read through a pipe arrives whole, as it does into a file", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = path.join(repo, "src", "cli.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-help-"));
  try {
    const target = path.join(dir, "help.txt");
    const fd = fs.openSync(target, "w");
    const toFile = spawnSync(process.execPath, ["--import", "tsx", cli, "--help"], { stdio: ["ignore", fd, "pipe"], cwd: repo });
    fs.closeSync(fd);
    assert.equal(toFile.status, 0);
    const whole = fs.readFileSync(target, "utf8");
    assert.ok(whole.length > 16 * 1024, "the usage is longer than a pipe's first write");
    const piped = spawnSync(process.execPath, ["--import", "tsx", cli, "--help"], { encoding: "utf8", cwd: repo, maxBuffer: 1 << 24 });
    assert.equal(piped.status, 0);
    assert.equal(piped.stdout.length, whole.length);
    assert.equal(piped.stdout.slice(-200), whole.slice(-200));
    // `scan` with no path prints the same usage and exits 1, and never goes on to scan.
    const scan = spawnSync(process.execPath, ["--import", "tsx", cli, "scan"], { encoding: "utf8", cwd: repo, maxBuffer: 1 << 24 });
    assert.equal(scan.status, 1);
    assert.equal(scan.stderr, "");
    assert.equal(scan.stdout, whole);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exitWhenDrained exits with its code only after a long stdout and stderr have reached a pipe whole (#740)", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-drain-"));
  try {
    const child = path.join(dir, "child.mjs");
    const commands = pathToFileURL(path.join(repo, "src", "commands.ts")).href;
    fs.writeFileSync(
      child,
      `import { exitWhenDrained } from ${JSON.stringify(commands)};\n` +
        `process.stdout.write("o".repeat(1 << 20));\nprocess.stderr.write("e".repeat(1 << 20));\nawait exitWhenDrained(3);\n`,
    );
    const piped = spawnSync(process.execPath, ["--import", "tsx", child], { encoding: "utf8", cwd: repo, maxBuffer: 1 << 24 });
    assert.equal(piped.status, 3);
    assert.equal(piped.stdout.length, 1 << 20);
    assert.equal(piped.stderr.length, 1 << 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A config whose allowed writes `policy explain` prints in full: about 150 KB of output from a short command line,
 * since Linux caps one argument at 128 KB and Windows a whole command line at 32 KB.
 */
function longConfig(dir: string): string {
  const file = path.join(dir, "long-config.json");
  const allowedWrites = Array.from({ length: 50 }, (_, i) => `POST /api/things${i}/${"a".repeat(3000)}`);
  fs.writeFileSync(file, JSON.stringify({ allowedWrites }));
  return file;
}

test("a command that ends with an exit code, read through a pipe, arrives whole as it does into a file (#740)", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = path.join(repo, "src", "cli.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-exit-"));
  try {
    const argv = ["--import", "tsx", cli, "policy", "explain", "POST", "https://app.example/api/things"];
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, SCENESCOUT_CONFIG: longConfig(dir) };
    const target = path.join(dir, "out.txt");
    const fd = fs.openSync(target, "w");
    const toFile = spawnSync(process.execPath, argv, { stdio: ["ignore", fd, "pipe"], cwd: repo, env });
    fs.closeSync(fd);
    assert.ifError(toFile.error);
    assert.equal(toFile.status, 0, String(toFile.stderr));
    const whole = fs.readFileSync(target, "utf8");
    assert.ok(whole.length > 128 * 1024, "longer than a pipe's buffer");
    const piped = spawnSync(process.execPath, argv, { encoding: "utf8", cwd: repo, env, maxBuffer: 1 << 24 });
    assert.ifError(piped.error);
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal(piped.stdout, whole);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "exitWhenDrained keeps its own code when the reader left after the last write (`| head`), on stdout and on stderr (#740)",
  { skip: process.platform === "win32" },
  () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-epipe-"));
    try {
      const commands = pathToFileURL(path.join(repo, "src", "commands.ts")).href;
      for (const which of ["stdout", "stderr"] as const) {
        const child = path.join(dir, `${which}.mjs`);
        // `head -c 1` has read the byte and gone by the time the drain's own write reaches the pipe.
        fs.writeFileSync(
          child,
          `import { exitWhenDrained } from ${JSON.stringify(commands)};\n` +
            `process.${which}.write("x");\nawait new Promise((r) => setTimeout(r, 500));\nawait exitWhenDrained(3);\n`,
        );
        const other = path.join(dir, "other.txt");
        const redirect = which === "stdout" ? '2>"$OTHER"' : '2>&1 >"$OTHER"';
        const script = `( "$1" --import tsx "$2" ${redirect}; echo $? >"$STATUS" ) | head -c 1 >/dev/null`;
        const status = path.join(dir, "status.txt");
        const run = spawnSync("sh", ["-c", script, "sh", process.execPath, child], { cwd: repo, env: { ...process.env, OTHER: other, STATUS: status } });
        assert.equal(run.status, 0, String(run.stderr));
        assert.equal(fs.readFileSync(other, "utf8"), "", which);
        assert.equal(fs.readFileSync(status, "utf8").trim(), "3", which);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

/** Runs the CLI with `which` piped into `head -c 10`, which closes its end after the first bytes; the other stream goes to a file. */
function throughHead(argv: string[], which: "stdout" | "stderr", dir: string, env: NodeJS.ProcessEnv): { code: number; other: string } {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const other = path.join(dir, "other.txt");
  const status = path.join(dir, "status.txt");
  const redirect = which === "stdout" ? '2>"$OTHER"' : '2>&1 >"$OTHER"';
  const script = `node="$1"; shift; ( "$node" --import tsx "$@" ${redirect}; echo $? >"$STATUS" ) | head -c 10 >/dev/null`;
  const run = spawnSync("sh", ["-c", script, "sh", process.execPath, path.join(repo, "src", "cli.ts"), ...argv], {
    cwd: repo,
    env: { ...env, OTHER: other, STATUS: status },
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, String(run.stderr));
  return { code: Number(fs.readFileSync(status, "utf8").trim()), other: fs.readFileSync(other, "utf8") };
}

test("a command whose reader has gone (`| head`) exits with its own code and prints no EPIPE trace (#740)", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-epipe-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, SCENESCOUT_CONFIG: longConfig(dir) };
    const policy = throughHead(["policy", "explain", "POST", "https://app.example/api/things"], "stdout", dir, env);
    assert.equal(policy.code, 0, policy.other.slice(0, 500));
    assert.equal(policy.other, "");
    // The usage path sets the exit code and returns (#736): its 0 and its 1 survive a gone reader too.
    const help = throughHead(["--help"], "stdout", dir, env);
    assert.equal(help.code, 0, help.other.slice(0, 500));
    assert.equal(help.other, "");
    const bare = throughHead([], "stdout", dir, env);
    assert.equal(bare.code, 1, bare.other.slice(0, 500));
    assert.equal(bare.other, "");
    // A long refusal goes to stderr: with stderr's reader gone it still exits with the refusal's 1, and stdout stays empty.
    const refused = throughHead(["scan", `--${"x".repeat(20_000)}`], "stderr", dir, env);
    assert.equal(refused.code, 1);
    assert.equal(refused.other, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("src/ ends a process only through exitWhenDrained, apart from the MCP server's shutdown, which prints nothing (#740)", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const found: string[] = [];
  for (const file of fs.readdirSync(src, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts")) continue;
    fs.readFileSync(path.join(src, file), "utf8")
      .split("\n")
      .forEach((line) => {
        if (line.includes("process.exit(")) found.push(`${file.replaceAll("\\", "/")}: ${line.trim()}`);
      });
  }
  assert.deepEqual(found.sort(), [
    "commands.ts: process.exit(code);",
    "mcp-server.ts: void shutdown().finally(() => process.exit(0));",
    "mcp-server.ts: void shutdown().finally(() => process.exit(0));",
    "mcp-server.ts: void shutdown().finally(() => process.exit(0));",
  ]);
});

test("`--help` and `-h` print the usage and exit 0 for EVERY subcommand, and the command itself never runs", async () => {
  for (const command of SUBCOMMANDS) {
    for (const help of ["--help", "-h"]) {
      for (const argv of [
        [command, help],
        [command, "--skip-browser", help],
        [command, "http://127.0.0.1:3000", help],
      ]) {
        const out = await dispatched(argv);
        assert.deepEqual(out, { ran: [], exit: 0, said: ["usage"] }, argv.join(" "));
      }
    }
  }
});

test("`install --help` does nothing: no skill, no browser download, no registration, no command on PATH", async () => {
  // The install handler is the only way to any of those steps; it is never reached.
  const out = await dispatched(["install", "--help"]);
  assert.deepEqual(out.ran, []);
  assert.equal(out.exit, 0);
});

test("install, doctor, scan, status and watch refuse an argument they do not know instead of ignoring it", async () => {
  const cases: [string[], string][] = [
    [["install", "--dry-run"], "unknown option --dry-run"],
    [["install", "--browser", "firefox"], "unknown option --browser — did you mean --browsers?"],
    [["install", "--browser=firefox"], "unknown option --browser — did you mean --browsers?"],
    [["install", "--skip-browser=yes"], "unknown option --skip-browser"],
    [["install", "firefox"], "unexpected argument firefox"],
    [["install", "-x"], "unknown option -x"],
    [["doctor", "--verbose"], "unknown option --verbose"],
    [["doctor", "extra"], "unexpected argument extra"],
    [["scan", ".", "--json"], "unknown option --json"],
    [["scan", "a", "b"], "unexpected argument b"],
    [["status", "--all"], "unknown option --all"],
    [["watch", "--no-opn"], "unknown option --no-opn"],
    [["watch", "a", "b"], "unexpected argument b"],
  ];
  for (const [argv, message] of cases) {
    assert.deepEqual(await dispatched(argv), { ran: [], exit: 1, said: [message] }, argv.join(" "));
  }
});

test("the flags each hand-parsed command documents still reach it", async () => {
  const cases: string[][] = [
    ["install"],
    ["install", "--skip-browser", "--no-register", "--no-command"],
    ["install", "--browser-only", "--browsers", "firefox,webkit"],
    ["install", "--browsers=all", "--client", "cursor", "--clients=vscode"],
    // A valued flag's value is not read as a flag of its own.
    ["install", "--client", "-weird"],
    ["doctor"],
    ["doctor", "--engine"],
    ["scan", "."],
    ["status"],
    ["status", "some/project"],
    ["watch", "--no-open"],
    ["watch", "some/project", "--no-open"],
  ];
  for (const argv of cases) assert.deepEqual(await dispatched(argv), { ran: [argv.join(" ")], exit: null, said: [] }, argv.join(" "));
});

test("check, ci, login, export and policy keep their own option parsing, and serve starts whatever else it is given", async () => {
  // Their parsers refuse unknown options with their own exit codes (check, ci, export and policy exit 2), so the preflight leaves them be.
  for (const argv of [
    ["check", "http://127.0.0.1:3000", "--nope"],
    ["ci", "http://127.0.0.1:3000", "--nope"],
    ["login", "http://127.0.0.1:3000", "--nope"],
    ["export", "--to", "github", "--nope"],
    ["policy", "explain", "POST", "http://127.0.0.1:3000/api/x", "--nope"],
    ["config", "explain", "--nope"],
    ["config", "explain", "--project", "some/project"],
    ["policy", "explain", "DELETE", "http://127.0.0.1:3000/api/x", "--mode", "read-only", "--header", "X-Trace: 1"],
    ["serve", "--stray"],
  ]) {
    assert.deepEqual((await dispatched(argv)).ran, [argv.join(" ")], argv.join(" "));
  }
});

test("`scenescout policy explain`: each mode's verdict and exit 0, its body from a file, the server's settings, and exit 2 on a bad argument", () => {
  const run = (args: string[], env: Record<string, string | undefined> = {}, files: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runPolicyCommand(args, {
      env,
      readBody: (file) => {
        if (!(file in files)) throw new Error(`ENOENT: ${file}`);
        return files[file];
      },
      out: (line) => void out.push(line),
      err: (line) => void err.push(line),
    });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  };
  const missing = run(["explain", "POST", "https://app.example.com/api/things", "--body", "body.json"]);
  assert.equal(missing.code, EXIT_POLICY.couldNotExplain, "a body file that is not there");
  assert.match(missing.stderr, /^scenescout policy: could not read the body file body\.json/);
  const out = run(["explain", "POST", "https://app.example.com/api/things", "--body", "body.json"], {}, { "body.json": '{"action":"delete","id":3}' });
  assert.equal(out.code, EXIT_POLICY.explained, out.stderr);
  assert.match(out.stdout, /Looks destructive to the standard classifier/);
  for (const [mode, outcome] of [
    ["observe", "refused"],
    ["read-only", "depends"],
    ["safe-write", "depends"],
    ["destructive", "allowed"],
  ])
    assert.match(out.stdout, new RegExp(`^  ${mode} +${outcome} `, "m"), mode);
  const one = run(["explain", "GET", "https://app.example.com/things/9/void", "--mode", "observe"]);
  assert.equal(one.code, EXIT_POLICY.explained);
  assert.equal(one.stdout.match(/^  [a-z-]+ +(allowed|refused|depends) /gm)?.length, 1, "one mode asked for, one verdict");
  assert.match(one.stdout, /^  observe +allowed /m);
  // With the server's setting on, the same page load is refused, as the server would refuse it.
  assert.match(
    run(["explain", "GET", "https://app.example.com/things/9/void", "--mode", "observe"], { SCENESCOUT_REFUSE_DESTRUCTIVE_GETS: "1" }).stdout,
    /^  observe +refused /m,
  );
  // A setting the server would refuse to start with is refused here too.
  const badEnv = run(["explain", "GET", "https://app.example.com/"], { SCENESCOUT_STRICT_WRITES: "maybe" });
  assert.equal(badEnv.code, EXIT_POLICY.couldNotExplain);
  assert.match(badEnv.stderr, /SCENESCOUT_STRICT_WRITES must be 1 or 0/);
  for (const bad of [
    ["explain", "GET"],
    ["explain", "GET", "https://app.example.com", "--nope"],
    ["show", "GET", "https://app.example.com"],
  ]) {
    const r = run(bad);
    assert.equal(r.code, EXIT_POLICY.couldNotExplain, bad.join(" "));
    assert.match(r.stderr, /^scenescout policy: /, bad.join(" "));
    assert.equal(r.stdout, "", bad.join(" "));
  }
});

test("`scenescout policy explain` prints no credential from the URL or a malformed argument, and applies the config file's readPosts as a session would", () => {
  const run = (args: string[], config?: Record<string, string>) => {
    const out: string[] = [];
    const err: string[] = [];
    const reader = {
      exists: (file: string) => config !== undefined && file in config,
      read: (file: string) => config![file],
      realpath: (file: string) => file,
    };
    const code = runPolicyCommand(args, {
      env: {},
      readBody: () => "",
      out: (line) => void out.push(line),
      err: (line) => void err.push(line),
      config: { launchDir: "/launch", reader },
    });
    return { code, text: [...out, ...err].join("\n") };
  };
  const secretUrl = run([
    "explain",
    "POST",
    "https://someone:hunter2@app.example.com/api/x?token=abcdef123456",
    "--header",
    "Authorization: Bearer abc.def.ghi",
  ]);
  assert.equal(secretUrl.code, EXIT_POLICY.explained, secretUrl.text);
  assert.doesNotMatch(secretUrl.text, /hunter2|abcdef123456|abc\.def\.ghi/);
  assert.match(secretUrl.text, /^POST https:\/\/app\.example\.com\/api\/x\?token=/m, "the address is still shown, without them");
  for (const argv of [
    ["explain", "POST", "https://app.example.com/x", "--header", "Authorization Bearer opensesame-hunter2"],
    ["explain", "POST", "https:/someone:hunter2@[bad"],
    ["explain", "POST", "https://app.example.com/x", "--app", "hunter2 is not an address"],
  ]) {
    const r = run(argv);
    assert.equal(r.code, EXIT_POLICY.couldNotExplain, argv.join(" "));
    assert.doesNotMatch(r.text, /hunter2|opensesame/, argv.join(" "));
  }
  assert.match(run(["--nope"]).text, /unknown option --nope/);
  // The config file's readPosts is the list a session reads, with no environment list: observe lets the named POST out.
  const search = ["explain", "POST", "https://app.example.com/api/search", "--mode", "observe"];
  assert.match(run(search).text, /^ {2}observe +refused /m, "no config: not a read POST");
  const withFile = run(search, { [path.join("/launch", ".scenescout", "config.json")]: JSON.stringify({ readPosts: ["POST /api/search"] }) });
  assert.equal(withFile.code, EXIT_POLICY.explained, withFile.text);
  assert.match(withFile.text, /^ {2}observe +allowed .*POST \/api\/search/m);
  assert.match(withFile.text, /Config: /);
});

test("the CLI runs `scenescout policy explain` and exits with its code (one process: the codes themselves are tested above)", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of Object.keys(POLICY_EXPLAIN_ENV)) delete env[name];
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", path.join(repo, "src", "cli.ts"), "policy", ...args], { cwd: repo, env, encoding: "utf8" });
  const ok = cli("explain", "DELETE", "https://app.example.com/api/things/3", "--mode", "read-only");
  assert.equal(ok.status, EXIT_POLICY.explained, ok.stderr);
  assert.match(ok.stdout, /^  read-only +refused /m);
});

/** The variables `scenescout policy explain` reads, as the server does, each with a value that turns its setting on. */
const POLICY_EXPLAIN_ENV = {
  SCENESCOUT_STRICT_WRITES: "1",
  SCENESCOUT_REFUSE_DESTRUCTIVE_GETS: "1",
  SCENESCOUT_READ_POSTS: "POST /api/search",
  SCENESCOUT_AUTH_POSTS: "POST /api/login",
  SCENESCOUT_ALLOWED_WRITES: "POST /api/things",
} as const;

test("`scenescout policy explain`'s help names exactly the variables and config keys it reads", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // Read from the source: a piped --help can be cut short on macOS, where usage() exits before stdout drains.
  const help = fs.readFileSync(path.join(repo, "src", "cli.ts"), "utf8");
  const start = help.indexOf("scenescout policy explain <METHOD> <URL>");
  assert.ok(start >= 0, "the usage has a policy explain entry");
  const entry = help.slice(start, help.indexOf("Sends nothing.", start));
  assert.deepEqual([...new Set(entry.match(/SCENESCOUT_[A-Z_]+/g))].sort(), Object.keys(POLICY_EXPLAIN_ENV).sort());
  for (const [name, value] of Object.entries(POLICY_EXPLAIN_ENV))
    assert.notDeepEqual(policySettingsFrom({ [name]: value }), policySettingsFrom({}), `${name} changes what policy explain judges by`);
  const keys = ["readPosts", "writeClassifier", "refuseDestructiveGets", "authPosts", "allowedWrites"];
  for (const key of keys) {
    assert.ok((CONFIG_KEYS as readonly string[]).includes(key), `${key} is a config key`);
    assert.match(entry, new RegExp(`\\b${key}\\b`), `the help names the config's ${key}`);
  }
});

test("`scenescout config explain`: exit 0 with a line per key, exit 2 with one line on a bad argument, an invalid file or a folder outside projectsRoot", () => {
  const run = (args: string[], files: Record<string, string> = {}, env: Record<string, string | undefined> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    // Keyed by resolved path, so the stand-in files are found however the command joins its paths on this platform.
    const byPath = new Map(Object.entries(files).map(([f, text]) => [path.resolve(f), text]));
    const reader = { exists: (f: string) => byPath.has(path.resolve(f)), read: (f: string) => byPath.get(path.resolve(f)) ?? "", realpath: (f: string) => f };
    const code = runConfigCommand(args, { env, launchDir: path.resolve("/launch"), reader, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const none = run(["explain"]);
  assert.equal(none.code, EXIT_CONFIG.explained);
  assert.match(none.out, /^Config files: none/);
  assert.match(none.out, /^ {2}egress +all +\(default\)$/m);
  const strict = run(["explain"], { "/launch/.scenescout/config.json": '{"preset":"strict"}' });
  assert.equal(strict.code, EXIT_CONFIG.explained);
  assert.match(strict.out, /^ {2}maxMode +observe +\(operator file's preset "strict"\)$/m);
  for (const [args, files, message] of [
    [[], {}, /^scenescout config: say what to do/],
    [["explain", "--nope"], {}, /^scenescout config: unknown option --nope$/],
    [["explain", "extra"], {}, /^scenescout config: unexpected argument extra$/],
    [["explain", "--project"], {}, /^scenescout config: /],
    [["frobnicate"], {}, /^scenescout config: unknown action frobnicate/],
    [["explain"], { "/launch/.scenescout/config.json": '{"maxmode":"observe"}' }, /unknown key "maxmode"/],
    [["explain"], { "/launch/.scenescout/config.json": "{" }, /not valid JSON/],
    [["explain"], { "/launch/.scenescout/config.json": '{"projectsRoot":"/work"}' }, /outside|not inside|projectsRoot/],
  ] as const) {
    const r = run([...args], { ...files }, {});
    assert.equal(r.code, EXIT_CONFIG.couldNotExplain, args.join(" "));
    assert.match(r.err, message);
    assert.equal(r.err.split("\n").length, 1);
    assert.equal(r.out, "");
  }
  // An environment value the server refuses stops it too.
  assert.equal(run(["explain"], {}, { SCENESCOUT_STRICT_WRITES: "maybe" }).code, EXIT_CONFIG.couldNotExplain);
});

test("the CLI runs `scenescout config explain` and exits with its code (one process: the codes themselves are tested above)", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ["SCENESCOUT_CONFIG", "SCENESCOUT_STRICT_WRITES", "SCENESCOUT_REFUSE_DESTRUCTIVE_GETS", "SCENESCOUT_READ_POSTS", "SCENESCOUT_AUTH_POSTS"])
    delete env[name];
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", path.join(repo, "src", "cli.ts"), "config", ...args], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
  const ok = cli("explain");
  assert.equal(ok.status, EXIT_CONFIG.explained, ok.stderr);
  assert.match(ok.stdout, /^ {2}egress +all +\(default\)$/m);
  const bad = cli("explain", "--nope");
  assert.equal(bad.status, EXIT_CONFIG.couldNotExplain);
  assert.match(bad.stderr, /^scenescout config: unknown option --nope/);
});

test("the top level: help, version, and an unknown or missing command", async () => {
  for (const help of ["--help", "-h", "help"]) assert.deepEqual(await dispatched([help]), { ran: [], exit: 0, said: ["usage"] });
  for (const v of ["--version", "-v"]) assert.deepEqual(await dispatched([v]), { ran: [], exit: null, said: ["version"] });
  assert.deepEqual(await dispatched(["instal"]), { ran: [], exit: 1, said: ["usage"] });
  assert.deepEqual(await dispatched([]), { ran: [], exit: 1, said: ["usage"] });
  // An inherited property is not a command.
  assert.deepEqual(await dispatched(["constructor"]), { ran: [], exit: 1, said: ["usage"] });
});

/**
 * The flags a hand-parsed command's function in cli.ts reads. Line endings are
 * normalised first: a Windows checkout has CRLF, and a body that never finds
 * its closing brace would run on into the next function and borrow its flags.
 */
function flagsReadBy(source: string, command: string): Set<string> {
  const text = asLf(source);
  const start = text.indexOf(`async function ${command}(flags: string[])`);
  assert.ok(start >= 0, `cli.ts has no ${command}(flags) function`);
  const end = text.indexOf("\n}\n", start);
  assert.ok(end >= 0, `found no end to ${command}() in cli.ts`);
  const body = text.slice(start, end);
  return new Set([...body.matchAll(/flags(?:\.includes\(|, )"(--[a-z-]+)"|\["(--[a-z-]+)", "(--[a-z-]+)"\]/g)].flatMap((m) => m.slice(1).filter(Boolean)));
}

test("every flag install and doctor read in cli.ts is one the preflight accepts", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"), "utf8");
  for (const command of ["install", "doctor"] as const) {
    const read = flagsReadBy(source, command);
    assert.ok(read.size > 0, `found no flags in ${command}()`);
    const spec = HAND_PARSED[command];
    for (const flag of read) assert.ok([...spec.switches, ...spec.valued].includes(flag), `${command} reads ${flag}, which the preflight would refuse`);
  }
});

test("reading a command's flags from cli.ts gives the same answer with CRLF line endings", () => {
  const lf = [
    "async function install(flags: string[]): Promise<void> {",
    '  if (flags.includes("--skip-browser")) return;',
    "}",
    "",
    "async function doctor(flags: string[]): Promise<void> {",
    '  if (flags.includes("--engine")) return;',
    "}",
    "",
  ].join("\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  for (const source of [lf, crlf]) {
    assert.deepEqual([...flagsReadBy(source, "install")], ["--skip-browser"]);
    assert.deepEqual([...flagsReadBy(source, "doctor")], ["--engine"]);
  }
});

// ── The first run: `scenescout <url>` ──────────────────────────────────────────

test("an address as the first argument is a first run; a subcommand is still its subcommand, and any other word gets the usage", async () => {
  const firstRuns: string[][] = [
    ["http://127.0.0.1:3000"],
    ["https://app.example.com/start?tab=1", "--max-routes", "5", "--max-minutes=2", "--out", "here"],
    // Its own parser refuses these with a reason, which beats the generic usage.
    ["localhost:3000"],
    ["example.com"],
    ["127.0.0.1:8080/app"],
    ["[::1]:3000"],
    ["ftp://files.example.com"],
    ["http://127.0.0.1:3000", "--nope"],
  ];
  for (const argv of firstRuns) assert.deepEqual(await dispatched(argv), { ran: [`(first run) ${argv.join(" ")}`], exit: null, said: [] }, argv.join(" "));
  // A subcommand given an address is that subcommand, never a first run.
  assert.deepEqual((await dispatched(["check", "http://127.0.0.1:3000"])).ran, ["check http://127.0.0.1:3000"]);
  // Help after an address is the usage, and nothing runs.
  for (const help of ["--help", "-h"]) assert.deepEqual(await dispatched(["http://127.0.0.1:3000", help]), { ran: [], exit: 0, said: ["usage"] });
  // Words that are neither: the usage, exit 1, as before. The address comes first, so options before it are not a first run.
  for (const argv of [
    ["instal"],
    ["chek", "http://127.0.0.1:3000"],
    ["-x"],
    ["localhost-ish"],
    ["hello world"],
    ["--max-routes", "5", "http://127.0.0.1:3000"],
  ]) {
    assert.deepEqual(await dispatched(argv), { ran: [], exit: 1, said: ["usage"] }, argv.join(" "));
  }
});

test("what reads as an address: a scheme, or a host with a dot, a port or the name localhost", () => {
  const yes = [
    "http://x",
    "HTTPS://X.TEST",
    "ftp://x",
    "localhost",
    "LOCALHOST:3000",
    "localhost/app",
    "example.com",
    "a.b.c/d?e#f",
    "10.0.0.2:80",
    "[::1]:8080",
    "web:3000",
  ];
  const no = [undefined, "", "check", "instal", "--help", "-h", "-x", "localhost-ish", "hello world", "./dist", "/abs/path", "C:\\temp", "x:y"];
  for (const arg of yes) assert.equal(looksLikeUrl(arg), true, String(arg));
  for (const arg of no) assert.equal(looksLikeUrl(arg), false, String(arg));
  // No subcommand reads as an address, so the order they are tried in can never matter.
  for (const command of SUBCOMMANDS) assert.equal(looksLikeUrl(command), false, command);
});

test("a first run's options: the defaults, both spellings, and an out folder resolved from where it runs", () => {
  const plain = parseFirstRunArgs(["http://127.0.0.1:3000"], "/p");
  assert.deepEqual(plain, { ok: true, options: { url: "http://127.0.0.1:3000/", maxRoutes: 20, maxMinutes: 3, mode: "observe" } });
  assert.deepEqual(FIRST_RUN_DEFAULTS, { maxRoutes: 20, maxMinutes: 3, mode: "observe" });
  const given = parseFirstRunArgs(
    ["https://app.example.com/start", "--max-routes", "5", "--max-minutes=10", "--mode", "read-only", "--out", "reports/first"],
    "/p",
  );
  assert.deepEqual(given, {
    ok: true,
    options: { url: "https://app.example.com/start", maxRoutes: 5, maxMinutes: 10, mode: "read-only", outDir: "/p/reports/first" },
  });
  // An absolute --out is kept as given.
  assert.deepEqual(parseFirstRunArgs(["http://127.0.0.1:3000", "--out=/abs/out"], "/p"), {
    ok: true,
    options: { url: "http://127.0.0.1:3000/", maxRoutes: 20, maxMinutes: 3, mode: "observe", outDir: "/abs/out" },
  });
});

test("a first look runs in observe mode unless read-only is asked for, and in no mode that writes", () => {
  const modeOf = (args: string[]) => {
    const r = parseFirstRunArgs(["http://127.0.0.1:3000", ...args], "/p");
    return r.ok ? r.options.mode : r.error;
  };
  assert.equal(modeOf([]), "observe");
  assert.equal(modeOf(["--mode", "observe"]), "observe");
  assert.equal(modeOf(["--mode=read-only"]), "read-only");
  for (const writes of ["safe-write", "destructive", "READ-ONLY", "readonly"]) {
    assert.equal(
      modeOf(["--mode", writes]),
      "--mode must be observe (the default) or read-only: a first look never writes on purpose, whatever the mode",
      writes,
    );
  }
  assert.match(String(modeOf(["--mode"])), /--mode needs a value/);
});

test("a first run's caps have bounds, and each mistake is a sentence naming the option", () => {
  const error = (args: string[]): string => {
    const r = parseFirstRunArgs(["http://127.0.0.1:3000", ...args], "/p");
    assert.equal(r.ok, false, args.join(" "));
    return (r as { error: string }).error;
  };
  for (const bad of ["0", "-1", `${MAX_CHECK_ROUTES + 1}`, "2.5", "lots", ""]) {
    assert.match(
      error([`--max-routes=${bad}`]),
      bad === "" ? /--max-routes needs a value/ : new RegExp(`--max-routes must be a whole number from 1 to ${MAX_CHECK_ROUTES}`),
      bad,
    );
  }
  for (const bad of ["0", `${MAX_FIRST_RUN_MINUTES + 1}`, "0.5"]) {
    assert.match(error(["--max-minutes", bad]), new RegExp(`--max-minutes must be a whole number from 1 to ${MAX_FIRST_RUN_MINUTES}`), bad);
  }
  // The edges are accepted.
  for (const [flag, value] of [
    ["--max-routes", "1"],
    ["--max-routes", `${MAX_CHECK_ROUTES}`],
    ["--max-minutes", "1"],
    ["--max-minutes", `${MAX_FIRST_RUN_MINUTES}`],
  ]) {
    assert.equal(parseFirstRunArgs(["http://127.0.0.1:3000", flag, value], "/p").ok, true, `${flag} ${value}`);
  }
  assert.match(error(["--max-routes"]), /--max-routes needs a value/);
  assert.match(error(["--out", "--max-routes", "3"]), /--out needs a value/);
  assert.match(error(["--verbose"]), /unknown option --verbose: a first look takes only --max-routes, --max-minutes, --mode, --out/);
  assert.match(error(["-v"]), /unknown option -v/);
  // An option of check is pointed at check, which has it.
  assert.match(error(["--storage-state", "s.json"]), /--storage-state is an option of scenescout check/);
  assert.match(error(["--fail-on", "high"]), /--fail-on is an option of scenescout check/);
  assert.match(error(["http://127.0.0.1:4000"]), /give one address, not 2/);
});

test("a first run takes a whole http or https address, and says how to write one it cannot take", () => {
  const error = (arg: string): string => {
    const r = parseFirstRunArgs([arg], "/p");
    assert.equal(r.ok, false, arg);
    return (r as { error: string }).error;
  };
  // Not guessed, but the line to type is given: plain http for a local dev server, https elsewhere.
  assert.equal(error("localhost:3000"), "write the address in full, with its scheme: scenescout http://localhost:3000");
  assert.equal(error("127.0.0.1:8080/app"), "write the address in full, with its scheme: scenescout http://127.0.0.1:8080/app");
  assert.equal(error("example.com"), "write the address in full, with its scheme: scenescout https://example.com");
  // The line to type survives being pasted: a query is quoted.
  assert.equal(error("example.com/a?b=1&c=2"), "write the address in full, with its scheme: scenescout 'https://example.com/a?b=1&c=2'");
  assert.match(error("ftp://files.example.com"), /only http and https addresses can be looked at \(got ftp:\)/);
  assert.match(error("file:///etc/passwd"), /only http and https/);
  assert.match(error("http://user:secret@127.0.0.1:3000"), /put no credentials in the address/);
  assert.match(error("http://[nope"), /not a URL/);
  assert.match((parseFirstRunArgs([], "/p") as { error: string }).error, /give the address to look at/);
});

test("a first run is a check in its mode, never gated, in Chromium, with its caps and nothing read from a project", () => {
  const options = firstRunCheckOptions({ url: "http://127.0.0.1:3000/", maxRoutes: 7, maxMinutes: 2, mode: "observe" }, "/empty-project");
  assert.deepEqual(options, {
    url: "http://127.0.0.1:3000/",
    projectDir: "/empty-project",
    failOn: "never",
    mode: "observe",
    browser: "chromium",
    maxRoutes: 7,
    timeBudgetMs: 120_000,
    ignore: [],
    ignorePaths: [],
    flows: "off",
    retest: false,
    flowWrites: "never",
    onRefusedStep: "report",
    gateRetests: "never",
    // A first look pictures nothing for visual baselines.
    baseline: "off",
    baselineThreshold: 0.1,
  });
  assert.equal(firstRunCheckOptions({ url: "http://127.0.0.1:3000/", maxRoutes: 7, maxMinutes: 2, mode: "read-only" }, "/p").mode, "read-only");
});

test("a first run downloads only the headless Chromium build a check launches, and only when it is missing", () => {
  const exe = { chromium: "/c/ms-playwright/chromium-9/chrome", firefox: "/c/ms-playwright/firefox-7/firefox", webkit: "/c/ms-playwright/webkit-3/pw_run.sh" };
  const shellMarker = path.join("/c/ms-playwright/chromium_headless_shell-9", "INSTALLATION_COMPLETE");
  const on = (...present: string[]) => browserPresence(exe, (p) => present.includes(p));
  // A clean machine: the shell alone, not the full browser and not the other engines.
  assert.deepEqual(firstRunDownloads(on()), ["chromium-headless-shell"]);
  assert.deepEqual(firstRunDownloads(on(exe.firefox, exe.webkit)), ["chromium-headless-shell"], "another engine on disk does not stand in for it");
  assert.deepEqual(firstRunDownloads(on(exe.chromium)), ["chromium-headless-shell"], "the full browser alone does not launch headless");
  // Already there: nothing to download, the full browser or not.
  assert.deepEqual(firstRunDownloads(on(shellMarker)), []);
  assert.deepEqual(firstRunDownloads(on(exe.chromium, shellMarker)), []);
  assert.match(downloadLine(["chromium-headless-shell"]), /Downloading it once \(chromium-headless-shell, about 200 MB on disk\)/);
});

/** Report files as a first look writes them: each begins the way a first look's own does. */
const REPORT_FILES = {
  "report.md": "# SceneScout first look\n\nhttp://127.0.0.1:3000/ · 1 page looked at\n",
  "check.json": '{\n  "tool": "scenescout-check",\n  "version": "0.0.0"\n}\n',
};
/** Every file under `dir` with its content, so a test can say nothing in it changed. */
const contents = (dir: string): Record<string, string> =>
  Object.fromEntries(
    (fs.readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[])
      .filter((f) => fs.statSync(path.join(dir, f)).isFile())
      .sort()
      .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
  );
/** Links need privileges on Windows; root ignores permission bits. The cases that need either say so where they are skipped. */
const canLink = process.platform !== "win32";
const permissionsHold = process.platform !== "win32" && process.getuid?.() !== 0;

test("a first look's report goes to scenescout-report/ where it runs, marked as a first look's, its .gitignore written before the report", () => {
  const cwd = tmp("sc-first-cwd-");
  const where = writeFirstRunReport(REPORT_FILES, { cwd, tmpdir: tmp("sc-first-tmp-") });
  const dir = path.join(cwd, FIRST_RUN_DIRNAME);
  assert.deepEqual(where, { dir });
  assert.deepEqual(fs.readdirSync(dir).sort(), [".gitignore", FIRST_LOOK_MARKER, "check.json", "report.md"]);
  assert.ok(fs.readFileSync(path.join(dir, ".gitignore"), "utf8").split("\n").includes("*"), "the folder ignores itself");
  // An empty folder of that name is as good as none.
  const emptyCwd = tmp("sc-first-cwd-");
  fs.mkdirSync(path.join(emptyCwd, FIRST_RUN_DIRNAME));
  assert.equal(reportFolderProblem(path.join(emptyCwd, FIRST_RUN_DIRNAME), false), null);
  writeFirstRunReport(REPORT_FILES, { cwd: emptyCwd, tmpdir: tmp("sc-first-tmp-") });
  assert.ok(fs.existsSync(path.join(emptyCwd, FIRST_RUN_DIRNAME, FIRST_LOOK_MARKER)));
});

test("a later first look replaces only its own two files in a folder an earlier one marked", () => {
  const cwd = tmp("sc-first-cwd-");
  const dir = path.join(cwd, FIRST_RUN_DIRNAME);
  writeFirstRunReport(REPORT_FILES, { cwd, tmpdir: tmp("sc-first-tmp-") });
  fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
  fs.writeFileSync(path.join(dir, ".gitignore"), "# kept\n");
  assert.equal(reportFolderProblem(dir, false), null);
  const second = { ...REPORT_FILES, "report.md": "# SceneScout first look\n\nthe second\n" };
  writeFirstRunReport(second, { cwd, tmpdir: tmp("sc-first-tmp-") });
  assert.equal(fs.readFileSync(path.join(dir, "report.md"), "utf8"), second["report.md"]);
  assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "mine");
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), "# kept\n");
});

test("a scenescout-report/ a first look did not mark is never written into, nor swapped for a temporary folder", () => {
  // The same folder a first look leaves, with everything in it but the marker.
  const cwd = tmp("sc-first-cwd-");
  const dir = path.join(cwd, FIRST_RUN_DIRNAME);
  writeFirstRunReport(REPORT_FILES, { cwd, tmpdir: tmp("sc-first-tmp-") });
  fs.rmSync(path.join(dir, FIRST_LOOK_MARKER));
  const before = contents(dir);
  const tmpdir = tmp("sc-first-tmp-");
  const problem = reportFolderProblem(dir, false);
  assert.equal(
    problem,
    `${dir} already exists and holds files a first look did not write, so nothing in it is touched. Pass --out <folder> to put the report somewhere else.`,
  );
  assert.throws(() => writeFirstRunReport(REPORT_FILES, { cwd, tmpdir }), { message: problem });
  assert.deepEqual(contents(dir), before, "nothing in it changed");
  assert.deepEqual(fs.readdirSync(tmpdir), [], "and no temporary folder stood in for it");
  // A hidden file counts: the folder is not empty.
  const hidden = tmp("sc-first-cwd-");
  fs.mkdirSync(path.join(hidden, FIRST_RUN_DIRNAME));
  fs.writeFileSync(path.join(hidden, FIRST_RUN_DIRNAME, ".keep"), "");
  assert.match(reportFolderProblem(path.join(hidden, FIRST_RUN_DIRNAME), false) ?? "", /holds files a first look did not write/);
  // A file of that name is left alone too.
  const file = tmp("sc-first-cwd-");
  fs.writeFileSync(path.join(file, FIRST_RUN_DIRNAME), "not a folder");
  assert.match(
    reportFolderProblem(path.join(file, FIRST_RUN_DIRNAME), false) ?? "",
    /already exists and is not a folder, so it is left alone\. Pass --out <folder>/,
  );
  assert.throws(() => writeFirstRunReport(REPORT_FILES, { cwd: file, tmpdir }), /is not a folder/);
  assert.equal(fs.readFileSync(path.join(file, FIRST_RUN_DIRNAME), "utf8"), "not a folder");
  // A marker that is a folder marks nothing.
  const fake = tmp("sc-first-cwd-");
  fs.mkdirSync(path.join(fake, FIRST_RUN_DIRNAME, FIRST_LOOK_MARKER), { recursive: true });
  assert.match(reportFolderProblem(path.join(fake, FIRST_RUN_DIRNAME), false) ?? "", /holds files a first look did not write/);
});

test("a report.md or check.json is replaced only when a first look wrote it, whatever the folder and however the name is cased", () => {
  // A marked folder where someone has since put their own report.md: it stays theirs.
  const cwd = tmp("sc-first-cwd-");
  const dir = path.join(cwd, FIRST_RUN_DIRNAME);
  writeFirstRunReport(REPORT_FILES, { cwd, tmpdir: tmp("sc-first-tmp-") });
  fs.writeFileSync(path.join(dir, "report.md"), "my own notes");
  assert.equal(
    reportFolderProblem(dir, false),
    `${dir} holds a report.md a first look did not write, so nothing there is replaced. Pass --out <folder> to put the report somewhere else.`,
  );
  assert.throws(() => writeFirstRunReport(REPORT_FILES, { cwd, tmpdir: tmp("sc-first-tmp-") }), /holds a report\.md a first look did not write/);
  assert.equal(fs.readFileSync(path.join(dir, "report.md"), "utf8"), "my own notes");
  // --out: other files are fine, a report the first look did not write is not, marked or not.
  const out = tmp("sc-first-out-");
  fs.writeFileSync(path.join(out, "check.json"), '{"mine": true}');
  assert.equal(
    reportFolderProblem(out, true),
    `--out ${out} holds a check.json a first look did not write, so nothing there is replaced. Name another folder with --out.`,
  );
  fs.writeFileSync(path.join(out, FIRST_LOOK_MARKER), "");
  assert.match(reportFolderProblem(out, true) ?? "", /holds a check\.json a first look did not write/);
  // Another case of the same name: on a file system that ignores case it answers to report.md, and is refused; where
  // case matters it is another file. Either way it is never overwritten.
  const cased = tmp("sc-first-out-");
  fs.writeFileSync(path.join(cased, "Report.md"), "my own report");
  const ignoresCase = fs.existsSync(path.join(cased, "report.md"));
  const problem = reportFolderProblem(cased, true);
  if (ignoresCase) assert.match(problem ?? "", /holds a report\.md a first look did not write/);
  else {
    assert.equal(problem, null);
    writeFirstRunReport(REPORT_FILES, { cwd: tmp("sc-first-cwd-"), tmpdir: tmp("sc-first-tmp-"), outDir: cased });
  }
  assert.equal(fs.readFileSync(path.join(cased, "Report.md"), "utf8"), "my own report");
  // A link where report.md goes would carry the write elsewhere: refused, and its target untouched.
  if (canLink) {
    const linked = tmp("sc-first-out-");
    const target = path.join(tmp("sc-first-elsewhere-"), "precious.md");
    fs.writeFileSync(target, "precious");
    writeFirstRunReport(REPORT_FILES, { cwd: tmp("sc-first-cwd-"), tmpdir: tmp("sc-first-tmp-"), outDir: linked });
    fs.rmSync(path.join(linked, "report.md"));
    fs.symlinkSync(target, path.join(linked, "report.md"));
    assert.match(reportFolderProblem(linked, true) ?? "", /holds a report\.md a first look did not write/);
    assert.equal(fs.readFileSync(target, "utf8"), "precious");
  }
});

test(
  "a first look that cannot write its own folder writes to a temporary folder and says why",
  { skip: !permissionsHold && process.platform !== "win32" ? "running as root, which no file permission stops" : false },
  () => {
    // An earlier look's folder whose marker cannot be written: the folder passes every check and the write fails.
    const cwd = tmp("sc-first-cwd-");
    const dir = path.join(cwd, FIRST_RUN_DIRNAME);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, FIRST_LOOK_MARKER), "");
    fs.chmodSync(path.join(dir, FIRST_LOOK_MARKER), 0o444);
    assert.equal(reportFolderProblem(dir, false), null);
    const tmpdir = tmp("sc-first-tmp-");
    const fallback = writeFirstRunReport(REPORT_FILES, { cwd, tmpdir });
    assert.equal(path.dirname(fallback.dir), tmpdir);
    assert.deepEqual(fs.readdirSync(fallback.dir).sort(), [FIRST_LOOK_MARKER, "check.json", "report.md"]);
    assert.match(fallback.note ?? "", /could not be written \((EACCES|EPERM)\), so the report is in a temporary folder/);
    // Nowhere at all: both reasons, so neither is lost. The temporary folder would go under a file, which POSIX
    // reports as ENOTDIR and Windows as ENOENT.
    const noTmp = path.join(tmp("sc-first-tmp-"), "a-file");
    fs.writeFileSync(noTmp, "x");
    const underFile = process.platform === "win32" ? "ENOENT" : "ENOTDIR";
    assert.throws(
      () => writeFirstRunReport(REPORT_FILES, { cwd, tmpdir: noTmp }),
      new RegExp(`could not be written \\((EACCES|EPERM)\\), and neither could a temporary folder \\(${underFile}\\)`),
    );
    fs.chmodSync(path.join(dir, FIRST_LOOK_MARKER), 0o644);
  },
);

test("a first look's .gitignore goes in before its report, and never over one that is already there", () => {
  const cwd = tmp("sc-first-cwd-");
  const dir = path.join(cwd, FIRST_RUN_DIRNAME);
  // A write that fails on the report itself, after the marker and the .gitignore: report.md is a file nobody may write.
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, FIRST_LOOK_MARKER), "");
  fs.writeFileSync(path.join(dir, "report.md"), REPORT_FILES["report.md"]);
  fs.chmodSync(path.join(dir, "report.md"), 0o444);
  if (permissionsHold || process.platform === "win32") {
    const fallback = writeFirstRunReport(REPORT_FILES, { cwd, tmpdir: tmp("sc-first-tmp-") });
    assert.notEqual(fallback.dir, dir);
    assert.ok(fs.readFileSync(path.join(dir, ".gitignore"), "utf8").split("\n").includes("*"), "written before the file that failed");
  }
  fs.chmodSync(path.join(dir, "report.md"), 0o644);
  // One already there, or a link in its place, is left as it is.
  fs.writeFileSync(path.join(dir, ".gitignore"), "# theirs\n");
  writeFirstRunReport(REPORT_FILES, { cwd, tmpdir: tmp("sc-first-tmp-") });
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), "# theirs\n");
  if (canLink) {
    const linkCwd = tmp("sc-first-cwd-");
    const linkDir = path.join(linkCwd, FIRST_RUN_DIRNAME);
    fs.mkdirSync(linkDir);
    const away = path.join(tmp("sc-first-elsewhere-"), "never-created");
    fs.symlinkSync(away, path.join(linkDir, ".gitignore"));
    fs.writeFileSync(path.join(linkDir, FIRST_LOOK_MARKER), "");
    writeFirstRunReport(REPORT_FILES, { cwd: linkCwd, tmpdir: tmp("sc-first-tmp-") });
    assert.equal(fs.existsSync(away), false, "the dangling link's target was not created");
  }
});

test("--out is used as given: created only when written, marked, no .gitignore, other files kept, and it must be a folder that can be written", () => {
  const tmpdir = tmp("sc-first-tmp-");
  // New, and nested: created when the report is written, not before.
  const out = path.join(tmp("sc-first-out-"), "looks", "today");
  assert.equal(reportFolderProblem(out, true), null);
  assert.equal(fs.existsSync(path.join(out, "..")), false, "asking creates nothing");
  assert.deepEqual(writeFirstRunReport(REPORT_FILES, { cwd: tmp("sc-first-cwd-"), tmpdir, outDir: out }), { dir: out });
  assert.deepEqual(fs.readdirSync(out).sort(), [FIRST_LOOK_MARKER, "check.json", "report.md"]);
  // A folder holding other files is fine, and they are kept; so is replacing a report an earlier look wrote there.
  const shared = tmp("sc-first-out-");
  fs.writeFileSync(path.join(shared, "notes.txt"), "mine");
  assert.equal(reportFolderProblem(shared, true), null);
  writeFirstRunReport(REPORT_FILES, { cwd: tmp("sc-first-cwd-"), tmpdir, outDir: shared });
  writeFirstRunReport(REPORT_FILES, { cwd: tmp("sc-first-cwd-"), tmpdir, outDir: shared });
  assert.equal(fs.readFileSync(path.join(shared, "notes.txt"), "utf8"), "mine");
  // A file, a path under a file, a link and a folder nobody may write cannot be the folder.
  const blocked = path.join(tmp("sc-first-out-"), "taken");
  fs.writeFileSync(blocked, "a file");
  assert.equal(reportFolderProblem(blocked, true), `--out ${blocked} is a file, not a folder.`);
  assert.equal(reportFolderProblem(path.join(blocked, "inside"), true), `--out ${path.join(blocked, "inside")} cannot be created: ${blocked} is a file.`);
  assert.equal(fs.readFileSync(blocked, "utf8"), "a file");
  if (canLink) {
    const dangling = path.join(tmp("sc-first-out-"), "gone");
    fs.symlinkSync(path.join(tmp("sc-first-out-"), "missing"), dangling);
    assert.equal(reportFolderProblem(dangling, true), `--out ${dangling} is a link or a special file, not a folder.`);
  }
  if (permissionsHold) {
    const locked = tmp("sc-first-out-");
    fs.chmodSync(locked, 0o555);
    assert.equal(reportFolderProblem(path.join(locked, "report"), true), `--out ${path.join(locked, "report")} cannot be written (EACCES).`);
    fs.chmodSync(locked, 0o755);
  }
});

test("an attach downloads a missing browser itself outside CI, tells CI to keep its install step, and never downloads when set off", () => {
  const rows: Array<[NodeJS.ProcessEnv, "download" | "refuse" | "tell"]> = [
    [{}, "download"],
    [{ CI: "false" }, "download"],
    [{ CI: "0" }, "download"],
    [{ CI: "" }, "download"],
    [{ CI: "true" }, "tell"],
    [{ CI: "1" }, "tell"],
    [{ GITHUB_ACTIONS: "true" }, "tell"],
    [{ CI: "true", [BROWSER_DOWNLOAD_ENV]: "on" }, "download"],
    [{ CI: "true", [BROWSER_DOWNLOAD_ENV]: "auto" }, "tell"],
    [{ [BROWSER_DOWNLOAD_ENV]: "off" }, "refuse"],
    [{ [BROWSER_DOWNLOAD_ENV]: " OFF " }, "refuse"],
    [{ CI: "true", [BROWSER_DOWNLOAD_ENV]: "off" }, "refuse"],
    [{ [BROWSER_DOWNLOAD_ENV]: "" }, "download"],
  ];
  for (const [env, want] of rows) assert.equal(browserDownloadDecision(env), want, JSON.stringify(env));
  // A setting it does not know refuses the attach rather than reading as a default that might download.
  assert.throws(() => browserDownloadDecision({ [BROWSER_DOWNLOAD_ENV]: "never" }), /SCENESCOUT_BROWSER_DOWNLOAD="never" is not a setting.*auto, on, off/);
  // The same CI rule the evidence pictures default by (isCiEnv), not a second one.
  assert.equal(browserDownloadDecision({ CI: "false", GITHUB_ACTIONS: "true" }), "tell");
  assert.equal(browserDownloadDecision({ GITHUB_ACTIONS: "false" }), "download");
});

test("the download line says in plain words what is happening and how big it is", () => {
  assert.equal(
    attachDownloadLine("chromium-headless-shell"),
    "Getting the test browser ready — a one-time download of about 200 MB (chromium-headless-shell). The test carries on once it is done.",
  );
  assert.match(attachDownloadLine("firefox"), /about 270 MB \(firefox\)/);
});

test("the browser download runs as Node inside a host's Electron runtime, and is left alone elsewhere", () => {
  const env = { PATH: "/usr/bin" };
  assert.deepEqual(downloadEnv(env, undefined), env);
  assert.deepEqual(downloadEnv(env, "30.0.0"), { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal("ELECTRON_RUN_AS_NODE" in env, false, "the server's own environment is not changed");
});

test("a failed browser download is explained by the installer's cause, not its stack trace", () => {
  const refused = [
    "Downloading WebKit 26.6 (playwright webkit v2359) from http://127.0.0.1:9/builds/webkit.zip",
    "Error: connect ECONNREFUSED 127.0.0.1:9",
    "  errno: -61,",
    "}",
    "Failed to install browsers",
    "Error: Failed to download WebKit 26.6 (playwright webkit v2359), caused by",
    "    at ChildProcess.emit (node:events:508:28)",
  ].join("\n");
  assert.equal(installerFailure(refused), "connect ECONNREFUSED 127.0.0.1:9");
  assert.equal(installerFailure("Failed to install browsers\n    at x (y.js:1)\n"), "Failed to install browsers");
  assert.equal(installerFailure(""), null);
  assert.equal(installerFailure("}\n    at x (y.js:1)\n"), null);
});

test("a valued option takes the next argument or its =value, and refuses a missing value or a following option", async () => {
  const { readFlagValue, flagName } = await import("../src/engine/args.ts");
  assert.equal(flagName("--limit=5"), "limit");
  assert.equal(flagName("--limit"), "limit");
  assert.deepEqual(readFlagValue(["--limit", "5", "x"], 0), { ok: true, name: "limit", value: "5", last: 1 });
  assert.deepEqual(readFlagValue(["--limit=5", "x"], 0), { ok: true, name: "limit", value: "5", last: 0 });
  assert.deepEqual(readFlagValue(["--limit="], 0), { ok: true, name: "limit", value: "", last: 0 });
  assert.deepEqual(readFlagValue(["--limit"], 0), { ok: false, error: "--limit needs a value" });
  assert.deepEqual(readFlagValue(["--limit", "--other"], 0), { ok: false, error: "--limit needs a value" });
  // Only a following `--option` is refused: a value starting with one dash (a negative number, or a lone `-`) is a value,
  // and after `=` everything is the value, even when it starts with `--`.
  assert.deepEqual(readFlagValue(["--limit", "-1"], 0), { ok: true, name: "limit", value: "-1", last: 1 });
  assert.deepEqual(readFlagValue(["--from", "-"], 0), { ok: true, name: "from", value: "-", last: 1 });
  assert.deepEqual(readFlagValue(["--limit=--other"], 0), { ok: true, name: "limit", value: "--other", last: 0 });
});

// The Playwright hold (#487) is a published range, not only this repository's lockfile: a caret
// range lets `npx scenescout` and every global install resolve the release the hold is about.
// The hold is recorded in AGENTS.md's "Pinned dependencies", and this test holds the two equal,
// so lifting it means editing both.
const HELD_PLAYWRIGHT_MINOR = "1.63";

/** Whether a range this package might publish (`~X.Y.Z`, `^X.Y.Z`, `>=X.Y.Z <A.B.C` or `X.Y.Z`) admits `version`. */
function rangeAdmits(range: string, version: string): boolean {
  const parse = (v: string): number[] => {
    const parts = v.split(".").map(Number);
    assert.ok(parts.length === 3 && parts.every(Number.isInteger), `${v} is not a plain X.Y.Z version`);
    return parts;
  };
  const cmp = (a: number[], b: number[]): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const v = parse(version);
  const bounded = /^>=\s*(\S+)\s+<\s*(\S+)$/.exec(range.trim());
  if (bounded) return cmp(v, parse(bounded[1])) >= 0 && cmp(v, parse(bounded[2])) < 0;
  const op = /^[~^]/.exec(range)?.[0] ?? "";
  const lo = parse(range.slice(op.length));
  if (op === "") return cmp(v, lo) === 0;
  const hi = op === "~" ? [lo[0], lo[1] + 1, 0] : lo[0] > 0 ? [lo[0] + 1, 0, 0] : lo[1] > 0 ? [0, lo[1] + 1, 0] : [0, 0, lo[2] + 1];
  return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
}

test("rangeAdmits reads the range shapes package.json may publish", () => {
  assert.equal(rangeAdmits("^1.63.0", "1.64.1"), true, "a caret range admits the next minor");
  assert.equal(rangeAdmits("~1.63.0", "1.63.9"), true);
  assert.equal(rangeAdmits("~1.63.0", "1.64.0"), false, "a tilde range stops at the next minor");
  assert.equal(rangeAdmits(">=1.63.0 <1.64.0", "1.63.2"), true);
  assert.equal(rangeAdmits(">=1.63.0 <1.64.0", "1.64.0"), false);
  assert.equal(rangeAdmits("1.63.0", "1.63.1"), false);
  assert.equal(rangeAdmits("~1.63.1", "1.63.0"), false);
  assert.equal(rangeAdmits("^0.2.1", "0.3.0"), false);
  assert.equal(rangeAdmits("^0.0.3", "0.0.4"), false);
});

test("while AGENTS.md records the Playwright hold, the published range admits no 1.64", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };
  const range = pkg.dependencies.playwright;
  assert.ok(range, "playwright is a runtime dependency");
  assert.equal(lock.packages[""]?.dependencies?.playwright, range, "the lockfile records the range package.json publishes");
  const locked = lock.packages["node_modules/playwright"]?.version;
  assert.ok(locked && rangeAdmits(range, locked), `the locked playwright ${locked} is inside ${range}`);

  const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
  const hold = agents.split("\n").find((line) => line.startsWith(`- **playwright stays on ${HELD_PLAYWRIGHT_MINOR}.**`));
  const next = `${HELD_PLAYWRIGHT_MINOR.split(".")[0]}.${Number(HELD_PLAYWRIGHT_MINOR.split(".")[1]) + 1}.0`;
  if (hold) {
    assert.equal(
      rangeAdmits(range, next),
      false,
      `AGENTS.md holds Playwright on ${HELD_PLAYWRIGHT_MINOR}, so the published range ${range} must not admit ${next}`,
    );
    assert.ok(hold.includes(`\`${range}\``), `AGENTS.md's hold names the published range ${range}`);
  } else {
    // Lifted: the range moved past the held minor, whether it still admits it (^1.63.0) or starts later (~1.65.0).
    const floor = /(\d+)\.(\d+)\.\d+/.exec(range);
    const startsLater =
      floor !== null && (Number(floor[1]) > Number(next.split(".")[0]) || (floor[1] === next.split(".")[0] && Number(floor[2]) >= Number(next.split(".")[1])));
    assert.ok(rangeAdmits(range, next) || startsLater, `AGENTS.md no longer records the Playwright hold, so widen the range ${range} (or restore the line)`);
  }
});

test("while AGENTS.md records the Playwright hold, Dependabot ignores the whole next minor and nothing after it", () => {
  const cfg = parseYaml(fs.readFileSync(path.join(repoRoot, ".github", "dependabot.yml"), "utf8")) as {
    updates: Array<{ "package-ecosystem": string; ignore?: Array<{ "dependency-name": string; versions?: string[] }> }>;
  };
  const ignored = (cfg.updates.find((u) => u["package-ecosystem"] === "npm")?.ignore ?? [])
    .filter((i) => i["dependency-name"] === "playwright")
    .flatMap((i) => i.versions ?? []);
  const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
  const held = agents.split("\n").some((line) => line.startsWith(`- **playwright stays on ${HELD_PLAYWRIGHT_MINOR}.**`));
  if (!held) {
    assert.deepEqual(ignored, [], "AGENTS.md no longer records the Playwright hold, so drop its Dependabot ignore too");
    return;
  }
  const [major, minor] = HELD_PLAYWRIGHT_MINOR.split(".").map(Number);
  const isIgnored = (v: string) => ignored.some((r) => rangeAdmits(r, v));
  for (const v of [`${major}.${minor + 1}.0`, `${major}.${minor + 1}.1`, `${major}.${minor + 1}.99`]) {
    assert.ok(isIgnored(v), `AGENTS.md says Dependabot ignores ${major}.${minor + 1}.x, but it would propose ${v}`);
  }
  assert.equal(isIgnored(`${major}.${minor + 2}.0`), false, `the release expected to fix #487 (${major}.${minor + 2}.0) must still be proposed`);
});

/** engines.node read as a lower bound `>=x[.y[.z]]`, or null when it is written another way. */
function nodeFloor(range: string): string | null {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  return m ? `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}` : null;
}

test("engines start on an LTS line, and every place that states the floor agrees", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    engines: { node: string };
    devDependencies: Record<string, string>;
  };
  const floor = nodeFloor(pkg.engines.node);
  assert.ok(floor, `engines.node is read as a lower bound, not ${pkg.engines.node}`);
  const floorMajor = Number(floor.split(".")[0]);
  // Whether the line is still maintained depends on the date, so node-lts.yml checks that weekly (ADR 34).
  assert.ok(floorMajor in NODE_LTS_END_OF_LIFE, `engines start on Node ${floorMajor}, which is not an LTS line`);
  assert.equal(NODE_FLOOR, floor, "the doctor checks the engines floor");
  assert.equal(Math.min(...FULL_PLATFORMS.map((p) => p.node)), floorMajor, `CI's oldest cell runs the engines floor's line, Node ${floorMajor}`);
  for (const p of FULL_PLATFORMS) assert.ok(p.node in NODE_LTS_END_OF_LIFE, `CI's ${p.os} cell runs Node ${p.node}, which is not an LTS line`);
  assert.match(pkg.devDependencies["@types/node"], new RegExp(`^\\^${floorMajor}\\.`), "the types describe the oldest supported Node");
});

test("the weekly LTS check: a floor or a cell on a line past its end of life fails from that day, not the day before", () => {
  const cells = [22, 24, 24, 24];
  assert.deepEqual(ltsProblems({ floorMajor: 22, cellMajors: cells, today: "2027-04-29" }), []);
  const ended = ltsProblems({ floorMajor: 22, cellMajors: cells, today: "2027-04-30" });
  assert.equal(ended.length, 2, ended.join("\n"));
  assert.match(ended[0], /engines start on Node 22; the oldest LTS line maintained on 2027-04-30 is 24/);
  assert.match(ended[1], /cell on Node 22, which is not a maintained LTS line/);
  assert.deepEqual(ltsProblems({ floorMajor: 24, cellMajors: [24, 26], today: "2027-04-30" }), []);
  // A floor above the oldest maintained line drops a line users still run.
  assert.match(ltsProblems({ floorMajor: 24, cellMajors: [24], today: "2026-10-30" }).join(), /oldest LTS line maintained on 2026-10-30 is 22/);
  assert.match(ltsProblems({ floorMajor: 30, cellMajors: [], today: "2031-01-01" }).join(), /no Node LTS line in the table is maintained/);
  assert.deepEqual(maintainedLtsLines("2026-10-30"), [22, 24, 26]);

  const wf = parseYaml(fs.readFileSync(path.join(repoRoot, ".github", "workflows", "node-lts.yml"), "utf8")) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, { steps: Array<{ run?: string }> }>;
  };
  assert.ok("schedule" in wf.on && "workflow_dispatch" in wf.on, "runs weekly and by hand");
  assert.ok(!("pull_request" in wf.on) && !("push" in wf.on), "a calendar date never fails a pull request");
  assert.deepEqual(wf.permissions, { contents: "read" });
  assert.ok(
    Object.values(wf.jobs).some((j) => j.steps.some((s) => s.run?.includes("scripts/node-lts.ts"))),
    "a step runs the check",
  );
});

test("engines admit no Node that a runtime dependency refuses", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { engines: { node: string } };
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8")) as {
    packages: Record<string, { dev?: boolean; engines?: Record<string, string> | string[] }>;
  };
  const ours = nodeFloor(pkg.engines.node)!;
  const refused: string[] = [];
  for (const [where, entry] of Object.entries(lock.packages)) {
    if (!where || entry.dev || Array.isArray(entry.engines) || !entry.engines?.node) continue;
    const theirs = nodeFloor(entry.engines.node);
    assert.ok(theirs, `${where} declares node ${entry.engines.node}, a range this test does not read yet`);
    if (!atLeastVersion(ours, theirs)) refused.push(`${where} needs ${entry.engines.node}`);
  }
  assert.deepEqual(refused, [], `engines (${pkg.engines.node}) admit Node versions these dependencies refuse`);
});

test("Dependabot waits out a cooldown on both ecosystems: a week, and a month for an npm major", () => {
  const cfg = parseYaml(fs.readFileSync(path.join(repoRoot, ".github", "dependabot.yml"), "utf8")) as {
    updates: Array<{
      "package-ecosystem": string;
      cooldown?: Record<string, number>;
      ignore?: Array<{ "dependency-name": string; "update-types"?: string[] }>;
    }>;
  };
  for (const ecosystem of ["npm", "github-actions"]) {
    const cooldown = cfg.updates.find((u) => u["package-ecosystem"] === ecosystem)?.cooldown;
    assert.ok((cooldown?.["default-days"] ?? 0) >= 7, `${ecosystem} waits at least 7 days for a release`);
  }
  const npm = cfg.updates.find((u) => u["package-ecosystem"] === "npm")!;
  assert.ok((npm.cooldown?.["semver-major-days"] ?? 0) >= 30, "an npm major waits at least 30 days");
  assert.ok(
    npm.ignore?.some((i) => i["dependency-name"] === "@types/node" && i["update-types"]?.includes("version-update:semver-major")),
    "@types/node moves its major with the engines floor, not with Dependabot",
  );
});

test("each action looks for the engines floor before it installs Node, comparing by minor", () => {
  const floor = NODE_FLOOR;
  const short = floor.replace(/\.0$/, "");
  for (const file of ["action.yml", "ci/action.yml", "qa/action.yml"]) {
    const action = parseYaml(fs.readFileSync(path.join(repoRoot, file), "utf8")) as { runs: { steps: ReleaseStep[] } };
    const step = action.runs.steps.find((s) => s.id === "node");
    assert.ok(step?.run, `${file} has a step that looks for Node`);
    assert.equal(step.name, `Look for Node.js ${short} or newer`, file);
    const script = /node -e '([^']+)'/.exec(step.run)?.[1] ?? "";
    assert.ok(script.includes(`"${floor}"`), `${file} compares against the engines floor ${floor}`);
    const passes = (wanted: string) => spawnSync(process.execPath, ["-e", script.replace(`"${floor}"`, `"${wanted}"`)]).status === 0;
    // This suite runs on a supported Node, so the floor itself passes; one minor or one major later does not.
    const [ownMajor, ownMinor] = process.versions.node.split(".").map(Number);
    assert.equal(passes(floor), true, `${file}: Node ${process.versions.node} meets ${floor}`);
    assert.equal(passes(`${ownMajor}.${ownMinor}.0`), true, `${file}: an equal minor passes`);
    assert.equal(passes(`${ownMajor}.${ownMinor + 1}.0`), false, `${file}: a later minor of the same line fails`);
    assert.equal(passes(`${ownMajor + 1}.0.0`), false, `${file}: a later line fails`);
  }
});

type ReleaseStep = {
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean>;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  name?: string;
};
type ReleaseJob = { needs?: string | string[]; if?: string; permissions?: Record<string, string>; outputs?: Record<string, string>; steps: ReleaseStep[] };
function releaseWorkflow(): { on: Record<string, any>; jobs: Record<string, ReleaseJob> } {
  return parseYaml(fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8"));
}
const needsOf = (job: ReleaseJob): string[] => (job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]);
/** A `run:` that executes this repository's code or its installed dependencies. */
const RUNS_REPO_CODE = /\b(node|npx|tsx|bash|sh)\b|\bnpm (run|ci|exec|test|start|pack|rebuild|x)\b|\.\/(?!package\/scenescout-)|scripts\//;

test("release: the job that can mint the npm token checks nothing out, installs nothing and runs no repository code", () => {
  const wf = releaseWorkflow();
  const holders = Object.entries(wf.jobs)
    .filter(([, j]) => j.permissions?.["id-token"] === "write")
    .map(([name]) => name)
    .sort();
  // The attestation job holds it too, to sign the bundle; it only downloads the file and runs one GitHub action.
  assert.deepEqual(holders, ["attest-desktop-extension", "publish"], "only the publish and attestation jobs can mint a token");
  for (const name of holders) {
    const job = wf.jobs[name];
    assert.ok(!job.steps.some((s) => s.uses?.startsWith("actions/checkout")), `${name}: no checkout`);
    for (const s of job.steps.filter((s) => s.run)) {
      const code = s
        .run!.split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .join("\n")
        .replace(/npm install -g npm@\d+\.\d+\.\d+ --ignore-scripts/g, "")
        .replace(/\bnpm publish "\$tarball"/g, "");
      assert.doesNotMatch(code, RUNS_REPO_CODE, `${name} runs repository code:\n${s.run}`);
      assert.ok(!s.run!.includes("${{"), `${name}: an expression is substituted into a script:\n${s.run}`);
    }
  }
  // The rule's own contrast: the build job that packs the tarball does run repository code, and is caught.
  assert.match(wf.jobs.build.steps.map((s) => s.run ?? "").join("\n"), RUNS_REPO_CODE);

  const publish = wf.jobs.publish;
  assert.deepEqual(publish.permissions, { contents: "read", "id-token": "write" });
  assert.deepEqual(
    publish.steps.map((s) => s.uses?.split("@")[0] ?? "run"),
    ["actions/setup-node", "run", "actions/download-artifact", "run"],
    "set up Node, pin npm, download the tarball, publish it",
  );
  assert.equal(publish.steps[0].with?.["registry-url"], undefined, "an .npmrc expecting NODE_AUTH_TOKEN would stop trusted publishing");
  assert.equal(publish.steps[0].with?.cache, undefined, "a cache reads a lockfile from a checkout this job does not have");
  assert.equal(publish.steps[2].with?.name, "npm-package");
  const script = publish.steps[3].run!;
  assert.match(script, /tarball="\.\/package\/scenescout-\$VERSION\.tgz"/, 'a leading ./, or npm reads "package/x.tgz" as a GitHub repository');
  const publishes = script.split("\n").filter((l) => /\bnpm publish\b/.test(l));
  assert.equal(publishes.length, 2, "the real publish and the rehearsal");
  for (const line of publishes) {
    assert.match(line, /npm publish "\$tarball" --provenance --access public --tag "\$DIST_TAG" --ignore-scripts/, line);
    // --force only skips npm's refusal to publish over a version it has; it never goes on a publish that sends.
    if (/--force\b/.test(line)) assert.match(line, /--dry-run\b/, line);
  }
  assert.equal(publish.steps[3].env?.DIST_TAG, "${{ needs.build.outputs.dist-tag }}");
  assert.equal(publish.steps[3].env?.DRY_RUN, "${{ needs.build.outputs.dry-run }}");
});

test("release: npm's answer decides the publish, the tarball is packed once, and the tag and release follow the publish", () => {
  const wf = releaseWorkflow();
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.release, undefined, "no script publishes from a folder any more");

  // The version job only versions: the action publishes nothing and creates no release.
  const version = wf.jobs.version;
  assert.deepEqual(version.permissions, { contents: "write", "pull-requests": "write" });
  const changesets = version.steps.find((s) => s.id === "changesets");
  assert.match(changesets?.uses ?? "", /^changesets\/action@[0-9a-f]{40}$/);
  assert.equal(changesets?.with?.["publish-script"], undefined, "the action never publishes");
  assert.equal(String(changesets?.with?.["create-github-releases"]), "false", "the release job creates the GitHub Release");

  // Build: decided by npm, not by a git tag; packed into a folder made first.
  const build = wf.jobs.build;
  assert.deepEqual(build.permissions, { contents: "read" });
  assert.match(build.if ?? "", /needs\.version\.outputs\.has-changesets == 'false'/, "only once the version pull request has been merged");
  assert.match(build.if ?? "", /needs\.gate\.outputs\.dry-run == 'true'/, "or for a rehearsal");
  const plan = build.steps.find((s) => s.id === "plan");
  assert.equal(plan?.run, "node scripts/release-plan.mjs");
  assert.equal(plan?.env?.NPM_PUBLISH, "${{ vars.NPM_PUBLISH }}");
  for (const name of ["gate", "version", "build"])
    for (const s of wf.jobs[name].steps)
      assert.doesNotMatch(s.run ?? "", /\bgit (tag|rev-parse|ls-remote)\b|refs\/tags/, `${name} decides nothing by a git tag`);
  const pack = build.steps.find((s) => /\bnpm pack\b/.test(s.run ?? ""));
  assert.ok(pack?.run, "the build packs the tarball");
  const lines = pack.run.split("\n");
  const mkdir = lines.findIndex((l) => /^mkdir -p package$/.test(l.trim()));
  const packLine = lines.findIndex((l) => /^npm pack --ignore-scripts --pack-destination package$/.test(l.trim()));
  assert.ok(mkdir >= 0 && packLine > mkdir, "npm pack does not create its destination, so the folder is made first");
  const upload = build.steps.find((s) => /^actions\/upload-artifact@/.test(s.uses ?? ""));
  assert.equal(upload?.with?.name, "npm-package");
  assert.equal(upload?.with?.path, "package/scenescout-${{ steps.plan.outputs.version }}.tgz");
  const packs = Object.entries(wf.jobs).filter(([, j]) => j.steps.some((s) => /\bnpm pack\b/.test(s.run ?? "")));
  assert.deepEqual(
    packs.map(([n]) => n),
    ["build"],
    "packed once",
  );

  // Publishing, tagging and releasing each happen in one job, and nothing uses the old commands.
  const holding = (re: RegExp) =>
    Object.entries(wf.jobs)
      .filter(([, j]) => j.steps.some((s) => re.test(s.run ?? "")))
      .map(([n]) => n);
  assert.deepEqual(holding(/\bnpm publish\b/), ["publish"]);
  assert.deepEqual(holding(/\bchangeset git-tag\b/), ["release"]);
  assert.deepEqual(holding(/\bgh release create\b/), ["release"]);
  assert.deepEqual(holding(/\bgit push\b/), ["release"]);
  assert.deepEqual(
    holding(/\bchangeset (publish|tag)\b|npm run release\b/),
    [],
    "changeset tag is deprecated, and changeset publish publishes from a job with a checkout",
  );

  // Everything that names the version comes after npm has it: each such job needs publish, directly or not.
  const reaches = (from: string, target: string): boolean => needsOf(wf.jobs[from]).some((n) => n === target || reaches(n, target));
  for (const name of ["release", "publish-guide", "desktop-extension", "attach-desktop-extension", "attest-desktop-extension"])
    assert.ok(reaches(name, "publish"), `${name} runs only after the publish`);
  const release = wf.jobs.release;
  assert.deepEqual(release.permissions, { contents: "write" });
  assert.match(release.if ?? "", /needs\.publish\.result == 'success'/);
  const tag = release.steps.find((s) => s.id === "tag")!;
  assert.match(tag.run!, /npx --no changeset git-tag/);
  const gh = release.steps.find((s) => /\bgh release create\b/.test(s.run ?? ""))!;
  assert.equal(gh.if, "steps.tag.outputs.tag != ''", "no release in a rehearsal");
  assert.match(gh.run!, /gh release create "\$TAG" --verify-tag --title "\$TAG" --notes-file notes\.md "\$\{prerelease\[@\]\}"/);
  assert.equal(release.steps.find((s) => s.name === "Point the major tag at this release")?.if, "steps.tag.outputs.tag != ''");
  for (const name of ["publish-guide", "attach-desktop-extension", "attest-desktop-extension"])
    assert.match(wf.jobs[name].if ?? "", /needs\.release\.outputs\.tag != ''/, `${name} writes nothing in a rehearsal`);
  assert.equal(wf.jobs["desktop-extension"].steps[0].with?.ref, "${{ needs.release.outputs.ref }}", "the tag, or in a rehearsal the commit");

  // A rehearsal is asked for by hand, and is the default when asked.
  const input = wf.on.workflow_dispatch?.inputs?.["dry-run"];
  assert.equal(input?.type, "boolean");
  assert.equal(input?.default, true);
  assert.match(
    String((wf as { concurrency?: { group?: string } }).concurrency?.group),
    /inputs\.dry-run && 'release-rehearsal' \|\| 'release'/,
    "a rehearsal never displaces a release run",
  );
  assert.match(wf.jobs.gate.if ?? "", /github\.ref == 'refs\/heads\/main'/, "and only on main: trusted publishing names the workflow file, not the branch");
  assert.match(version.if ?? "", /needs\.gate\.outputs\.dry-run != 'true'/, "a rehearsal opens no version pull request");

  // The actions this repository allows: GitHub's own and changesets/action.
  for (const job of Object.values(wf.jobs))
    for (const s of job.steps.filter((s) => s.uses)) assert.match(s.uses!, /^(actions\/[\w-]+|changesets\/action)@[0-9a-f]{40}$/, s.uses);

  // The bundle ships with a checksum and an attestation.
  const attach = wf.jobs["attach-desktop-extension"];
  assert.ok(
    attach.steps.some((s) => /sha256sum \*\.mcpb > SHA256SUMS/.test(s.run ?? "")),
    "a checksum file for the bundle",
  );
  assert.ok(
    attach.steps.some((s) => /gh release upload "\$TAG" \*\.mcpb SHA256SUMS\b/.test(s.run ?? "")),
    "uploaded beside it",
  );
  const attest = wf.jobs["attest-desktop-extension"];
  assert.deepEqual(attest.permissions, { contents: "read", "id-token": "write", attestations: "write" });
  const step = attest.steps.find((s) => /^actions\/attest-build-provenance@[0-9a-f]{40}$/.test(s.uses ?? ""));
  assert.ok(step, "the bundle is attested by an action pinned by commit");
  assert.equal(step.with?.["subject-path"], "*.mcpb");
  assert.ok(!attest.steps.some((s) => s.uses?.startsWith("actions/checkout") || s.run), "and runs no repository code");
});

/** Runs one release.yml step's script under bash with `git`, `npx` and `npm` replaced by functions that log their arguments. */
function runReleaseStep(
  job: string,
  pick: (s: ReleaseStep) => boolean,
  env: Record<string, string>,
  opts: { npmPrints?: string; tarball?: string; publishFails?: boolean; viewPrints?: string } = {},
) {
  const dir = tmp("sc-release-step-");
  if (opts.tarball) {
    fs.mkdirSync(path.join(dir, "package"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package", opts.tarball), "");
  }
  const script = releaseWorkflow().jobs[job].steps.find(pick)!.run!;
  const log = path.join(dir, "calls.log");
  const out = path.join(dir, "output");
  fs.writeFileSync(out, "");
  const stubs = [
    `git() { echo "git $*" >> "$CALLS"; case "$1" in rev-parse) [ "$2" = "--verify" ] || echo "\${TAGGED_SHA:-$GITHUB_SHA}";; esac; return 0; }`,
    `npx() { echo "npx $*" >> "$CALLS"; }`,
    `npm() { echo "npm $*" >> "$CALLS"; case "$1" in view) printf '%s\\n' "$NPM_VIEW_PRINTS";; publish) printf '%s\\n' "$NPM_PRINTS"; [ -z "$NPM_PUBLISH_FAILS" ];; *) printf '%s\\n' "$NPM_PRINTS";; esac; }`,
  ].join("\n");
  const r = execFileSyncSafe("bash", ["-eo", "pipefail", "-c", `${stubs}\n${script}`], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      CALLS: log,
      GITHUB_OUTPUT: out,
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      NPM_PRINTS: opts.npmPrints ?? "",
      NPM_PUBLISH_FAILS: opts.publishFails ? "1" : "",
      NPM_VIEW_PRINTS: opts.viewPrints ?? "",
      ...env,
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  return { status: r.status, calls, output: fs.readFileSync(out, "utf8") };
}
function execFileSyncSafe(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }): { status: number } {
  try {
    execFileSync(cmd, args, { ...opts, stdio: "pipe" });
    return { status: 0 };
  } catch (err) {
    return { status: (err as { status?: number }).status ?? -1 };
  }
}

test("release: a rehearsal tags in the runner and pushes nothing; a real run pushes the tag and hands it on", () => {
  const isTag = (s: ReleaseStep) => s.id === "tag";
  const real = runReleaseStep("release", isTag, { VERSION: "1.2.3", DRY_RUN: "false" });
  assert.equal(real.status, 0);
  assert.match(real.calls, /^npx --no changeset git-tag$/m);
  assert.match(real.calls, /^git push origin refs\/tags\/v1\.2\.3$/m);
  assert.match(real.output, /^tag=v1\.2\.3$/m);
  assert.match(real.output, /^ref=v1\.2\.3$/m);
  const rehearsal = runReleaseStep("release", isTag, { VERSION: "1.2.3", DRY_RUN: "true" });
  assert.equal(rehearsal.status, 0);
  assert.match(rehearsal.calls, /^npx --no changeset git-tag$/m, "the rehearsal runs changeset git-tag too");
  assert.doesNotMatch(rehearsal.calls, /git push/);
  assert.doesNotMatch(rehearsal.output, /^tag=/m, "so no later job tags, releases, attaches or attests");
  assert.match(rehearsal.output, /^ref=0123456789abcdef0123456789abcdef01234567$/m, "the bundle is built from the commit");
  // A tag that already names another commit: npm has this commit's version, so the run stops rather than push or release.
  const elsewhere = runReleaseStep("release", isTag, { VERSION: "1.2.3", DRY_RUN: "false", TAGGED_SHA: "fedcba9876543210fedcba9876543210fedcba98" });
  assert.equal(elsewhere.status, 1);
  assert.doesNotMatch(elsewhere.calls, /git push/);
  assert.equal(elsewhere.output, "");
});

test("release: the publish step sends the tarball under its dist-tag, and a rehearsal fails when npm took no OIDC token", () => {
  const isPublish = (s: ReleaseStep) => s.name === "Publish to npm";
  const run = (env: Record<string, string>, npmPrints = "", tarball: string | null = "scenescout-1.2.3.tgz") =>
    runReleaseStep("publish", isPublish, env, { npmPrints, tarball: tarball ?? undefined });
  // No tarball downloaded: refused before npm runs.
  const missing = run({ VERSION: "1.2.3", DIST_TAG: "latest", DRY_RUN: "false" }, "", null);
  assert.notEqual(missing.status, 0);
  assert.equal(missing.calls, "");
  const real = run({ VERSION: "1.2.3", DIST_TAG: "next", DRY_RUN: "false" });
  assert.equal(real.status, 0);
  assert.equal(real.calls.trim(), "npm publish ./package/scenescout-1.2.3.tgz --provenance --access public --tag next --ignore-scripts");
  const rehearsal = run({ VERSION: "1.2.3", DIST_TAG: "latest", DRY_RUN: "true" }, "+ scenescout@1.2.3");
  assert.equal(rehearsal.status, 0);
  assert.equal(
    rehearsal.calls.trim(),
    "npm publish ./package/scenescout-1.2.3.tgz --provenance --access public --tag latest --ignore-scripts --dry-run --force",
  );
  // npm's own words when it holds no token: a dry run only warns, so the step turns the warning into a failure.
  const noToken = run(
    { VERSION: "1.2.3", DIST_TAG: "latest", DRY_RUN: "true" },
    "npm warn This command requires you to be logged in to https://registry.npmjs.org/ (dry-run)",
  );
  assert.equal(noToken.status, 1);
});

test("release: a publish npm took but whose answer was lost succeeds on a re-run, so re-running the failed jobs finishes the release", () => {
  // npm can store a version and still fail the request; a re-run is then refused as a publish over
  // that version. The step treats npm holding this very tarball (same sha512 integrity) as published,
  // and anything else as the failure it is.
  const isPublish = (s: ReleaseStep) => s.name === "Publish to npm";
  const env = { VERSION: "1.2.3", DIST_TAG: "latest", DRY_RUN: "false" };
  const tarball = "scenescout-1.2.3.tgz";
  const ours = `sha512-${crypto.createHash("sha512").update(Buffer.alloc(0)).digest("base64")}`;
  const same = runReleaseStep("publish", isPublish, env, { tarball, publishFails: true, viewPrints: ours });
  assert.equal(same.status, 0, "npm has this tarball as 1.2.3: it was published");
  assert.match(same.calls, /^npm view scenescout@1\.2\.3 dist\.integrity --prefer-online$/m);
  const other = runReleaseStep("publish", isPublish, env, { tarball, publishFails: true, viewPrints: "sha512-c29tZXRoaW5nIGVsc2U=" });
  assert.equal(other.status, 1, "npm has a different 1.2.3: the failure stands");
  const none = runReleaseStep("publish", isPublish, env, { tarball, publishFails: true, viewPrints: "" });
  assert.equal(none.status, 1, "npm has no 1.2.3: the failure stands");
  const ok = runReleaseStep("publish", isPublish, env, { tarball, viewPrints: "sha512-unused" });
  assert.equal(ok.status, 0);
  assert.doesNotMatch(ok.calls, /npm view/, "a publish that succeeded asks nothing more");
});

test("release plan: publish exactly when npm lacks the version, under the tag changeset publish would use", () => {
  const base = { version: "1.2.3", published: ["1.2.2"], preState: null, dryRun: false, publishEnabled: true };
  // Each pair differs in one fact.
  assert.equal(releasePlan(base).publish, true, "npm lacks 1.2.3");
  assert.equal(releasePlan({ ...base, published: ["1.2.2", "1.2.3"] }).publish, false, "npm has 1.2.3");
  assert.equal(releasePlan({ ...base, publishEnabled: false }).publish, false, "NPM_PUBLISH is off");
  assert.equal(releasePlan({ ...base, published: ["1.2.3"], dryRun: true }).publish, true, "a rehearsal always reaches npm publish --dry-run");
  assert.equal(releasePlan({ ...base, publishEnabled: false, dryRun: true }).publish, true, "even with NPM_PUBLISH off, since it sends nothing");
  assert.equal(releasePlan(base).distTag, "latest");
  assert.equal(releasePlan({ ...base, version: "2.0.0-next.0", preState: { tag: "next" } }).distTag, "next", "pre mode publishes to its tag");
  assert.equal(distTagFor(null), "latest");
  for (const bad of [undefined, "", "1.2.3", "^1", "a b"]) assert.throws(() => distTagFor({ tag: bad }), /names no usable tag/, String(bad));
  for (const bad of ["1.2", "v1.2.3", "", "1.2.3 "]) assert.throws(() => releasePlan({ ...base, version: bad }), /not a release version/, bad);

  assert.deepEqual(parseVersions('["1.0.0","1.0.1"]', false), ["1.0.0", "1.0.1"]);
  assert.deepEqual(parseVersions('"1.0.0"', false), ["1.0.0"], "npm prints a lone version as a string");
  assert.deepEqual(parseVersions('{"error":{"code":"E404","summary":"Not Found"}}', true), [], "a package npm has never seen");
  assert.throws(() => parseVersions('{"error":{"code":"ETIMEDOUT","summary":"timed out"}}', true), /ETIMEDOUT/, "anything else stops the run");
  assert.throws(() => parseVersions("npm error", true), /no JSON/);
  assert.throws(() => parseVersions("[1]", false), /unexpected/);
});

test("build: dist is emptied before tsc, so a file deleted from src is not packed", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(
    pkg.scripts.build,
    /rmSync\(['"]dist['"], *\{[^}]*recursive: *true[^}]*\}\).*&& node node_modules\/typescript\/bin\/tsc && node scripts\/bin-executable\.mjs$/,
    "clear dist, then compile",
  );
});

test("build: the compiler is typescript's own tsc by path, since the typescript-api alias declares a tsc bin too", () => {
  // node_modules/.bin/tsc points at one of the two, and an install that updates only the alias repoints it to 5.x.
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const manifest = (dir: string) =>
    JSON.parse(fs.readFileSync(path.join(repoRoot, "node_modules", dir, "package.json"), "utf8")) as { version: string; bin?: Record<string, string> };
  assert.ok(manifest("typescript-api").bin?.tsc, "the alias still declares tsc; if it stops, the scripts may call tsc again");
  const major = (range: string) => /\d+/.exec(range.replace(/^npm:typescript@/, ""))?.[0];
  assert.equal(manifest("typescript").version.split(".")[0], major(pkg.devDependencies.typescript), "node_modules/typescript is the declared compiler");
  assert.equal(manifest("typescript-api").version.split(".")[0], major(pkg.devDependencies["typescript-api"]), "the alias is the declared API");
  for (const [name, script] of Object.entries(pkg.scripts)) {
    for (const word of script.split(/\s+/)) {
      assert.notEqual(word, "tsc", `${name} runs the bare tsc, which may be the alias's`);
      assert.notEqual(word, "tsserver", `${name} runs the bare tsserver, which is the alias's`);
    }
  }
  for (const name of ["build", "typecheck:scripts"]) assert.ok(pkg.scripts[name].includes("node node_modules/typescript/bin/tsc"), name);
});

test("ci action: the model key is blanked for every step except the one that runs the exploration", () => {
  type Step = { id?: string; name?: string; env?: Record<string, string> };
  const action = parseYaml(fs.readFileSync(path.join(repoRoot, "ci", "action.yml"), "utf8")) as { runs: { steps: Step[] } };
  const names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  const withKey = action.runs.steps.filter((s) => names.some((n) => s.env && n in s.env && s.env[n] !== ""));
  assert.deepEqual(
    withKey.map((s) => s.id),
    [],
    "no step sets the key to a value; the run step receives the caller's own",
  );
  for (const step of action.runs.steps) {
    const blank = names.every((n) => step.env?.[n] === "");
    if (step.id === "run") assert.ok(!names.some((n) => step.env && n in step.env), "the run step keeps the key the caller set");
    else assert.ok(blank, `${step.name ?? step.id} sees no model key`);
  }
});

test("example workflows: Dependabot reads their folder, and their third-party pins match the ones this repository's workflows use", () => {
  const cfg = parseYaml(fs.readFileSync(path.join(repoRoot, ".github", "dependabot.yml"), "utf8")) as {
    updates: Array<{ "package-ecosystem": string; directories?: string[] }>;
  };
  const dirs = cfg.updates.find((u) => u["package-ecosystem"] === "github-actions")?.directories ?? [];
  assert.ok(dirs.includes("/examples/workflows"), "a copied example would otherwise keep a pin nothing updates");
  const pins = (text: string) =>
    new Map([...text.matchAll(/^\s*(?:-\s+)?uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40})\s+#\s*(v\S+)/gm)].map((m) => [m[1], `${m[2]} ${m[3]}`]));
  const own = new Map<string, string>();
  const wfDir = path.join(repoRoot, ".github", "workflows");
  for (const f of fs.readdirSync(wfDir)) for (const [k, v] of pins(fs.readFileSync(path.join(wfDir, f), "utf8"))) own.set(k, v);
  const exDir = path.join(repoRoot, "examples", "workflows");
  let checked = 0;
  for (const f of fs.readdirSync(exDir)) {
    for (const [action, pin] of pins(fs.readFileSync(path.join(exDir, f), "utf8"))) {
      if (!own.has(action)) continue;
      checked++;
      assert.equal(pin, own.get(action), `${f}: ${action} is pinned to a release this repository's workflows have moved past`);
    }
  }
  assert.ok(checked >= 2, `the scan found the shared pins: ${checked}`);
});

test("the build leaves every bin target executable, so a linked scenescout still runs after a rebuild", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const targets = Object.values(pkg.bin ?? {}) as string[];
  assert.ok(targets.length > 0, "package.json declares a bin");
  assert.match(pkg.scripts.build, /&& node scripts\/bin-executable\.mjs$/, "build marks the bin targets executable after tsc");

  // Run the step on a copy of the targets made 0644, as tsc writes them.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-bin-"));
  fs.mkdirSync(path.join(tmp, "scripts"));
  fs.copyFileSync(path.join(repoRoot, "scripts", "bin-executable.mjs"), path.join(tmp, "scripts", "bin-executable.mjs"));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ bin: pkg.bin }));
  for (const target of targets) {
    fs.mkdirSync(path.dirname(path.join(tmp, target)), { recursive: true });
    fs.writeFileSync(path.join(tmp, target), "#!/usr/bin/env node\n", { mode: 0o644 });
  }
  execFileSync(process.execPath, [path.join(tmp, "scripts", "bin-executable.mjs")]);
  if (process.platform !== "win32") {
    for (const target of targets) {
      assert.equal(fs.statSync(path.join(tmp, target)).mode & 0o111, 0o111, `${target} is executable`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
