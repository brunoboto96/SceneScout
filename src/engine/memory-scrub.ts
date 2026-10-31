/**
 * Text a store kept before the redaction it now runs: a value typed into a
 * secret field, a card number or an email address an older engine wrote down
 * in clear. When a newer engine first opens the store, the current redaction
 * runs over what it kept once (findings and the merges folded into them,
 * tickets and their verdicts, lanes' stated decisions, and every session log's
 * lines), and the store records which redaction it has been through, so the
 * work is not repeated on every load. A later change to the redaction raises REDACTION_VERSION, and
 * the next load cleans again. An older engine still running beside a newer one
 * can write its own copy back in a later merge; the next version's scrub, or
 * the redaction applied wherever the text is read for a report or an export,
 * covers that.
 *
 * Only text a person or the agent wrote, or the page put in an action, is
 * read: ids, routes' identities and state fingerprints are left alone, since a
 * digit run in a hash could read as a card number. The redaction itself is
 * passed in (redact.ts redactSecrets), so this file holds the walk and memory-
 * test holds it to a fixture written the way an older engine wrote one.
 */
import fs from "node:fs";
import path from "node:path";
import { writeOwnerOnlySync } from "./owner-file.js";

/**
 * The redaction a store has been cleaned with. Raise it when the redaction
 * learns to hide something it kept before. 2: short and letters-only values
 * set against a secret's name, more providers' keys, PINs and sign-in codes,
 * more field words, cards split by slashes, spelled-out email addresses and
 * more words for a phone (#550). 3: a secret set after a refused one
 * (`password:secret ＝…`), and the rest of a card number a Bearer or Basic
 * token stops inside (#619). 4: more providers' keys and the rest of a marked key's tail, Basic credentials with no
 * digit, and more secrets' names before a value (#538).
 */
export const REDACTION_VERSION = 4;

type Redact = (text: string) => string;

/** The parts of memory.json that hold free text: a finding's words, steps and folded merges, a ticket's title and criteria, a verdict's reason, a lane's stated decision. */
export interface ScrubbableMemory {
  findings: Array<{
    title: string;
    detail: string;
    evidence?: string;
    url: string;
    repro: string[];
    verifyNote?: string;
    convention?: string;
    judgedMerges?: Array<{ title: string; evidence?: string }>;
  }>;
  tickets?: Array<{ title: string; criteria: Array<{ text: string }> }>;
  criterionVerdicts?: Array<{ reason: string }>;
  laneDecisions?: Array<{ observation: string; evidence: string | null }>;
}

/** Redact every free-text field of the store in place; returns how many fields changed. */
export function scrubMemoryText(data: ScrubbableMemory, redact: Redact): number {
  let changed = 0;
  const clean = (text: string): string => {
    const out = redact(text);
    if (out !== text) changed += 1;
    return out;
  };
  for (const f of data.findings) {
    f.title = clean(f.title);
    f.detail = clean(f.detail);
    f.url = clean(f.url);
    if (typeof f.evidence === "string") f.evidence = clean(f.evidence);
    if (typeof f.verifyNote === "string") f.verifyNote = clean(f.verifyNote);
    if (typeof f.convention === "string") f.convention = clean(f.convention);
    if (Array.isArray(f.repro)) f.repro = f.repro.map((step) => (typeof step === "string" ? clean(step) : step));
    for (const m of f.judgedMerges ?? []) {
      if (typeof m.title === "string") m.title = clean(m.title);
      if (typeof m.evidence === "string") m.evidence = clean(m.evidence);
    }
  }
  for (const t of data.tickets ?? []) {
    if (typeof t.title === "string") t.title = clean(t.title);
    for (const c of t.criteria ?? []) if (typeof c.text === "string") c.text = clean(c.text);
  }
  for (const v of data.criterionVerdicts ?? []) if (typeof v.reason === "string") v.reason = clean(v.reason);
  // Stored as addLaneDecisions stores them now: redacted, then cut to 200 characters.
  for (const d of data.laneDecisions ?? []) {
    if (typeof d.observation === "string") d.observation = clean(d.observation).slice(0, 200);
    if (typeof d.evidence === "string") d.evidence = clean(d.evidence).slice(0, 200);
  }
  return changed;
}

/**
 * A session log (one JSON action per line) with each action's url, target and
 * result redacted, as logAction redacts them now. A line that does not parse
 * is kept as it is; the text is null when nothing changed.
 */
export function scrubSessionLog(text: string, redact: Redact): string | null {
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (line.trim() === "") return line;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line;
    }
    if (entry === null || typeof entry !== "object") return line;
    let touched = false;
    for (const field of ["url", "target", "result"] as const) {
      const value = entry[field];
      if (typeof value !== "string") continue;
      const out = redact(value);
      if (out !== value) {
        entry[field] = out;
        touched = true;
      }
    }
    if (!touched) return line;
    changed = true;
    return JSON.stringify(entry);
  });
  return changed ? lines.join("\n") : null;
}

/**
 * Clean every session log in `dir` but `current` (this process's own, which
 * logAction already redacts). A log that grew while it was read belongs to a
 * session still running in another process and is left for the next load:
 * the result says whether every log is clean. Logs are rewritten owner-only,
 * and never through a link left at their name (owner-file.ts).
 */
export function scrubSessionLogs(dir: string, current: string, redact: Redact): { cleaned: number; complete: boolean } {
  let cleaned = 0;
  let complete = true;
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^session-.*\.jsonl$/.test(n) && path.join(dir, n) !== current);
  } catch {
    return { cleaned, complete: false };
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const before = fs.lstatSync(file);
      if (!before.isFile()) continue;
      const out = scrubSessionLog(fs.readFileSync(file, "utf8"), redact);
      if (out === null) continue;
      if (fs.statSync(file).size !== before.size) {
        complete = false;
        continue;
      }
      writeOwnerOnlySync(file, out);
      cleaned += 1;
    } catch (err) {
      // A log this user may not read or write never will be: it is not waited for. Anything else is tried again at the next load.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") complete = false;
    }
  }
  return { cleaned, complete };
}
