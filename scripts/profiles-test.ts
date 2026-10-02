/**
 * Named sign-in profiles: which role names are allowed, where a profile lives,
 * that it is written owner-only and ignored by git, what may be printed about
 * it, how scout_attach turns `role` into the file it loads, and how long a
 * profile will last (cookie dates and JWT `exp`) against a run's length.
 *
 *   npx tsx --test scripts/profiles-test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import {
  describeSaved,
  mergeSessionStorage,
  SESSION_RESTORED_MARKER,
  sessionStorageInitScript,
  splitProfile,
  withSessionStorage,
  isLooserThanOwner,
  listProfiles,
  parseLoginArgs,
  permissionNote,
  profileDir,
  profilePath,
  PROFILE_DIR_MODE,
  PROFILE_FILE_MODE,
  reloginCommand,
  resolveAttachAuth,
  roleLabel,
  summarizeState,
  validateRoleName,
  writeProfile,
} from "../src/engine/profiles.ts";
import {
  isAuthReturn,
  judgeSignIn,
  LoginWindows,
  looksLikeCredential,
  STABLE_LOOKS,
  startWatch,
  type HeldValue,
  type SignInLook,
  type SignInVerdict,
  type SignInWatch,
} from "../src/engine/signed-in.ts";
import { cookieMatchesHost, describeLifetime, judgeLifetime, judgeProfileFile, jwtExpiry, readLifetime } from "../src/engine/expiry.ts";

const POSIX = process.platform !== "win32";
const tempProject = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-profiles-"));
const STATE = {
  cookies: [{ name: "sid", value: "s3cret-cookie-value", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
  origins: [{ origin: "http://127.0.0.1:3000", localStorage: [{ name: "token", value: "s3cret-local-value" }] }],
};
/** A profile as the capture now saves it: IndexedDB inside an origin, sessionStorage beside the storage state. */
const FULL_PROFILE = {
  cookies: STATE.cookies,
  origins: [{ ...STATE.origins[0], indexedDB: [{ name: "auth-db", version: 1, stores: [] }] }],
  sessionStorage: [{ origin: "http://127.0.0.1:3000", entries: [{ name: "auth_token", value: "s3cret-session-value" }] }],
};

test("a role name is a plain word: nothing that could be a path, hidden, or need quoting", () => {
  for (const ok of ["admin", "qa-lead", "role_2", "a", "9lives", "x".repeat(40)]) {
    assert.deepEqual(validateRoleName(ok), { ok: true, role: ok }, ok);
  }
  // One role whatever its case: on a case-insensitive filesystem they would be one file anyway.
  assert.deepEqual(validateRoleName("Admin"), { ok: true, role: "admin" });
  assert.equal(profilePath("/p", "QA"), profilePath("/p", "qa"));
  for (const bad of ["", "../admin", "..", "a/b", "a\\b", ".hidden", "-flag", "_x", "a.b", "a b", "x".repeat(41), "admin\n", "résumé", "/etc/passwd"]) {
    assert.equal(validateRoleName(bad).ok, false, JSON.stringify(bad));
  }
  for (const reserved of ["con", "NUL", "com1", "LPT9", "anonymous", "Anonymous"]) {
    assert.equal(validateRoleName(reserved).ok, false, reserved);
  }
  assert.equal(validateRoleName(undefined).ok, false);
  assert.equal(validateRoleName(42).ok, false);
});

test("a profile lives in .scenescout/auth/<role>.json, and an unchecked name never becomes a path", () => {
  const project = path.join(os.tmpdir(), "p");
  assert.equal(profilePath(project, "admin"), path.join(project, ".scenescout", "auth", "admin.json"));
  assert.equal(path.dirname(profilePath(project, "qa")), profileDir(project));
  assert.throws(() => profilePath(project, "../../outside"), /not allowed/);
  assert.throws(() => profilePath(project, "a/b"), /not allowed/);
});

test("a saved profile is owner-only, in an owner-only directory, and replaced whole", { skip: !POSIX && "no POSIX modes on Windows" }, () => {
  const project = tempProject();
  try {
    // A directory that already existed looser (someone made it by hand) is tightened.
    fs.mkdirSync(profileDir(project), { recursive: true, mode: 0o755 });
    fs.chmodSync(profileDir(project), 0o755);
    const saved = writeProfile(project, "admin", STATE);
    assert.equal(saved.path, profilePath(project, "admin"));
    assert.deepEqual(saved.summary, { cookies: 1, origins: 1, sessionOrigins: 0, indexedDBs: 0 });
    assert.equal(fs.statSync(saved.path).mode & 0o777, PROFILE_FILE_MODE);
    assert.equal(fs.statSync(profileDir(project)).mode & 0o777, PROFILE_DIR_MODE);
    assert.deepEqual(JSON.parse(fs.readFileSync(saved.path, "utf8")), STATE, "the storage state is carried through unchanged");

    // Recording the role again replaces the file; no temporary file is left beside it.
    writeProfile(project, "admin", { cookies: [], origins: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(saved.path, "utf8")), { cookies: [], origins: [] });
    assert.deepEqual(fs.readdirSync(profileDir(project)), ["admin.json"]);
    assert.equal(fs.statSync(saved.path).mode & 0o777, PROFILE_FILE_MODE);

    // A temporary file a crashed write left behind, world-readable, is not reused with its mode.
    const stale = `${saved.path}.${process.pid}.tmp`;
    fs.writeFileSync(stale, "left over", { mode: 0o644 });
    fs.chmodSync(stale, 0o644);
    writeProfile(project, "admin", STATE);
    assert.equal(fs.statSync(saved.path).mode & 0o777, PROFILE_FILE_MODE);
    assert.deepEqual(fs.readdirSync(profileDir(project)), ["admin.json"]);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a state that is not a storage state is refused before anything is written", () => {
  const project = tempProject();
  try {
    assert.throws(() => writeProfile(project, "admin", null), /no storage state/);
    assert.throws(() => writeProfile(project, "admin", { cookies: [] }), /no cookies or origins/);
    assert.throws(() => writeProfile(project, "../x", STATE), /not allowed/);
    assert.equal(fs.existsSync(profilePath(project, "admin")), false);
    assert.equal(summarizeState({ cookies: [1, 2], origins: [] }).ok, true);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a profile recorded before any run is still ignored by git", () => {
  const project = tempProject();
  try {
    execFileSync("git", ["init", "-q"], { cwd: project });
    const saved = writeProfile(project, "qa", STATE);
    const ignored = spawnSync("git", ["check-ignore", "-q", path.relative(project, saved.path)], { cwd: project });
    assert.equal(ignored.status, 0, "git check-ignore must report the profile as ignored");
    const untracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: project, encoding: "utf8" });
    assert.doesNotMatch(untracked, /auth/, untracked);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("what is printed about a profile is where and how much, never what", () => {
  const line = describeSaved("/p/.scenescout/auth/admin.json", { cookies: 3, origins: 1, sessionOrigins: 1, indexedDBs: 2 });
  assert.equal(
    line,
    "Saved to /p/.scenescout/auth/admin.json (3 cookies, 1 origin with local storage or IndexedDB, 1 origin with session storage, 2 IndexedDB databases).",
  );
  const saved = summarizeState(FULL_PROFILE);
  assert.ok(saved.ok);
  assert.deepEqual(saved.summary, { cookies: 1, origins: 1, sessionOrigins: 1, indexedDBs: 1 });
  const printed = describeSaved("/p/x.json", saved.summary);
  assert.doesNotMatch(printed, /s3cret|sid|token|auth_token|tokens/);
});

test("attach by role loads that role's profile; with a file, or neither, it does what it did before", () => {
  const project = "/work/app";
  const file = profilePath(project, "admin");
  const exists = (p: string) => p === file;
  assert.deepEqual(resolveAttachAuth({ projectDir: project, role: "admin" }, exists), { kind: "role", role: "admin", storageStatePath: file });
  assert.deepEqual(resolveAttachAuth({ projectDir: project, storageStatePath: "/work/state.json" }, exists), {
    kind: "file",
    storageStatePath: "/work/state.json",
  });
  assert.deepEqual(resolveAttachAuth({ projectDir: project }, exists), { kind: "none" });
});

test("attach refuses role and storageStatePath together, a bad role, and a role nobody recorded", () => {
  const project = "/work/app";
  const none = () => false;
  assert.throws(() => resolveAttachAuth({ projectDir: project, role: "admin", storageStatePath: "/x.json" }, () => true), /role or storageStatePath, not both/);
  assert.throws(() => resolveAttachAuth({ projectDir: project, role: "../../etc" }, () => true), /not allowed/);
  assert.throws(
    () => resolveAttachAuth({ projectDir: project, url: "http://127.0.0.1:3000/", role: "admin" }, none, () => ["qa", "viewer"]),
    (err: Error) => err.message.includes("`scenescout login http://127.0.0.1:3000/ --role admin`") && err.message.includes("Saved roles: qa, viewer."),
  );
  assert.throws(
    () => resolveAttachAuth({ projectDir: project, role: "admin" }, none, () => []),
    (err: Error) => err.message.includes("`scenescout login <url> --role admin`") && !err.message.includes("Saved roles"),
  );
  // The list of saved roles is a hint; failing to read it does not hide the refusal.
  assert.throws(
    () =>
      resolveAttachAuth({ projectDir: project, role: "admin" }, none, () => {
        throw new Error("EACCES");
      }),
    /scenescout login <url> --role admin/,
  );
});

test("a refusal for a missing role names --project only when SceneScout chose the folder", () => {
  const none = () => false;
  const refusal = (opts: Partial<Parameters<typeof resolveAttachAuth>[0]> & { projectDir: string }): string => {
    try {
      resolveAttachAuth({ url: "http://localhost:3000", role: "admin", ...opts }, none, () => []);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("the attach was not refused");
  };
  const cases: Array<[string, Parameters<typeof refusal>[0], string]> = [
    ["a given or workspace folder: as before", { projectDir: "/work/app" }, "`scenescout login http://localhost:3000 --role admin`"],
    ["a given folder, said explicitly", { projectDir: "/work/app", projectChosen: false }, "`scenescout login http://localhost:3000 --role admin`"],
    [
      "a chosen folder, POSIX",
      { projectDir: "/home/u/Documents/SceneScout/localhost-3000", projectChosen: true, platform: "linux" },
      "`scenescout login http://localhost:3000 --role admin --project '/home/u/Documents/SceneScout/localhost-3000'`",
    ],
    [
      "a chosen folder, POSIX, with a space and a quote",
      { projectDir: "/Users/u/My Docs/it's/SceneScout/localhost-3000", projectChosen: true, platform: "darwin" },
      "--project '/Users/u/My Docs/it'\\''s/SceneScout/localhost-3000'`",
    ],
    [
      "a chosen folder, Windows",
      { projectDir: "C:\\Users\\u\\My Documents\\SceneScout\\localhost-3000", projectChosen: true, platform: "win32" },
      '--project "C:\\Users\\u\\My Documents\\SceneScout\\localhost-3000"`',
    ],
  ];
  for (const [name, opts, want] of cases) assert.ok(refusal(opts).includes(want), `${name}: ${refusal(opts)}`);
  assert.ok(!refusal({ projectDir: "/work/app" }).includes("--project"), "a given folder adds no --project");
});

test("the record-it-again command for an expired sign-in names --project only when SceneScout chose the folder", () => {
  const base = { role: "admin", url: "http://localhost:3000" };
  const cases: Array<[string, Parameters<typeof reloginCommand>[0], string]> = [
    ["a given or workspace folder: as before", { ...base, projectDir: "/work/app" }, "scenescout login http://localhost:3000 --role admin"],
    ["said explicitly", { ...base, projectDir: "/work/app", projectChosen: false }, "scenescout login http://localhost:3000 --role admin"],
    [
      "a chosen folder, POSIX",
      { ...base, projectDir: "/home/u/Documents/SceneScout/localhost-3000", projectChosen: true, platform: "linux" },
      "scenescout login http://localhost:3000 --role admin --project '/home/u/Documents/SceneScout/localhost-3000'",
    ],
    [
      "a chosen folder, Windows",
      { ...base, projectDir: "C:\\Users\\u\\My Documents\\SceneScout\\localhost-3000", projectChosen: true, platform: "win32" },
      'scenescout login http://localhost:3000 --role admin --project "C:\\Users\\u\\My Documents\\SceneScout\\localhost-3000"',
    ],
  ];
  for (const [name, opts, want] of cases) assert.equal(reloginCommand(opts), want, name);
});

test("a session is labelled by its role, its file's name, or anonymous", () => {
  assert.equal(roleLabel({ kind: "role", role: "qa", storageStatePath: "/p/.scenescout/auth/qa.json" }), "qa");
  assert.equal(roleLabel({ kind: "file", storageStatePath: "/work/auth/manager.json" }), "manager");
  assert.equal(roleLabel({ kind: "none" }), "anonymous");
});

test("the saved roles are the valid .json names in the directory", () => {
  const project = "/work/app";
  const listing = () => ["qa.json", "admin.json", "admin.json.123.tmp", ".DS_Store", "bad name.json", "notes.txt"];
  assert.deepEqual(listProfiles(project, listing), ["admin", "qa"]);
  const missing = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.deepEqual(listProfiles(project, missing), []);
});

test("a profile others can read is called out at attach; an owner-only one is not", () => {
  assert.equal(isLooserThanOwner(0o100600, "linux"), false);
  assert.equal(isLooserThanOwner(0o100400, "darwin"), false);
  assert.equal(isLooserThanOwner(0o100644, "linux"), true);
  assert.equal(isLooserThanOwner(0o100660, "darwin"), true);
  assert.equal(isLooserThanOwner(0o100666, "win32"), false, "Windows has no such bits to judge");
  assert.equal(permissionNote("/p/a.json", 0o100600, "linux"), null);
  assert.match(permissionNote("/p/a.json", 0o100644, "linux") ?? "", /mode 644.*chmod 600 "\/p\/a\.json"/);
});

test("scenescout login takes one URL and a valid role, and nothing that would leak or escape", () => {
  const ok = parseLoginArgs(["http://127.0.0.1:3000/app", "--role", "admin"], "/work/app");
  assert.deepEqual(ok, { ok: true, options: { url: "http://127.0.0.1:3000/app", role: "admin", projectDir: path.resolve("/work/app") } });
  const withFlags = parseLoginArgs(["https://app.example.com", "--role=qa", "--project", "sub", "--browser", "firefox"], "/work");
  assert.ok(withFlags.ok);
  assert.equal(withFlags.options.projectDir, path.resolve("/work/sub"));
  assert.equal(withFlags.options.browser, "firefox");

  const refused = (args: string[], re: RegExp) => {
    const r = parseLoginArgs(args, "/work");
    assert.equal(r.ok, false, args.join(" "));
    if (!r.ok) assert.match(r.error, re);
  };
  refused(["http://127.0.0.1:3000"], /role name/);
  refused(["http://127.0.0.1:3000", "--role", "../../x"], /not allowed/);
  refused(["http://127.0.0.1:3000", "--role"], /--role needs a value/);
  refused(["http://127.0.0.1:3000", "--role", "admin", "--headless", "x"], /unknown option --headless/);
  refused(["--role", "admin"], /exactly one URL/);
  refused(["http://a.test", "http://b.test", "--role", "admin"], /exactly one URL/);
  refused(["not a url", "--role", "admin"], /not a URL/);
  refused(["file:///etc/passwd", "--role", "admin"], /only http and https/);
  refused(["http://user:pw@127.0.0.1:3000", "--role", "admin"], /no credentials in the URL/);
  refused(["http://127.0.0.1:3000", "--role", "admin", "--browser", "edge"], /--browser must be one of/);
  refused(["http://127.0.0.1:3000", "--role", "admin", "--save", "later"], /--save must be one of auto, enter/);
  refused(["http://127.0.0.1:3000", "--role", "admin", "--script", "--save", "enter"], /--save applies to the window/);
});

test("the window saves by itself unless --save enter asks for Enter alone, and reads --success-url without --script", () => {
  const plain = parseLoginArgs(["http://127.0.0.1:3000", "--role", "admin"], "/work");
  assert.ok(plain.ok && plain.options.save === undefined, "no --save leaves the default, auto, to the runner");
  const enter = parseLoginArgs(["http://127.0.0.1:3000", "--role", "admin", "--save", "enter"], "/work");
  assert.ok(enter.ok && enter.options.save === "enter");
  const success = parseLoginArgs(["http://127.0.0.1:3000", "--role", "admin", "--success-url=/home"], "/work");
  assert.ok(success.ok && success.options.successUrl === "/home" && success.options.script === undefined);
  const scripted = parseLoginArgs(["http://127.0.0.1:3000", "--role", "admin", "--script", "--success-url", "/home"], "/work");
  assert.ok(
    scripted.ok && scripted.options.successUrl === undefined && scripted.options.script?.get("success-url") === "/home",
    "with --script it stays the script's",
  );
});

// ── sessionStorage and IndexedDB ────────────────────────────────────────────

test("sessionStorage read from every frame is merged per origin; opaque origins, the marker and junk are dropped", () => {
  const merged = mergeSessionStorage([
    {
      origin: "http://127.0.0.1:3000",
      entries: [
        ["auth_token", "a"],
        ["theme", "dark"],
      ],
    },
    // A second tab on the same origin: a later read of the same key wins, others are kept.
    {
      origin: "http://127.0.0.1:3000",
      entries: [
        ["auth_token", "b"],
        [SESSION_RESTORED_MARKER, "1"],
      ],
    },
    { origin: "https://idp.example", entries: [["state", "xyz"]] },
    { origin: "null", entries: [["sandboxed", "1"]] },
    { origin: "about:blank", entries: [["x", "1"]] },
    { origin: "http://127.0.0.1:3000/path", entries: [["not-an-origin", "1"]] },
    { origin: "http://127.0.0.1:4000", entries: [] },
    { origin: "http://127.0.0.1:5000", entries: [["n", 1 as unknown as string], ["only-one"]] },
    { origin: "http://127.0.0.1:6000", entries: "nope" },
  ]);
  assert.deepEqual(merged, [
    {
      origin: "http://127.0.0.1:3000",
      entries: [
        { name: "auth_token", value: "b" },
        { name: "theme", value: "dark" },
      ],
    },
    { origin: "https://idp.example", entries: [{ name: "state", value: "xyz" }] },
  ]);
});

test("a profile keeps sessionStorage beside the storage state, and attach splits them again", () => {
  const captured = withSessionStorage(STATE, FULL_PROFILE.sessionStorage);
  assert.deepEqual(captured, { ...STATE, sessionStorage: FULL_PROFILE.sessionStorage });
  // Nothing to add leaves the storage state exactly as Playwright returned it.
  assert.equal(withSessionStorage(STATE, []), STATE);

  const split = splitProfile(FULL_PROFILE);
  assert.deepEqual(split.sessionStorage, FULL_PROFILE.sessionStorage);
  assert.deepEqual(Object.keys(split.storageState).sort(), ["cookies", "origins"], "Playwright is handed only what it restores");
  assert.deepEqual(split.storageState.origins, FULL_PROFILE.origins, "IndexedDB rides inside the origins Playwright restores");

  // A profile saved by the capture before sessionStorage was kept loads as it always did.
  assert.deepEqual(splitProfile(STATE), { storageState: STATE, sessionStorage: [] });
  assert.equal(sessionStorageInitScript(splitProfile(STATE).sessionStorage), null);

  const project = tempProject();
  try {
    const saved = writeProfile(project, "member", captured);
    assert.deepEqual(saved.summary, { cookies: 1, origins: 1, sessionOrigins: 1, indexedDBs: 0 });
    assert.deepEqual(splitProfile(JSON.parse(fs.readFileSync(saved.path, "utf8"))).sessionStorage, FULL_PROFILE.sessionStorage);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a malformed profile is refused whole, not half-restored", () => {
  assert.throws(() => splitProfile(null), /no storage state/);
  assert.throws(() => splitProfile({ cookies: [] }), /no cookies or origins/);
  for (const bad of [
    "x",
    [{ origin: "null", entries: [] }],
    [{ origin: "http://a.test", entries: [{ name: "k", value: 1 }] }],
    [{ origin: "http://a.test", entries: "k=v" }],
    [null],
  ]) {
    assert.throws(() => splitProfile({ ...STATE, sessionStorage: bad }), /sessionStorage list is malformed/, JSON.stringify(bad));
  }
});

/** Run the restore script as a frame at `origin` would, against a tab's sessionStorage; returns that frame's sessionStorage. */
function runRestore(script: string, origin: string, tab: Map<string, string>): { clear(): void } {
  // A fresh prototype per document, as each page load has its own Storage.prototype.
  class Storage {
    getItem(k: string) {
      return tab.has(k) ? tab.get(k)! : null;
    }
    setItem(k: string, v: string) {
      tab.set(k, String(v));
    }
    clear() {
      tab.clear();
    }
  }
  const sessionStorage = new Storage();
  vm.runInNewContext(script, { location: { origin }, sessionStorage });
  return sessionStorage;
}

test("the restore script seeds only the matching origin, once per tab, and keeps values as data", () => {
  const tricky = `"); globalThis.pwned = 1; ("</script>\u2028`;
  const script = sessionStorageInitScript([
    {
      origin: "http://127.0.0.1:3000",
      entries: [
        { name: "auth_token", value: "t1" },
        { name: "odd", value: tricky },
      ],
    },
  ]);
  assert.ok(script);

  const tab = new Map<string, string>();
  runRestore(script, "http://127.0.0.1:3000", tab);
  assert.equal(tab.get("auth_token"), "t1");
  assert.equal(tab.get("odd"), tricky, "a value is written as the string it was, never run");
  assert.equal(tab.get(SESSION_RESTORED_MARKER), "1");

  // The app signs out in this tab; a reload runs the script again and must not sign it back in.
  tab.delete("auth_token");
  runRestore(script, "http://127.0.0.1:3000", tab);
  assert.equal(tab.has("auth_token"), false);

  // An app that signs out by clearing sessionStorage stays signed out too: clear() keeps the marker.
  const cleared = new Map<string, string>();
  runRestore(script, "http://127.0.0.1:3000", cleared).clear();
  assert.equal(cleared.has("auth_token"), false);
  runRestore(script, "http://127.0.0.1:3000", cleared);
  assert.equal(cleared.has("auth_token"), false, "the next page load must not restore the token the app cleared");
  assert.equal(cleared.get(SESSION_RESTORED_MARKER), "1");

  // Any other origin, including an iframe from elsewhere or the same host on another port, gets nothing.
  for (const other of ["http://127.0.0.1:4000", "https://127.0.0.1:3000", "null", "http://evil.test"]) {
    const elsewhere = new Map<string, string>();
    runRestore(script, other, elsewhere);
    assert.equal(elsewhere.size, 0, other);
  }
  // An origin named like an Object.prototype property is not matched by accident.
  const proto = new Map<string, string>();
  runRestore(script, "constructor", proto);
  assert.equal(proto.size, 0);
});

test("a re-attach seeds each tab once more from the latest profile, after the attach's script", () => {
  const origin = "http://127.0.0.1:3000";
  const attach = sessionStorageInitScript([{ origin, entries: [{ name: "auth_token", value: "old" }] }])!;
  const reattach = sessionStorageInitScript([{ origin, entries: [{ name: "auth_token", value: "new" }] }], { generation: "reattach-1" })!;
  assert.ok(attach && reattach);
  /** One page load after the re-attach: both scripts run, the attach's first, as Playwright runs them in the order added. */
  const load = (tab: Map<string, string>) => {
    runRestore(attach, origin, tab);
    return runRestore(reattach, origin, tab);
  };

  // The tab the attach seeded, whose sign-in the app then dropped on a revoked token.
  const tab = new Map<string, string>([[SESSION_RESTORED_MARKER, "1"]]);
  load(tab);
  assert.equal(tab.get("auth_token"), "new", "the latest profile's token is put back in a tab the attach already seeded");
  assert.equal(tab.get(SESSION_RESTORED_MARKER), "reattach-1");

  // Once per tab again: the app signs out after the re-attach and stays signed out, by removeItem or by clear().
  tab.delete("auth_token");
  load(tab);
  assert.equal(tab.has("auth_token"), false, "a sign-out after the re-attach stands");
  const cleared = new Map<string, string>([[SESSION_RESTORED_MARKER, "1"]]);
  load(cleared).clear();
  assert.equal(cleared.get(SESSION_RESTORED_MARKER), "reattach-1", "clear() leaves the re-attach's mark, not the attach's");
  load(cleared);
  assert.equal(cleared.has("auth_token"), false);

  // A tab opened after the re-attach ends on the latest sign-in, never the older one.
  const fresh = new Map<string, string>();
  load(fresh);
  assert.equal(fresh.get("auth_token"), "new");
  load(fresh);
  assert.equal(fresh.get("auth_token"), "new");

  // The origin rule holds for the re-attach too.
  const elsewhere = new Map<string, string>([[SESSION_RESTORED_MARKER, "1"]]);
  runRestore(reattach, "http://127.0.0.1:4000", elsewhere);
  assert.equal(elsewhere.has("auth_token"), false);

  // "1" is the attach's own mark: a re-attach using it would never seed a tab the attach had seeded.
  assert.throws(() => sessionStorageInitScript([{ origin, entries: [] }], { generation: "1" }), /must not be "1"/);
});

// ── How long a profile lasts ────────────────────────────────────────────────

const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);
const MIN = 60_000;
const APP = "http://127.0.0.1:3000";
/** An unsigned JWT with the given `exp` in epoch ms (or no exp); only the payload matters here. */
const jwt = (expMs?: number, extra: Record<string, unknown> = {}): string =>
  [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "user-1", ...extra, ...(expMs === undefined ? {} : { exp: Math.floor(expMs / 1000) }) })).toString("base64url"),
    "c2lnbmF0dXJl",
  ].join(".");
const cookie = (name: string, expiresMs: number | -1, value = "opaque-cookie-value", domain = "127.0.0.1") => ({
  name,
  value,
  domain,
  path: "/",
  expires: expiresMs === -1 ? -1 : expiresMs / 1000,
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
});
const stateOf = (cookies: unknown[], storage: { name: string; value: string }[] = []) => ({
  cookies,
  origins: storage.length ? [{ origin: APP, localStorage: storage }] : [],
});
const judge = (state: unknown, runMin = 60, marginMin = 10) =>
  judgeLifetime(readLifetime(state, { url: APP }), {
    now: NOW,
    runMs: runMin * MIN,
    marginMs: marginMin * MIN,
    role: "admin",
    rerun: "scenescout login http://127.0.0.1:3000 --role admin",
  });

test("session cookies carry no date: the lifetime is unknown, warned, never refused", () => {
  const life = readLifetime(stateOf([cookie("sid", -1)]), { url: APP });
  assert.equal(life.dated.length, 0);
  assert.equal(life.undated, 1);
  const v = judge(stateOf([cookie("sid", -1)]));
  assert.equal(v.kind, "unknown");
  if (v.kind === "unknown") assert.match(v.message, /only credentials with no date.*scenescout login http:\/\/127\.0\.0\.1:3000 --role admin/);
  assert.match(describeLifetime(life, NOW), /^Lasts: unknown — no expiry found, only 1 credential with no date \(a session cookie/);
});

test("a profile whose every cookie has expired is refused, and names the command that records it again", () => {
  const v = judge(stateOf([cookie("sid", NOW - 5 * MIN)]));
  assert.equal(v.kind, "refuse");
  if (v.kind === "refuse") assert.match(v.message, /role "admin" has expired.*5m00s ago.*Run `scenescout login http:\/\/127\.0\.0\.1:3000 --role admin` again/);
  assert.match(describeLifetime(readLifetime(stateOf([cookie("sid", NOW - 5 * MIN)])), NOW), /already expired/);
});

test("a JWT's exp in localStorage dates the profile; the run's length plus the margin decides", () => {
  const token = jwt(NOW + 45 * MIN);
  const state = stateOf([], [{ name: "auth", value: JSON.stringify({ accessToken: token }) }]);
  const life = readLifetime(state, { url: APP });
  assert.deepEqual(life.dated, [{ source: "local-storage-jwt", name: "auth", expiresAt: Math.floor((NOW + 45 * MIN) / 1000) * 1000 }]);
  const short = judge(state, 60, 10);
  assert.equal(short.kind, "refuse", "45 minutes cannot cover a 60-minute run");
  if (short.kind === "refuse") {
    assert.match(short.message, /will not last the run: it ends in 45m00s \(token in localStorage "auth"\).*1h00m.*10m00s margin/);
    assert.ok(!short.message.includes(token) && !short.message.includes(token.split(".")[1]), "never the token itself");
  }
  assert.equal(judge(state, 30, 10).kind, "ok", "a 30-minute run with 10 minutes to spare fits in 45");
  assert.equal(judge(state, 40, 0).kind, "ok", "the margin is the caller's: zero lets a 40-minute run through");
  assert.equal(judge(state, 40, 10).kind, "refuse", "the same run with the default margin does not fit");
  const said = describeLifetime(life, NOW);
  assert.match(said, /^Lasts: about 45m00s \(the last dated credential, token in localStorage "auth"\)\.$/);
  assert.ok(!said.includes(token));
});

test("a JWT inside a cookie ends the cookie at whichever comes first, URL-encoded or not", () => {
  const encoded = encodeURIComponent(`Bearer ${jwt(NOW + 20 * MIN)}`);
  const life = readLifetime(stateOf([cookie("session", NOW + 7 * 86_400_000, encoded)]), { url: APP });
  assert.equal(life.dated[0].source, "cookie-jwt");
  assert.equal(life.dated[0].expiresAt, Math.floor((NOW + 20 * MIN) / 1000) * 1000);
  const laterToken = readLifetime(stateOf([cookie("session", NOW + 20 * MIN, jwt(NOW + 7 * 86_400_000))]), { url: APP });
  assert.equal(laterToken.dated[0].source, "cookie", "the cookie's own date is sooner");
});

test("a malformed JWT is counted as unreadable and dates nothing", () => {
  // Built, not written out: a literal JWT-shaped string in a tracked file is refused by hygiene-test.
  const b64 = (text: string) => Buffer.from(text).toString("base64url");
  const bad = `${b64('{"alg":"none"}')}.${b64('{"not json')}.sig`;
  const noExp = jwt(undefined);
  const life = readLifetime(
    stateOf(
      [],
      [
        { name: "a", value: bad },
        { name: "b", value: noExp },
        { name: "c", value: jwt(undefined, { exp: "tomorrow" }) },
      ],
    ),
    { url: APP },
  );
  assert.equal(life.dated.length, 0);
  assert.equal(life.unreadableTokens, 3);
  assert.equal(jwtExpiry("not.a.token"), null);
  assert.equal(jwtExpiry(bad), null);
  assert.equal(jwtExpiry(jwt(NOW)), Math.floor(NOW / 1000) * 1000);
  assert.equal(judge(stateOf([], [{ name: "a", value: bad }])).kind, "unknown");
});

test("a profile with no cookie and no token is unknown", () => {
  for (const state of [{ cookies: [], origins: [] }, stateOf([], [{ name: "theme", value: "dark" }]), null, "not a state"]) {
    const life = readLifetime(state, { url: APP });
    assert.equal(life.credentials.length, 0, JSON.stringify(state));
    assert.equal(judge(state).kind, "unknown");
    assert.match(describeLifetime(life, NOW), /no cookie or token with an expiry/);
  }
});

test("the profile lasts until its LAST dated credential: a short cookie beside a long one warns, alone it refuses", () => {
  const shortOnly = stateOf([cookie("sid", NOW + 15 * MIN)]);
  const shortBesideLong = stateOf([cookie("sid", NOW + 15 * MIN), cookie("prefs", NOW + 30 * 86_400_000)]);
  assert.equal(judge(shortOnly).kind, "refuse");
  const v = judge(shortBesideLong);
  assert.equal(v.kind, "warn", "a minute-long analytics cookie must not block every run");
  if (v.kind === "warn") assert.match(v.message, /cookie "sid" expires in 15m00s/);
  const shortBesideSession = judge(stateOf([cookie("sid", NOW + 15 * MIN), cookie("s", -1)]));
  assert.equal(shortBesideSession.kind, "warn", "a session cookie may keep it alive, so it is not certain");
  assert.match(describeLifetime(readLifetime(shortBesideLong), NOW), /about 30 days .*The first to expire is cookie "sid", in 15m00s\./);
  const expiredBesideLong = judge(stateOf([cookie("sid", NOW - 5 * MIN), cookie("prefs", NOW + 30 * 86_400_000)]));
  assert.equal(expiredBesideLong.kind, "warn");
  if (expiredBesideLong.kind === "warn") assert.match(expiredBesideLong.message, /cookie "sid" expired 5m00s ago/);
});

test("a token with no expiry beside a short one keeps the verdict uncertain: warned, not refused", () => {
  const access = { name: "access", value: jwt(NOW + 15 * MIN) };
  assert.equal(judge(stateOf([], [access])).kind, "refuse", "the short token alone cannot last the run");
  const withRefresh = stateOf([], [access, { name: "refresh", value: jwt(undefined) }]);
  const life = readLifetime(withRefresh, { url: APP });
  assert.equal(life.undated, 1, "a JWT with no exp is an undated credential");
  assert.equal(judge(withRefresh).kind, "warn", "the refresh token may keep the sign-in alive");
  assert.match(
    describeLifetime(life, NOW),
    /^Lasts: unknown — the last dated credential, token in localStorage "access", ends in 15m00s, but it also holds 1 credential with no date/,
  );
});

test("a cookie for another host left out keeps the verdict uncertain: warned, not refused", () => {
  const access = { name: "access", value: jwt(NOW + 15 * MIN) };
  const withApiCookie = stateOf([cookie("refresh", NOW + 30 * 86_400_000, "x", "api.example.test")], [access]);
  assert.equal(readLifetime(withApiCookie, { url: APP }).elsewhere, 1);
  assert.equal(judge(withApiCookie).kind, "warn", "a cookie the check cannot place may still keep the sign-in alive");
  assert.equal(judge(stateOf([], [access])).kind, "refuse", "the same token with nothing left out is refused");
});

test("with a URL, only cookies sent to its host and storage of its origin count", () => {
  assert.equal(cookieMatchesHost(".example.test", "app.example.test"), true);
  assert.equal(cookieMatchesHost("example.test", "example.test"), true);
  assert.equal(cookieMatchesHost("example.test", "badexample.test"), false);
  const idp = stateOf([cookie("idp", NOW + 5 * MIN, "x", "login.other.test"), cookie("sid", NOW + 5 * 86_400_000)]);
  assert.equal(readLifetime(idp, { url: APP }).dated.length, 1);
  assert.equal(readLifetime(idp).dated.length, 2, "no URL: everything counts");
  const otherOrigin = { cookies: [], origins: [{ origin: "http://127.0.0.1:4000", localStorage: [{ name: "t", value: jwt(NOW + MIN) }] }] };
  assert.equal(readLifetime(otherOrigin, { url: APP }).credentials.length, 0);
});

test("reading a profile file: a bad file is refused without quoting its contents", () => {
  const opts = { url: APP, now: NOW, runMs: 60 * MIN, marginMs: 10 * MIN, role: "admin", rerun: "scenescout login <url> --role admin" };
  assert.throws(
    () => judgeProfileFile("/p/admin.json", opts, () => '{"cookies": [{"value": "s3cret-cookie-value"'),
    (err: Error) => /not valid JSON; run `scenescout login <url> --role admin` again/.test(err.message) && !err.message.includes("s3cret"),
  );
  assert.throws(
    () =>
      judgeProfileFile("/p/admin.json", opts, () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }),
    /could not be read \(ENOENT\)/,
  );
  assert.equal(judgeProfileFile("/p/admin.json", opts, () => JSON.stringify(stateOf([cookie("sid", NOW + 2 * 60 * MIN)]))).kind, "ok");
});

// ── When an interactive sign-in has finished ────────────────────────────────

const SI_APP = "http://app.test:3000";
const SI_IDP = "https://idp.test";
const held = (name: string, value: string, domain = "app.test", p = "/"): HeldValue => ({ kind: "cookie", key: `cookie|${domain}|${p}|${name}`, name, value });
const local = (name: string, value: string, origin = SI_APP): HeldValue => ({ kind: "local", key: `local|${origin}|${name}`, name, value });
const look = (url: string, over: Partial<SignInLook> = {}): SignInLook => ({ url, signInField: false, held: [], popupAway: false, ...over });
const SESSION = held("app_session", "s3cr3t-session-value-0123456789");

/** Run the looks through the watch and return every verdict. */
function judgeAll(watch: SignInWatch, looks: SignInLook[]): SignInVerdict[] {
  const out: SignInVerdict[] = [];
  let w = watch;
  for (const l of looks) {
    const r = judgeSignIn(w, l);
    w = r.watch;
    out.push(r.verdict);
  }
  return out;
}
const last = (v: SignInVerdict[]): SignInVerdict => v[v.length - 1];
const reasonOf = (v: SignInVerdict): string => (v.kind === "waiting" ? v.reason : `signed-in:${v.via}`);
/** The same look twice, as STABLE_LOOKS asks. */
const twice = (l: SignInLook): SignInLook[] => Array.from({ length: STABLE_LOOKS }, () => l);

test("an SSO round trip: still on the identity provider is not signed in, nor is the app's callback, nor the app with no session yet", () => {
  const watch = startWatch(`${SI_APP}/`, []);
  const steps = judgeAll(watch, [
    look(`${SI_APP}/login`, { signInField: false }),
    look(`${SI_IDP}/authorize?client_id=x`),
    // The provider's own session cookie, set on its host: the app holds nothing yet.
    look(`${SI_IDP}/authorize?client_id=x`, { held: [held("idp_session", "idp-session-value-0123456789", "idp.test")] }),
    look(`${SI_APP}/sso/callback?code=abc&state=xyz`, { held: [SESSION] }),
    look(`${SI_APP}/sso/finishing`),
    look(`${SI_APP}/sso/finishing`),
  ]);
  assert.deepEqual(steps.map(reasonOf), ["sign-in-screen", "away", "away", "returning", "no-session", "no-session"]);
  // The contrast: the same trip, and then the app holds a new session. Signed in, once two looks agree.
  const done = judgeAll(watch, [look(`${SI_APP}/login`), look(`${SI_IDP}/authorize`), ...twice(look(`${SI_APP}/home`, { held: [SESSION] }))]);
  assert.deepEqual(done.map(reasonOf), ["sign-in-screen", "away", "settling", "signed-in:credential"]);
  assert.deepEqual(last(done), { kind: "signed-in", via: "credential", credential: 'cookie "app_session"' });
});

test("one look is never enough: a redirect chain passes through pages that look signed in for a moment", () => {
  const watch = { ...startWatch(`${SI_APP}/`, []), sawSignIn: true };
  const moved = judgeAll(watch, [look(`${SI_APP}/a`, { held: [SESSION] }), look(`${SI_APP}/b`, { held: [SESSION] })]);
  assert.deepEqual(moved.map(reasonOf), ["settling", "settling"], "two looks at two addresses are two first looks");
  const interrupted = judgeAll(watch, [
    look(`${SI_APP}/a`, { held: [SESSION] }),
    look(`${SI_APP}/a`, { held: [SESSION], signInField: true }),
    look(`${SI_APP}/a`, { held: [SESSION] }),
  ]);
  assert.equal(reasonOf(last(interrupted)), "settling", "a look that went back to waiting starts the count again");
});

test("a sign-in form on the app: the password field holds it open; the same page without one, with a new session, is signed in", () => {
  const watch = startWatch(`${SI_APP}/login`, [held("csrftoken", "a".repeat(32))]);
  const form = judgeAll(watch, [look(`${SI_APP}/login`, { signInField: true }), ...twice(look(`${SI_APP}/`, { signInField: true, held: [SESSION] }))]);
  assert.equal(reasonOf(last(form)), "sign-in-screen", "a password field on screen is the sign-in screen, whatever is held");
  const spa = judgeAll(watch, [
    look(`${SI_APP}/`, { signInField: true }),
    ...twice(look(`${SI_APP}/`, { held: [local("access_token", "opaque-access-token-0123456789")] })),
  ]);
  assert.deepEqual(last(spa), { kind: "signed-in", via: "credential", credential: 'localStorage "access_token"' }, "a single-page app that signs in in place");
});

test("a landing page that sets a cookie before anyone signs in is not a sign-in", () => {
  // Never through a sign-in screen: a banner dismissed, a preference stored.
  const watch = startWatch(`${SI_APP}/`, []);
  const banner = judgeAll(watch, twice(look(`${SI_APP}/`, { held: [held("session_pref", "x".repeat(24))] })));
  assert.equal(reasonOf(last(banner)), "not-started");
  // The contrast: the same cookie after the sign-in screen was seen.
  const after = judgeAll(watch, [look(`${SI_APP}/signin`), ...twice(look(`${SI_APP}/`, { held: [held("session_pref", "x".repeat(24))] }))]);
  assert.equal(reasonOf(last(after)), "signed-in:credential");
});

test("what was held when the window opened is the baseline: only a new value, or a changed one, counts", () => {
  const anon = held("PHPSESSID", "anonymous-session-id-000000");
  const watch = { ...startWatch(`${SI_APP}/`, [anon]), sawSignIn: true };
  assert.equal(reasonOf(last(judgeAll(watch, twice(look(`${SI_APP}/`, { held: [anon] }))))), "no-session", "the anonymous session the first page set");
  const rotated = held("PHPSESSID", "rotated-at-sign-in-11111111");
  assert.equal(reasonOf(last(judgeAll(watch, twice(look(`${SI_APP}/`, { held: [rotated] }))))), "signed-in:credential", "the same cookie rotated at sign-in");
});

test("the provider's state, nonce and anti-forgery values are not a session; analytics are not either", () => {
  const cases: [string, string, boolean][] = [
    ["whatever", jwt(), true],
    ["app_session", "abc", true],
    ["connect.sid", "s%3Aabc.def", true],
    ["sid", "short", true],
    [".AspNetCore.Cookies", "CfDJ8-long-opaque-value", true],
    ["sb-project-auth-token", JSON.stringify({ access_token: jwt(), user: {} }), true],
    ["store", JSON.stringify({ token: "opaque-token-value" }), true],
    ["persist:root", '{"auth":"{\\"token\\":null}"}', false],
    ["authState", '{"isLoggedIn":false}', false],
    ["k", "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4", true],
    ["oauth_state", "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4", false],
    ["oidc_nonce", "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4", false],
    ["csrftoken", "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4", false],
    ["XSRF-TOKEN", "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4", false],
    ["code_verifier", "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4", false],
    ["_ga", "GA1.1.1234567890.1234567890", false],
    ["theme", "dark", false],
    ["cookie_consent", "accepted-all-categories-2026", false],
    ["app_session", "", false],
  ];
  for (const [name, value, want] of cases) assert.equal(looksLikeCredential({ name, value }), want, `${name}=${value}`);
});

test("an OAuth, OpenID Connect or SAML return is the app still finishing, not the end", () => {
  const cases: [string, boolean][] = [
    [`${SI_APP}/callback?code=abc&state=xyz`, true],
    [`${SI_APP}/callback#access_token=abc&token_type=bearer`, true],
    [`${SI_APP}/callback#id_token=abc`, true],
    [`${SI_APP}/saml/acs?SAMLResponse=abc`, true],
    [`${SI_APP}/orders?code=SUMMER&page=2`, false],
    [`${SI_APP}/home`, false],
    ["not a url", false],
  ];
  for (const [url, want] of cases) assert.equal(isAuthReturn(url), want, url);
});

test("a sign-in popup on the provider holds the window open until it closes", () => {
  const watch = startWatch(`${SI_APP}/login`, []);
  const popup = judgeAll(watch, [look(`${SI_APP}/login`), ...twice(look(`${SI_APP}/home`, { held: [SESSION], popupAway: true }))]);
  assert.equal(reasonOf(last(popup)), "popup");
  const closed = judgeAll(watch, [
    look(`${SI_APP}/login`),
    look(`${SI_APP}/login`, { popupAway: true }),
    ...twice(look(`${SI_APP}/home`, { held: [SESSION] })),
  ]);
  assert.equal(reasonOf(last(closed)), "signed-in:credential");
});

test("about:blank before the first page is nowhere; another origin is the provider", () => {
  const watch = startWatch(`${SI_APP}/`, []);
  assert.equal(reasonOf(last(judgeAll(watch, [look("about:blank")]))), "not-started");
  const r = judgeSignIn(watch, look("about:blank"));
  assert.equal(r.watch.sawSignIn, false, "a blank tab is not a sign-in screen");
  assert.equal(judgeSignIn(watch, look(`${SI_IDP}/`)).watch.sawSignIn, true);
});

test("a success URL decides instead of the session, once a sign-in screen was seen: reached with no sign-in field is signed in; anywhere else is not", () => {
  const watch = { ...startWatch(`${SI_APP}/`, [], "/dashboard"), sawSignIn: true };
  assert.equal(reasonOf(last(judgeAll(watch, twice(look(`${SI_APP}/dashboard`))))), "signed-in:success-url", "no credential needed");
  assert.equal(
    reasonOf(last(judgeAll(watch, twice(look(`${SI_APP}/home`, { held: [SESSION] }))))),
    "no-session",
    "a new session elsewhere is not the success URL",
  );
  assert.equal(reasonOf(last(judgeAll(watch, twice(look(`${SI_APP}/dashboard`, { signInField: true }))))), "sign-in-screen");
  assert.equal(reasonOf(last(judgeAll(watch, twice(look(`${SI_IDP}/dashboard`))))), "away", "a path is looked for on the app only");
  // The contrast: the same page before any sign-in screen. A success URL the start page matches ("/") would otherwise save at once.
  const fresh = startWatch(`${SI_APP}/`, [], "/");
  assert.equal(reasonOf(last(judgeAll(fresh, twice(look(`${SI_APP}/`))))), "not-started");
  assert.equal(reasonOf(last(judgeAll(fresh, [look(`${SI_APP}/login`), ...twice(look(`${SI_APP}/`))]))), "signed-in:success-url");
  const absolute = { ...startWatch(`${SI_APP}/`, [], "https://portal.test/start"), sawSignIn: true };
  assert.equal(
    reasonOf(last(judgeAll(absolute, twice(look("https://portal.test/start?x=1"))))),
    "signed-in:success-url",
    "an absolute success URL may be on another origin",
  );
  assert.equal(
    reasonOf(last(judgeAll(absolute, twice(look("https://portal.test/start", { signInField: true }))))),
    "sign-in-screen",
    "...and a sign-in field there still holds it",
  );
});

test("a second step with no field (a push to approve, a challenge, an account picker) is still the sign-in", () => {
  const watch = { ...startWatch(`${SI_APP}/`, []), sawSignIn: true };
  for (const p of ["/mfa", "/2fa/push", "/verify", "/auth/challenge", "/select-account", "/log-in"]) {
    assert.equal(reasonOf(last(judgeAll(watch, twice(look(`${SI_APP}${p}`, { held: [SESSION] }))))), "sign-in-screen", p);
  }
  // The contrast: the same partial session on a page that is not a step of the sign-in.
  assert.equal(reasonOf(last(judgeAll(watch, twice(look(`${SI_APP}/verifications`, { held: [SESSION] }))))), "signed-in:credential", "/verifications");
});

test("the app is the origin the window opened at, and the same host's other scheme or www. its first page landed on", () => {
  const upgraded = startWatch("http://app.test/", [], undefined, "https://www.app.test/login");
  assert.deepEqual(upgraded.appOrigins, ["http://app.test", "https://www.app.test"]);
  const done = judgeAll(upgraded, [look("https://www.app.test/login"), ...twice(look("https://www.app.test/home", { held: [SESSION] }))]);
  assert.equal(reasonOf(last(done)), "signed-in:credential");
  // The contrast: a first page on another host is the provider, not the app.
  const sso = startWatch("https://app.test/", [], undefined, "https://login.idp.test/authorize");
  assert.deepEqual(sso.appOrigins, ["https://app.test"]);
  assert.equal(reasonOf(last(judgeAll(sso, twice(look("https://login.idp.test/done", { held: [SESSION] }))))), "away");
});

test("a scout_login window is waited on by every call for its role, and its outcome is kept until a call reports it", async () => {
  let clock = 0;
  const windows = new LoginWindows<{ id: number; done: Promise<string> }>(1000, () => clock);
  let opened = 0;
  const finish = new Map<number, (v: string) => void>();
  const start = async () => {
    opened += 1;
    const id = opened;
    return { id, done: new Promise<string>((r) => finish.set(id, r)) };
  };
  const first = await windows.get("p\0admin", start);
  const again = await windows.get("p\0admin", start);
  assert.equal(opened, 1, "a second call waits on the open window");
  assert.ok(!first.resumed && again.resumed && again.window === first.window);
  assert.equal((await windows.get("p\0viewer", start)).window.id, 2, "another role has its own window");
  // The sign-in finishes between two calls: the next call gets that outcome, not a new window.
  finish.get(1)!("saved");
  await first.window.done;
  await new Promise((r) => setImmediate(r));
  clock = 500;
  const late = await windows.get("p\0admin", start);
  assert.ok(late.resumed && late.window.id === 1 && (await late.window.done) === "saved");
  windows.reported("p\0admin", late.window);
  assert.equal((await windows.get("p\0admin", start)).window.id, 3, "once reported, the next call opens a new window");
  // An outcome nobody asked for is dropped after keepMs.
  const viewer = windows.all().find((w) => w.id === 2)!;
  finish.get(2)!("closed");
  await viewer.done;
  await new Promise((r) => setImmediate(r));
  clock = 5000;
  assert.equal((await windows.get("p\0viewer", start)).window.id, 4);
});
