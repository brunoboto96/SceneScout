/**
 * Where a run keeps its notes, memory and report when the agent names no
 * project folder (scout_attach `projectPath`).
 *
 * A client with no workspace (a desktop chat app, say) has no folder to offer,
 * and a person testing a site should not be asked to invent one. So each tested
 * site gets its own folder under the user's documents folder, such as
 * `Documents/SceneScout/localhost-3000/`, created on first use.
 *
 * What wins, first to last:
 *   1. the `projectPath` the attach names, always;
 *   2. the client's workspace folder, when it offers one (MCP roots);
 *   3. the per-site default, unless PROJECTS_DIR_ENV is `off`.
 * The default is never placed inside a git repository below the home folder: a
 * folder of recordings and saved logins does not belong in somebody's commits
 * unless they chose it. A home folder that is itself a repository (dotfiles)
 * does not count.
 *
 * Everything here is pure (the filesystem is passed in), so it is table-tested
 * in memory-test.
 */
import path from "node:path";
import { domainToUnicode, fileURLToPath } from "node:url";
import { MEMORY_DIRNAME } from "./memory.js";

/** The setting: an absolute folder that holds one folder per tested site, or `off`. */
export const PROJECTS_DIR_ENV = "SCENESCOUT_PROJECTS_DIR";
/** The folder made under the documents folder when the setting is unset. */
export const DEFAULT_PROJECTS_DIRNAME = "SceneScout";

/** The parts of the environment the documents folder depends on. */
export interface Home {
  platform: NodeJS.Platform;
  /** os.homedir(). */
  homedir: string;
  env: Record<string, string | undefined>;
  /** Linux: the contents of ~/.config/user-dirs.dirs, when there is one. */
  userDirs?: string;
}

/**
 * The user's documents folder. Windows: `%USERPROFILE%\Documents`; Linux and
 * others: XDG_DOCUMENTS_DIR from the environment or user-dirs.dirs (which the
 * server reads on Linux only), else
 * `~/Documents`; macOS: `~/Documents`.
 */
export function documentsDir(home: Home): string {
  if (home.platform === "win32") {
    const profile = home.env.USERPROFILE && path.win32.isAbsolute(home.env.USERPROFILE) ? home.env.USERPROFILE : home.homedir;
    return path.win32.join(profile, "Documents");
  }
  if (home.platform !== "darwin") {
    const fromEnv = home.env.XDG_DOCUMENTS_DIR;
    const fromFile = home.userDirs?.match(/^\s*XDG_DOCUMENTS_DIR\s*=\s*"([^"\n]*)"/m)?.[1];
    for (const raw of [fromEnv, fromFile]) {
      if (!raw) continue;
      const expanded = raw.replace(/^\$HOME(?=\/|$)/, home.homedir);
      if (!path.posix.isAbsolute(expanded)) continue;
      // resolve() drops a trailing slash, so "$HOME/" compares equal to the home folder.
      const dir = path.posix.resolve(expanded);
      // XDG says a documents folder equal to $HOME means "none": fall through to ~/Documents.
      if (dir !== path.posix.resolve(home.homedir)) return dir;
    }
  }
  return path.posix.join(home.homedir, "Documents");
}

/** Names Windows reserves, which no folder may take, whatever its extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * The folder name for a tested site: its host as a person would write it, with
 * the port when there is one. `http://localhost:3000` → `localhost-3000`,
 * `https://xn--bcher-kva.example/` → `bücher.example`, `http://[::1]:8080` →
 * `ipv6-__1-8080`. Two addresses of one site (http and https, any path) share
 * a folder; a different port is a different site. Throws for an address with
 * no host, which has no site to name.
 */
export function siteFolderName(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a full address, so there is no site to name a folder after. Pass projectPath.`);
  }
  let host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) throw new Error(`"${url}" has no host, so there is no site to name a folder after. Pass projectPath.`);
  if (host.startsWith("[")) host = `ipv6-${host.slice(1, -1).replace(/:/g, "_")}`;
  else host = domainToUnicode(host).normalize("NFC") || host;
  // A hostname holds only letters, digits, hyphens and dots, but say so here
  // rather than trust it: this becomes one path segment.
  host = host.replace(/[^\p{L}\p{M}\p{N}._-]/gu, "_").replace(/^\.+/, "_");
  if (RESERVED.test(host)) host = `site-${host}`;
  return parsed.port ? `${host}-${parsed.port}` : host;
}

/**
 * The folder holding one folder per site: the setting when it names an
 * absolute folder, `null` when it is `off`, else `<documents>/SceneScout`.
 * A setting that is neither throws, naming the variable.
 */
export function projectsRoot(home: Home): string | null {
  const setting = home.env[PROJECTS_DIR_ENV]?.trim();
  const p = home.platform === "win32" ? path.win32 : path.posix;
  if (setting) {
    if (setting.toLowerCase() === "off") return null;
    if (!p.isAbsolute(setting)) throw new Error(`${PROJECTS_DIR_ENV} must be an absolute folder or "off", not "${setting}".`);
    return p.normalize(setting);
  }
  return p.join(documentsDir(home), DEFAULT_PROJECTS_DIRNAME);
}

/**
 * The git repository a folder would sit inside: the nearest folder, the folder
 * itself included, holding a `.git` (a directory, or a file in a worktree).
 * `exists` is fs.existsSync in use; the folder need not exist yet.
 *
 * With `stopAt` (the home folder), the walk ends below it: a home folder that
 * is itself a repository, as a dotfiles setup makes it, does not count, since
 * refusing every default folder there is worse than one untracked folder in
 * it. A folder outside `stopAt` is walked to the root.
 */
export function enclosingRepo(dir: string, exists: (p: string) => boolean, platform: NodeJS.Platform = process.platform, stopAt?: string): string | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  const same = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const stop = stopAt === undefined ? undefined : p.resolve(stopAt);
  for (let at = p.resolve(dir); ;) {
    if (stop !== undefined && same(at, stop)) return null;
    if (exists(p.join(at, ".git"))) return at;
    const up = p.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * The first workspace folder a client offers as MCP roots, or null. Only `file:`
 * roots name a folder, read as `platform` reads them: `file:///C:/work/app` is
 * `C:\\work\\app` on Windows, and a root with no drive letter is no folder there.
 */
export function workspaceFromRoots(roots: Array<{ uri: string }> | undefined, platform: NodeJS.Platform = process.platform): string | null {
  for (const root of roots ?? []) {
    if (!root.uri.startsWith("file:")) continue;
    try {
      return fileURLToPath(root.uri, { windows: platform === "win32" });
    } catch {
      continue; // a file: URI naming another host, or no absolute path on this platform: not a folder here
    }
  }
  return null;
}

export type ProjectFolder = { dir: string; source: "given" | "workspace" | "default"; note: string } | { refused: string };

/**
 * Which folder a run keeps its files in, and the plain line that says so.
 * `given` is the attach's projectPath; `workspace` the client's folder, if any.
 */
export function chooseProjectFolder(input: {
  given?: string;
  workspace?: string | null;
  url: string;
  home: Home;
  exists: (p: string) => boolean;
}): ProjectFolder {
  if (input.given !== undefined) return { dir: input.given, source: "given", note: "" };
  if (input.workspace) {
    return {
      dir: input.workspace,
      source: "workspace",
      note: `📁 FILES: no projectPath was given, so this run's notes, memory, sign-ins and report are kept in your workspace folder, under ${input.workspace}.`,
    };
  }
  let root: string | null;
  let name: string;
  try {
    root = projectsRoot(input.home);
    name = siteFolderName(input.url);
  } catch (err) {
    return { refused: `No projectPath was given and no default folder could be chosen: ${(err as Error).message}` };
  }
  if (root === null)
    return {
      refused: `No projectPath was given, and ${PROJECTS_DIR_ENV} is "off", so there is no default folder. Pass projectPath: the folder this run's notes, memory and report go in.`,
    };
  const p = input.home.platform === "win32" ? path.win32 : path.posix;
  const dir = p.join(root, name);
  const repo = enclosingRepo(dir, input.exists, input.home.platform, input.home.homedir);
  if (repo)
    return {
      refused:
        `No projectPath was given, and the default folder ${dir} would be inside the git repository ${repo}, where a run's recordings and saved logins could be committed. ` +
        `Pass projectPath to choose a folder (inside that repository too, if that is what you want), or set ${PROJECTS_DIR_ENV} to a folder outside it.`,
    };
  return {
    dir,
    source: "default",
    note:
      `📁 FILES: this site's notes, memory, sign-ins and report are kept in ${dir} — a folder SceneScout made for this site, since none was given. ` +
      `The report will be ${p.join(dir, MEMORY_DIRNAME, "report.md")}. Pass projectPath, or set ${PROJECTS_DIR_ENV}, to keep them elsewhere.`,
  };
}
