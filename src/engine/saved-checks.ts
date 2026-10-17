/**
 * Saved guided checks (design section 2.8): a person's choices kept under a
 * name, so the same check can be run again with one press.
 *
 * A saved check holds the choices and nothing else: the address, the areas,
 * the journey sentence, pasted tickets, how the person signs in (never with
 * what), the care level and how thorough. Its schema has no field for a
 * password, a code, a token or a cookie, and a file with any field it does not
 * name is refused rather than read, so nothing can ride along in one. Running
 * it again builds a new plan from the choices, unaccepted: a care level that
 * needs the person's confirmation asks for it again every time (ADR 24).
 *
 * They live in the project's `.scenescout/guided/`, one file per check,
 * owner-only like sign-in profiles, and the folder's self-ignoring .gitignore
 * keeps them out of the project's commits. The rules are table-tested in
 * guided-test; nothing here launches a browser or talks to a client.
 */
import fs from "node:fs";
import path from "node:path";
import { checkGuidedChoices, holdsCredential, type Checked, type GuidedChoices, type GuidedPlan } from "./guided.js";
import { SAVED_WORDS } from "./guided-words.js";
import { MEMORY_DIRNAME, writeSelfIgnore } from "./memory-dir.js";
import { writeOwnerOnlySync } from "./owner-file.js";
import { secretWordKind } from "./sensitive.js";

/** What a saved check holds. Never a password, code, token or cookie. */
export interface SavedCheck {
  /** Letters, digits, spaces and dashes; at most MAX_SAVED_NAME. */
  name: string;
  choices: GuidedChoices;
  /** ISO time it was saved. */
  savedAt: string;
  /** ISO time it was last run again. */
  lastRunAt?: string;
}

/** The directory under .scenescout/ that holds one file per saved check. */
export const SAVED_CHECKS_DIRNAME = "guided";
/** Owner read and write only, as a sign-in profile: the choices name the site and how the person signs in. */
export const SAVED_CHECK_FILE_MODE = 0o600;
export const SAVED_CHECK_DIR_MODE = 0o700;
/** The longest name. */
export const MAX_SAVED_NAME = 60;
/** The most saved checks one project keeps. */
export const MAX_SAVED_CHECKS = 50;

/** Every field a saved check has. Any other is refused. */
export const SAVED_FIELDS = ["name", "choices", "savedAt", "lastRunAt"] as const;

/** Field names that would carry sign-in material, beyond what secretWordKind reads as a secret. */
const SIGN_IN_FIELD = /cookie|storage.?state|authori[sz]ation|credential|^auth|^headers?$/i;

/** Names Windows refuses as a file, whatever the extension: COM and LPT take a superscript 1 to 3 as well as a digit. */
const RESERVED_FILE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].flatMap((d) => [`com${d}`, `lpt${d}`]),
]);

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;

const NO_CREDENTIALS = "a saved check keeps your choices only, never a password, code, token or cookie";

/** A saved check's name, checked: trimmed, inner spaces collapsed, and refused with one sentence that never repeats it. */
export function checkSavedName(raw: unknown): Checked<string> {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "give the check a name, e.g. Shop sign-up on a phone" };
  const name = raw.trim().replace(/ +/g, " ").normalize("NFC");
  if (name.length > MAX_SAVED_NAME) return { ok: false, error: `the name is longer than ${MAX_SAVED_NAME} characters` };
  if (!NAME_RE.test(name)) return { ok: false, error: "use only letters, digits, spaces and dashes in the name, starting with a letter or digit" };
  if (holdsCredential(name)) return { ok: false, error: `the name holds what looks like a password, code or token: ${NO_CREDENTIALS}` };
  if (RESERVED_FILE_NAMES.has(savedCheckSlug(name))) return { ok: false, error: "that name is reserved by some computers for a device: choose another" };
  return { ok: true, value: name };
}

/**
 * The file name a saved check is kept under: its name case-folded, spaces as
 * dashes. Two names that differ only so are one check. Upper then lower case
 * folds as a case-insensitive folder can (ß and SS alike), so two names such
 * a folder would store as one file are one check here too.
 */
export function savedCheckSlug(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC").replace(/[ -]+/g, "-").replace(/^-|-$/g, "");
}

/** Where a project's saved checks live. */
export function savedChecksDir(projectDir: string): string {
  return path.join(path.resolve(projectDir), MEMORY_DIRNAME, SAVED_CHECKS_DIRNAME);
}

/** Where one saved check lives. Throws on a name checkSavedName refuses: a caller that skipped the check is a bug. */
export function savedCheckPath(projectDir: string, name: string): string {
  const checked = checkSavedName(name);
  if (!checked.ok) throw new Error(checked.error);
  const dir = savedChecksDir(projectDir);
  const file = path.join(dir, `${savedCheckSlug(checked.value)}.json`);
  if (path.dirname(file) !== dir) throw new Error("a saved check's name resolves outside its folder");
  return file;
}

const isIsoTime = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * A saved check read back from its file, checked, or the sentence that says
 * why it is refused. A field it does not name is refused, and one named for a
 * credential is refused as such; neither refusal repeats the field's name or
 * value. The choices are held to checkGuidedChoices, which refuses a
 * credential in the address, the journey or a ticket the same way. The
 * SceneScout config's cap on care levels is applied when it is run, not here,
 * so a check saved before a cap was set is still listed.
 */
export function checkSavedCheck(raw: unknown): { ok: true; saved: SavedCheck } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "a saved check must be an object" };
  const given = raw as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if ((SAVED_FIELDS as readonly string[]).includes(key)) continue;
    if (secretWordKind(key) || SIGN_IN_FIELD.test(key))
      return { ok: false, error: `a saved check has no field for a password, code, token or cookie: ${NO_CREDENTIALS}` };
    return { ok: false, error: `a saved check has a field it does not take: its fields are ${SAVED_FIELDS.join(", ")}` };
  }
  const name = checkSavedName(given.name);
  if (!name.ok) return name;
  const choices = checkGuidedChoices(given.choices);
  if (!choices.ok) return { ok: false, error: `its choices cannot be used: ${choices.error}` };
  if (!isIsoTime(given.savedAt)) return { ok: false, error: "savedAt must be the time it was saved, as an ISO date" };
  if (given.lastRunAt !== undefined && !isIsoTime(given.lastRunAt)) return { ok: false, error: "lastRunAt must be the time it was last run, as an ISO date" };
  return {
    ok: true,
    saved: {
      name: name.value,
      choices: choices.choices,
      savedAt: given.savedAt,
      ...(given.lastRunAt !== undefined ? { lastRunAt: given.lastRunAt as string } : {}),
    },
  };
}

/** A plan's choices as a saved check under `name`. A re-check is not saved: it is made from findings, not choices. */
export function savedCheckFrom(
  plan: Pick<GuidedPlan, "choices" | "recheck">,
  name: unknown,
  now: string,
): { ok: true; saved: SavedCheck } | { ok: false; error: string } {
  if (plan.recheck) return { ok: false, error: SAVED_WORDS.noRecheck };
  return checkSavedCheck({ name, choices: plan.choices, savedAt: now });
}

/** The file's text: the fields in a fixed order, so the same check is the same file. */
export function savedCheckText(saved: SavedCheck): string {
  const ordered: Record<string, unknown> = { name: saved.name, choices: saved.choices, savedAt: saved.savedAt };
  if (saved.lastRunAt) ordered.lastRunAt = saved.lastRunAt;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * A project's saved checks, by name, and the files that could not be read as
 * one (by file name only: what is in them is not repeated). A project with no
 * folder for them has none.
 */
export function listSavedChecks(projectDir: string): { checks: SavedCheck[]; refused: string[] } {
  const dir = savedChecksDir(projectDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { checks: [], refused: [] };
    throw err;
  }
  const checks: SavedCheck[] = [];
  const refused: string[] = [];
  for (const file of names.filter((n) => n.endsWith(".json")).sort()) {
    const read = readSavedFile(path.join(dir, file));
    if (read.ok && `${savedCheckSlug(read.saved.name)}.json` === file) checks.push(read.saved);
    else refused.push(file.slice(0, 80));
  }
  return { checks: checks.sort((a, b) => a.name.localeCompare(b.name)), refused };
}

function readSavedFile(file: string): { ok: true; saved: SavedCheck } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, error: "the file is not a saved check SceneScout can read" };
  }
  return checkSavedCheck(raw);
}

/** One saved check by name, or the sentence that says why not. */
export function readSavedCheck(projectDir: string, name: unknown): { ok: true; saved: SavedCheck } | { ok: false; error: string } {
  const checked = checkSavedName(name);
  if (!checked.ok) return checked;
  const file = savedCheckPath(projectDir, checked.value);
  if (!fs.existsSync(file)) return { ok: false, error: `there is no saved check called "${checked.value}"` };
  const read = readSavedFile(file);
  return read.ok ? read : { ok: false, error: `the saved check "${checked.value}" cannot be used: ${read.error}` };
}

/**
 * Write a saved check, owner-only: the folder is created 0700 (and tightened
 * if it was looser), the file born 0600 under a temporary name and renamed
 * into place. `.scenescout/` gets its self-ignoring .gitignore if it has none.
 * Returns whether a check of that name was replaced.
 */
export function writeSavedCheck(projectDir: string, saved: SavedCheck): { path: string; replaced: boolean } {
  const checked = checkSavedCheck(saved);
  if (!checked.ok) throw new Error(checked.error);
  const file = savedCheckPath(projectDir, checked.saved.name);
  const dir = path.dirname(file);
  const replaced = fs.existsSync(file);
  if (!replaced && listSavedChecks(projectDir).checks.length >= MAX_SAVED_CHECKS)
    throw new Error(`this project already keeps ${MAX_SAVED_CHECKS} saved checks: delete one first`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  writeSelfIgnore(path.dirname(dir));
  fs.mkdirSync(dir, { recursive: true, mode: SAVED_CHECK_DIR_MODE });
  if (process.platform !== "win32") fs.chmodSync(dir, SAVED_CHECK_DIR_MODE);
  writeOwnerOnlySync(file, savedCheckText(checked.saved));
  return { path: file, replaced };
}

/** Delete a saved check by name. True when there was one. */
export function deleteSavedCheck(projectDir: string, name: unknown): { ok: true; deleted: boolean; name: string } | { ok: false; error: string } {
  const checked = checkSavedName(name);
  if (!checked.ok) return checked;
  const file = savedCheckPath(projectDir, checked.value);
  if (!fs.existsSync(file)) return { ok: true, deleted: false, name: checked.value };
  fs.rmSync(file);
  return { ok: true, deleted: true, name: checked.value };
}

/** What deleting a saved check answers: deleting one that is already gone is a success that says so, so a second press or tab is not an error. */
export function deleteSavedCheckReply(projectDir: string, name: unknown): { ok: true; text: string } | { ok: false; error: string } {
  const gone = deleteSavedCheck(projectDir, name);
  if (!gone.ok) return gone;
  return { ok: true, text: gone.deleted ? SAVED_WORDS.deleted(gone.name) : SAVED_WORDS.alreadyGone(gone.name) };
}
