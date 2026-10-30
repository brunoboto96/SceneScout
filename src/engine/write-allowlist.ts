/**
 * The endpoint allowlist for writes: the operator names the writes that may
 * leave the page (a method and a path each), and every other write is
 * refused. The guarantee rests on the list, not on a pattern deciding whether
 * a request looks destructive, so a listed write goes out whatever its path or
 * body looks like, and an unlisted one is refused whatever it looks like.
 *
 * Only the operator sets it (the config file's `allowedWrites` or
 * SCENESCOUT_ALLOWED_WRITES); an attach argument has no way to name an entry.
 * Pure logic, table-tested in policy-test.
 */
import { matchReadPost, readPostEntries, readPostsSetting, type ReadPost } from "./policy.js";

/** The environment variable naming the writes that may leave the page. The config file's list is the most it may name. */
export const ALLOWED_WRITES_ENV = "SCENESCOUT_ALLOWED_WRITES";

/** The most writes one list may name. */
export const MAX_ALLOWED_WRITES = 50;

/** The methods an entry may name: the writes. A read needs no entry, and a method override is judged as the method it names. */
export const ALLOWED_WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** One write the operator named: a method, and an origin (null for the app's own) with path segments, `*` standing for any one segment. */
export interface AllowedWrite extends ReadPost {
  method: string;
}

/**
 * The list a session judges writes by, as the browser engine holds it.
 * `andModeRules`: a listed write must also pass the mode's own rules, so the
 * list only narrows (a guided check, or a list only a project's file set).
 */
export interface AllowedWritesSetting {
  entries: string[];
  andModeRules: boolean;
}

/** What the route handler asks of the list for one write. */
export interface WriteAllowList {
  /** Whether the write is on the list. */
  listed: boolean;
  /** The entry that lists it. */
  entry?: AllowedWrite;
  /** True: being listed is not enough, the mode's own rules also apply. */
  andModeRules: boolean;
}

/** The refusal of a write that is not on the list, as the route handler and the explain command word it. */
export const NOT_ALLOWED_WRITE_REFUSAL = `not on the list of allowed writes (the config's allowedWrites or ${ALLOWED_WRITES_ENV})`;

/** An entry in one spelling: the method upper-cased, one space, the path without a trailing slash. Unreadable: trimmed as written. */
export function allowedWriteKey(entry: string): string {
  const parsed = allowedWriteEntries([entry]).entries[0];
  return parsed ? parsed.entry : entry.trim();
}

/**
 * The entries parsed, and what was given that is not one. An entry is
 * `<METHOD> <path>` for the app's own origin or `<METHOD> <http(s) URL>` for an
 * API on another origin, where METHOD is POST, PUT, PATCH or DELETE (any case).
 * The path is read as readPostEntries reads it: it starts with `/`, carries no
 * query or fragment, and `*` stands only for one whole segment, so nothing is
 * widened by accident.
 */
export function allowedWriteEntries(list: readonly string[]): { entries: AllowedWrite[]; rejected: string[]; overflow: string[] } {
  const entries: AllowedWrite[] = [];
  const rejected: string[] = [];
  const overflow: string[] = [];
  for (const raw of list) {
    const text = raw.trim();
    const space = [...text].findIndex((c) => c.trim() === "");
    const method = (space === -1 ? text : text.slice(0, space)).toUpperCase();
    const target = space === -1 ? "" : text.slice(space).trim();
    if (!(ALLOWED_WRITE_METHODS as readonly string[]).includes(method) || target === "") {
      rejected.push(raw);
      continue;
    }
    // The path rules are the read POSTs': parse it as a POST entry and carry the method beside it.
    const parsed = readPostEntries([`POST ${target}`]);
    const one = parsed.entries[0];
    if (!one) {
      rejected.push(raw);
      continue;
    }
    const entry = `${method} ${one.entry.slice("POST ".length)}`;
    if (entries.some((e) => e.entry === entry)) continue;
    if (entries.length < MAX_ALLOWED_WRITES) entries.push({ ...one, entry, method });
    else overflow.push(raw);
  }
  return { entries, rejected, overflow };
}

/** The entries of an environment value, separated by commas or new lines (as SCENESCOUT_READ_POSTS is read). */
export function allowedWritesFromEnv(env: string | undefined): string[] {
  return readPostsSetting(undefined, env);
}

/** The entry that lists a write of `method` to `url`, or null. The method is the one the policy judges it as (policy.ts writeMethod). */
export function matchAllowedWrite(entries: readonly AllowedWrite[], appUrl: string, method: string, url: string): AllowedWrite | null {
  const found = matchReadPost(
    entries.filter((e) => e.method === method.toUpperCase()),
    appUrl,
    url,
  );
  return (found as AllowedWrite | null) ?? null;
}

/** The list as one write is judged against it, or null when no list is set (every write is judged by the mode alone). */
export function writeAllowListFor(
  setting: { entries: readonly AllowedWrite[]; andModeRules: boolean } | null,
  appUrl: string,
  method: string,
  url: string,
): WriteAllowList | null {
  if (!setting) return null;
  const entry = matchAllowedWrite(setting.entries, appUrl, method, url);
  return { listed: entry !== null, entry: entry ?? undefined, andModeRules: setting.andModeRules };
}
