/**
 * Redaction of credentials and personal data from text the engine is about to
 * persist or publish. memory.ts re-exports both functions, so importers that
 * reach them through the store are unchanged.
 *
 * Every pattern here reads text the app controls, so each runs on the
 * linear-time engine (linear-regex.ts); memory-test holds this file to no
 * JavaScript regular expression.
 */
import { isSpace, LinearRegex, runEnd, SPACE } from "./linear-regex.js";
import { cardEndAcross, FIELD_WORDS, maskSecretFieldValues, maskSecretParams, redactPersonal } from "./sensitive.js";

const isAsciiDigit = (c: string) => c >= "0" && c <= "9";
const isAsciiLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isAlnum = (c: string) => isAsciiDigit(c) || isAsciiLetter(c);
const isWordChar = (c: string | undefined) => c !== undefined && (isAlnum(c) || c === "_");
/** The characters of a bearer or basic credential. */
const isTokenChar = (c: string) => isAlnum(c) || "._~+/=-".includes(c);
/** The characters of a base64url run: a key's tail that may hold `_` and `-`. */
const isBase64UrlChar = (c: string) => isAlnum(c) || c === "_" || c === "-";
/** The characters of a keyword-led value. */
const isValueChar = (c: string) => isAlnum(c) || "._~+/=".includes(c);
const DIGIT = new LinearRegex("[0-9]");

/** Words that name a code that is not a secret ("error code 123456", "promo code …"). */
const OTHER_CODE_WORDS = new Set([
  ...["error", "status", "postal", "zip", "product", "area", "country", "exit", "reference", "promo", "order", "tracking"],
  ...["response", "http", "reason", "discount", "coupon", "voucher", "gift", "invoice", "referral", "invite", "promotion", "campaign"],
]);

/**
 * Whether one of OTHER_CODE_WORDS, a word on its own, and one whitespace
 * character stand just before `index` (the lookbehind of the sign-in code rule).
 */
function afterOtherCodeWord(text: string, index: number): boolean {
  if (index < 2 || !isSpace(text[index - 1])) return false;
  let start = index - 1;
  // The longest word is nine letters; reading one more tells a longer word from it.
  while (start > 0 && index - 1 - start <= 9 && isAsciiLetter(text[start - 1])) start -= 1;
  if (isWordChar(text[start - 1])) return false;
  return OTHER_CODE_WORDS.has(text.slice(start, index - 1).toLowerCase());
}

interface SecretPattern {
  re: LinearRegex;
  /** The text a match is replaced by. */
  replace: (groups: ReadonlyArray<string | undefined>) => string;
}

const fixed = (text: string) => (): string => text;

/** Whether `value` is whole base64 of printable text with a colon after its first character, as Basic credentials are. */
function decodesToUserPassword(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, "base64").toString("latin1");
  if (decoded.indexOf(":") < 1) return false;
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** The characters a keyword-led value's run is read in, for its entropy signal: the value's own, and a hyphen. */
const isRunChar = isTokenChar;
/**
 * Whether the run of value characters from `start` holds a digit and a letter
 * (the keyword rule's lookaheads). Candidates come left to right, so the last
 * run read is kept: a later candidate inside it is answered without reading it
 * again, and the text is read once. `reset` forgets it, before another text.
 */
function makeRunEntropy(): { check: (text: string, start: number) => boolean; reset: () => void } {
  let runStart = -1;
  let runStop = -1;
  let lastDigit = -1;
  let lastLetter = -1;
  const reset = () => {
    runStart = -1;
    runStop = -1;
  };
  const check = (text: string, start: number) => {
    if (start < runStart || start >= runStop) {
      runStart = start;
      runStop = start;
      lastDigit = -1;
      lastLetter = -1;
      while (runStop < text.length && isRunChar(text[runStop])) {
        if (isAsciiDigit(text[runStop])) lastDigit = runStop;
        else if (isAsciiLetter(text[runStop])) lastLetter = runStop;
        runStop += 1;
      }
    }
    return lastDigit >= start && lastLetter >= start;
  };
  return { check, reset };
}
const runEntropy = makeRunEntropy();

/**
 * `extend` for an open-ended run of `inRun` characters: where the run that
 * holds `end` stops. The last run read is kept, so candidates refused inside
 * one run (the search goes on from the next character) do not read it again.
 */
function runExtender(inRun: (c: string) => boolean): (match: { end: number }, text: string) => number {
  let lastText = "";
  let start = -1;
  let stop = -1;
  return ({ end }, text) => {
    if (text !== lastText || end < start || end > stop) {
      lastText = text;
      start = end;
      stop = runEnd(text, end, inRun);
    }
    return stop;
  };
}

const tokenRun = runExtender(isTokenChar);
const markedKeyRun = runExtender(isBase64UrlChar);
const alnumRun = runExtender(isAlnum);
/** `extend` for a bearer or basic token: its run, and on to the end of a card number the run stops inside. */
function tokenExtender(match: { end: number }, text: string): number {
  const end = tokenRun(match, text);
  return cardEndAcross(text, end) ?? end;
}

/**
 * Secrets an app leaks into its own error UI must not be re-published by the
 * tool that found them. Findings quote app output verbatim, and that output has
 * in practice included partial provider API keys; `.scenescout/` is gitignored
 * but still gets zipped and attached to tickets. Keep a short prefix so the
 * finding stays actionable, drop the rest.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // A private key's whole block, or its start to the end of the text when the end is cut off.
  {
    re: new LinearRegex(String.raw`-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}(?s:.)*?(?:-{5}END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}|$)`, {
      needs: ["private key"],
    }),
    replace: fixed("[private key redacted]"),
  },
  // Providers' key shapes, each by its fixed prefix, so the prefix alone ("the sk-ant prefix") is prose.
  { re: new LinearRegex(String.raw`\bsk-ant-[A-Za-z0-9_-]{10,}`, { needs: ["sk-ant-"] }), replace: fixed("sk-ant-[redacted]") },
  { re: new LinearRegex(String.raw`\b(xox[abeprs])-[A-Za-z0-9-]{10,}`, { needs: ["xox"] }), replace: (g) => `${g[1]}-[redacted]` },
  { re: new LinearRegex(String.raw`\bAIza[0-9A-Za-z_-]{30,}`, { needs: ["aiza"] }), replace: fixed("AIza[redacted]") },
  { re: new LinearRegex(String.raw`\bglpat-[A-Za-z0-9_-]{20,}`, { needs: ["glpat-"] }), replace: fixed("glpat-[redacted]") },
  { re: new LinearRegex(String.raw`\bnpm_[A-Za-z0-9]{36,}`, { needs: ["npm_"] }), replace: fixed("npm_[redacted]") },
  { re: new LinearRegex(String.raw`\bgithub_pat_[A-Za-z0-9_]{22,}`, { needs: ["github_pat_"] }), replace: fixed("github_pat_[redacted]") },
  { re: new LinearRegex(String.raw`\bxapp-[0-9]-[A-Za-z0-9-]{20,}`, { needs: ["xapp-"] }), replace: fixed("xapp-[redacted]") },
  { re: new LinearRegex(String.raw`\bwhsec_[A-Za-z0-9+/=]{20,}`, { needs: ["whsec_"] }), replace: fixed("whsec_[redacted]") },
  { re: new LinearRegex(String.raw`\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`, { needs: ["sg."] }), replace: fixed("SG.[redacted]") },
  { re: new LinearRegex(String.raw`\bhf_[A-Za-z0-9]{30,}`, { needs: ["hf_"] }), replace: fixed("hf_[redacted]") },
  // Needs the environment marker (sk_live_…) or a digit in the tail, or it
  // eats ordinary identifiers: "pk_customer_identifier" became "pk_[redacted]".
  // Each tail is read to its least length, then to the end of its run: after the marker, one that may hold `_` and `-`
  // (sk-proj-…), or the rest of the key was left readable.
  {
    re: new LinearRegex(String.raw`\b(sk|pk|rk)[-_](?:((?:live|test|proj)[-_][A-Za-z0-9_-]{8})|([A-Za-z0-9]{8}))`, {
      needs: ["k-", "k_"],
      extend: (match, text) => (match.groups[2] !== undefined ? markedKeyRun(match, text) : alnumRun(match, text)),
      accept: ({ groups, text }) => groups[2] !== undefined || DIGIT.test(text.slice((groups[1] ?? "").length + 1)),
    }),
    replace: (g) => `${g[1]}_[redacted]`,
  },
  { re: new LinearRegex(String.raw`\bgh[pousr]_[A-Za-z0-9]{16,}`, { needs: ["gh"] }), replace: fixed("gh?_[redacted]") },
  { re: new LinearRegex(String.raw`\bAKIA[0-9A-Z]{12,}`, { needs: ["akia"] }), replace: fixed("AKIA[redacted]") },
  // Keep the scheme that actually matched: rewriting a Basic-auth finding to
  // say "Bearer" silently changes what the finding claims.
  // Same entropy requirement as the keyword rule: "Basic authentication-required"
  // is prose, and redacting it rewrote a sentence into nonsense.
  {
    re: new LinearRegex(String.raw`\b((?i:Bearer|Basic))([${SPACE}]+)[A-Za-z0-9._~+/=-]{16}`, {
      needs: ["bearer", "basic"],
      extend: tokenExtender,
      accept: ({ groups, text }) => DIGIT.test(text.slice((groups[1] ?? "").length + (groups[2] ?? "").length)),
    }),
    replace: (g) => `${g[1]} [redacted]`,
  },
  // Basic credentials whose base64 holds no digit ("dXNlcjpwYXNz"): the run is whole base64 that decodes to
  // `user:password` in printable characters, which prose of the same letters is not. The last group is the lookahead:
  // no token character next, unless it is a full stop that ends the sentence.
  {
    re: new LinearRegex(String.raw`\b((?i:Basic))[${SPACE}]+([A-Za-z0-9+/]{8,}={0,2})($|[^A-Za-z0-9._~+/=-]|\.(?:$|[^A-Za-z0-9._~+/=-]))`, {
      needs: ["basic"],
      lookahead: true,
      accept: ({ groups }) => decodesToUserPassword(groups[2] ?? ""),
    }),
    replace: (g) => `${g[1]} [redacted]`,
  },
  // A bearer token of letters only is still a token when it is one unbroken run: prose joins its words with hyphens.
  // Not Basic: "basic internationalization" is prose of the same shape. The last group is the lookahead.
  {
    re: new LinearRegex(String.raw`\b((?i:Bearer))[${SPACE}]+[A-Za-z._~+/=]{16,}($|[^A-Za-z0-9._~+/=-])`, {
      needs: ["bearer"],
      lookahead: true,
    }),
    replace: (g) => `${g[1]} [redacted]`,
  },
  { re: new LinearRegex(String.raw`\beyJ[A-Za-z0-9._-]{20,}`, { needs: ["eyj"] }), replace: fixed("eyJ[redacted-jwt]") },
  // Keyword-led values need an entropy signal — a digit AND a letter, no
  // internal word breaks. Without it this matched ordinary English: "Password
  // requirements are not enforced" became "Password [redacted] are not
  // enforced", and a mangled finding just reads as the agent writing nonsense.
  {
    re: new LinearRegex(String.raw`\b((?i:api[-_ ]?key|secret|password|token))(["'${SPACE}:=]+)[A-Za-z0-9._~+/=]{12}`, {
      needs: ["key", "secret", "password", "token"],
      extend: runExtender(isValueChar),
      accept: ({ index, groups }, text) => runEntropy.check(text, index + (groups[1] ?? "").length + (groups[2] ?? "").length),
    }),
    replace: (g) => `${g[1]}${g[2]}[redacted]`,
  },
  // A PIN or a sign-in code written after its word: four to eight digits after "PIN" (or "PIN code"), six to eight
  // after "code", "OTP" or "passcode", unless the code is an error, status, postal, product, coupon or invoice one.
  // The last group of each is the lookahead: no digit next, nor a digit after a hyphen (or a dot or slash, after a PIN).
  {
    re: new LinearRegex(
      String.raw`\b((?i:PIN(?:[${SPACE}]+(?:code|number))?))([${SPACE}]*(?:(?i:is)[${SPACE}]+|[:=#][${SPACE}]*)?)[0-9]{4,8}($|[^0-9./-]|[./-](?:$|[^0-9]))`,
      { needs: ["pin"], lookahead: true },
    ),
    replace: (g) => `${g[1]}${g[2]}[redacted]`,
  },
  {
    // Six to eight digits, or two groups of three as a text message spaces them ("482 913").
    re: new LinearRegex(
      String.raw`\b((?i:(?:(?:verification|login|sign-in|security|one-time|otp|sms|2fa|mfa|auth|access|confirmation)[${SPACE}]+)?code|otp|passcode))` +
        String.raw`([${SPACE}]*(?:(?i:is)[${SPACE}]+|[:=][${SPACE}]*)?)(?:[0-9]{6,8}|[0-9]{3}[ -][0-9]{3})($|[^0-9-]|-(?:$|[^0-9]))`,
      { needs: ["code", "otp"], lookahead: true, accept: ({ index }, text) => !afterOtherCodeWord(text, index) },
    ),
    replace: (g) => `${g[1]}${g[2]}[redacted]`,
  },
];

/**
 * A secret's name set against a value with a colon or an equals sign
 * (`password: hunter2`, `"client_secret":"abc"`), whatever the value's length
 * or letters. Group 1 is the name, 2 the separator, 3 the value. A value of
 * letters only must end its clause and not be a word about the field, so
 * "Password: required" and "Token: missing after refresh" stay.
 */
const SET_SECRET_RE = new LinearRegex(
  // The value does not start with "[" (a value already masked).
  // A name may be several words before its secret's (`aws_secret_access_key`).
  String.raw`\b((?:[A-Za-z]+[-_]?)*?(?i:password|passwd|pwd|passphrase|secret|api[-_ ]?key|(?:private|signing|session|access|encryption|master)[-_]?key|credentials?|token))` +
    String.raw`([${SPACE}]*["']?[${SPACE}]*[:=：＝][${SPACE}]*["']?)([^${SPACE}"',;)}\][][^${SPACE}"',;)}\]]*)`,
  { needs: ["passw", "pwd", "passphrase", "secret", "key", "credential", "token"] },
);
const MASKED_SHOWN = new LinearRegex("^[•●∙·*]+$");
const LETTERS_ONLY = new LinearRegex(String.raw`^\p{L}+$`);
/** What may follow a value of letters only for it to end its clause. */
const CLAUSE_END = new LinearRegex(String.raw`^(?:[${SPACE}]*$|[${SPACE}]*[,;)}\]"'\n]|\.(?:[${SPACE}]|$))`);

/**
 * Whether a value's full stop (`stop`) and the text from `from` on end its
 * clause, as CLAUSE_END reads them: only the spaces they start with and the
 * two characters after are read, so a text with many values is read once.
 */
function endsClause(stop: string, text: string, from: number): boolean {
  if (stop !== "") return CLAUSE_END.test((stop + text.slice(from, from + 1)).slice(0, 2));
  let spaces = from;
  while (spaces < text.length && isSpace(text[spaces])) spaces += 1;
  return CLAUSE_END.test(text.slice(from, spaces + 2));
}

function maskSetSecrets(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = "";
  let last = 0;
  let at = 0;
  // A refused match resumes the scan right after its name, not after its value: the value may hold, or be followed
  // by, the name of another secret ("password:secret ＝…").
  for (;;) {
    const match = SET_SECRET_RE.exec(text, at);
    if (!match) break;
    const [, name = "", sep = "", raw = ""] = match.groups;
    // A sentence's full stop is not part of the value.
    let cut = raw.length;
    while (cut > 0 && raw[cut - 1] === ".") cut -= 1;
    const stop = raw.slice(cut);
    const value = raw.slice(0, cut);
    const refused =
      // Empty, or the dots or stars a masked value is shown as (the engine's own "•••• (masked: …)" included).
      value === "" ||
      MASKED_SHOWN.test(value) ||
      (LETTERS_ONLY.test(value)
        ? FIELD_WORDS.has(value.toLowerCase()) || !endsClause(stop, text, match.end)
        : value.length < 3 && !sep.includes('"') && !sep.includes("'"));
    if (refused) {
      at = match.index + name.length;
      continue;
    }
    hits += 1;
    out += `${text.slice(last, match.index)}${name}${sep}[redacted]${stop}`;
    last = match.end;
    at = match.end;
  }
  return { text: out + text.slice(last), hits };
}

/**
 * Strip anything that looks like a credential from text we are about to
 * persist: credential shapes, a value typed into a field whose label names a
 * secret (`textbox "Password" ← "…"`, whatever its length), the value of a
 * parameter named for one (`?password=…`), and personal data
 * (email addresses and card numbers, sensitive.ts).
 *
 * Silent edits are their own hazard, so a redaction announces itself: a reader
 * who sees mangled-looking text needs to know the tool did it deliberately.
 * Credentials and masked values are counted in a trailing note; personal data
 * is replaced by a marker that names it (`[email redacted]`).
 */
export function redactSecrets(text: string): string {
  const masked = maskSecretFieldValues(text);
  // A parameter named for a secret (`?pin=…` from a GET form) is masked whatever its value looks like.
  const params = maskSecretParams(masked.text);
  const set = maskSetSecrets(params.text);
  let out = set.text;
  let hits = masked.hits + params.hits + set.hits;
  for (const { re, replace } of SECRET_PATTERNS) {
    runEntropy.reset();
    out = re.replace(out, ({ groups }) => {
      hits += 1;
      return replace(groups);
    });
  }
  out = redactPersonal(out);
  return hits > 0 ? `${out} [${hits} secret${hits === 1 ? "" : "s"} redacted]` : out;
}

const REDACTED_NOTE = new LinearRegex(String.raw` \[[0-9]+ secrets? redacted\]$`);

/**
 * Routes are links the app printed, and a link can carry a token
 * (`?reset=…`, `?api_key=…`). Evidence is redacted where issues are built;
 * this does the same for every route string before anything is written.
 */
export function redactRoute(route: string): string {
  // The trailing "[n secrets redacted]" note belongs to prose; in a route it would read as part of the path.
  return REDACTED_NOTE.replace(redactSecrets(route), "");
}

/**
 * Personal data in the page's text, masked for the agent when the config's
 * redactPageText is "pii" (issue #537): email addresses, a phone number after
 * a word for one, and card numbers, each replaced by the marker redactPersonal
 * writes (`[email redacted]`, `[phone redacted]`, `[card number redacted]`).
 * They are the markers a stored finding already carries, so a title the agent
 * copies from masked text is the title the store keeps, and dedup reads both
 * alike. Credentials are not counted or noted here: this is what the agent
 * reads, not what is kept.
 */
export function maskPageText(text: string): string {
  if (!text.includes("\\")) return redactPersonal(text);
  // JSON a tool quotes (an API body, a console argument) writes a newline as `\n`: read as it is, `\nme@host` is an
  // address starting with the escape's letter, and its marker would leave a backslash before `[`, which is no JSON
  // escape. So the text is read as JSON would decode it and written back with its escapes: `\n`, `\r` and `\t` are
  // read as a space that stands for them (so `Phone:\n+44 …` is still a phone after its word), `\u0040` and
  // `\u002e` as the `@` and `.` they stand for, and every other escape ends the stretch masked on its own. A stretch
  // nothing is masked in is written back exactly as it came.
  const spacesFree = !WHITESPACE_STAND_INS.some((c) => text.includes(c));
  let out = "";
  let raw = "";
  let read = "";
  const flush = (): void => {
    if (raw === "") return;
    const masked = redactPersonal(read);
    out += masked === read ? raw : WHITESPACE_STAND_INS.reduce((t, c, i) => t.split(c).join(WHITESPACE_ESCAPES[i]!), masked);
    raw = "";
    read = "";
  };
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "\\" && next !== undefined) {
      const hex = next === "u" && isHex4(text, i + 2) ? text.slice(i + 2, i + 6).toLowerCase() : "";
      const plain = hex === "0040" ? "@" : hex === "002e" ? "." : "";
      const space = spacesFree ? WHITESPACE_ESCAPES.indexOf(`\\${next}`) : -1;
      if (plain || space >= 0) {
        raw += text.slice(i, plain ? i + 6 : i + 2);
        read += plain || WHITESPACE_STAND_INS[space]!;
        i += plain ? 6 : 2;
        continue;
      }
      if (hex !== "" || JSON_ESCAPES.includes(next)) {
        flush();
        const length = hex === "" ? 2 : 6;
        out += text.slice(i, i + length);
        i += length;
        continue;
      }
    }
    raw += c;
    read += c;
    i += 1;
  }
  flush();
  return out;
}

/**
 * JSON's escapes for a newline, a carriage return and a tab, and the space each
 * is read as while masking: characters redactPersonal reads as space and a page
 * seldom holds (a text that holds one is masked between those escapes instead).
 */
const WHITESPACE_ESCAPES = ["\\n", "\\r", "\\t"];
const WHITESPACE_STAND_INS = ["\u2028", "\u2029", "\u205f"];

/** The letters JSON writes after a backslash for a one-character escape. */
const JSON_ESCAPES = '"\\/bfnrt';

const isHexDigit = (c: string | undefined): boolean => c !== undefined && (isAsciiDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"));
const isHex4 = (text: string, at: number): boolean => isHexDigit(text[at]) && isHexDigit(text[at + 1]) && isHexDigit(text[at + 2]) && isHexDigit(text[at + 3]);

/** A tool's result as the MCP server returns it: text and pictures, and perhaps structured content. */
export interface MaskableResult {
  content: Array<{ type: string; text?: string } & Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
}

/** Every string in a JSON value masked, its keys and every other value kept. */
function maskStrings(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((v) => maskStrings(v, mask));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskStrings(v, mask);
    return out;
  }
  return value;
}

/**
 * A tool's result with personal data masked in each text part (and an
 * embedded resource's text) and in every string value of its structured
 * content; keys are kept. A picture is returned as it is: what it
 * shows is masked only where secret-pixels.ts paints a field over.
 */
export function maskToolResult<T extends MaskableResult>(result: T, mask: (text: string) => string = maskPageText): T {
  const content = result.content.map((part) => {
    if (part.type === "text" && typeof part.text === "string") return { ...part, text: mask(part.text) };
    // An embedded resource's text, should a tool return one.
    const resource = part.resource as { text?: unknown } | undefined;
    if (part.type === "resource" && resource && typeof resource.text === "string") return { ...part, resource: { ...resource, text: mask(resource.text) } };
    return part;
  });
  const out = { ...result, content };
  if (result.structuredContent !== undefined) out.structuredContent = maskStrings(result.structuredContent, mask) as Record<string, unknown>;
  return out;
}

/**
 * A tool's handler whose result is masked when `masked()` says so, asked
 * before and after the call (an attach opens a session under its config, a
 * close drops one), either answer masking. A thrown error is returned as the
 * MCP SDK would answer it, an `isError` result, with its message masked, and
 * the error object itself is left as it was; with masking off it is thrown on
 * unchanged. Anything that is not a result (no `content` list) passes as it is.
 */
export function maskingHandler<H extends (...args: never[]) => unknown>(handler: H, masked: () => boolean, mask: (text: string) => string = maskPageText): H {
  const wrapped = async (...args: never[]): Promise<unknown> => {
    const before = masked();
    let result: unknown;
    try {
      result = await (handler as (...a: never[]) => unknown)(...args);
    } catch (err) {
      if (!before && !masked()) throw err;
      return { content: [{ type: "text", text: mask(err instanceof Error ? err.message : String(err)) }], isError: true };
    }
    const isResult = result !== null && typeof result === "object" && Array.isArray((result as MaskableResult).content);
    return isResult && (before || masked()) ? maskToolResult(result as MaskableResult, mask) : result;
  };
  return wrapped as unknown as H;
}
