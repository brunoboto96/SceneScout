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
  resolveClaudeDir,
  type Runner,
  type RunResult,
} from "../src/installer.ts";

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
  const { run, calls } = scripted([fail("MCP server scenescout already exists in user config"), ok(), ok(), notRegistered]);
  const result = registerMcp({ launch: ["/n", "/s.js"], serverPath: "/s.js", run });
  assert.deepEqual(result, { status: "registered", replaced: true, removedLegacy: [], notes: [] });
  assert.deepEqual(calls.map((c) => c.slice(1, 3).join(" ")).slice(0, 3), ["mcp add", "mcp remove", "mcp add"]);
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
  const { run } = scripted([fail("MCP server scenescout already exists in user config"), ok(), fail("config is locked")]);
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
    chromiumPath: path.join(packageRoot, "no-such-chromium"),
    run: scripted([absent]).run,
  });
  const failing = checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failing, ["node >= 20", "engine built", "chromium downloaded", "skill installed", "claude CLI on PATH"]);
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
    chromiumPath,
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
    chromiumPath,
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
    chromiumPath,
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
  const base = { packageRoot, claudeDir, nodeVersion: "v22.1.0", chromiumPath };

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
  const checks = diagnose({ packageRoot, claudeDir, nodeVersion: "v22.1.0", chromiumPath, run: scripted([ok(listing)]).run });
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
  const base = { packageRoot, claudeDir, nodeVersion: "v22.1.0", chromiumPath };
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
  const base = { packageRoot, claudeDir: tmp("sc-claude-"), nodeVersion: "v22.1.0", chromiumPath };
  const engine = diagnose({ ...base, scope: "engine", run: scripted([]).run });
  assert.deepEqual(
    engine.map((c) => c.name),
    ["node >= 20", "engine built", "chromium downloaded"],
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
