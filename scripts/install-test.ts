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
import {
  diagnose,
  installSkill,
  isEphemeralRoot,
  launchCommand,
  manualRegisterCommand,
  NPX_SERVE_ARGS,
  parseRegistration,
  registerMcp,
  repairCommands,
  resolveClaudeDir,
  type Runner,
  type RunResult,
} from "../src/installer.ts";
import {
  browserPresence,
  defaultAttachNote,
  defaultEngine,
  focusAdvanceKey,
  headlessShellDir,
  launchTarget,
  parseBrowserSelection,
  playwrightInstallArgs,
  serviceWorkerPolicy,
  sharedWorkersAllowed,
} from "../src/browsers.ts";

import { explorePrompt, loadPlaybook, PLAYBOOK_RELATIVE_PATH, SERVER_INSTRUCTIONS, stripFrontMatter } from "../src/playbook.ts";

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
  // The install command in the README is `scenescout@<marketplace name>`.
  assert.deepEqual(
    marketplace.plugins.map((p) => p.name),
    [plugin.name],
  );
  assert.notEqual(marketplace.name, plugin.name, "a marketplace may not share its plugin's name");
  assert.ok(fs.existsSync(path.join(root, "skills", "scenescout", "SKILL.md")), "plugins load skills from skills/<name>/SKILL.md");
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
  // A client may send no arguments object at all.
  assert.match(explorePrompt("# Method", undefined), /Target: ask me for the URL/);
  // A level the method does not know would leave the agent guessing.
  assert.throws(() => explorePrompt("# Method", { level: "deep" }), /"deep" is not one the method knows.*minimal, medium, extensive/);
  // With no URL the agent is told to find one, not left with a blank target.
  assert.match(explorePrompt("# Method", {}), /Target: ask me for the URL/);
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
