/**
 * Writing a file under `.scenescout/` so that nothing already at its name
 * decides where the bytes go or who can read them.
 *
 * Two kinds of file, two modes. What only the engine reads, or what could
 * open a session (the live token, status files, memory.json, the session
 * log), is owner-only. What a person reads or another tool serves (the
 * report, ASSUMPTIONS.md, the self-ignoring .gitignore, frames, pictures and
 * captures) is born with the mode the user's umask gives any new file, as it
 * was before: a 0600 report cannot be opened by a teammate on a shared
 * checkout or a web server, and a 0600 .gitignore makes another user's git
 * see every file it was there to hide. Both kinds are written the same way.
 *
 * A plain write follows a symbolic link left at the name, sending the content
 * into whatever file the link points at, and `mode` applies only when a file
 * is created, so a file already there keeps its bits. Each whole-file write
 * here is born with its mode under a fresh temporary name ("wx": created now,
 * never through a link) and renamed into place. A rename replaces the entry,
 * link or file, and never writes through it. A write that fails removes its
 * temporary file, which holds the same content.
 *
 * An append-only log cannot be rewritten for every line, so an append opens
 * the file with O_NOFOLLOW instead: a link at the name is refused, never
 * followed.
 */
import crypto from "node:crypto";
import fs from "node:fs";

/** Owner read and write, nobody else. */
export const OWNER_ONLY = 0o600;
/** Whatever the user's umask leaves of read and write for all: a new file's usual mode. */
export const USER_DOCUMENT = 0o666;
export type FileMode = typeof OWNER_ONLY | typeof USER_DOCUMENT;

/** A temporary name beside `file`, unique to this process and this write. */
export function tempNameFor(file: string): string {
  return `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
}

/** Replace `file` with `data`, owner-only, without writing through anything at its name. */
export function writeOwnerOnly(file: string, data: string | Uint8Array): Promise<void> {
  return writeReplacing(file, data, OWNER_ONLY);
}

/** Replace `file` with `data`, with the mode the user's umask gives, without writing through anything at its name. */
export function writeDocument(file: string, data: string | Uint8Array): Promise<void> {
  return writeReplacing(file, data, USER_DOCUMENT);
}

/** The same, synchronously, for the callers that cannot wait. */
export function writeOwnerOnlySync(file: string, data: string | Uint8Array): void {
  writeReplacingSync(file, data, OWNER_ONLY);
}

/** The same, synchronously, for the callers that cannot wait. */
export function writeDocumentSync(file: string, data: string | Uint8Array): void {
  writeReplacingSync(file, data, USER_DOCUMENT);
}

/** Write `data` to a fresh temporary file born with `mode` (less the umask), then rename it over `file`. */
async function writeReplacing(file: string, data: string | Uint8Array, mode: FileMode): Promise<void> {
  const temp = tempNameFor(file);
  try {
    const handle = await fs.promises.open(temp, "wx", mode);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temp, file);
  } catch (err) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

function writeReplacingSync(file: string, data: string | Uint8Array, mode: FileMode): void {
  const temp = tempNameFor(file);
  try {
    const fd = fs.openSync(temp, "wx", mode);
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The write's own error is the one to report; a temporary file that would not go is the lesser problem.
    }
    throw err;
  }
}

/**
 * Append to `file`, creating it owner-only. A symbolic link at the name is
 * refused: O_NOFOLLOW where the platform has it, and a check of the entry
 * where it does not (Windows, where making a link takes a privilege).
 */
export function appendOwnerOnlySync(file: string, data: string): void {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (noFollow === undefined) {
    let isLink = false;
    try {
      isLink = fs.lstatSync(file).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (isLink) throw new Error(`${file} is a symbolic link; SceneScout does not write through one`);
    fs.appendFileSync(file, data, { mode: OWNER_ONLY });
    return;
  }
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow, OWNER_ONLY);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${file} is a symbolic link; SceneScout does not write through one`);
    throw err;
  }
  try {
    // At the end, whatever the position: the file was opened O_APPEND.
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}
