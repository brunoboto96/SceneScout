/**
 * Destructive-action policy. In read-only mode the engine refuses to interact
 * with elements whose accessible name / testid / id matches these patterns —
 * enforcement lives here, at the tool layer, never in the model's prompt.
 */
import { isIdSegment } from "./fingerprint.js";
import { fromJs, registerJsPattern } from "./js-regex.js";
import { isSpace, LinearRegex, SPACE } from "./linear-regex.js";
import { scriptLiteral } from "./script-literal.js";
import { identifierWords, strictIsDestructive, type WriteClassifier } from "./strict-writes.js";

/** A label's word as the destructive patterns read it: `\bword\b`, case folded as JavaScript's `i` flag does without `u`. */
const word = (source: string, needs?: readonly string[]): LinearRegex => fromJs(String.raw`\b${source}\b`, "i", needs ? { needs } : {});

/**
 * JavaScript read some of these with a lookahead or a lookbehind. RE2 has neither, so a lookahead
 * is an optional last group that is there exactly when the lookahead's text is (it is the pattern's
 * end, so it holds where it can), and the candidate is refused by `accept` when it is; a lookbehind
 * is a check of the text before the candidate (`filterBefore`).
 */
const EXEMPT_RESET = String.raw`\s+(?:filters?|zoom|search|view|sort|order|form|password|layout|columns?|selection|preferences?|defaults?)`;
const EXEMPT_DISCARD = String.raw`[\s_-]+(?:(?:your|my|all|the|any)[\s_-]+)?(?:unsaved[\s_-]+|pending[\s_-]+|local[\s_-]+|draft[\s_-]+)?(?:changes|edits)\b`;
// "Remove" at the end of a label whose object is a filter or a chip: at most 60 characters on one line, then the word, then nothing but marks.
const EXEMPT_REMOVE_AFTER = String.raw`[^\n]{0,60}?\b(?:filters?|chips?)\W*$`;

const isWordChar = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";

/** Whether `word` (lower case, ASCII) ends at `end` in `text`, in either case, with a non-word character or the start before it. */
function wordEndsAt(text: string, end: number, word: string): boolean {
  const start = end - word.length;
  if (start < 0) return false;
  for (let k = 0; k < word.length; k++) {
    const c = text[start + k];
    if (c !== word[k] && c !== word[k].toUpperCase()) return false;
  }
  const before = text[start - 1];
  return before === undefined || !isWordChar(before);
}

/** Whether a filter or a chip (and one to three spaces or hyphens) stands right before `index`: the lookbehind of the "remove" pattern. */
function filterBefore(text: string, index: number): boolean {
  for (let gap = 1; gap <= 3; gap++) {
    const at = index - gap;
    if (at < 0) break;
    const c = text[at];
    if (c !== "-" && !isSpace(c)) break;
    if (["filters", "filter", "chips", "chip"].some((w) => wordEndsAt(text, at, w))) return true;
  }
  return false;
}

const DESTRUCTIVE_PATTERNS: LinearRegex[] = [
  word("delete", ["delete"]),
  // "Remove" a filter chip drops a condition from the view: "Remove Status:
  // Open filter" re-queries the list, the same sense the reset rule exempts.
  // A label whose object, at its end, is a filter or a chip, or a test id with
  // the chip before the verb ("filter-remove"), is exempt; "Remove member",
  // and "Remove member. Use the filter to find others.", still count.
  fromJs(
    String.raw`\bremove\b(${EXEMPT_REMOVE_AFTER})?`,
    "i",
    { needs: ["remove"], accept: ({ index, groups }, text) => groups[1] === undefined && !filterBefore(text, index) },
    String.raw`(?<!\b(?:filters?|chips?)[\s-]{1,3})\bremove\b(?!${EXEMPT_REMOVE_AFTER})`,
  ),
  word("revoke", ["revoke"]),
  word("destroy", ["destroy"]),
  word("purge", ["purge"]),
  word("terminate", ["terminate"]),
  word("deactivate", ["deactivate"]),
  word("archive", ["archive"]),
  word("wipe", ["wipe"]),
  // "Reset" is destructive only in some of its senses. Matching it bare refused
  // "Reset filters", "Reset zoom", "Reset search" and "Reset password" — none
  // of which destroy anything — so read-only runs skipped ordinary controls and
  // lost coverage on the very pages they were sent to explore. Exempt the
  // view/form senses; everything else ("Reset workspace", "Factory reset",
  // "Reset all data") still counts.
  fromJs(
    String.raw`\breset\b(${EXEMPT_RESET})?`,
    "i",
    { needs: ["reset"], accept: ({ groups }) => groups[1] === undefined },
    String.raw`\breset\b(?!${EXEMPT_RESET})`,
  ),
  // "Discard" names two different things. "Discard changes", "Discard your
  // edits" and "Discard unsaved changes" drop what the tester typed and has not
  // sent: no record exists to lose, and refusing it left a session stuck on a
  // dirty form behind the app's own leave-confirmation. Those senses are
  // exempt, written as words or as a test id ("discard-changes"); "Discard
  // draft", "Discard record" and a bare "Discard" still count.
  // If the confirm does send a write, the wire policy judges that request as it
  // judges any other, and `discard` is a destructive verb in a path there.
  fromJs(
    String.raw`\bdiscard\b(${EXEMPT_DISCARD})?`,
    "i",
    { needs: ["discard"], accept: ({ groups }) => groups[1] === undefined },
    String.raw`\bdiscard\b(?!${EXEMPT_DISCARD})`,
  ),
  fromJs(String.raw`\bcancel subscription\b`, "i", { needs: ["cancel subscription"] }),
  // The verb: a control that signs the user off, starting the label ("Sign
  // off", "(Sign off)", a test id "sign-off-button") or joined to another verb
  // ("Save and sign off", "Save & sign off"). Anywhere else it is the noun
  // approval apps label things with ("Needs sign-off", "Manager sign-off",
  // "Final sign-off recorded"), which destroys nothing. Told by position, not
  // by a list of the words that may come before it: any modifier can.
  registerJsPattern(
    String.raw`(?:^[^\p{L}\p{N}]*|\b(?:and|then)\s+|&\s*)sign(?: |-)?off\b`,
    "iu",
    new LinearRegex(String.raw`(?:^[^\p{L}\p{N}]*|\b(?i:and|then)[${SPACE}]+|&[${SPACE}]*)(?i:sign)(?: |-)?(?i:off)\b`, { needs: ["sign"] }),
  ),
  // The tool is generic — destructive labels come in many languages.
  word("(?:eliminar|borrar|suprimir)", ["eliminar", "borrar", "suprimir"]), // es
  word("(?:excluir|apagar|remover)", ["excluir", "apagar", "remover"]), // pt
  word("supprimer", ["supprimer"]), // fr
  word("(?:löschen|loeschen|entfernen)", ["löschen", "loeschen", "entfernen"]), // de
  word("elimina(?:re)?", ["elimina"]), // it
  word("verwijder(?:en)?", ["verwijder"]), // nl
  // \b is ASCII-only in JS regexes — non-Latin scripts match as substrings.
  fromJs(String.raw`(удалить|удаление)`, "i"), // ru
  fromJs(String.raw`(削除|删除|삭제)`, "", { needs: ["削除", "删除", "삭제"] }), // ja/zh/ko
];

/**
 * Network-layer destructive signals that delete/disable data regardless of
 * what the button was labeled. Used by the write-policy interceptor.
 *
 * URL and BODY are judged by DIFFERENT rules, on purpose. A URL path is
 * STRUCTURE — a bare destructive verb as a path segment (`/users/3/delete`,
 * `/widgets/bulk-delete`) is a strong, unambiguous signal. A request BODY is
 * often user CONTENT — a document being analysed, a record description, a document
 * uploaded for review — so a bare keyword in it is usually prose, not intent.
 * Scanning the body for bare `delete`/`remove` blocked ordinary create/submit
 * POSTs whose payload merely MENTIONED a destructive word: seen live, an document
 * text containing "Remove jewellery" and a description saying "Safe to delete"
 * each got their `POST /api/ai/analyze` (and a plain create) refused. That is
 * pure lost coverage with no safety gain — the analyse/create was never
 * destructive. So the body is matched only for STRUCTURED destructive intent.
 */

/**
 * The verbs that make a URL path a destructive command, read as whole WORDS
 * of the path (#684). The path is read twice: as the runs of letters and
 * digits between anything else (`/users/3/delete`, `/delete_all`,
 * `/DELETE-ALL`, `/bulkdelete`), which is what the regular expression before
 * #684 matched, and with its identifiers split on camelCase, PascalCase and
 * where letters meet digits too (strict-writes.ts identifierWords:
 * `/items/deleteAll`, `/bulkDelete`, `/removeAll`, `/purgeCache`,
 * `/UserService.DeleteUser`, `/delete2`). A verb in either reading counts, so
 * the path refuses everything it refused before and more.
 *
 * Whole words only: another form of the verb is not the verb, so
 * `/deletedAtFilter`, `/removedItems`, `/purgeable`, `/archives` and
 * `/bulkDeletionStatus` stay plain. Any word after the verb is read as its
 * object, with no exception: `/purgeReport` and `/bulkDeleteHistory` count,
 * and so do `/delete-requests` and `/deleteReasons`, since a POST to a
 * "delete request" endpoint commonly files the deletion it names. Only the
 * strict classifier reads a verb before `request(s)`/`reason(s)` as a noun
 * phrase.
 */
const STANDARD_PATH_VERBS: ReadonlySet<string> = new Set(["delete", "remove", "purge", "destroy", "archive", "revoke", "deactivate", "wipe", "discard"]);
/** Verbs written joined to a modifier, in lower case, that no split can find. */
const JOINED_PATH_VERBS: ReadonlySet<string> = new Set(["bulkdelete", "forcedelete"]);
const WORD_SEPARATORS_RE = fromJs(String.raw`[^A-Za-z0-9]+`);

/**
 * Whether a URL path names a destructive verb as one of its words (the
 * standard classifier's reading of a path). The runs are split before they
 * are lower-cased: a character whose lower case is an ASCII letter (the
 * Kelvin sign, a dotted capital I) separates words, as it did for `\b`.
 */
export function pathNamesDestructiveVerb(path: string): boolean {
  const runs = WORD_SEPARATORS_RE.splitText(path).map((t) => t.toLowerCase());
  if (runs.some((t) => STANDARD_PATH_VERBS.has(t) || JOINED_PATH_VERBS.has(t))) return true;
  return identifierWords(path, { digits: true }).some((w) => STANDARD_PATH_VERBS.has(w));
}

/**
 * Structured destructive intent inside a body — never a bare keyword.
 * Two shapes: (a) a GraphQL destructive mutation (the 200-char window after
 * `mutation` catches the anonymous `mutation { deleteUser(id: 7) }`, not just
 * the named `mutation DeleteUser {`); (b) a destructive verb as the VALUE of a
 * command-like key (`"action":"delete"`, `operation=archive`, `"_method":"DELETE"`).
 * A destructive word sitting in any OTHER field value (a title, a description,
 * document text) is content, not a command, and is deliberately not matched.
 *
 * The key must be preceded by a STRUCTURAL character (quote, brace, bracket,
 * comma, or the start of the body / a query string) so the same sentence-shaped
 * prose this fix exists to allow cannot sneak back in through the command
 * branch: "Our intent: delete duplicate accounts" is still content. `intent`
 * and `verb` are not in the key list at all — they read as prose far more often
 * than as command fields.
 */
const DESTRUCTIVE_BODY_RE = fromJs(
  String.raw`\bmutation\b[\s\S]{0,200}?\b(?:delete|remove|archive|destroy|purge|revoke)[A-Za-z_]|(?:^|[{,[\s]*["']|[?&])\s*(?:action|operation|op|method|_method|command|cmd)["']?\s*[:=]\s*["']?(?:delete|remove|purge|destroy|archive|revoke|deactivate|wipe|discard)\b`,
  "i",
);

export function isDestructiveWire(url: string, body?: string | null): boolean {
  return pathNamesDestructiveVerb(url) || (!!body && DESTRUCTIVE_BODY_RE.test(body.slice(0, 2000)));
}

/**
 * Whether a write to `url` (the full request URL) with this body looks
 * destructive, by the classifier the session runs with. The standard one
 * judges the path and the first 2,000 characters of the body
 * (isDestructiveWire); the strict one (strict-writes.ts, opt-in) splits
 * identifiers into words, reads the query's command keys and the whole body,
 * and knows more verbs.
 */
export function isDestructiveRequest(url: string, body: string | null | undefined, classifier: WriteClassifier = "standard"): boolean {
  if (classifier === "strict") return strictIsDestructive(url, body);
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* not a full URL: judged as given, as the route handler always has */
  }
  return isDestructiveWire(pathname, body);
}

/**
 * The headers a server may read as the request's real method. Many
 * frameworks let a POST stand in for PUT, PATCH or DELETE this way, for
 * clients and proxies that can send only GET and POST.
 */
export const METHOD_OVERRIDE_HEADERS = ["x-http-method-override", "x-http-method", "x-method-override"] as const;

/** The method a request is judged as, and how it named it when that is not the method it was sent with. */
export interface WriteMethod {
  method: string;
  /** "X-HTTP-Method-Override: DELETE", "_method=DELETE in the query", …; absent when the sent method stands. */
  via?: string;
}

/** How much a method writes, for choosing between the sent method and an override: a read, a POST, or anything else. */
function methodWeight(method: string): number {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return 0;
  return method === "POST" ? 1 : 2;
}

const OVERRIDE_SEPARATOR = fromJs(String.raw`[\s,;]+`);
const METHOD_NAME = fromJs(String.raw`^[A-Z][A-Z-]*$`);
const KEY_LEAD = fromJs(String.raw`^[ [\]]+`);
const KEY_CLOSE = fromJs(String.raw`\]+$`);
const DISPOSITION_LINE = fromJs(String.raw`^content-disposition[ \t]*:`, "i");
const CHARSET_PREFIX = fromJs(String.raw`^[^']*'[^']*'`);
const LINE_BREAK = fromJs(String.raw`\r?\n`);
const HEADER_WORD = fromJs(String.raw`(^|-)([a-z])`);
const WHITE_SPACE = fromJs(String.raw`\s+`);
const HEADING_TAG = fromJs(String.raw`^h[1-6]$`, "i");
const QUERY_OR_FRAGMENT = fromJs(String.raw`[?#].*$`);
const LEADING_DOTS = fromJs(String.raw`^\.+`);
const PASSWORD_WORD = fromJs(String.raw`^password$`, "i");
const NOT_A_SIGN_IN_ACTION = fromJs(String.raw`^(users?|accounts?|members?|password|signup|sign-up|register|verify|invite|invitations?)$`, "i");
const SESSION_WORD = fromJs(String.raw`^sessions?$`, "i");
const CONNECT_WORD = fromJs(String.raw`^connect$`, "i");
const WORD_SEPARATOR = fromJs(String.raw`[-_.]+`);
const HTTP_SCHEME = fromJs(String.raw`^https?:`, "i");
const HTTP_URL = fromJs(String.raw`^https?:\/\/`, "i");
const FILE_EXTENSION = fromJs(String.raw`\.[a-z0-9]+$`, "i");
const TRAILING_DOT = fromJs(String.raw`\.(:\d+)?$`);
const BLANK_FRAME = fromJs(String.raw`^about:(blank|srcdoc)`, "i");
const MARKUP = fromJs(String.raw`<\s*[a-z!/?]`, "i");
const JAVASCRIPT_URL = fromJs(String.raw`javascript:`, "i");
const CONTROL_CHARACTER = fromJs(String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]`);
const POST_ENTRY = fromJs(String.raw`^\s*POST\s+(\S+)\s*$`, "i");
const QUERY_OR_FRAGMENT_CHAR = fromJs(String.raw`[?#]`);
const QUERY_OR_FRAGMENT_OR_SPACE = fromJs(String.raw`[?#\s]`);
const FORM_QUERY_FIELD = fromJs(String.raw`(?:^|&)query=`);
const ENTRY_SEPARATOR = fromJs(String.raw`[,\n]`);

/** The method names an override value holds: one token, or a list a lenient server might read the first of. */
function overrideNames(value: string): string[] {
  return OVERRIDE_SEPARATOR.splitText(value)
    .map((v) => v.trim().toUpperCase())
    .filter((v) => METHOD_NAME.test(v));
}

/**
 * Whether a form, query or multipart field name is `_method` as a server reads
 * it, once decoded. PHP drops leading spaces, reads a name only up to a NUL
 * byte and reads `.` or a space in it as `_`; Rack 2 strips the brackets round
 * a top-level name (`[_method]`). Any of them makes it the override.
 */
function isMethodKey(key: string): boolean {
  const name = KEY_CLOSE.replace(KEY_LEAD.replace(key.split("\0")[0], ""), "");
  return name.replaceAll(" ", "_").replaceAll(".", "_").toLowerCase() === "_method";
}

/** `_method` among a query's or a form body's fields, keys decoded. */
function formMethodOverrides(text: string): string[] {
  const out: string[] = [];
  for (const [key, value] of new URLSearchParams(text)) if (isMethodKey(key)) out.push(value);
  return out;
}

/** `_method` in a body: a form-encoded field, a multipart field, or a top-level JSON key. */
function bodyMethodOverrides(body: string): string[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return typeof parsed?._method === "string" ? [parsed._method] : [];
    } catch {
      /* not JSON: read as the other shapes below */
    }
  }
  return [...formMethodOverrides(body), ...multipartMethodOverrides(body)];
}

/**
 * The `name` parameters of a multipart part's Content-Disposition line, quoted
 * either way or bare, or none when the line is not one. Split on `;` outside
 * quotes, as PHP reads it, and every `name` (and RFC 2231 `name*`) is kept: a
 * server may take the first or the last.
 */
function dispositionNames(line: string): string[] {
  if (!DISPOSITION_LINE.test(line)) return [];
  const params: string[] = [];
  let current = "";
  let quote = "";
  for (const c of line.slice(line.indexOf(":") + 1)) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ";") {
      params.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  params.push(current);
  const names: string[] = [];
  for (const param of params) {
    const eq = param.indexOf("=");
    const key = eq < 0 ? "" : param.slice(0, eq).trim().toLowerCase();
    if (key !== "name" && key !== "name*") continue;
    let value = param.slice(eq + 1).trim();
    // RFC 2231: charset'language'value, percent-encoded.
    if (key === "name*") value = safeDecode(CHARSET_PREFIX.replace(value, ""));
    const q = value[0];
    names.push(q === '"' || q === "'" ? value.slice(1, value.length > 1 && value.endsWith(q) ? -1 : undefined) : value);
  }
  return names;
}

/** A percent-encoded value decoded, or as given when it does not decode. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * `_method` among a multipart body's parts: a part whose Content-Disposition
 * names it, then its other header lines, a blank line and the value. Read
 * line by line, so the scan stays linear however the body is built.
 */
function multipartMethodOverrides(body: string): string[] {
  const out: string[] = [];
  const lines = LINE_BREAK.splitText(body);
  for (let i = 0; i < lines.length; i++) {
    if (!dispositionNames(lines[i]).some(isMethodKey)) continue;
    // A bounded few header lines after it, then the blank line that ends them.
    let j = i + 1;
    while (j < lines.length && j <= i + 8 && lines[j] !== "") j++;
    if (lines[j] === "" && j + 1 < lines.length) out.push(lines[j + 1]);
  }
  return out;
}

/**
 * The method the write policy judges a request as. A request may name
 * another method than the one it is sent with, in an override header
 * (METHOD_OVERRIDE_HEADERS), in `_method` in the query, or in `_method` in a
 * form, multipart or JSON body, and a server that honours it acts on the
 * named method: `POST /items/3` with `X-HTTP-Method-Override: DELETE` deletes.
 *
 * Every override is read, from every place, and the request is judged as the
 * one that writes most: any method that is not GET, HEAD, OPTIONS or POST
 * outweighs a POST, which outweighs a read. An override can therefore only
 * make a request stricter to judge, never looser: a POST naming GET is still
 * a POST. This is structural, and on in every mode but destructive.
 */
export function writeMethod(input: { method: string; url: string; headers?: Record<string, string>; body?: string | null }): WriteMethod {
  const sent = input.method.toUpperCase();
  const named: Array<{ method: string; via: string }> = [];
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const lower = name.toLowerCase();
    if (!(METHOD_OVERRIDE_HEADERS as readonly string[]).includes(lower)) continue;
    const display = HEADER_WORD.replace(lower, ({ groups }) => (groups[1] ?? "") + (groups[2] ?? "").toUpperCase()).replace("Http", "HTTP");
    for (const m of overrideNames(value)) named.push({ method: m, via: `${display}: ${m}` });
  }
  const query = input.url.indexOf("?");
  if (query >= 0) {
    for (const v of formMethodOverrides(input.url.slice(query + 1).split("#")[0]))
      for (const m of overrideNames(v)) named.push({ method: m, via: `_method=${m} in the query` });
  }
  if (input.body) for (const v of bodyMethodOverrides(input.body)) for (const m of overrideNames(v)) named.push({ method: m, via: `_method=${m} in the body` });
  let best: WriteMethod = { method: sent };
  for (const n of named) if (methodWeight(n.method) > methodWeight(best.method)) best = { method: n.method, via: n.via };
  return best;
}

/** How a blocked or logged request is named: its method, and the method it was judged as when an override changed it. */
export function writeMethodLabel(sent: string, judged: WriteMethod): string {
  return judged.via ? `${sent.toUpperCase()} as ${judged.method}` : judged.method;
}

/** Auth/session flows must work even under strict write policies (login, token refresh, logout). */
export const AUTH_FLOW_RE = fromJs(String.raw`\/(auth|login|logout|signin|sign-in|signup|sign-up|session|token|verify|oauth|sso|password)\b`, "i");

/**
 * A control's label is a verb phrase: "Delete", "Remove user", "Archive the
 * project". A card or tile that is a button carries prose in its accessible
 * name, the title then a sentence about it ("Manager Approves or rejects
 * orders that need sign-off."), and a destructive word in that sentence
 * describes what the thing is for; it is not the command the click sends, the
 * same distinction the wire policy draws for words inside a POST body.
 *
 * So a label that is prose, longer than this many words AND containing a
 * sentence, is judged by its head, the first few words, where the imperative
 * lives: a match counts only when it STARTS there. The pattern still sees the
 * whole label, so "reset filters" straddling the boundary keeps the context
 * its exemption looks ahead at. Everything else is judged whole: a short
 * label, a long one with no sentence in it ("Yes, I am sure I want to delete
 * this"), a script written without spaces.
 *
 * A confirm button whose long label ends in a full stop and puts the verb
 * late is the residue this lets through. The wire policy below still blocks
 * the DELETE, PUT, PATCH or verb-path POST it would send; a plain POST to a
 * neutral path passes in read-only, as it does for any control this list does
 * not name.
 */
export const LABEL_HEAD_WORDS = 6;

/** The head: up to LABEL_HEAD_WORDS whitespace-separated words from the start. */
const HEAD_RE = fromJs(String.raw`^\s*(?:\S+\s+){0,${LABEL_HEAD_WORDS - 1}}\S+`);
/** A sentence ends in the label: a full stop, question or exclamation mark followed by space or the end. */
const SENTENCE_RE = fromJs(String.raw`[.!?](?:\s|$)`);

/**
 * Where a match must start to count: the end of the head for prose, the end
 * of the label for everything else.
 */
function matchLimit(label: string): number {
  if (!SENTENCE_RE.test(label)) return label.length;
  const head = HEAD_RE.exec(label);
  if (!head || head.text.length === label.trimEnd().length) return label.length;
  return head.text.length;
}

export function isDestructive(...labels: Array<string | null | undefined>): boolean {
  return labels.some((label) => {
    if (typeof label !== "string" || label.length === 0) return false;
    const limit = matchLimit(label);
    return DESTRUCTIVE_PATTERNS.some((re) => {
      const m = re.exec(label);
      return m !== null && m.index < limit;
    });
  });
}

/**
 * A listed element as the label policy judges it. `name` is its accessible
 * name, which for an element with no label of its own is all its text,
 * descendants included. `ownText` is the label it is given (aria-label,
 * aria-labelledby) and its text without what belongs to the controls inside it, and `centre` the labels and test ids of the controls
 * inside it that cover its centre point, the spot a click on it lands; both
 * are read in the page and absent when they could not be.
 */
export interface JudgedControl {
  tag: string;
  role: string;
  name: string;
  testid?: string | null;
  ownText?: string | null;
  centre?: readonly string[] | null;
  /** Whether a user can act on it (collector.ts isInteractive). False for an element listed only for its test id or text. */
  interactive?: boolean;
}

/** The most words a click target's own text may have and still be read as its command. */
export const COMMAND_TEXT_WORDS = 4;

/** A short verb phrase, or null: at most COMMAND_TEXT_WORDS words and no sentence. */
function commandText(text: string): string | null {
  const words = WHITE_SPACE.splitText(text.trim()).filter(Boolean);
  return words.length > 0 && words.length <= COMMAND_TEXT_WORDS && !SENTENCE_RE.test(text) ? text : null;
}

/** Roles whose accessible name is the label of the one thing a click does. */
const LABELLED_CONTROL_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "checkbox",
  "radio",
  "switch",
  "treeitem",
  "image",
]);

/**
 * The label that makes a listed element destructive, or null. A control is
 * judged by its OWN name, never by what it merely contains:
 *
 * - A button, link, menu item, tab or option (by tag or by role) is named
 *   by what it does, and that name is judged whole, however long: a button
 *   "Delete all my saved data" is refused. The word cap below is only for
 *   containers, whose text is the record they show.
 * - A dropdown (a `<select>`, a combobox, a listbox) is named by its options,
 *   all of them, so a filter offering "All, Create, Update, Delete" read as a
 *   delete control and choosing "Create" was refused. Choosing is judged where
 *   the value is known: scout_select vets the chosen option, and an option
 *   clicked in a custom list is a control of its own. Only its test id, and a
 *   control covering its centre, are judged here.
 * - Anything else (a row, a card, a heading, a panel listed for its test id
 *   or a click handler) is judged by its test id and by the control covering
 *   its centre, where a click on it lands: a row whose middle IS a delete
 *   button is still refused, and the buttons inside it are listed, and
 *   refused, on their own. Its text is the record it shows ("Archive Test
 *   Widget", "Final sign-off recorded"), not a command, so the text counts
 *   only for a click target whose own text is a short verb phrase
 *   (COMMAND_TEXT_WORDS words, no sentence): a clickable div saying "Delete".
 *   A heading is never judged by its text.
 *
 * When the page could not say what the own text is, the whole name stands in
 * and is judged whole, so a reading that failed can only refuse more.
 */
export function destructiveLabelOf(c: JudgedControl): string | null {
  const first = (...labels: Array<string | null | undefined>): string | null =>
    labels.find((l): l is string => typeof l === "string" && l.length > 0 && isDestructive(l)) ?? null;
  const centre = c.centre ?? [];
  if (c.tag === "select" || c.role === "combobox" || c.role === "listbox") return first(c.testid, ...centre);
  if (LABELLED_CONTROL_ROLES.has(c.role) || c.tag === "button" || c.tag === "a") return first(c.name, c.testid);
  if (c.role === "heading" || HEADING_TAG.test(c.tag)) return first(c.testid, ...centre);
  const own = c.ownText == null ? c.name : c.interactive === false ? null : commandText(c.ownText);
  return first(own, c.testid, ...centre);
}

/**
 * A dropdown pick, judged by the value asked for, the dropdown's test id and
 * the label of the option it matches. The dropdown's own name is not judged
 * (destructiveLabelOf), so this is the check, and a label that could not be
 * read (null) refuses: an unvetted pick could be "Delete".
 */
export function pickIsDestructive(value: string | undefined, testid: string | null | undefined, optionLabel: string | null): boolean {
  return optionLabel === null || isDestructive(value, testid, optionLabel);
}

export function destructiveRefusal(label: string, mode: string = "read-only"): string {
  return (
    `REFUSED by ${mode} policy: "${label}" matches a destructive-action pattern. ` +
    `This run is ${mode}; do not attempt this element again. If destructive flows must be tested, ` +
    `the user has to re-attach with mode="destructive" against a disposable/seeded environment.`
  );
}

/** One write the policy refused, as the block notice reports it. */
export interface BlockedWrite {
  /** "POST https://host/path?query", or "navigation to …" for a refused page move. */
  sig: string;
  /** It started before the action now reporting it: background traffic, or a previous action's. */
  late: boolean;
  /** The page's own request was answered with a 403 in the server's place. */
  answered?: boolean;
  /** A reason beyond the mode's rule: a foreign embed, or ESCAPE_REFUSAL. */
  why?: string;
}

/** The `why` of a page move refused as a possible escape from a foreign frame's sandbox. */
export const ESCAPE_REFUSAL = "a possible frame escape";

/** The `why` of a page load refused because its address is a destructive command (strict-writes.ts destructiveGet, opt-in). */
export const DESTRUCTIVE_GET_REFUSAL = "a page load whose address is a destructive command";

/** New blocked endpoints listed by name in one notice; the rest are counted. */
export const BLOCK_NOTICE_LIST = 5;

/** What a blocked write is remembered by: its method and URL, without query or fragment. */
export function blockSignature(sig: string): string {
  return QUERY_OR_FRAGMENT.replace(sig, "");
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The write-policy block notice, said once. A page that beacons to a
 * monitoring endpoint on every load had every tool result open with the same
 * blocked request five times over and the whole explanation after it, which
 * buried the action's own result and the blocks that mattered.
 *
 * So a session remembers what it has been told. Each endpoint (by
 * blockSignature, per write rule) is named in full the first time it is
 * blocked; after that it is counted on one line. The explanation is given in
 * full once per rule, and later notices for a new endpoint refer back to it.
 * Nothing about the blocking changes: every request is still refused, and
 * every refusal is still reported, if only as a count.
 */
export class BlockNotices {
  private seen = new Set<string>();
  private explained = new Set<WriteMode>();

  /** Forget everything said: a re-attached session starts a new conversation. */
  reset(): void {
    this.seen.clear();
    this.explained.clear();
  }

  /**
   * The notice for the writes refused since the last action, or "" when there
   * were none. `createdCount` is how many records this run has created, which
   * the safe-write advice names.
   */
  notice(rule: WriteMode, blocked: readonly BlockedWrite[], createdCount = 0): string {
    if (blocked.length === 0) return "";
    type Group = { first: BlockedWrite; count: number; allLate: boolean; answered: boolean; whys: Set<string> };
    const groups = new Map<string, Group>();
    for (const b of blocked) {
      const key = blockSignature(b.sig);
      const g = groups.get(key);
      if (g) {
        g.count += 1;
        g.allLate &&= b.late;
        g.answered ||= !!b.answered;
        if (b.why) g.whys.add(b.why);
      } else groups.set(key, { first: b, count: 1, allLate: b.late, answered: !!b.answered, whys: new Set(b.why ? [b.why] : []) });
    }
    const fresh: Array<[string, Group]> = [];
    const repeats: Array<[string, Group]> = [];
    for (const [key, g] of groups) {
      const memo = `${rule} ${key}`;
      if (this.seen.has(memo)) repeats.push([key, g]);
      else {
        this.seen.add(memo);
        fresh.push([key, g]);
      }
    }
    const late = (g: Group): string => (g.allLate ? " (late — likely from a previous action or background traffic)" : "");
    const times = (g: Group): string => (g.count > 1 ? ` ×${g.count}` : "");
    const repeatCount = repeats.reduce((n, [, g]) => n + g.count, 0);
    const repeatLine =
      repeats.length === 0
        ? ""
        : `${plural(repeatCount, "repeat block")} of ${plural(repeats.length, "known endpoint")} (` +
          repeats
            .slice(0, 3)
            .map(([key, g]) => `${key} ×${g.count}${g.allLate ? ", background" : ""}`)
            .join("; ") +
          (repeats.length > 3 ? `; +${repeats.length - 3} more` : "") +
          `)`;
    const head = `\n🛡 WRITE-POLICY blocked (${rule}): `;
    if (fresh.length === 0) return `${head}${repeatLine}, refused as before. The tester's safety policy, not an app bug.`;

    const list = fresh
      .slice(0, BLOCK_NOTICE_LIST)
      .map(([, g]) => `${g.first.sig}${times(g)}${late(g)}`)
      .join("; ");
    const more = fresh.length > BLOCK_NOTICE_LIST ? ` (+${fresh.length - BLOCK_NOTICE_LIST} more new)` : "";
    const also = repeatLine ? `; also ${repeatLine}` : "";
    const whys = new Set(fresh.flatMap(([, g]) => [...g.whys]));
    const escaped = whys.delete(ESCAPE_REFUSAL);
    const destructiveLoad = whys.delete(DESTRUCTIVE_GET_REFUSAL);
    const foreign = [...whys];
    const answered = fresh.some(([, g]) => g.answered);
    const reasons =
      (foreign.length > 0
        ? `Refused because it was ${foreign.join("; ")}: it would reach a site embedded in the page rather than the app, which no mode but destructive allows. `
        : "") +
      (escaped
        ? `A move of the whole page off the app, with no Referer, was refused: a frame that held another site now sits on a data: or blob: URL, where WebKit drops the frame's sandbox, so the move may be that frame's. No mode but destructive allows it. `
        : "") +
      (destructiveLoad
        ? `A page load whose address names a destructive command (such as /items/3/delete) was refused, because the operator turned on refusing them in observe and read-only. Do not retry it; note the link as untested. `
        : "");
    if (this.explained.has(rule)) {
      return (
        `${head}${list}${more}${also}. The tester's safety policy, not an app bug (explained in full earlier in this session). ` +
        reasons +
        (answered ? `The page's request was answered with a 403 in the server's place, as before. ` : "")
      ).trimEnd();
    }
    this.explained.add(rule);
    return (
      `${head}${list}${more}${also}. ` +
      `This is the tester's safety policy, NOT an app bug — do not file a finding for the resulting error UI. ` +
      reasons +
      (answered
        ? `The page's own requests were answered with a 403 in the server's place, so the page's handling of a refusal is real: an error message is correct, and a success message is a false_success violation. `
        : "") +
      (rule === "observe"
        ? `observe mode lets out only GET, HEAD and OPTIONS (plus signing in, signing out, token refresh and POSTs named in readPosts), so no form submission reaches the server. Re-attach with mode="read-only" ONLY if the user confirms that ordinary form submissions are acceptable on this target. If a refused POST only reads (a search or query sent as POST), the user can name it in readPosts instead; never add one yourself.`
        : rule === "read-only"
          ? `Re-attach with mode="safe-write" to test create/edit flows, or "destructive" (user-approved disposable env only).`
          : `In safe-write, updates/deletes are only allowed on resources this session created (${createdCount} so far).`)
    );
  }
}

/** How the engine answers a native dialog the page opens. */
export type DialogResponse = "accept" | "dismiss";

/**
 * The answer to a native dialog. alert, confirm and prompt are dismissed in
 * the modes that protect data (observe, read-only) and accepted otherwise, as
 * before: a confirm can stand between a click and a delete.
 *
 * `beforeunload` is the page asking whether to leave while it holds unsent
 * input. Leaving sends no write of its own, and whatever the page sends as it
 * goes is judged by the wire policy like any other request, but leaving does
 * throw away what the tester typed. So it is the caller's choice: `leave: true`
 * leaves, `leave: false` stays, and with no choice the mode decides, staying
 * in observe and read-only. Either way the result says what happened (see
 * dialogNote), because a dismissed one surfaced only as a bare ERR_ABORTED.
 */
export function dialogResponse(type: string, readOnly: boolean, leave?: boolean): DialogResponse {
  if (type === "beforeunload") return (leave ?? !readOnly) ? "accept" : "dismiss";
  return readOnly ? "dismiss" : "accept";
}

/** The line an action's result carries for a native dialog the page opened during it. */
export function dialogNote(d: { type: string; message: string; response: DialogResponse; leave?: boolean }): string {
  const message = WHITE_SPACE.replace(d.message.trim(), " ").slice(0, 120);
  if (d.type === "beforeunload") {
    return d.response === "dismiss"
      ? `\n⚠ LEAVE CONFIRMATION: the page asked to confirm leaving (it holds input that was never sent), and the engine answered "stay"` +
          `${d.leave === false ? " as asked (leave: false)" : ""}, so the navigation was cancelled and the page is unchanged. ` +
          `This is not an app bug, and nothing was sent. To leave and discard that unsent input, repeat the action with leave: true.`
      : `\nℹ LEAVE CONFIRMATION: the page asked to confirm leaving (it held input that was never sent), and the engine answered "leave"` +
          `${d.leave === true ? " as asked (leave: true)" : ""}, so that unsent input is discarded. ` +
          `Any request the page sends as it is left is judged by the write policy like any other.`;
  }
  return `\nℹ DIALOG (${d.type})${message ? `: "${message}"` : ""} — ${d.response === "accept" ? "accepted" : "dismissed"} by the engine.`;
}

/**
 * Write-policy tiers. The database behind the app may be live, so the
 * guarantee lives at the network layer (HTTP verbs), not in button labels.
 *
 * - "observe":     nothing but GET, HEAD and OPTIONS leaves the page (login and
 *                  token refresh excepted). For a target holding real data,
 *                  where even an ordinary form submission creates a record
 *                  somebody has to clean up.
 * - "read-only":   destructive-labelled controls are refused, and
 *                  PUT/PATCH/DELETE plus destructive-looking POSTs are blocked.
 *                  Plain POSTs pass, because submitting forms is how
 *                  validation bugs are found, and are reported.
 * - "safe-write":  create freely; the engine tracks what THIS RUN creates and
 *                  allows PUT/PATCH/DELETE only on those records.
 * - "destructive": everything allowed. Explicit opt-in, disposable data only.
 */
export type WriteMode = "observe" | "read-only" | "safe-write" | "destructive";
export const WRITE_MODES = ["observe", "read-only", "safe-write", "destructive"] as const;

/** The stricter of two modes: WRITE_MODES runs from the strictest to the loosest. */
export function stricterMode(a: WriteMode, b: WriteMode): WriteMode {
  return WRITE_MODES.indexOf(a) <= WRITE_MODES.indexOf(b) ? a : b;
}

/**
 * How long a rule that was just loosened still judges writes. A request is
 * judged when the engine hears of it, which can be after the page sent it: a
 * beacon a page sends as it is left reaches the browser-level interception
 * tens of milliseconds after the page has gone, and a routed request waits its
 * turn behind the handler. Five seconds is two orders of magnitude above the
 * delays seen, and the price is only that writes sent in the first seconds
 * after a flow ends are judged by the flow's stricter rule.
 */
export const LOOSENED_RULE_HOLD_MS = 5000;

/**
 * The write rule in force, as the judges must read it: a request is judged by
 * the rule in force when the page sent it, which the engine cannot see, so by
 * the strictest rule in force at any time in the hold before it is judged.
 * Tightening the rule applies at once; loosening it (a flow handing back to
 * the crawl) keeps the stricter rule in force for `holdMs`, so a write the
 * flow's page sent under the flow's rule is never judged under the looser one
 * because it was heard of a moment late.
 */
export class WriteRule {
  private held: Array<{ mode: WriteMode; until: number }> = [];

  constructor(
    private current: WriteMode,
    private readonly holdMs = LOOSENED_RULE_HOLD_MS,
  ) {}

  set(mode: WriteMode, now = Date.now()): void {
    if (stricterMode(this.current, mode) === this.current && this.current !== mode) this.held.push({ mode: this.current, until: now + this.holdMs });
    this.current = mode;
  }

  /** The rule a write heard of now is judged by. */
  at(now = Date.now()): WriteMode {
    this.held = this.held.filter((h) => h.until >= now);
    return this.held.reduce((rule, h) => stricterMode(rule, h.mode), this.current);
  }
}

/**
 * May this non-GET request leave the page? Auth-flow requests are let through
 * before this is asked. `owned` means the request addresses a record this run
 * created (always false outside safe-write, where nothing is tracked).
 */
/**
 * In observe mode, the only auth requests let through are the ones a session
 * needs in order to exist: logging in, logging out, refreshing a token. Whole
 * path SEGMENTS, never substrings — `/users/login-history/clear` and
 * `/api/tokens` (mint an API token) are not logins. These words count
 * wherever they sit near the end; the ambiguous ones below only on an auth path.
 */
const OBSERVE_AUTH_SEGMENT_RE = fromJs(String.raw`^(login|log-in|signin|sign-in|logout|log-out|signout|sign-out|oauth|oauth2|sso|authenticate|authn)$`, "i");

/** A sign-in step's own name, before which `password` is the step that sends it (`/u/login/password`), not a change of password. */
const OBSERVE_SIGN_IN_SEGMENT_RE = fromJs(String.raw`^(login|log-in|signin|sign-in)$`, "i");

/** The environment variable naming the only POSTs that count as signing in (`authExemption: allowlist`). */
export const AUTH_POSTS_ENV = "SCENESCOUT_AUTH_POSTS";

/** The sign-in POSTs an operator listed, for one request: the entries, the app's URL, and the request's full URL. */
export interface AuthPostList {
  entries: readonly ReadPost[];
  appUrl: string;
  url: string;
  /** True: a POST must be listed AND look like a sign-in to the path rule (a guided check), so the list only narrows. Default: the list alone decides. */
  andSignInPath?: boolean;
}

/**
 * The auth allowlist from SCENESCOUT_AUTH_POSTS, or null when it is unset or
 * empty and the path rule applies. Entries are written as read POSTs are
 * (`POST /api/login`, `POST https://idp.example.com/oauth/token`, `*` for one
 * segment), separated by commas or new lines; what is not one is returned in
 * `rejected`. Set, it is the whole exemption: sign-in is expected to happen
 * out of band (`scenescout login`, a saved role), and only these POSTs go out
 * as sign-in during the run.
 */
export function authPostsSetting(env: string | undefined): { entries: ReadPost[]; rejected: string[]; overflow: string[] } | null {
  const list = readPostsSetting(undefined, env);
  return list.length === 0 ? null : readPostEntries(list);
}

/**
 * Words that name a sign-in step on an auth path (`/auth/refresh`,
 * `/oauth/token`, `/api/session`) and an action on anything else
 * (`/api/reports/refresh`, `/api/users/7/token`, `/api/carts/9/session`,
 * `/api/payments/callback`). Sign-in only in context: see authWordInContext.
 */
const OBSERVE_AMBIGUOUS_AUTH_RE = fromJs(String.raw`^(refresh|token|sessions?|callback|authorize)$`, "i");

/** A segment as compared: a leading dot dropped (`/.auth/refresh`) and `_` read as `-` (`/users/sign_in`), so it reads as the word it holds. */
const bareSegment = (seg: string): string => LEADING_DOTS.replace(seg, "").replaceAll("_", "-");

/** An API or version prefix: `/api`, `/rest`, `/v1`, `/v2.0`. */
const API_PREFIX_SEGMENT_RE = fromJs(String.raw`^(api|rest|v\d+(?:\.\d+)*)$`, "i");

/** Words that name the auth namespace, as one word of a segment (`/auth`, `/oauth2`, `/openid-connect`, `/rt-auth`, `/token/refresh`). */
const AUTH_NAMESPACE_WORD_RE = fromJs(
  String.raw`^(auth|oauth|oauth2|sso|idp|identity|openid|oidc|saml|saml2|jwt|token|tokens|session|sessions|login|signin|authentication|authn)$`,
  "i",
);

/**
 * Whether a segment names the auth namespace: one of its words (split on `-`,
 * `_` and `.`) is an auth word, or the whole segment is `connect` (`/connect/token`).
 * Inside a longer segment `connect` names an integration (`/stripe-connect`).
 */
function authNamespaceSegment(seg: string): boolean {
  return CONNECT_WORD.test(seg) || WORD_SEPARATOR.splitText(seg).some((w) => AUTH_NAMESPACE_WORD_RE.test(w));
}

/**
 * Words of the namespace a provider's callback lands in (`/auth/github/callback`,
 * `/.auth/login/aad/callback`). Not `connect`, `token(s)` or `session(s)`:
 * `/api/connect/stripe/callback` links an integration and
 * `/api/sessions/7/callback` acts on a record.
 */
const PROVIDER_NAMESPACE_WORD_RE = fromJs(String.raw`^(auth|oauth|oauth2|omniauth|sso|idp|identity|openid|oidc|saml|saml2|login|signin|authentication)$`, "i");

function providerNamespaceSegment(seg: string): boolean {
  return WORD_SEPARATOR.splitText(seg).some((w) => PROVIDER_NAMESPACE_WORD_RE.test(w));
}

/** Segments that scope an identity provider to a tenant or realm, whose id follows (`/realms/12345/protocol/openid-connect/token`). */
const IDP_SCOPE_SEGMENT_RE = fromJs(String.raw`^(realms|tenants|tfp)$`, "i");

/**
 * Whether segment `k` names an identity provider's tenant: a domain or an id
 * that opens the path (`/tenant.example.com/...`, `/<tenant-guid>/...`), or
 * what follows a scope segment (`/tfp/<tenant>/...`).
 */
function tenantSegment(segments: readonly string[], k: number): boolean {
  if (k === 0) return segments[0].includes(".") || isIdSegment(segments[0], 1);
  return IDP_SCOPE_SEGMENT_RE.test(bareSegment(segments[k - 1]));
}

/**
 * Whether a record's id comes before `index`, after a segment that is not
 * the auth namespace, an API prefix, an identity provider's scope or its
 * tenant: `/api/devices/7/auth/refresh` acts on device 7. An id that opens the
 * path is a tenant (`/<tenant-guid>/oauth2/v2.0/token`), one after a tenant is
 * its sign-in policy (`/<tenant>/B2C_1_signin/oauth2/v2.0/token`), and one
 * after an auth segment is an auth server's (`/oauth2/<server-id>/v1/token`).
 */
function recordBefore(segments: readonly string[], index: number): boolean {
  for (let k = 1; k < index; k++) {
    // +1: isIdSegment counts as split("/") does.
    if (!isIdSegment(segments[k], k + 1)) continue;
    const prev = bareSegment(segments[k - 1]);
    if (authNamespaceSegment(prev) || API_PREFIX_SEGMENT_RE.test(prev) || IDP_SCOPE_SEGMENT_RE.test(prev) || tenantSegment(segments, k - 1)) continue;
    return true;
  }
  return false;
}

/**
 * Whether the ambiguous auth word at `index` is a sign-in step: it opens the
 * path, or comes right after an API prefix or a segment of the auth
 * namespace (`/api/auth/refresh`, `/oauth/token`, `/oauth2/v1/token`). A
 * callback may also follow a provider's name inside the auth namespace
 * (`/auth/github/callback`). A word after any other resource
 * (`/api/reports/refresh`, `/integrations/slack/authorize`) or after a
 * record's id (`/api/devices/4/refresh`) is not.
 *
 * Second to last, only a callback inside the auth namespace counts
 * (`/api/auth/callback/credentials`): `/api/token/mint` and
 * `/api/refresh/reports` are actions on what follows.
 */
function authWordInContext(segments: readonly string[], index: number): boolean {
  if (recordBefore(segments, index)) return false;
  const word = bareSegment(segments[index]).toLowerCase();
  const prev = index > 0 ? bareSegment(segments[index - 1]) : null;
  if (index < segments.length - 1) return word === "callback" && prev !== null && providerNamespaceSegment(prev);
  if (prev === null || API_PREFIX_SEGMENT_RE.test(prev) || authNamespaceSegment(prev)) return true;
  // A provider has a name, not an id: `/auth/7/callback` acts on a record.
  return word === "callback" && index >= 2 && !isIdSegment(segments[index - 1], index) && providerNamespaceSegment(bareSegment(segments[index - 2]));
}

/**
 * Is this request an auth flow that must work even though the mode would
 * otherwise block it?
 *
 * Never for a destructive-looking request, in any mode: the exemption used to
 * be tested first, so `POST /api/session/123/delete` went through in read-only
 * because its path contains "session".
 *
 * In observe mode the exemption is much narrower than elsewhere. Signing up,
 * changing or resetting a password, verifying an email and creating a user all
 * change data on the target, and observe promises that nothing is created.
 * Refreshing a report, rotating a device's token or creating a checkout
 * session are writes too, so refresh, token, session, callback and authorize
 * count only on an auth path (authWordInContext).
 */
export function isAuthExempt(mode: WriteMode, method: string, pathname: string, destructiveWire: boolean, list?: AuthPostList | null): boolean {
  if (method !== "POST" || destructiveWire) return false;
  // An operator's allowlist replaces the path rule, in every mode; in a guided check it only narrows it.
  if (list) {
    const listed = matchReadPost(list.entries, list.appUrl, list.url) !== null;
    if (!listed || !list.andSignInPath) return listed;
  }
  if (mode !== "observe") return AUTH_FLOW_RE.test(pathname);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const last = bareSegment(segments[segments.length - 1]);
  // The password step of signing in (`/u/login/password`), not changing or resetting one (`/account/password`).
  if (
    PASSWORD_WORD.test(last) &&
    segments.length >= 2 &&
    OBSERVE_SIGN_IN_SEGMENT_RE.test(bareSegment(segments[segments.length - 2])) &&
    !recordBefore(segments, segments.length - 2)
  )
    return true;
  if (NOT_A_SIGN_IN_ACTION.test(last)) return false;
  // The matching segment must be at, or next to, the end: /auth/token/refresh, /oauth/token, /login.
  for (let i = Math.max(0, segments.length - 2); i < segments.length; i++) {
    const seg = bareSegment(segments[i]);
    if (OBSERVE_AUTH_SEGMENT_RE.test(seg)) return true;
    // `session(s)` only as the last segment, where a POST means "sign in", not "act on session 123".
    const sessionWord = SESSION_WORD.test(seg);
    if (OBSERVE_AMBIGUOUS_AUTH_RE.test(seg) && (!sessionWord || i === segments.length - 1) && authWordInContext(segments, i)) return true;
  }
  return false;
}

/**
 * The origin of a request's frame when that frame belongs to another site than
 * the app: an embedded widget, such as a form, chat or payment box served by a
 * third party. A write from one reaches that third party, not the app under
 * test, so no mode short of destructive lets it out.
 *
 * `frameChain` lists the URLs of the frame that issued the request and each of
 * its parents, stopping before the top document. A frame with no address of
 * its own (about:blank, srcdoc) belongs to whoever created it, so it is skipped
 * and its parent decides. Any foreign frame in the chain makes the request
 * foreign: an app page nested inside a widget is still being driven by it.
 * Null for the top document, same-origin frames, and requests with no frame.
 */
export function foreignFrameOrigin(appUrl: string, frameChain: readonly string[]): string | null {
  let app: string;
  try {
    app = new URL(appUrl).origin;
  } catch {
    return null;
  }
  for (const url of frameChain) {
    let frame: URL;
    try {
      frame = new URL(url);
    } catch {
      continue;
    }
    if (frame.protocol !== "http:" && frame.protocol !== "https:") continue;
    if (frame.origin !== app) return frame.origin;
  }
  return null;
}

/**
 * The origin to name when a write started by another site is headed outside
 * the app, or null when the write is the app's own or lands in the app.
 *
 * The source is foreign when the frame that sent it (or a parent) is of
 * another origin, or when the request's Origin header names another origin
 * than both the app and the frame it is attributed to. The second catches a
 * foreign frame's form aimed at `_top` or `_blank`, and a popup it opens: the
 * browser reports those against the top page or no frame at all, but the
 * Origin header still names the frame's site. A sign-in page loaded as the
 * whole page is not caught by it, since there the header and the page agree.
 *
 * A foreign write whose destination is the app itself — a sign-in provider's
 * frame posting its reply back to the app's callback — is the app's business
 * and is left to the ordinary rules.
 */
export function foreignWrite(
  appUrl: string,
  req: {
    url: string;
    frameChain: readonly string[];
    frameUrl: string | null;
    originHeader?: string;
    /** The URL of the page that sent it, when that is not the page the session drives (a popup nobody adopted). */
    unadoptedPageUrl?: string | null;
    /** Whether the session's page has a frame of another origin right now. */
    pageHasForeignFrame?: boolean;
  },
): string | null {
  let app: string;
  try {
    app = new URL(appUrl).origin;
  } catch {
    return null;
  }
  const originOf = (url: string | null | undefined): string | null => {
    if (!url) return null;
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  if (originOf(req.url) === app) return null;
  const fromFrame = foreignFrameOrigin(appUrl, req.frameChain);
  if (fromFrame) return fromFrame;
  const header = originOf(req.originHeader);
  if (header && header !== app && header !== originOf(req.frameUrl)) return header;
  // A popup a foreign frame opened on its own site posts from its own script
  // before it can be closed, and there the header and the page agree. The
  // session never drives a page it did not adopt, so its writes out are not
  // the app's.
  if (req.unadoptedPageUrl !== undefined && req.unadoptedPageUrl !== null) return originOf(req.unadoptedPageUrl) ?? "a page the session did not open";
  // A frame with a no-referrer policy sends "Origin: null". Out of the app,
  // on a page that embeds another site, that is taken to be the embed.
  if (req.originHeader === "null" && req.pageHasForeignFrame) return "an embedded frame (Origin: null)";
  return null;
}

/**
 * Whether the session's page was moved off the app by one of its embeds. The
 * sandbox forbids a frame to move the page, but WebKit drops it for a frame
 * that loads a `data:` URL in its own place, and a Chromium service worker can
 * serve a frame's document unseen.
 *
 * Decided on the navigation's first request, given the other sites the page
 * embeds at that moment (the engine asks the frames still attached, so a route
 * change, a 204 or a download changes nothing). A move from a page with no
 * embeds, or one carrying the app as its Referer — a click on the app's page —
 * is the tester's: a hosted sign-in page, even one the app also embeds for
 * silent sign-in, keeps the ordinary rules. With another site's Referer, it is
 * an embed's. With no Referer at all (an app that sends none, or a frame that
 * hides its origin) it is an embed's only when it goes to one of the embedded
 * sites.
 */
export class EmbedMoveTracker {
  private pending: string | null = null;
  /** The origin the page was moved to by an embed, while it stays there. */
  movedTo: string | null = null;
  constructor(private readonly appUrl: string) {}

  /** The top window's navigation to `url` sent its first request, with this Referer, from a page embedding these other sites. */
  navigationStarted(url: string, referer: string | undefined, embedded: ReadonlySet<string>): void {
    const target = foreignFrameOrigin(this.appUrl, [url]);
    if (!target || embedded.size === 0) {
      this.pending = null;
      return;
    }
    const refererIsHttp = !!referer && HTTP_SCHEME.test(referer);
    if (refererIsHttp && foreignFrameOrigin(this.appUrl, [referer!]) === null) this.pending = null;
    else if (refererIsHttp) this.pending = target;
    else this.pending = embedded.has(target) ? target : null;
  }

  /** The top window now shows `url`: a new document, or a same-document route change. */
  pageLoaded(url: string): void {
    let origin: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      origin = u.origin;
    } catch {
      return;
    }
    if (foreignFrameOrigin(this.appUrl, [url]) === null) {
      this.movedTo = null;
      this.pending = null;
      return;
    }
    if (this.pending === origin) this.movedTo = origin;
    else if (this.movedTo !== origin) this.movedTo = null;
    this.pending = null;
  }
}

/**
 * The origin to name when the session's page was moved off the app by one of
 * its embeds (EmbedMoveTracker) and writes to another site from there, or
 * null. Refused unless it is a sign-in request.
 */
export function offAppPageWrite(appUrl: string, pageUrl: string | undefined, destinationUrl: string, movedByEmbed: string | null): string | null {
  if (!movedByEmbed) return null;
  const originOf = (url: string | undefined): string | null => {
    if (!url) return null;
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  const app = originOf(appUrl);
  const page = originOf(pageUrl);
  if (!app || !page || page === app || page !== movedByEmbed) return null;
  if (originOf(destinationUrl) === app) return null;
  return page;
}

/**
 * The page a sandboxed frame is given in place of a redirect: it navigates to
 * the redirect's target itself, so the next hop is a navigation the policy
 * routes and sandboxes again. A redirect answered as a redirect is followed by
 * the browser without asking, and the page it lands on was not sandboxed.
 */
export function sandboxedRedirectPage(target: string): string {
  // No referrer: the next hop would otherwise name this stand-in page, where a real redirect names the app.
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>location.replace(${scriptLiteral(target)});</script>`;
}

/** The last path segment of a page that is a sign-in page, and nothing else: not a verification step, where a payment provider's frame sits. */
const SIGN_IN_SEGMENT_RE = fromJs(String.raw`^(login|log-in|signin|sign-in|signup|sign-up|sso|oauth)$`, "i");

/**
 * Whether a foreign frame's writes out may go on this page after all: a
 * captcha on the app's own sign-in page is a cross-origin frame that posts to
 * its own site, and refusing it would make every login fail. Only on the app's
 * own origin, only when the page's last path segment is a sign-in word (a
 * trailing file extension ignored, `_` read as `-`) — not "auth", which is
 * also the last step of a card payment's verification — and not in observe, where only the login
 * request itself goes out.
 */
export function allowsForeignWriteOnSignIn(mode: WriteMode, topPageUrl: string, appUrl: string): boolean {
  if (mode === "observe" || mode === "destructive") return false;
  let page: URL;
  try {
    page = new URL(topPageUrl);
    if (page.origin !== new URL(appUrl).origin) return false;
  } catch {
    return false;
  }
  const segments = page.pathname.split("/").filter(Boolean);
  // "sign_in" is "sign-in": underscores are how some frameworks spell it.
  const last = FILE_EXTENSION.replace(segments[segments.length - 1] ?? "", "").replaceAll("_", "-");
  return SIGN_IN_SEGMENT_RE.test(last);
}

/**
 * The embed a failing request is attributed to: the other site whose frame
 * sent it (`frameSite`, judged on the frame chain), unless the request went to
 * the app itself — a 500 from the app is the app's to answer, whoever called.
 */
export function embedOfRequest(appUrl: string, requestUrl: string, frameSite: string | null): string | null {
  if (!frameSite) return null;
  return foreignFrameOrigin(appUrl, [requestUrl]) === null ? null : frameSite;
}

/** The most origins a session may trust with its embeds' writes. */
export const MAX_TRUSTED_EMBEDS = 10;

/**
 * The origins a session was told to trust, normalised, and what was given
 * that is not one. An entry must be a plain http(s) origin — scheme, host and
 * port, nothing after — so a path or a wildcard cannot widen it by accident.
 */
export function trustedEmbedOrigins(list: readonly string[] | undefined): { origins: string[]; rejected: string[]; overflow: string[] } {
  const origins: string[] = [];
  const rejected: string[] = [];
  const overflow: string[] = [];
  for (const raw of list ?? []) {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      rejected.push(raw);
      continue;
    }
    const bare = u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password;
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !bare || raw.includes("*")) {
      rejected.push(raw);
      continue;
    }
    // "pay.example.com." is "pay.example.com": one origin, one slot.
    const origin = TRAILING_DOT.replaceFirst(u.origin, ({ groups }) => groups[1] ?? "");
    if (origins.includes(origin)) continue;
    if (origins.length < MAX_TRUSTED_EMBEDS) origins.push(origin);
    else overflow.push(raw);
  }
  return { origins, rejected, overflow };
}

/**
 * Whether the writes a frame of `origin` sends outside the app may go out
 * after all: only for an origin the user named as trusted (a provider in test
 * mode, say), and only in safe-write — read-only and observe keep their
 * promise, and destructive allows everything already.
 */
export function trustsEmbedWrite(mode: WriteMode, trusted: ReadonlySet<string>, origin: string): boolean {
  return mode === "safe-write" && trusted.has(origin);
}

/**
 * Whether a foreign write may go out because of trust: every other site
 * involved — each http(s) frame from the sender up to the page, and the
 * Origin header when it names one — must be trusted, so an untrusted embed
 * cannot borrow a trusted one it wraps. A page the session never adopted (a
 * popup) is not a frame, and trust does not reach it.
 */
export function trustsForeignWrite(
  mode: WriteMode,
  trusted: ReadonlySet<string>,
  appUrl: string,
  req: { frameChain: readonly string[]; originHeader?: string; unadoptedPageUrl?: string | null },
): boolean {
  if (mode !== "safe-write" || trusted.size === 0 || req.unadoptedPageUrl) return false;
  const originOf = (url: string | undefined): string | null => {
    if (!url) return null;
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  const app = originOf(appUrl);
  const involved = new Set<string>();
  for (const url of req.frameChain) {
    // A blank or srcdoc frame is its parent's, and the parent is judged next.
    // Any other frame with no web address (blob:, data:) could be an untrusted
    // site that moved itself there to wrap a trusted one: no trust through it.
    if (BLANK_FRAME.test(url)) continue;
    const o = originOf(url);
    if (!o) return false;
    if (o !== app) involved.add(o);
  }
  const header = originOf(req.originHeader);
  if (header && header !== app) involved.add(header);
  return involved.size > 0 && [...involved].every((o) => trustsEmbedWrite(mode, trusted, o));
}

/** The longest text typed into another site's frame; past it, a value is a fuzzing probe, not a user's input. */
export const MAX_EMBED_TEXT = 200;

/**
 * Why a value must not be typed into another site's frame, or null when it
 * may be. The tester is authorised to test the app, not the embeds of
 * others: markup, fuzzing lengths and control characters typed there would
 * be probing a third party's system without its leave.
 */
export function hostileForEmbed(text: string): string | null {
  if (MARKUP.test(text) || JAVASCRIPT_URL.test(text)) return "it is markup";
  if (text.length > MAX_EMBED_TEXT) return `it is longer than ${MAX_EMBED_TEXT} characters`;
  if (CONTROL_CHARACTER.test(text)) return "it holds control characters";
  return null;
}

/** The refusal for a probe aimed at another site's frame. */
export function embedProbeRefusal(what: string, origin: string): string {
  return (
    `REFUSED: ${what} inside a frame of ${origin}, another site embedded in the page. The tester is authorised to test the app, ` +
    `not the embeds of others, so hostile input, repeated-click probes and file uploads are never sent into one, in any mode. ` +
    `Ordinary clicks and typing there are allowed; the embed's writes out of the app are refused by the write policy.`
  );
}

/**
 * The sandbox given to every document a frame of another origin loads, outside
 * destructive mode: scripts, forms and its own origin keep working, and no
 * popups or top-window navigation are allowed. A browser applies it to every
 * realm the document makes, nested frames and blank ones included, which a
 * script patch cannot reach: in Firefox a detached link's click, a
 * `<base target>` or a borrowed `window.open` each opened a popup whose first
 * requests never reached the policy.
 */
export const FOREIGN_FRAME_SANDBOX = "sandbox allow-scripts allow-forms allow-same-origin";

/**
 * A response's Content-Security-Policy with the foreign-frame sandbox added. A
 * second policy joined with a comma is enforced alongside the first, so the
 * document's own policy still holds.
 */
export function withForeignFrameSandbox(existing: string | undefined): string {
  return existing && existing.trim() ? `${existing}, ${FOREIGN_FRAME_SANDBOX}` : FOREIGN_FRAME_SANDBOX;
}

/** The most POST endpoints a session may name as reads. */
export const MAX_READ_POSTS = 20;

/** The environment variable naming POST endpoints that only read, for every surface that attaches. A `readPosts` option wins over it. */
export const READ_POSTS_ENV = "SCENESCOUT_READ_POSTS";

/** One POST endpoint the user named as a read: an origin (null for the app's own) and path segments, `*` standing for any one segment. */
export interface ReadPost {
  /** The entry as given, for the log and the report. */
  entry: string;
  origin: string | null;
  segments: string[];
}

/**
 * The POST endpoints a session was told only read, from the `readPosts`
 * option, else the environment variable (entries separated by commas or new
 * lines). Nothing by default: observe refuses every POST until the user names
 * one, and the agent must never add one itself.
 */
export function readPostsSetting(option: readonly string[] | undefined, env: string | undefined): string[] {
  if (option !== undefined) return [...option];
  return ENTRY_SEPARATOR.splitText(env ?? "")
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * The entries parsed, and what was given that is not one. An entry is
 * `POST <path>` for the app's own origin, or `POST <http(s) URL>` for an API
 * on another origin: the method must be POST, the path must start with `/`
 * and carry no query or fragment, and `*` may stand only for one whole path
 * segment, such as an id. Exact otherwise, so nothing is widened by accident;
 * a trailing slash is ignored.
 */
export function readPostEntries(list: readonly string[]): { entries: ReadPost[]; rejected: string[]; overflow: string[] } {
  const entries: ReadPost[] = [];
  const rejected: string[] = [];
  const overflow: string[] = [];
  for (const raw of list) {
    const m = POST_ENTRY.exec(raw);
    if (!m) {
      rejected.push(raw);
      continue;
    }
    let origin: string | null = null;
    let pathname = m.groups[1] ?? "";
    if (HTTP_URL.test(pathname)) {
      let u: URL;
      try {
        u = new URL(pathname);
      } catch {
        rejected.push(raw);
        continue;
      }
      if (u.search || u.hash || u.username || u.password || QUERY_OR_FRAGMENT_CHAR.test(pathname)) {
        rejected.push(raw);
        continue;
      }
      origin = u.origin;
      // The path as written: URL would percent-encode a `*`.
      const slash = pathname.indexOf("/", pathname.indexOf("//") + 2);
      pathname = slash === -1 ? "/" : pathname.slice(slash);
    }
    const segments = pathname.split("/").filter(Boolean);
    if (!pathname.startsWith("/") || QUERY_OR_FRAGMENT_OR_SPACE.test(pathname) || segments.some((seg) => seg.includes("*") && seg !== "*")) {
      rejected.push(raw);
      continue;
    }
    const entry = `POST ${origin ?? ""}${"/" + segments.join("/")}`;
    if (entries.some((e) => e.entry === entry)) continue;
    if (entries.length < MAX_READ_POSTS) entries.push({ entry, origin, segments });
    else overflow.push(raw);
  }
  return { entries, rejected, overflow };
}

/** The entry a POST to `url` matches, or null. An entry with no origin matches the app's own origin only. */
export function matchReadPost(entries: readonly ReadPost[], appUrl: string, url: string): ReadPost | null {
  let target: URL;
  let app: string;
  try {
    target = new URL(url);
    app = new URL(appUrl).origin;
  } catch {
    return null;
  }
  const segments = target.pathname.split("/").filter(Boolean);
  return (
    entries.find(
      (e) => (e.origin ?? app) === target.origin && e.segments.length === segments.length && e.segments.every((seg, i) => seg === "*" || seg === segments[i]),
    ) ?? null
  );
}

/**
 * The page a script's POST was sent from, for the gap ledger's list of pages
 * observe refused a POST on. The Referer of a request the top document sent,
 * when it is a page of the app; otherwise the page the session drives when the
 * request is seen. A frame's Referer is its own document, which the session
 * never navigates to, so the caller passes none for a frame's request.
 *
 * The Referer comes first because the session's page URL can lag: a page's
 * script can send its first request before the browser has told Playwright
 * that the page committed, so the session still reports the page it came
 * from. A Referer that is the app's bare origin is set aside for the session's
 * page: an app whose referrer policy sends only the origin would otherwise
 * charge every page's POST to "/". The price is that the app's root page,
 * whose own Referer is that bare origin, still relies on the session's page
 * URL, lag and all.
 */
export function refusedPostPage(appUrl: string, referer: string | undefined, pageUrl: string | undefined): string | undefined {
  if (!referer) return pageUrl;
  let from: URL;
  try {
    from = new URL(referer);
    if (from.origin !== new URL(appUrl).origin) return pageUrl;
  } catch {
    return pageUrl;
  }
  const bareOrigin = from.pathname === "/" && !from.search;
  return bareOrigin && pageUrl ? pageUrl : referer;
}

/** The longest body read for a GraphQL operation; a longer one cannot be vetted and is refused. */
export const MAX_READ_POST_BODY = 100_000;

/** A GraphQL operation that writes: `mutation` or `subscription`, then an optional name, then its variables, directives or selection. */
const GRAPHQL_WRITE_OP_RE = fromJs(String.raw`(?:^|[^A-Za-z0-9_$])(?:mutation|subscription)\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*)?[({@]`);

/**
 * Whether a body carries a GraphQL operation that is not a query, or one that
 * cannot be read. Read from the body as sent, from every `query` string in a
 * JSON body (or a batch of them), so an escaped newline cannot hide the
 * keyword, and from a form-encoded `query` field. A persisted query (a hash
 * and no text) counts, since its operation is unknown. A search box's text
 * ("mutation testing") is not an operation and does not match.
 */
export function graphqlWriteOperation(body: string): boolean {
  if (GRAPHQL_WRITE_OP_RE.test(body)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A form-encoded body: its `query` field, decoded.
    const query = FORM_QUERY_FIELD.test(body) ? new URLSearchParams(body).get("query") : null;
    return query !== null && GRAPHQL_WRITE_OP_RE.test(query);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const { query, extensions } = item as { query?: unknown; extensions?: { persistedQuery?: unknown } };
    if (typeof query === "string") return GRAPHQL_WRITE_OP_RE.test(query);
    // A persisted query names its operation by hash alone, so what it runs cannot be read: refused.
    return typeof extensions === "object" && extensions !== null && extensions.persistedQuery !== undefined;
  });
}

/**
 * The entry that lets this POST out of observe, or null. Only in observe:
 * read-only and safe-write already let a POST out unless it looks
 * destructive, and destructive lets everything out. Even a listed endpoint is
 * refused when its path or body looks destructive (the whole body is read),
 * when its body is a GraphQL mutation, subscription or persisted query, or
 * when the body is too long to vet.
 */
export function readPostAllowed(input: {
  mode: WriteMode;
  method: string;
  url: string;
  appUrl: string;
  body: string | null | undefined;
  destructiveWire: boolean;
  entries: readonly ReadPost[];
}): ReadPost | null {
  if (input.mode !== "observe" || input.method !== "POST" || input.destructiveWire || input.entries.length === 0) return null;
  const entry = matchReadPost(input.entries, input.appUrl, input.url);
  if (!entry) return null;
  const body = input.body ?? "";
  // The whole body, not the first 2000 characters isDestructiveWire reads: a command after a long filter still counts.
  if (body.length > MAX_READ_POST_BODY || DESTRUCTIVE_BODY_RE.test(body) || graphqlWriteOperation(body)) return null;
  return entry;
}

export function allowsWrite(mode: WriteMode, method: string, destructiveWire: boolean, owned: boolean): boolean {
  if (mode === "destructive") return true;
  if (mode === "observe") return false;
  // POST: creation/RPC passes unless it looks destructive and is not ours.
  if (method === "POST") return !destructiveWire || owned;
  // PUT/PATCH/DELETE: only in safe-write, only on this run's own records.
  return mode === "safe-write" && owned;
}

/**
 * Which blocked requests the write policy answers rather than drops.
 *
 * A dropped request tells the page nothing it would ever meet in production:
 * `fetch` rejects with a network error, and the code that handles a refusal —
 * the branch that should say "couldn't save" — never runs. Answering a script's
 * request with a refusal keeps the server untouched and exercises that branch,
 * so a page that reports a refused save as saved is caught. A navigation (a
 * native form post) is still dropped: answering it would replace the page the
 * user was on with the stand-in body.
 */
export function answersWithRefusal(resourceType: string): boolean {
  return resourceType === "fetch" || resourceType === "xhr";
}

/** Header on every refusal the policy writes, so the stand-in can be told from the server's own answer. */
export const POLICY_REFUSAL_HEADER = "x-scenescout-policy";

/**
 * The response the write policy sends in the server's place. 403, because the
 * request is forbidden, not failed: a 5xx invites retries, and a 401 is what
 * many apps read as "signed out". The CORS headers let a cross-origin API
 * call read the refusal instead of failing as a network error, which would
 * drop it all over again. `origin` is the request's own Origin header, echoed
 * only when there is one.
 */
export function policyRefusal(
  mode: WriteMode,
  method: string,
  pathname: string,
  origin?: string,
  why?: string,
): { status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { "content-type": "application/json", [POLICY_REFUSAL_HEADER]: `refused; mode=${mode}` };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
    headers["access-control-expose-headers"] = POLICY_REFUSAL_HEADER;
  }
  return {
    status: 403,
    headers,
    body: JSON.stringify({
      error: "Forbidden",
      message: `${method} ${pathname} was refused by the tester's ${mode} write policy${why ? ` (${why})` : ""}. The server never received it.`,
    }),
  };
}
