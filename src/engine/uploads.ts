/**
 * Where an upload's bytes come from, and the fence around reading them off disk.
 *
 * `scout_upload {filePath}` makes the engine read a file chosen by whoever drives
 * it and hand the bytes to the app under test. Unfenced, that is a way to
 * exfiltrate any file the tester's account can read (an SSH key, a browser
 * profile) into a web form. So disk uploads are confined to the attached
 * project, by REAL path, and the rule is a pure function here so it can be
 * tested with real symlinks instead of only through a browser.
 *
 * The project is named by whoever attaches, so the fence alone does not keep a
 * key out: a project attached at a home folder holds `.ssh/`, and every real
 * repository holds `.env`. Credential-shaped paths are therefore refused by
 * name as well, on the path as given and on its real path, unless the operator
 * names the exact file in SCENESCOUT_UPLOAD_ALLOW, a setting of the server's
 * environment the agent cannot change.
 */
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_ALLOW_ENV, isListedPath } from "./allow-paths.js";
import { FIXTURE_KINDS, isFixtureKind, mimeForName, type FixtureFile, type FixtureKind } from "./fixtures.js";

/** Folders whose contents are credentials, wherever they sit in a path, the project's own path included. */
const SECRET_DIRS: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg", ".config", ".kube", ".docker"]);

/** File names that are credentials whatever folder holds them (dotfiles are refused anyway; these say why). */
const SECRET_FILE = /^(\.env.*|\.npmrc|\.netrc|\.pgpass|.*\.(pem|key|p8|p12|pfx|ppk|jks|keystore|asc|kdbx))$/i;

/**
 * An SSH key: `id_` and no extension but `.pub` (id_rsa, id_ed25519, id_rsa_work.pub), or a key type's
 * own name with anything after it (id_rsa.bak, id_ed25519.old). `id_card.png` is a picture.
 */
const SSH_KEY = /^id_([^.]+(\.pub)?|(rsa|dsa|ecdsa|ed25519)(_sk)?[._-].*)$/i;

/**
 * A path segment as Windows opens it: an NTFS stream suffix (`x.key::$DATA`)
 * and trailing dots and spaces (`x.pem.`, `x.pem `) are dropped by the file
 * system, so they must not get a name past the rules above.
 */
function asOpened(part: string): string {
  return part.replace(/:.*$/, "").replace(/[. ]+$/, "") || part;
}

const segments = (p: string): string[] =>
  p
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map(asOpened);

/** The secrets folder a path runs through (`.ssh`, `.aws` and the like), anywhere in it, or undefined. */
export function secretFolderIn(abs: string): string | undefined {
  return segments(abs)
    .slice(0, -1)
    .find((p) => SECRET_DIRS.has(p.toLowerCase()));
}

/**
 * Why a path is credential-shaped, or undefined. `rel` is the path inside the
 * project, where any dotfile or dot-folder counts (`.scenescout/fixtures/`
 * aside, the folder the fence's own refusal suggests); `abs` is the whole path,
 * where only the named secrets folders count, so a project that is itself
 * `~/.aws` does not make its files ordinary.
 */
export function secretPathReason(abs: string, rel: string): string | undefined {
  const secretDir = secretFolderIn(abs);
  if (secretDir) return `it is inside ${secretDir}/, which holds credentials`;
  const parts = segments(rel);
  const base = parts[parts.length - 1] ?? "";
  if (SSH_KEY.test(base)) return "its name is an SSH key's";
  if (SECRET_FILE.test(base)) return "its name is a credential file's";
  // The fixtures folder itself is allowed; a dotfile or hidden folder below it is as hidden as anywhere else.
  const fixtures = parts.length >= 3 && parts[0] === ".scenescout" && parts[1] === "fixtures";
  const dotted = parts.slice(fixtures ? 2 : 0).find((p) => p.startsWith("."));
  if (dotted) return dotted === base ? "it is a dotfile" : `it is inside ${dotted}/, a hidden folder`;
  return undefined;
}

/** Renaming an upload means sending it as an in-memory payload, so it is read whole. */
export const MAX_RENAMED_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface ResolvedUpload {
  /** A path Playwright streams from disk, or an in-memory file. */
  payload: string | FixtureFile;
  name: string;
  mime: string;
  bytes: number;
  source: string;
}

/** A plan's upload `value`: blank → fixture inferred from accept; a kind → that fixture; anything else → a project-relative path. */
export function planUploadOptions(value: string | undefined): { fixture?: FixtureKind; filePath?: string } {
  const spec = (value ?? "").trim();
  if (spec === "") return {};
  const kind = spec.toLowerCase();
  if (isFixtureKind(kind)) return { fixture: kind };
  return { filePath: spec };
}

/**
 * Resolve a project-relative (or absolute) path to an upload payload, refusing
 * anything that lands outside the project once symlinks are followed.
 * `projectDir` must already be a real path; `projectDirNote` explains, in the
 * refusal, when it could not be resolved.
 */
export function resolveDiskUpload(
  project: { projectDir: string; projectDirNote?: string; allow?: readonly string[] },
  filePath: string,
  name?: string,
): { refused: string } | ResolvedUpload {
  const { projectDir, projectDirNote = "", allow = [] } = project;
  if (!projectDir) return { refused: "Not attached — uploads need a session with a project." };
  const resolved = path.resolve(projectDir, filePath);
  // realpath, so a symlink inside the project cannot point the upload at a
  // file outside it. A missing path stays as resolved and is reported below.
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    /* missing — the stat below says so */
  }
  const rel = path.relative(projectDir, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      refused:
        `REFUSED: filePath ${filePath} is outside the attached project (${projectDir})${projectDirNote}. Uploads are fenced to the project under test, ` +
        `as navigation is fenced to its origin — copy the fixture into the project (e.g. .scenescout/fixtures/) or omit filePath to upload a generated one.`,
    };
  }
  // Judged on the path as given and on where it really leads: a link named
  // avatar.png into .ssh/ and a link named .env to anything are both refused.
  const reason = secretPathReason(resolved, path.relative(projectDir, resolved)) ?? secretPathReason(real, rel);
  if (reason && !isListedPath(allow, resolved, real)) {
    return {
      refused:
        `REFUSED: filePath ${filePath} looks like a credential (${reason}), so it is not read into the page. ` +
        `Upload a generated file instead (omit filePath, or pass fixture: ${FIXTURE_KINDS.join(" | ")}), or copy a harmless test file into the project. ` +
        `If this exact file really is meant to be uploaded, the person running SceneScout can name it in the server's ${UPLOAD_ALLOW_ENV} setting ` +
        `(absolute paths, separated by "${path.delimiter}"); it cannot be set from a tool call.`,
    };
  }
  const stat = fs.statSync(real, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    return {
      refused: `filePath not found (or not a file): ${real}. To upload a generated file instead, omit filePath (or pass fixture: ${FIXTURE_KINDS.join(" | ")}).`,
    };
  }
  const finalName = name ?? path.basename(real);
  const mime = mimeForName(finalName);
  if (!name) return { payload: real, name: finalName, mime, bytes: stat.size, source: `from disk: ${rel}` };
  // A renamed upload has to travel as an in-memory payload.
  if (stat.size > MAX_RENAMED_UPLOAD_BYTES) {
    return { refused: `Renaming an upload reads it into memory; ${real} is ${stat.size} bytes — pass it without name, or use a smaller file.` };
  }
  return {
    payload: { name: finalName, mimeType: mime, buffer: fs.readFileSync(real) },
    name: finalName,
    mime,
    bytes: stat.size,
    source: `from disk: ${rel}, as ${finalName}`,
  };
}
