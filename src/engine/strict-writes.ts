/**
 * The strict write classifier, and the destructive-GET rule: two opt-in
 * judgements of whether a request destroys data, for an operator who would
 * rather lose some coverage than let a delete out (#548).
 *
 * The standard classifier (policy.ts isDestructiveWire) matches whole words
 * in the path and a command key's value at the start of the body. It misses
 * a verb inside an identifier (`/api/deleteUser`, `UserService.DeleteUser`,
 * a noun-first GraphQL field such as `productDelete`), a command in the
 * query (`?action=delete`), one past the first 2,000 characters of the body,
 * and verbs outside its list (cancel, refund, terminate, …). It also flags a
 * noun phrase (`/api/delete-requests`) and prose that looks like a command
 * key (`{"note":"action: delete"}`).
 *
 * The strict classifier splits identifiers into words (on camelCase, dots,
 * dashes and underscores) before matching, reads the query's command keys and
 * the whole body, parses a JSON or form body rather than pattern-matching its
 * text, reads a GraphQL mutation's root fields, and knows more verbs. A verb
 * followed by `request(s)` or `reason(s)` is a noun phrase (`delete-requests`,
 * `cancelReason`) and does not count.
 *
 * It is not a superset of the standard classifier, on purpose: it lets out
 * three shapes the standard one refuses, all of them false alarms there.
 * Those are a verb before `request(s)`/`reason(s)`, a destructive word in a
 * field that is not a command key (`{"note":"action: delete"}`), and a
 * harmless mutation whose arguments or selections name a verb (`deletedAt`).
 * Everything else the standard classifier refuses, it refuses
 * (policy-test's fuzz holds it to that).
 *
 * Off by default: SCENESCOUT_STRICT_WRITES=1 turns it on. How the config
 * file will lock it on is project-config.ts writeRulesSettings, which waits on
 * the browser engine taking it from the attach.
 * Everything here is pure and table-tested in policy-test.
 */
import { fromJs } from "./js-regex.js";
import type { LinearRegex } from "./linear-regex.js";

const LOWER_THEN_UPPER_RE = fromJs(String.raw`([a-z0-9])([A-Z])`);
const CAPITALS_THEN_WORD_RE = fromJs(String.raw`([A-Z]+)([A-Z][a-z])`);
const NOT_LETTER_OR_DIGIT_RE = fromJs(String.raw`[^A-Za-z0-9]+`);
const MUTATION_WORD_RE = fromJs(String.raw`\bmutation\b`);
const isLetter = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isWordChar = (c: string): boolean => isLetter(c) || (c >= "0" && c <= "9") || c === "_";
const OPERATION_KEYWORDS = new Set(["query", "mutation", "subscription", "fragment"]);

/** Which classifier judges whether a write is destructive. */
export type WriteClassifier = "standard" | "strict";

/** The environment variable that turns the strict classifier on. */
export const STRICT_WRITES_ENV = "SCENESCOUT_STRICT_WRITES";

/** The environment variable that turns on refusing page loads whose address is a destructive command. */
export const REFUSE_DESTRUCTIVE_GETS_ENV = "SCENESCOUT_REFUSE_DESTRUCTIVE_GETS";

/** An on/off environment variable: unset or empty is off, `1`/`true`/`on` is on, `0`/`false`/`off` is off, anything else is an error. */
function flag(name: string, value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "off") return false;
  if (v === "1" || v === "true" || v === "on") return true;
  throw new Error(`${name} must be 1 or 0 (or true/false, on/off), not ${JSON.stringify(value)}.`);
}

/** The write classifier the environment asks for: strict when SCENESCOUT_STRICT_WRITES is on. */
export function writeClassifierSetting(env: Record<string, string | undefined>): WriteClassifier {
  return flag(STRICT_WRITES_ENV, env[STRICT_WRITES_ENV]) ? "strict" : "standard";
}

/** Whether the environment asks for destructive page loads to be refused (SCENESCOUT_REFUSE_DESTRUCTIVE_GETS). */
export function refuseDestructiveGetsSetting(env: Record<string, string | undefined>): boolean {
  return flag(REFUSE_DESTRUCTIVE_GETS_ENV, env[REFUSE_DESTRUCTIVE_GETS_ENV]);
}

/** Verbs that destroy, cancel or reverse something, as one word of an identifier. */
const STRICT_VERBS = new Set([
  "delete",
  "remove",
  "purge",
  "destroy",
  "archive",
  "revoke",
  "deactivate",
  "wipe",
  "discard",
  "trash",
  "erase",
  "terminate",
  "disable",
  "cancel",
  "refund",
]);

/**
 * Words that, right after a verb, make the pair a noun phrase: a collection
 * of deletion requests, the reasons a user may give for cancelling. A POST to
 * one creates a record about the act; it is not the act. Kept to these two:
 * most nouns after a verb are its object (`delete-history`, `purge_logs`).
 */
const NOUN_PHRASE_HEADS = new Set(["request", "requests", "reason", "reasons"]);

/** Keys whose value is a command, in a body or a query: `action=delete`, `"method":"UserService.DeleteUser"`. */
const COMMAND_KEYS = new Set(["action", "operation", "op", "method", "_method", "command", "cmd", "operationname", "procedure", "rpc"]);

/** An identifier split into lower-case words: on anything not a letter or digit, and on camelCase boundaries. */
export function identifierWords(text: string): string[] {
  const spaced = (re: LinearRegex, t: string): string => re.replace(t, ({ groups: [, a, b] }) => `${a} ${b}`);
  return NOT_LETTER_OR_DIGIT_RE.splitText(spaced(CAPITALS_THEN_WORD_RE, spaced(LOWER_THEN_UPPER_RE, text)))
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Whether these words hold a verb from `verbs` that is not the head of a noun phrase. */
function wordsCommand(words: readonly string[], verbs: ReadonlySet<string>): boolean {
  return words.some((w, i) => verbs.has(w) && !NOUN_PHRASE_HEADS.has(words[i + 1] ?? ""));
}

/** Whether one identifier (a path segment, a command's value, a GraphQL field) names a destructive command. */
export function identifierIsDestructive(text: string): boolean {
  return wordsCommand(identifierWords(text), STRICT_VERBS);
}

/** The query's command keys, read: `?action=delete`, `?op=cancelOrder`. */
function queryCommand(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [key, value] of params) if (COMMAND_KEYS.has(key.toLowerCase()) && identifierIsDestructive(value)) return true;
  return false;
}

/**
 * The root fields of every mutation in a GraphQL document: the identifiers
 * directly inside a `mutation` operation's selection set, outside arguments
 * and strings. `mutation { productDelete(id: 3) { id } }` gives productDelete.
 */
export function mutationRootFields(doc: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let parens = 0;
  let lastKeyword = "";
  let inMutation = false;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i];
    if (c === '"') {
      // A string or a block string: skipped whole.
      if (doc.startsWith('"""', i)) {
        const end = doc.indexOf('"""', i + 3);
        i = end < 0 ? doc.length : end + 2;
      } else {
        let j = i + 1;
        while (j < doc.length && doc[j] !== '"') j += doc[j] === "\\" ? 2 : 1;
        i = j;
      }
      continue;
    }
    if (c === "#") {
      const end = doc.indexOf("\n", i);
      i = end < 0 ? doc.length : end;
      continue;
    }
    if (c === "(") parens += 1;
    else if (c === ")") parens = Math.max(0, parens - 1);
    else if (c === "{" && parens === 0) {
      if (depth === 0) inMutation = lastKeyword === "mutation";
      depth += 1;
    } else if (c === "}" && parens === 0) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) lastKeyword = "";
    } else if (isLetter(c) || c === "_") {
      let j = i + 1;
      while (j < doc.length && isWordChar(doc[j])) j++;
      const word = doc.slice(i, j);
      if (depth === 0 && parens === 0 && OPERATION_KEYWORDS.has(word)) lastKeyword = word;
      else if (depth === 1 && parens === 0 && inMutation) fields.push(word);
      i = j - 1;
    }
  }
  return fields;
}

/** Whether a GraphQL document's mutations name a destructive root field. */
function graphqlCommand(doc: string): boolean {
  return MUTATION_WORD_RE.test(doc) && mutationRootFields(doc).some(identifierIsDestructive);
}

/** The deepest a JSON body is walked; deeper values are not commands an API reads. */
const MAX_JSON_DEPTH = 32;

/** A parsed JSON body: a command key's value, a GraphQL `query`, at any depth (a batch, JSON-Patch, a JSON-RPC envelope). */
function jsonCommand(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => jsonCommand(v, depth + 1));
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const k = key.toLowerCase();
    if (typeof v === "string") {
      if (COMMAND_KEYS.has(k) && identifierIsDestructive(v)) return true;
      if (k === "query" && graphqlCommand(v)) return true;
    } else if (jsonCommand(v, depth + 1)) return true;
  }
  return false;
}

/** A command key written as text: at the start, or after a brace, bracket, comma, `&` or `?`, then its value. */
const TEXT_COMMAND_RE = fromJs(String.raw`(?:^|[{,[&?])\s*["']?([A-Za-z_]+)["']?\s*[:=]\s*["']?([A-Za-z0-9_.\-/]+)`);

/** A body that is neither JSON nor a form: a command key written as text, or a GraphQL document. */
function textCommand(body: string): boolean {
  for (const { groups } of TEXT_COMMAND_RE.matchAll(body))
    if (COMMAND_KEYS.has((groups[1] ?? "").toLowerCase()) && identifierIsDestructive(groups[2] ?? "")) return true;
  return graphqlCommand(body);
}

/** Whether a body reads as a form (`a=1&b=2`): no braces or quotes at its start, and a key=value first. */
const FORM_BODY_RE = fromJs(String.raw`^[\w.%[\]-]+=[^&]*(?:&|$)`);

/** The whole body, judged by what it is: JSON parsed and walked, a form read field by field, anything else as text. */
export function strictBodyIsDestructive(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return jsonCommand(JSON.parse(trimmed));
    } catch {
      return textCommand(trimmed);
    }
  }
  if (FORM_BODY_RE.test(trimmed)) {
    const form = new URLSearchParams(trimmed);
    for (const [key, value] of form) {
      const k = key.toLowerCase();
      if (COMMAND_KEYS.has(k) && identifierIsDestructive(value)) return true;
      if (k === "query" && graphqlCommand(value)) return true;
    }
    return false;
  }
  return textCommand(trimmed);
}

/** The path and query of a request URL; a URL that does not parse is taken as a path. */
function urlParts(url: string): { pathname: string; search: string } {
  try {
    const u = new URL(url, "http://relative.invalid");
    return { pathname: u.pathname, search: u.search };
  } catch {
    const q = url.indexOf("?");
    return q < 0 ? { pathname: url, search: "" } : { pathname: url.slice(0, q), search: url.slice(q) };
  }
}

/** One path segment, decoded where it can be. */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * The strict classifier: whether a write's path, query or body names a
 * destructive command. The path's segments are split into words, so
 * `/api/deleteUser`, `/rpc/UserService.DeleteUser` and `/items/3/cancel`
 * count; the query's command keys count; the whole body is read.
 */
export function strictIsDestructive(url: string, body?: string | null): boolean {
  const { pathname, search } = urlParts(url);
  if (pathname.split("/").filter(Boolean).map(decodeSegment).some(identifierIsDestructive)) return true;
  if (search && queryCommand(search)) return true;
  return !!body && strictBodyIsDestructive(body);
}

/** Verbs a page load's address may name to destroy something by being opened. */
const GET_VERBS = new Set([
  "delete",
  "remove",
  "destroy",
  "purge",
  "wipe",
  "erase",
  "revoke",
  "deactivate",
  "disable",
  "terminate",
  "cancel",
  "unsubscribe",
  "discard",
  "archive",
  "trash",
]);

/** Verbs that are also the name of a page that lists things (`/blog/archive`, `/mail/trash`): a command only right after a record's id. */
const GET_NOUN_VERBS = new Set(["archive", "trash"]);

/** A path segment that reads as a record's id: digits, a UUID, or a long hex or mixed token. */
const ALL_DIGITS_RE = fromJs(String.raw`^\d+$`);
const ID_SEGMENT_RE = fromJs(
  String.raw`^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)$`,
  "i",
  // The lookahead `(?=[A-Za-z0-9_-]*\d)` of the last kind is its digit, written in the pattern; its 12 characters at least are
  // the length checked here. A UUID or a hex id is longer than 12, so only a run of digits may be shorter.
  { accept: ({ text }) => text.length >= 12 || ALL_DIGITS_RE.test(text) },
  String.raw`^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{12,})$`,
);

/**
 * Whether a page load's address is a destructive command: a GET a link sends
 * that a server may act on, `/items/3/delete`, `/orders/3/cancel`,
 * `/unsubscribe?token=…`, `?action=delete`. `archive` and `trash` are also
 * the names of listing pages, so they count only right after an id
 * (`/items/3/archive`, not `/blog/archive`). Opt-in: refusing these loses the
 * page behind every such link, which is the point.
 */
export function destructiveGet(url: string): boolean {
  const { pathname, search } = urlParts(url);
  const segments = pathname.split("/").filter(Boolean).map(decodeSegment);
  const command = segments.some((seg, i) => {
    const words = identifierWords(seg);
    if (!wordsCommand(words, GET_VERBS)) return false;
    // A noun-or-verb word alone in its segment is a listing page unless a record's id comes just before it.
    if (words.length === 1 && GET_NOUN_VERBS.has(words[0])) return i > 0 && ID_SEGMENT_RE.test(segments[i - 1]);
    return true;
  });
  return command || (!!search && queryCommand(search));
}
