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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  NPX_SERVE_ARGS,
  parseRegistration,
  planCommand,
  registerMcp,
  repairCommands,
  resolveClaudeDir,
  type DesktopExtension,
  type Runner,
  type RunResult,
} from "../src/installer.ts";
import { atLeastVersion, downloadEnv, installerFailure } from "../src/installer.ts";
import { parse as parseYaml } from "yaml";
import {
  attachDownloadLine,
  BROWSER_DOWNLOAD_ENV,
  browserDownloadDecision,
  browserPresence,
  defaultAttachNote,
  defaultEngine,
  beaconResourceType,
  echoesFailedLoads,
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
  frameUnloadWritesMayGoUnissued,
  closeWaitsForLeavingWrites,
} from "../src/browsers.ts";

import { INTAKE_QUESTIONS, introQuestions } from "../src/intake.ts";
import { explorePrompt, loadPlaybook, PLAYBOOK_RELATIVE_PATH, SERVER_INSTRUCTIONS, stripFrontMatter } from "../src/playbook.ts";
import { livePrompt, loginPrompt, LOGIN_PROMPT_ARGUMENTS, LIVE_PROMPT_ARGUMENTS } from "../src/prompts.ts";

import { dispatch, HAND_PARSED, looksLikeUrl, SUBCOMMANDS, type CliHandlers, type Subcommand } from "../src/commands.ts";
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
import { MAX_CHECK_ROUTES } from "../src/engine/check.ts";
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
function scripted(replies: RunResult[]): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (command, args) => {
      calls.push([command, ...args]);
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
  assert.deepEqual(failing, ["node >= 20", "engine built", "browser downloaded (chromium-headless-shell)", "skill installed", "claude CLI on PATH"]);
  assert.ok(
    checks.every((c) => c.ok || c.fix),
    "every failure says how to fix it",
  );
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
    nodeVersion: "v22.1.0",
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
    nodeVersion: "v22.1.0",
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
    nodeVersion: "v22.1.0",
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
  const base = { packageRoot, claudeDir, nodeVersion: "v22.1.0", defaultBrowser: { target: "chromium-headless-shell" as const, path: chromiumPath } };

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
    nodeVersion: "v22.1.0",
    defaultBrowser: { target: "chromium-headless-shell", path: chromiumPath },
    run: scripted([ok(listing)]).run,
  });
  assert.deepEqual(
    checks.filter((c) => !c.ok),
    [],
  );
});

test("the plugin manifest ships the same version and starts the published server", () => {
  // Claude Code offers a plugin update only when plugin.json's own version
  // changes, so a release that bumps package.json alone never reaches plugin
  // users. `npm run version-packages` keeps them together; this pins it.
  // fileURLToPath, not URL.pathname: on Windows the latter is "/D:/…", which resolves to "D:\\D:\\…".
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string; name: string; bin: Record<string, string> };
  const plugin = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")) as {
    version: string;
    name: string;
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8")) as {
    name: string;
    plugins: Array<{ name: string; source: string }>;
  };

  assert.equal(plugin.version, pkg.version);
  // The server entry must run the package that is actually published, through a bin it actually has.
  const server = plugin.mcpServers.scenescout;
  assert.deepEqual([server.command, ...server.args], ["npx", "-y", pkg.name, "serve"]);
  assert.ok("scenescout" in pkg.bin);
  // The install command in the README is `scenescout@<marketplace name>`; the
  // optional mod is listed after it as a plugin of its own.
  assert.deepEqual(
    marketplace.plugins.map((p) => p.name),
    [plugin.name, "scenescout-mod"],
  );
  assert.equal(marketplace.plugins[0].source, "./");
  assert.notEqual(marketplace.name, plugin.name, "a marketplace may not share its plugin's name");
  assert.ok(fs.existsSync(path.join(root, "skills", "scenescout", "SKILL.md")), "plugins load skills from skills/<name>/SKILL.md");
});

test("the optional mod is a plugin of its own: listed, versioned with the package, and adding no server", () => {
  // Organisations that block mods must lose nothing: the main plugin keeps the
  // skill and the server, and the mod's own directory holds only the mod.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (relative: string) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  const pkg = read("package.json") as { version: string };
  const marketplace = read(".claude-plugin/marketplace.json") as { plugins: Array<{ name: string; source: string; description: string }> };
  const entry = marketplace.plugins.find((p) => p.name === "scenescout-mod");
  assert.ok(entry, "the marketplace lists the mod");
  assert.equal(entry.source, "./mods/scenescout-mod");
  assert.match(entry.description, /optional/i, "the listing says the mod is optional");
  const dir = path.join(root, entry.source);
  const mod = read(path.join(entry.source, ".claude-plugin", "plugin.json")) as {
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
  assert.deepEqual(Object.keys(mod.userConfig).sort(), ["lane_model", "mcp_server"]);
  for (const [key, option] of Object.entries(mod.userConfig)) {
    assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/, `${key}: a userConfig key is an identifier`);
    for (const field of Object.keys(option)) assert.ok(allowed.has(field), `${key}.${field} is not a userConfig field`);
    assert.equal(option.type, "string");
    assert.ok(option.title && option.description, `${key} has the title and description the dialog shows`);
    assert.notEqual(option.sensitive, true, `${key}: the mod asks for no secret`);
    assert.equal(option.default, "", `${key}: empty by default, so the mod does nothing until it is set`);
  }
  // hooks.json names one module, inside the plugin, and that module exists.
  const hooks = read(path.join(entry.source, "hooks", "hooks.json")) as { modules: string[]; hooks?: unknown };
  assert.deepEqual(hooks.modules, ["./register.js"]);
  assert.equal(hooks.hooks, undefined, "no settings hooks: everything is in the module");
  const register = fs.readFileSync(path.join(dir, "hooks", "register.js"), "utf8");
  // A hooks module may import only its own files by relative path, and the bare `claude-code`.
  const imports = [...register.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./pane.js"], "register.js imports only its own rules, by relative path");
  // Nothing in the main plugin's default component directories comes from the mod.
  assert.ok(!fs.existsSync(path.join(root, "hooks")), "the main plugin carries no hooks of its own, so blocking mods costs it nothing");
});

test("the mod registers its hooks as the settings say: the pane always, the spawn hook only with a lane model", async () => {
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
  const pane: Array<[string, unknown]> = [
    ["session.start", null],
    ["command.run", { command: COMMAND }],
    ["ui.close", null],
    ["ui.render", { component: "Pane" }],
  ];
  assert.equal(COMMAND, "scenescout-pane");
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
  const syncScript = fs.readFileSync(path.join(root, "scripts", "sync-plugin-version.mjs"), "utf8");
  assert.match(syncScript, /path\.join\("desktop-extension", "manifest\.json"\)/, "the sync moves the desktop extension's version with the package");
  assert.match(syncScript, /path\.join\("mods", "scenescout-mod", "\.claude-plugin", "plugin\.json"\)/, "the sync moves the mod's version with the package");
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
  assert.equal(manifest.compatibility?.runtimes?.node, `${pkg.engines.node}.0.0`, "the Node it needs is the package's");
  // Nothing to configure and nothing secret: the bundle starts the engine as it is.
  assert.deepEqual(manifest.server.mcp_config.env ?? {}, {});
  assert.equal(manifest.user_config, undefined);
});

test("the bundle build ships what the server reads at runtime, and the release attaches it from a job that runs no repository code", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "build-mcpb.mjs"), "utf8");
  const shipped =
    /for \(const entry of \[([^\]]+)\]\)/
      .exec(script)?.[1]
      .match(/"([^"]+)"/g)
      ?.map((s) => s.slice(1, -1)) ?? [];
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { files: string[]; scripts: Record<string, string> };
  for (const entry of pkg.files.filter((f) => f !== "CHANGELOG.md")) assert.ok(shipped.includes(entry), `the bundle ships ${entry}, as the npm package does`);
  assert.ok(shipped.includes(PLAYBOOK_RELATIVE_PATH.split(path.sep)[0]), "the server reads its playbook from skills/");
  assert.match(script, /"ci", "--omit=dev", "--ignore-scripts"/, "production dependencies only, and no install scripts");
  assert.equal(pkg.scripts.mcpb, "node scripts/build-mcpb.mjs");

  type Step = { uses?: string; run?: string; with?: Record<string, string | boolean> };
  type Job = { needs?: string | string[]; if?: string; permissions?: Record<string, string>; steps: Step[] };
  const wf = parseYaml(fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8")) as { jobs: Record<string, Job> };
  const build = wf.jobs["desktop-extension"];
  assert.ok(build, "release.yml builds the bundle");
  assert.equal(build.if, "needs.release.outputs.published == 'true' && needs.release.outputs.tag != ''", "only for a release that was published");
  assert.deepEqual(build.permissions, { contents: "read" }, "the job that runs repository code can change nothing");
  assert.equal(build.steps.find((s) => s.uses?.startsWith("actions/checkout"))?.with?.ref, "${{ needs.release.outputs.tag }}", "built from the release's tag");
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
    nodeVersion: "v22.1.0",
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
    ["node >= 20", "engine built", "browser downloaded (chromium-headless-shell)", "desktop extension installed", CLAUDE_CODE_NOT_NEEDED],
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
    nodeVersion: "v22.1.0",
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
      nodeVersion: "v22.1.0",
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
  const launch = launchCommand({ packageRoot: cached, nodePath, serverPath: path.join(cached, "dist", "mcp-server.js") });
  assert.deepEqual(launch.slice(1), NPX_SERVE_ARGS);
  assert.ok(path.isAbsolute(launch[0]) && /npx(\.cmd)?$/.test(launch[0]), "an absolute npx beside the running node, so it starts under nvm too");
  assert.ok(!launch.join(" ").includes("_npx"), "nothing in the registration points into the cache");
  // A node that ships without npm: a bare npx on PATH beats an absolute path to nothing.
  assert.equal(launchCommand({ packageRoot: cached, nodePath: path.join(tmp("sc-bare-"), "node"), serverPath: "x" })[0], "npx");

  // A clone or a global install is stable: register the script directly.
  const stable = path.join(path.sep, "opt", "tools", "scenescout");
  const server = path.join(stable, "dist", "mcp-server.js");
  assert.deepEqual(launchCommand({ packageRoot: stable, nodePath, serverPath: server }), [nodePath, server]);
});

test("diagnose accepts an npx registration and vets its launcher", () => {
  const packageRoot = fakePackage();
  const claudeDir = tmp("sc-claude-");
  installSkill({ packageRoot, claudeDir });
  const chromiumPath = path.join(packageRoot, "chromium");
  fs.writeFileSync(chromiumPath, "");
  const base = { packageRoot, claudeDir, nodeVersion: "v22.1.0", defaultBrowser: { target: "chromium-headless-shell" as const, path: chromiumPath } };
  const good = diagnose({ ...base, run: scripted([ok("scenescout:\n  Command: /opt/node/bin/npx\n  Args: -y scenescout serve\n")]).run });
  assert.deepEqual(
    good.filter((c) => !c.ok),
    [],
  );
  const bare = diagnose({ ...base, run: scripted([ok("scenescout:\n  Command: npx\n  Args: -y scenescout serve\n")]).run }).filter((c) => !c.ok);
  assert.equal(bare.length, 1);
  assert.match(bare[0].detail, /bare `npx`/);
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
    nodeVersion: "v22.1.0",
    defaultBrowser: { target: "chromium-headless-shell" as const, path: chromiumPath },
  };
  const engine = diagnose({ ...base, scope: "engine", run: scripted([]).run });
  assert.deepEqual(
    engine.map((c) => c.name),
    ["node >= 20", "engine built", "browser downloaded (chromium-headless-shell)"],
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
    nodeVersion: "v22.1.0",
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
  const base = { scope: "engine" as const, packageRoot, claudeDir: tmp("sc-claude-"), nodeVersion: "v22.1.0", run: scripted([]).run };
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

test("shared workers are taken from the page in every mode that blocks anything", () => {
  // Their requests cannot be intercepted in any browser; the smoke suite proves the DELETE no longer arrives.
  assert.equal(sharedWorkersAllowed("observe"), false);
  assert.equal(sharedWorkersAllowed("read-only"), false);
  assert.equal(sharedWorkersAllowed("safe-write"), false);
  assert.equal(sharedWorkersAllowed("destructive"), true);
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

/** A dispatch whose handlers only record what reached them; usage and refusal end the run as the real ones do. */
async function dispatched(argv: string[]): Promise<{ ran: string[]; exit: number | null; said: string[] }> {
  const ran: string[] = [];
  const said: string[] = [];
  class Exit {
    constructor(readonly code: number) {}
  }
  const record = (name: Subcommand) => (args: string[]) => {
    ran.push([name, ...args].join(" "));
  };
  const commands = Object.fromEntries(SUBCOMMANDS.map((c) => [c, record(c)])) as CliHandlers["commands"];
  try {
    await dispatch(argv[0], argv.slice(1), {
      usage: (code) => {
        said.push("usage");
        throw new Exit(code);
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
  return { ran, exit: null, said };
}

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

test("check, ci, login and export keep their own option parsing, and serve starts whatever else it is given", async () => {
  // Their parsers refuse unknown options with their own exit codes (check, ci and export exit 2), so the preflight leaves them be.
  for (const argv of [
    ["check", "http://127.0.0.1:3000", "--nope"],
    ["ci", "http://127.0.0.1:3000", "--nope"],
    ["login", "http://127.0.0.1:3000", "--nope"],
    ["export", "--to", "github", "--nope"],
    ["serve", "--stray"],
  ]) {
    assert.deepEqual((await dispatched(argv)).ran, [argv.join(" ")], argv.join(" "));
  }
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
