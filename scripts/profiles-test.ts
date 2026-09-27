/**
 * Named sign-in profiles: which role names are allowed, where a profile lives,
 * that it is written owner-only and ignored by git, what may be printed about
 * it, and how scout_attach turns `role` into the file it loads.
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
  resolveAttachAuth,
  roleLabel,
  summarizeState,
  validateRoleName,
  writeProfile,
} from "../src/engine/profiles.ts";

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
