/**
 * The project's memory directory: its name, carrying it over from the tool's
 * earlier name, and the .gitignore that keeps it out of the tested project's
 * commits. Split from memory.ts; memory.ts re-exports these names, so
 * importers are unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { writeDocumentSync } from "./owner-file.js";

/** Per-project directory for memory, session logs, and reports. */
export const MEMORY_DIRNAME = ".scenescout";
/** The one directory under it that is committed rather than ignored: saved flows (flow.ts). */
export const SELF_IGNORE_KEEP = "flows";
/** What the directory was called before the tool was renamed. */
export const LEGACY_MEMORY_DIRNAME = ".scenecraft";

/**
 * Carry a project's memory across the rename. Coverage, findings and notes are
 * the whole point of cross-run memory; starting an empty `.scenescout/` next to
 * a full legacy directory would silently throw every earlier run away and
 * re-report every known finding as new.
 *
 * Only when the new directory does not exist yet — once both are present the
 * new one is authoritative and the old one is left for the user to delete.
 * Returns a note for the attach output, or null when there was nothing to do.
 */
export function adoptLegacyMemoryDir(projectDir: string, isAlive: (pid: number) => boolean = pidAlive): string | null {
  const current = path.join(projectDir, MEMORY_DIRNAME);
  const legacy = path.join(projectDir, LEGACY_MEMORY_DIRNAME);
  if (fs.existsSync(current) || !fs.existsSync(legacy)) return null;
  // A pre-rename engine that is still running holds absolute paths into the
  // legacy directory. Moving it away makes every later write of that run fail,
  // and the only trace is a stderr line nobody reads. Leave it until it exits.
  const owner = liveOwnerPid(legacy, isAlive);
  if (owner !== null) {
    return `A pre-rename engine (pid ${owner}) is still using ${LEGACY_MEMORY_DIRNAME}/, so its memory was NOT moved — this run starts empty. Close that session and re-attach to carry the earlier coverage and findings over.`;
  }
  try {
    fs.renameSync(legacy, current);
  } catch (err) {
    // Two engines attaching at once both pass the guard above; the loser's
    // rename fails because the winner already moved it. That is success.
    if (fs.existsSync(current)) return null;
    // A read-only checkout must not break attach; say what was lost instead.
    return `Could not move ${LEGACY_MEMORY_DIRNAME}/ to ${MEMORY_DIRNAME}/ (${(err as Error).message}) — this run starts without the earlier memory.`;
  }
  return `Moved this project's memory from ${LEGACY_MEMORY_DIRNAME}/ to ${MEMORY_DIRNAME}/ (the tool was renamed); earlier coverage and findings are kept.`;
}

/** Signal 0 probes existence. EPERM means the process exists but is another user's — still alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** The pid named by a memory directory's status.json, when that process is still running and is not us. */
function liveOwnerPid(dir: string, isAlive: (pid: number) => boolean): number | null {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")) as { pid?: number };
    return st.pid && st.pid !== process.pid && isAlive(st.pid) ? st.pid : null;
  } catch {
    return null; // no status file, or a truncated one: nothing is provably using it
  }
}

/**
 * Keep our artifacts out of the tested project's commits.
 *
 * We write memory.json, rolling session logs, status.json and report.md into
 * the project under test, so `.scenescout/` turns up as untracked and a single
 * `git add -A` sweeps a test tool's scratch data into someone else's history.
 *
 * The ignore rule goes INSIDE our own directory rather than in the project's
 * root .gitignore: git reads nested .gitignore files, `*` makes every file
 * here invisible, and a directory holding only ignored files never appears in
 * `git status`. That gets the same result without editing a file we do not
 * own, and it disappears cleanly when someone deletes the directory.
 *
 * The one exception is `flows/`: saved flows are inputs a team commits so
 * CI replays them, not output. A file written before that exception existed
 * is still left alone; docs/ci.md says which two lines to add to it.
 *
 * Best-effort and idempotent — a read-only checkout must never break attach,
 * and an existing file is left exactly as the user left it.
 */
export function writeSelfIgnore(dir: string): string | null {
  try {
    const ignorePath = path.join(dir, ".gitignore");
    if (fs.existsSync(ignorePath)) return null;
    writeDocumentSync(
      ignorePath,
      "# SceneScout exploratory-test artifacts: memory, session logs, status, report.\n" +
        "# Self-ignoring so a `git add -A` in the tested project can never commit them.\n" +
        "*\n" +
        "# Except the flows `scenescout check` replays: they are written to be committed.\n" +
        `!${SELF_IGNORE_KEEP}/\n` +
        `!${SELF_IGNORE_KEEP}/*.json\n`,
    );
    return `Wrote ${MEMORY_DIRNAME}/.gitignore so these test artifacts stay out of your commits.`;
  } catch {
    return null; // housekeeping must never break a run
  }
}
