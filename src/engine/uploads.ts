/**
 * Where an upload's bytes come from, and the fence around reading them off disk.
 *
 * `scout_upload {filePath}` makes the engine read a file chosen by whoever drives
 * it and hand the bytes to the app under test. Unfenced, that is a way to
 * exfiltrate any file the tester's account can read (an SSH key, a browser
 * profile) into a web form. So disk uploads are confined to the attached
 * project, by REAL path, and the rule is a pure function here so it can be
 * tested with real symlinks instead of only through a browser.
 */
import fs from "node:fs";
import path from "node:path";
import { FIXTURE_KINDS, isFixtureKind, mimeForName, type FixtureFile, type FixtureKind } from "./fixtures.js";

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
  project: { projectDir: string; projectDirNote?: string },
  filePath: string,
  name?: string,
): { refused: string } | ResolvedUpload {
  const { projectDir, projectDirNote = "" } = project;
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
