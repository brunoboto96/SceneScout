/**
 * Named sign-in profiles: a role's saved browser state, recorded once by
 * `scenescout login <url> --role <name>` and attached by any number of
 * sessions with `scout_attach { role }`.
 *
 * Everything here is Playwright-free so it can be table-tested: where a
 * profile lives, which role names are allowed, how the file is written
 * (owner-only), and how an attach turns `role` into the storage state it
 * loads. The browser half — opening a window and reading its state back — is
 * in login-run.ts.
 *
 * A profile is a Playwright storage state (live session cookies, and
 * localStorage and IndexedDB per origin) for the app it was recorded against,
 * plus the sessionStorage Playwright's storage state leaves out: several
 * single-page-app sign-in libraries keep their tokens there, so without it a
 * restored session looks signed out. It is never printed,
 * never logged, and never leaves the project's .scenescout/ directory, which
 * ignores itself in git.
 */
import fs from "node:fs";
import path from "node:path";
import { BROWSER_ENGINES, type BrowserEngineName } from "../browsers.js";
import { MEMORY_DIRNAME, writeSelfIgnore } from "./memory.js";
import { SCRIPT_FLAGS } from "./scripted-login.js";

/** The directory under .scenescout/ that holds one file per role. */
export const AUTH_DIRNAME = "auth";

/** Owner read/write only: a profile is a live session. */
export const PROFILE_FILE_MODE = 0o600;
/** Owner only: listing the directory already says which roles have sessions. */
export const PROFILE_DIR_MODE = 0o700;

/** Longest role name. It becomes a filename and a label on the live view. */
export const ROLE_NAME_MAX = 40;

/**
 * A role name: letters, digits, `-` and `_`, starting with a letter or digit,
 * compared and stored lower-case.
 * Nothing that could be a path (no `/`, `\`, `.`), nothing hidden, nothing a
 * shell would need quoting for.
 */
const ROLE_NAME_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${ROLE_NAME_MAX - 1}}$`);

/**
 * Names Windows refuses as a file whatever the extension, compared without case.
 * "anonymous" is what a session with no sign-in is called, so a profile under that
 * name would make two different sessions read alike.
 */
const RESERVED_ROLE_NAMES = new Set(["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => [`com${i + 1}`, `lpt${i + 1}`]).flat(), "anonymous"]);

export type RoleCheck = { ok: true; role: string } | { ok: false; error: string };

/** Validate a role name at the boundary, before it goes anywhere near a path. */
export function validateRoleName(raw: unknown): RoleCheck {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "give a role name, e.g. --role admin" };
  if (!ROLE_NAME_RE.test(raw)) {
    return {
      ok: false,
      error: `role "${raw.slice(0, 60)}" is not allowed: use up to ${ROLE_NAME_MAX} letters, digits, "-" or "_", starting with a letter or digit`,
    };
  }
  if (RESERVED_ROLE_NAMES.has(raw.toLowerCase())) return { ok: false, error: `role "${raw}" is a reserved name; choose another` };
  // Lower-cased: on a case-insensitive filesystem "Admin" and "admin" are one
  // file, and recording one would silently replace the other.
  return { ok: true, role: raw.toLowerCase() };
}

/** Where a project's profiles live. */
export function profileDir(projectDir: string): string {
  return path.join(path.resolve(projectDir), MEMORY_DIRNAME, AUTH_DIRNAME);
}

/** Where one role's profile lives. Throws on a name that did not pass validateRoleName: a caller that skipped the check is a bug. */
export function profilePath(projectDir: string, role: string): string {
  const checked = validateRoleName(role);
  if (!checked.ok) throw new Error(checked.error);
  const dir = profileDir(projectDir);
  const file = path.join(dir, `${checked.role}.json`);
  // Belt and braces: the name rules already make this impossible.
  if (path.dirname(file) !== dir) throw new Error(`role "${role}" resolves outside ${dir}`);
  return file;
}

/** The roles with a saved profile, sorted. A project with no profile directory has none; any other read error is thrown. */
export function listProfiles(projectDir: string, readdir: (dir: string) => string[] = (d) => fs.readdirSync(d)): string[] {
  let names: string[];
  try {
    names = readdir(profileDir(projectDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .filter((n) => validateRoleName(n).ok)
    .sort();
}

/** The part of a storage state this module reads. The rest is carried through untouched. */
export interface StorageStateShape {
  cookies: unknown[];
  origins: unknown[];
}

/** One origin's sessionStorage, as a profile keeps it. */
export interface SessionStorageOrigin {
  origin: string;
  entries: { name: string; value: string }[];
}

/**
 * A profile on disk: the storage state Playwright restores itself, plus the
 * sessionStorage it has no field for. A profile saved before sessionStorage
 * was captured has no `sessionStorage` key and loads as it always did.
 */
export interface ProfileShape extends StorageStateShape {
  sessionStorage?: SessionStorageOrigin[];
}

/**
 * The key the restore script leaves in a tab's sessionStorage once it has
 * seeded that origin, so a page reloaded or navigated within the tab keeps
 * what the app has since written (or removed) instead of being seeded again.
 * Never captured into a profile.
 */
export const SESSION_RESTORED_MARKER = "__scenescout_session_restored";

/** A real origin a script can match against `location.origin`; opaque ("null"), about:, data: and file: frames have nothing to keep. */
function isWebOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string") return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
  } catch {
    return false;
  }
}

/**
 * Merge what each frame of each open tab held in sessionStorage into one list
 * per origin. Two tabs on one origin each have their own sessionStorage; the
 * profile keeps one, so a later read of the same key wins. Opaque origins,
 * non-string values and the restore marker are dropped; an origin left with
 * nothing is left out.
 */
export function mergeSessionStorage(frames: readonly { origin: unknown; entries: unknown }[]): SessionStorageOrigin[] {
  const byOrigin = new Map<string, Map<string, string>>();
  for (const frame of frames) {
    if (!isWebOrigin(frame.origin) || !Array.isArray(frame.entries)) continue;
    const kept = byOrigin.get(frame.origin) ?? new Map<string, string>();
    for (const entry of frame.entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [name, value] = entry as unknown[];
      if (typeof name !== "string" || typeof value !== "string" || name === SESSION_RESTORED_MARKER) continue;
      kept.set(name, value);
    }
    byOrigin.set(frame.origin, kept);
  }
  return [...byOrigin]
    .filter(([, entries]) => entries.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([origin, entries]) => ({ origin, entries: [...entries].map(([name, value]) => ({ name, value })) }));
}

/** A storage state with sessionStorage added, when there is any to add. */
export function withSessionStorage(state: unknown, sessionStorage: SessionStorageOrigin[]): unknown {
  if (sessionStorage.length === 0 || !state || typeof state !== "object") return state;
  return { ...(state as object), sessionStorage };
}

/**
 * Split a profile read from disk into what Playwright restores (the storage
 * state, handed to newContext) and the sessionStorage restored by script.
 * A malformed sessionStorage list is refused rather than half-applied: a
 * session that silently loses its token tests a signed-out app.
 */
export function splitProfile(raw: unknown): { storageState: StorageStateShape; sessionStorage: SessionStorageOrigin[] } {
  const checked = summarizeState(raw);
  if (!checked.ok) throw new Error(checked.error);
  const { sessionStorage, ...storageState } = raw as ProfileShape;
  if (sessionStorage === undefined) return { storageState, sessionStorage: [] };
  const valid =
    Array.isArray(sessionStorage) &&
    sessionStorage.every(
      (o) => o && isWebOrigin(o.origin) && Array.isArray(o.entries) && o.entries.every((e) => e && typeof e.name === "string" && typeof e.value === "string"),
    );
  if (!valid) throw new Error("the profile's sessionStorage list is malformed: record it again with `scenescout login`");
  return { storageState, sessionStorage };
}

/**
 * The init script that restores sessionStorage. It runs in every frame before
 * the page's own code, and writes only into a frame whose origin is one the
 * profile holds, only once per tab: after that the app's own writes stand.
 * An app that signs out with sessionStorage.clear() would take the marker with
 * it and be signed back in on the next page, so in those frames clear() puts
 * the marker back after clearing. Values go in as JSON, so nothing in them is
 * ever run. No sessionStorage to restore: no script.
 */
export function sessionStorageInitScript(sessionStorage: readonly SessionStorageOrigin[]): string | null {
  if (sessionStorage.length === 0) return null;
  const seed: Record<string, [string, string][]> = {};
  for (const o of sessionStorage) seed[o.origin] = o.entries.map((e) => [e.name, e.value]);
  return `(() => {
  const seed = ${JSON.stringify(seed)};
  const marker = ${JSON.stringify(SESSION_RESTORED_MARKER)};
  if (!Object.prototype.hasOwnProperty.call(seed, location.origin)) return;
  const proto = Object.getPrototypeOf(sessionStorage);
  const clear = proto.clear;
  proto.clear = function () {
    clear.call(this);
    if (this === sessionStorage) this.setItem(marker, "1");
  };
  if (sessionStorage.getItem(marker) !== null) return;
  for (const [name, value] of seed[location.origin]) sessionStorage.setItem(name, value);
  sessionStorage.setItem(marker, "1");
})();`;
}

/** What is safe to print about a profile: how much it holds, never what. */
export interface ProfileSummary {
  cookies: number;
  /** Origins with localStorage or IndexedDB (Playwright's `origins` list). */
  origins: number;
  /** Origins with sessionStorage. */
  sessionOrigins: number;
  /** IndexedDB databases, across every origin. */
  indexedDBs: number;
}

/** Check the shape of a storage state before writing it; a profile nobody can load is worse than none. */
export function summarizeState(state: unknown): { ok: true; summary: ProfileSummary } | { ok: false; error: string } {
  if (!state || typeof state !== "object") return { ok: false, error: "the browser returned no storage state" };
  const s = state as Partial<ProfileShape>;
  if (!Array.isArray(s.cookies) || !Array.isArray(s.origins)) return { ok: false, error: "the storage state has no cookies or origins list" };
  const indexedDBs = s.origins.reduce<number>((n, o) => {
    const dbs = o && typeof o === "object" ? (o as { indexedDB?: unknown }).indexedDB : undefined;
    return n + (Array.isArray(dbs) ? dbs.length : 0);
  }, 0);
  const sessionOrigins = Array.isArray(s.sessionStorage) ? s.sessionStorage.length : 0;
  return { ok: true, summary: { cookies: s.cookies.length, origins: s.origins.length, sessionOrigins, indexedDBs } };
}

/** The one line printed after saving: where, and how much. Never the contents. */
export function describeSaved(file: string, summary: ProfileSummary): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    `Saved to ${file} (${plural(summary.cookies, "cookie")}, ${plural(summary.origins, "origin")} with local storage or IndexedDB, ` +
    `${plural(summary.sessionOrigins, "origin")} with session storage, ${plural(summary.indexedDBs, "IndexedDB database")}).`
  );
}

/**
 * Write a profile, owner-only. The directory is created 0700 (and tightened
 * if it already existed looser), the file is written under a temporary name
 * created 0600 and renamed into place, so a half-written profile is never
 * attached and the contents never sit in a file anyone else can read, even
 * for a moment. .scenescout/ gets its self-ignoring .gitignore if it has
 * none, so a profile recorded before the first run is still never staged.
 */
export function writeProfile(projectDir: string, role: string, state: unknown): { path: string; summary: ProfileSummary } {
  const file = profilePath(projectDir, role);
  const checked = summarizeState(state);
  if (!checked.ok) throw new Error(checked.error);
  const dir = path.dirname(file);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  writeSelfIgnore(path.dirname(dir));
  fs.mkdirSync(dir, { recursive: true, mode: PROFILE_DIR_MODE });
  fs.chmodSync(dir, PROFILE_DIR_MODE);
  const temp = `${file}.${process.pid}.tmp`;
  // A temporary file left by a crashed write may have any mode: remove it, then
  // create afresh ("wx") so the mode given here is the one the file is born with.
  fs.rmSync(temp, { force: true });
  const fd = fs.openSync(temp, "wx", PROFILE_FILE_MODE);
  try {
    fs.writeFileSync(fd, JSON.stringify(state));
  } finally {
    fs.closeSync(fd);
  }
  // No chmod needed: a umask can only take bits away from 0600.
  fs.renameSync(temp, file);
  return { path: file, summary: checked.summary };
}

/**
 * Whether a file mode lets anyone but the owner read or write it. Windows
 * has no such bits to read, so it is never judged there.
 */
export function isLooserThanOwner(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false;
  return (mode & 0o077) !== 0;
}

/**
 * What an attach says about a profile others can read — someone loosened it,
 * or copied it in with a wider mode. Said, not refused: the session is still
 * the one the person recorded, and tightening it is one command.
 */
export function permissionNote(file: string, mode: number, platform: NodeJS.Platform = process.platform): string | null {
  if (!isLooserThanOwner(mode, platform)) return null;
  return `The profile at ${file} can be read by other accounts on this machine (mode ${(mode & 0o777).toString(8)}); it holds a live session. Tighten it: chmod 600 "${file}"`;
}

/** The command that records a role's profile, with the URL when it is known. */
export function loginCommand(role: string, url?: string): string {
  return `scenescout login ${url ?? "<url>"} --role ${role}`;
}

/** How a session signs in: a role profile, a storage-state file given by path, or not at all. */
export type AttachAuth = { kind: "role"; role: string; storageStatePath: string } | { kind: "file"; storageStatePath: string } | { kind: "none" };

/**
 * Turn scout_attach's `role` and `storageStatePath` into the one storage state
 * the session loads. Both at once is refused rather than letting one win
 * silently. A missing profile names the command that records it.
 */
export function resolveAttachAuth(
  opts: { projectDir: string; url?: string; role?: string; storageStatePath?: string },
  exists: (p: string) => boolean = fs.existsSync,
  listRoles: (projectDir: string) => string[] = listProfiles,
): AttachAuth {
  if (opts.role !== undefined && opts.storageStatePath !== undefined) {
    throw new Error("pass role or storageStatePath, not both: role loads the profile saved by `scenescout login`, storageStatePath loads a file you name");
  }
  if (opts.role !== undefined) {
    const checked = validateRoleName(opts.role);
    if (!checked.ok) throw new Error(checked.error);
    const file = profilePath(opts.projectDir, checked.role);
    if (!exists(file)) {
      let saved: string[] = [];
      try {
        saved = listRoles(opts.projectDir);
      } catch {
        /* the list is a hint in the message; the refusal stands without it */
      }
      throw new Error(
        `no sign-in is saved for role "${checked.role}" in this project. Run \`${loginCommand(checked.role, opts.url)}\`, sign in in the window it opens, then attach again.` +
          (saved.length > 0 ? ` Saved roles: ${saved.join(", ")}.` : ""),
      );
    }
    return { kind: "role", role: checked.role, storageStatePath: file };
  }
  if (opts.storageStatePath !== undefined) return { kind: "file", storageStatePath: opts.storageStatePath };
  return { kind: "none" };
}

/** The name a session is shown under: its role, the file's name, or anonymous. */
export function roleLabel(auth: AttachAuth): string {
  if (auth.kind === "role") return auth.role;
  if (auth.kind === "file") return path.basename(auth.storageStatePath).replace(/\.json$/i, "");
  return "anonymous";
}

// ── scenescout login ─────────────────────────────────────────────────────────

export interface LoginOptions {
  url: string;
  role: string;
  projectDir: string;
  browser?: BrowserEngineName;
  /** `--script`: sign in headless from the environment's credentials (engine/scripted-login.ts), with these of its flags given. */
  script?: Map<string, string>;
}

export const LOGIN_OPTION_NAMES = ["role", "project", "browser"] as const;

/**
 * Parse `scenescout login <url> --role <name> [--project dir] [--browser engine]
 * [--script [--success-url …] [--timeout s] …]`. `--script` takes no value; the
 * flags only it reads are refused without it.
 */
export function parseLoginArgs(args: readonly string[], cwd: string): { ok: true; options: LoginOptions } | { ok: false; error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let script = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (a === "--script") {
      script = true;
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const value = eq > 0 ? a.slice(eq + 1) : args[i + 1];
    if (value === undefined || (eq < 0 && value.startsWith("--"))) return { ok: false, error: `--${name} needs a value` };
    if (eq < 0) i += 1;
    flags.set(name, value);
  }
  const known = new Set<string>(LOGIN_OPTION_NAMES);
  const scriptOnly = new Set<string>(SCRIPT_FLAGS);
  for (const name of flags.keys()) {
    if (scriptOnly.has(name) && !script) return { ok: false, error: `--${name} only applies with --script` };
    if (!known.has(name) && !scriptOnly.has(name)) return { ok: false, error: `unknown option --${name}` };
  }
  if (positional.length !== 1) return { ok: false, error: "give exactly one URL to sign in at, e.g. scenescout login http://127.0.0.1:3000 --role admin" };
  let url: URL;
  try {
    url = new URL(positional[0]);
  } catch {
    return { ok: false, error: `not a URL: ${positional[0]}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: `only http and https URLs can be opened (got ${url.protocol})` };
  if (url.username || url.password) return { ok: false, error: "put no credentials in the URL: sign in in the window instead" };
  const role = validateRoleName(flags.get("role"));
  if (!role.ok) return { ok: false, error: role.error };
  const browser = flags.get("browser");
  if (browser !== undefined && !(BROWSER_ENGINES as readonly string[]).includes(browser)) {
    return { ok: false, error: `--browser must be one of ${BROWSER_ENGINES.join(", ")}` };
  }
  return {
    ok: true,
    options: {
      url: url.href,
      role: role.role,
      projectDir: path.resolve(cwd, flags.get("project") ?? "."),
      ...(browser ? { browser: browser as BrowserEngineName } : {}),
      ...(script ? { script: new Map([...flags].filter(([name]) => scriptOnly.has(name))) } : {}),
    },
  };
}
