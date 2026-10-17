/**
 * What must never be written down in clear: the value typed into a secret
 * field, and personal data (email addresses, card numbers) in any text the
 * tool keeps. Pure functions of what the page and the text say, so
 * memory-test table-tests them; browser.ts only gathers the facts.
 *
 * Masking errs towards hiding. A field wrongly taken for a secret costs a repro
 * one typed value; a password wrongly taken for an ordinary field is published
 * in the action log, the report and every issue exported from it.
 *
 * Every pattern here reads text the app controls, so each runs on the
 * linear-time engine (linear-regex.ts); memory-test holds this file to no
 * JavaScript regular expression.
 */
import { LINE_END, LinearRegex, type LinearMatch, SPACE } from "./linear-regex.js";

/** What the page says about a field, read in one evaluate (browser.ts). Every fact is optional. */
export interface SecretFieldFacts {
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  /** The field's accessible name, its <label>s, its aria-label: whatever names it to a person. One text, or several. */
  label?: string | readonly string[] | null;
  placeholder?: string | null;
  /** The field's maxlength; 1 is a box of a code split into one box per character. */
  maxLength?: number | null;
  /**
   * Whether the field was type=password when the engine read it before. A
   * show-password toggle turns it into type=text, and a field named by nothing
   * else would then read as an ordinary one.
   */
  wasPassword?: boolean | null;
}

export type SecretKind = "password" | "one-time code" | "card" | "secret";

/** The autocomplete tokens (HTML's autofill field names) that mark a credential or a payment card. */
const AUTOCOMPLETE_KINDS: Record<string, SecretKind> = {
  "current-password": "password",
  "new-password": "password",
  "one-time-code": "one-time code",
  "cc-number": "card",
  "cc-csc": "card",
  "cc-exp": "card",
  "cc-exp-month": "card",
  "cc-exp-year": "card",
};

/**
 * Words that name a secret, matched against a name's words (camelCase, `_`,
 * `-` and spaces split them; trailing digits dropped, so `password2` and
 * `cvv2` count). A word in `whole` must be the whole word, so "spinner",
 * "pinned", "tokens" and "tokenizer" are not a PIN or a token. A word in
 * `suffix` may also end a longer one (`userpassword`, `clientsecret`, `totp`), but not
 * start it: "passwordless" and "secretary" are not secrets.
 */
const WORD_KINDS: Array<{ kind: SecretKind; whole: string[]; suffix: string[]; phrases: string[] }> = [
  {
    kind: "password",
    whole: ["pwd", "pw", "pword", "senha", "haslo", "heslo", "пароль"],
    // German compounds put the head last, so a password's confirmation ends in "bestätigung", not in "passwort".
    suffix: [
      "password",
      "passwd",
      "passphrase",
      ...["passwort", "kennwort", "passwortbestatigung", "passwortbestaetigung", "kennwortbestatigung", "kennwortbestaetigung"],
      ...["passwortwiederholung", "contrasena", "wachtwoord", "losenord", "passord", "adgangskode", "salasana"],
    ],
    phrases: ["mot de passe", "palavra passe", "memorable word"],
  },
  {
    kind: "one-time code",
    whole: ["pin", "onetime", "otpcode", "mfa", "authenticator", "geheimzahl"],
    suffix: [
      "otp",
      "passcode",
      ...["bestatigungscode", "bestaetigungscode", "verifizierungscode", "einmalcode", "verificatiecode", "bevestigingscode"],
      ...["engangskod", "verifieringskod", "engangskode", "vahvistuskoodi"],
    ],
    phrases: [
      ...["one time", "verification code", "pass code", "auth code", "authentication code", "two factor"],
      ...["code de verification", "code de confirmation", "code a usage unique"],
      ...["codigo de verificacion", "codigo de confirmacion", "codigo de un solo uso"],
      ...["codigo de verificacao", "codigo de confirmacao", "codigo de uso unico"],
      ...["codice di verifica", "codice di conferma", "codice monouso"],
      ...["kod weryfikacyjny", "kod jednorazowy", "overovaci kod"],
    ],
  },
  {
    kind: "card",
    whole: ["cvc", "cvv", "csc", "ccv", "ccnum", "cryptogramme"],
    suffix: [
      ...["cardnumber", "ccnumber", "kartennummer", "prufnummer", "pruefnummer", "kaartnummer", "kortnummer"],
      ...["sicherheitscode", "beveiligingscode", "sakerhetskod", "sikkerhetskode", "sikkerhedskode"],
    ],
    phrases: [
      ...["security code", "card number", "card no", "credit card", "cc number", "cc num", "cc csc", "cc exp"],
      ...["numero de carte", "carte bancaire", "carte de credit", "code de securite"],
      ...["numero de tarjeta", "tarjeta de credito", "codigo de seguridad"],
      ...["numero do cartao", "numero de cartao", "cartao de credito", "codigo de seguranca"],
      ...["numero della carta", "numero di carta", "carta di credito", "codice di sicurezza"],
      ...["numer karty", "cislo karty", "kortin numero"],
    ],
  },
  {
    kind: "secret",
    whole: ["token", "bearer", "sessionid", "accesskey", "sshkey", "signingkey", "licensekey", "licencekey"],
    suffix: ["secret", "apikey"],
    phrases: [
      ...["api key", "recovery code", "backup code", "private key", "seed phrase", "recovery phrase", "security answer"],
      ...["access key", "ssh key", "signing key", "license key", "licence key", "session id"],
    ],
  },
];

/**
 * The letters without their accents, so "Contraseña", "contrasena" and an
 * "ñ" written as "n" and a combining tilde all read alike. A name or an id is
 * usually typed without accents, so the word lists are written without them.
 */
const MARKS = new LinearRegex(String.raw`\p{M}+`);
function foldAccents(text: string): string {
  return MARKS.replace(text.normalize("NFD"), "").replaceAll("ł", "l").replaceAll("Ł", "L").replaceAll("ø", "o").replaceAll("Ø", "O").replaceAll("ß", "ss");
}

const LOWER_THEN_UPPER = new LinearRegex(String.raw`([a-z0-9])([A-Z])`);
const UPPER_RUN_THEN_WORD = new LinearRegex(String.raw`([A-Z]+)([A-Z][a-z])`);
const NOT_LETTER_OR_DIGIT = new LinearRegex(String.raw`[^\p{L}\p{N}]+`);
const TRAILING_DIGITS = new LinearRegex(String.raw`[0-9]+$`);
const spaced = (m: LinearMatch) => `${m.groups[1]} ${m.groups[2]}`;

/** A name's words, lower-case: `newPassword` → new password, `PINCode` → pin code, `cvv2` → cvv. */
function wordsOf(text: string): string[] {
  const split = UPPER_RUN_THEN_WORD.replace(LOWER_THEN_UPPER.replace(foldAccents(text), spaced), spaced).toLowerCase();
  return NOT_LETTER_OR_DIGIT.split(split)
    .map((w) => TRAILING_DIGITS.replace(w ?? "", ""))
    .filter((w) => w.length > 0);
}

/**
 * Words that, after a secret's word and nothing else, make the name one about
 * the secret rather than the secret: `token_count`, `otp_enabled`,
 * `password_hint_enabled`, "Password strength", "Drop a pin on the map".
 */
const ABOUT_THE_SECRET = new Set([
  ...["count", "hint", "hints", "enabled", "disabled", "enable", "disable", "length", "strength", "meter", "policy", "rule", "rules"],
  ...["expiry", "expires", "expiration", "ttl", "visible", "visibility", "toggle", "type", "format", "map", "on", "the", "a"],
]);

/**
 * The words that may stand beside "code" in the name of a field a sign-in code
 * is typed into ("Code", "SMS code", "Enter the 6-digit code"). Any other word
 * names another kind of code: a promo, postal, country or review one.
 */
const CODE_COMPANIONS = new Set([
  ...["code", "enter", "your", "the", "a", "digit", "sms", "text", "email", "login", "sign", "in", "signin", "access", "auth"],
  ...["confirm", "confirmation", "verify", "received", "sent"],
]);

/**
 * Words that name a secret only as the whole name ("Pass", `seed`,
 * "Credentials", perhaps after "Enter your"): with another word they name
 * something else ("Pass rate", "Boarding pass", "Random seed").
 */
const ALONE_KINDS: Record<string, SecretKind> = { pass: "password", seed: "secret", credential: "secret", credentials: "secret" };
const ALONE_FILLERS = new Set(["enter", "your", "the", "a"]);

/** The kind a single word names on its own, by WORD_KINDS' whole words and suffixes. */
function wordKind(word: string): SecretKind | null {
  for (const { kind, whole, suffix } of WORD_KINDS) if (whole.includes(word) || suffix.some((s) => word.endsWith(s))) return kind;
  return null;
}

const TWO_FA = new LinearRegex(String.raw`(?:^|[^\p{L}\p{N}])2fa(?:$|[^\p{L}\p{N}])`, { ignoreCase: true, needs: ["2fa"] });

/** Which kind of secret a field's name, label or placeholder names, if any. */
export function secretWordKind(text: string): SecretKind | null {
  // "2FA" splits into "2" and "fa" below, so it is read before the split.
  if (TWO_FA.test(text)) return "one-time code";
  const words = wordsOf(text);
  if (words.length === 0) return null;
  // A secret's word followed only by words about it names a setting or a count, not the secret.
  let tail = words.length;
  while (tail > 0 && ABOUT_THE_SECRET.has(words[tail - 1])) tail -= 1;
  const last = words[tail - 1];
  if (tail > 0 && tail < words.length && (wordKind(last) || last === "code" || last in ALONE_KINDS)) return null;
  const joined = ` ${words.join(" ")} `;
  // A phrase is read before a single word, as it says more: "pass code" is a code, though "pass" alone is a password.
  for (const { kind, phrases } of WORD_KINDS) if (phrases.some((p) => joined.includes(` ${p} `))) return kind;
  for (const { kind, whole, suffix } of WORD_KINDS) if (words.some((w) => whole.includes(w) || suffix.some((s) => w.endsWith(s)))) return kind;
  if (words.includes("code") && words.every((w) => CODE_COMPANIONS.has(w))) return "one-time code";
  const named = words.filter((w) => !ALONE_FILLERS.has(w));
  if (named.length === 1 && ALONE_KINDS[named[0]]) return ALONE_KINDS[named[0]];
  return null;
}

/** The input types a split code's boxes use (scripted-login.ts reads the same boxes). */
const SINGLE_CHARACTER_TYPES = new Set(["", "text", "tel", "number", "password"]);

const WHITESPACE = new LinearRegex(`[${SPACE}]+`);

/** Whether what is typed into this field is a secret, and which kind; null for an ordinary field. */
export function secretFieldKind(facts: SecretFieldFacts): SecretKind | null {
  if ((facts.type ?? "").trim().toLowerCase() === "password" || facts.wasPassword === true) return "password";
  for (const token of WHITESPACE.split((facts.autocomplete ?? "").toLowerCase())) {
    const kind = AUTOCOMPLETE_KINDS[token ?? ""];
    if (kind) return kind;
  }
  // One box per character is a split one-time code, whatever each box is called ("Digit 1").
  if (facts.maxLength === 1 && SINGLE_CHARACTER_TYPES.has((facts.type ?? "").trim().toLowerCase())) return "one-time code";
  const labels = typeof facts.label === "string" ? [facts.label] : (facts.label ?? []);
  for (const text of [facts.name, facts.id, ...labels, facts.placeholder]) {
    const kind = text ? secretWordKind(text) : null;
    if (kind) return kind;
  }
  return null;
}

/** The fixed stand-in for a secret field's value: the same whatever was typed, so not even its length is kept. */
export function maskedValue(kind: SecretKind): string {
  return `•••• (masked: ${kind} field)`;
}

/** A JSON-quoted string, as the type result writes a value. */
const QUOTED_TEXT = String.raw`(?:[^"\\]|\\[^${LINE_END}])*`;
const QUOTED = `"${QUOTED_TEXT}"`;
/** `"<label>" ← "<value>"`, the shape a type entry names its field and value in. */
const TYPED_INTO_RE = new LinearRegex(`"(${QUOTED_TEXT})" ← (${QUOTED})`, { needs: [" ← "] });
const EXISTING_RE = new LinearRegex(`existing content ${QUOTED}`, { needs: ["existing content"] });

/**
 * Mask the typed value, and any previous content a note quotes, wherever text
 * says a value went into a field whose label names a secret. The browser masks
 * these as it types (browser.ts); this catches text written by any other route,
 * such as an older log or an agent's own note. `hits` counts what was masked.
 */
export function maskSecretFieldValues(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = "";
  let last = 0;
  for (const m of TYPED_INTO_RE.matchAll(text)) {
    const label = m.groups[1] ?? "";
    const kind = secretWordKind(label);
    if (!kind) continue;
    out += text.slice(last, m.index) + `"${label}" ← ${maskedValue(kind)}`;
    last = m.end;
    hits += 1;
    // What the note says the field held before is the same secret's earlier value.
    const next = text.indexOf(" ← ", last);
    const rest = text.slice(last, next === -1 ? text.length : next);
    const cleaned = EXISTING_RE.replace(rest, () => {
      hits += 1;
      return `existing content (masked: ${kind} field)`;
    });
    out += cleaned;
    last += rest.length;
  }
  return { text: out + text.slice(last), hits };
}

/**
 * `name=value` in a query string, a fragment or a form body. A GET form puts
 * what was typed into the address (`?password=…`), and the address is logged
 * with every action. Group 1 is what precedes it, 2 the name, 3 the value.
 */
const PARAM_RE = new LinearRegex(String.raw`(^|[?&;#${SPACE}"'(])((?:\p{L}|%[0-9A-Fa-f]{2})[\p{L}\p{N}_.%[\]-]*)=([^&#;${SPACE}"')]+)`, { needs: ["="] });

/** A parameter's name as a person wrote it: percent-escapes decoded (`has%C5%82o`), or left as they are when they do not decode. */
function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name; // A malformed escape is part of the name as written; it still names what it names.
  }
}

/**
 * Parameter names whose value is a credential although no field would be
 * named so: a sign-in callback's code, a signed link's signature, a key, a
 * session or an auth value, a password under a short name. Read against the
 * name's letters only, lower-cased (`X-Amz-Signature` is `xamzsignature`).
 * guided.ts refuses an address carrying one, so the two lists are this one.
 */
export const SECRET_PARAM = new LinearRegex(
  "^(?:code|sig|signature|xamzsignature|xgoogsignature|key|session|sessionid|sid|auth|authorization|pass|nonce|jwt)$",
);
const NOT_A_TO_Z = new LinearRegex("[^a-z]+");

/** Whether a parameter's name names a secret: a field's word for one, or one of SECRET_PARAM. */
export function secretParamName(name: string): boolean {
  const decoded = decodedName(name);
  return secretWordKind(decoded.replaceAll("[", " ").replaceAll("]", " ")) !== null || SECRET_PARAM.test(NOT_A_TO_Z.replace(decoded.toLowerCase(), ""));
}

/**
 * Words that, set after a secret's name and a colon, name something about the
 * field rather than its value ("Password: required", "Token: expired"). Shared
 * by the redaction (redact.ts) and the guided choices' credential check.
 */
export const FIELD_WORDS: ReadonlySet<string> = new Set([
  ...["label", "field", "box", "input", "placeholder", "hint", "required", "optional", "missing", "empty", "blank", "wrong", "invalid"],
  ...["hidden", "masked", "shown", "visible", "error", "errors", "message", "too", "must", "should", "expired", "none", "null"],
  ...["undefined", "true", "false", "yes", "no", "not", "accepted", "rejected", "unset", "set", "the", "a", "an", "is", "be"],
  // A strength meter's verdict, and what happened to the secret.
  ...["weak", "fair", "good", "strong", "expires", "revealed", "changed", "updated", "saved", "valid", "ok"],
  // A validation message's or a log's verdict on the secret ("Password: incorrect", "Token: revoked").
  ...["incorrect", "correct", "mismatch", "mismatched", "match", "matches", "matched", "present", "absent", "filled", "reset"],
  ...["revoked", "refreshed", "rotated", "redacted", "removed", "deleted", "cleared", "unknown", "failed", "denied", "locked"],
  ...["pending", "used", "unused", "ignored", "sent", "received", "generated", "created", "stored", "active", "inactive"],
]);

/** Mask the value of every parameter whose name names a secret (`pin=`, `otp=`, `password=`, `access_token=`), whatever its length. */
export function maskSecretParams(text: string): { text: string; hits: number } {
  let hits = 0;
  const out = PARAM_RE.replace(text, ({ text: m, groups }) => {
    const [, before = "", name = "", value = ""] = groups;
    // A form's nested names (`user[password]`, `user%5Bpassword%5D`) name the field last; a value already masked stays.
    if (value.startsWith("[") || !secretParamName(name)) return m;
    hits += 1;
    return `${before}${name}=[redacted]`;
  });
  return { text: out, hits };
}

const FILL_CALL = new LinearRegex(`\\b(fill|type|pressSequentially|insertText)\\([^${LINE_END}]*`, {
  needs: ["fill(", "type(", "presssequentially(", "inserttext("],
});

/**
 * Playwright's call log names the value an action was given (`- fill("…")`),
 * so the error from a failed fill of a secret field quotes the secret. It does
 * not escape a quote inside the value, so the call is masked to the end of its
 * line, and every value the fill was given is removed wherever else it appears.
 */
export function maskFillCalls(message: string, values: readonly string[] = []): string {
  let out = message;
  // Longest first, so a value inside another is not left behind as part of it.
  for (const value of [...values].sort((a, b) => b.length - a.length)) if (value !== "") out = out.split(value).join("(masked)");
  return FILL_CALL.replace(out, (m) => `${m.groups[1]}((masked))`);
}

// ---------------------------------------------------------------------------
// Personal data in text
// ---------------------------------------------------------------------------

/** Domains reserved for documentation (RFC 2606 / 6761) name nobody, so an address on one stays readable. */
const RESERVED_DOMAIN_RE = new LinearRegex(String.raw`^(?:[\p{L}\p{N}-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)$`, {
  ignoreCase: true,
});
/** An image's pixel-density suffix (`@2x` before its extension), which reads like an address but is a file name. */
const DENSITY_DOMAIN_RE = new LinearRegex(String.raw`^[0-9]+(?:\.[0-9]+)?x\.`, { ignoreCase: true });
/** The characters an address's local part is written in (a class's inside); an address starts where the one before is not one. */
const LOCAL = String.raw`\p{L}\p{N}._%+-`;
/**
 * An address in any script, its @ written out or percent-encoded (`%40`), as a
 * query string carries it, its local part plain or quoted (`"jo sample"@…`).
 * Group 1 is the domain.
 */
const EMAIL_RE = new LinearRegex(String.raw`(?:"[^"\n@]{1,64}"|[${LOCAL}]+)(?:@|%40)([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:\p{L}{2,}|xn--[a-z0-9-]+))`, {
  ignoreCase: true,
  needs: ["@", "%40"],
  notAfter: LOCAL,
});
/** An address at an IP literal (`jo@[10.1.2.3]`, `jo@[IPv6:…]`). */
const EMAIL_IP_RE = new LinearRegex(String.raw`[${LOCAL}]+@\[(?:IPv6:[0-9A-Fa-f:.]+|[0-9]{1,3}(?:\.[0-9]{1,3}){3})\]`, {
  needs: ["@["],
  notAfter: LOCAL,
});
/** `git@host:team/repo.git`: a path after the colon that follows an address. */
const SSH_PATH = new LinearRegex(String.raw`^:[A-Za-z0-9_~/.-]`);
/** "at" and "dot" written out to hide an address from scrapers: bracketed, `(at)` `[dot]`, or bare between spaces. */
const AT_WORD = String.raw`(?:[${SPACE}]*[([{][${SPACE}]*at[${SPACE}]*[)\]}][${SPACE}]*|[${SPACE}]+at[${SPACE}]+)`;
const DOT_WORD = String.raw`(?:[${SPACE}]*[([{][${SPACE}]*dot[${SPACE}]*[)\]}][${SPACE}]*|[${SPACE}]+dot[${SPACE}]+|\.)`;
const DOT_WORD_RE = new LinearRegex(DOT_WORD, { ignoreCase: true });
/** An address with its @, and perhaps its dots, written as words. Group 1 is the domain as written; the last group is the lookahead. */
const SPELLED_EMAIL_RE = new LinearRegex(String.raw`[${LOCAL}]+${AT_WORD}([\p{L}\p{N}-]+(?:${DOT_WORD}[\p{L}\p{N}-]+)+)($|[^\p{L}\p{N}])`, {
  ignoreCase: true,
  needs: ["at"],
  lookahead: true,
  notAfter: LOCAL,
});
const LETTERS_ONLY_2 = new LinearRegex(String.raw`^\p{L}{2,}$`);
const BRACKETED_WORD = new LinearRegex(String.raw`[([{][${SPACE}]*(?:at|dot)[${SPACE}]*[)\]}]`, { ignoreCase: true });
const BARE_DOT = new LinearRegex(String.raw`[${SPACE}]dot[${SPACE}]`, { ignoreCase: true });
/**
 * The top-level domains a bare "x at y dot z" must end in to be read as an
 * address: without a bracket, "look at the dot matrix" reads the same way.
 */
const BARE_SPELLED_TLDS = new Set(["com", "org", "net", "io", "co", "uk", "de", "fr", "es", "it", "nl", "eu", "edu", "gov", "info", "biz", "me", "dev", "app"]);

function redactSpelledEmail({ text: match, groups }: LinearMatch): string {
  const domain = DOT_WORD_RE.replace(groups[1] ?? "", ".");
  const tld = domain.slice(domain.lastIndexOf(".") + 1).toLowerCase();
  if (!LETTERS_ONLY_2.test(tld) || RESERVED_DOMAIN_RE.test(domain)) return match;
  const bracketed = BRACKETED_WORD.test(match);
  if (!bracketed && !BARE_SPELLED_TLDS.has(tld)) return match;
  // Only the @ spelled out, the dots written as dots, is an address only when the at is bracketed: "meet at noon.today" is not one.
  if (!bracketed && !BARE_DOT.test(match)) return match;
  return "[email redacted]";
}
/**
 * A run of digit groups split by single separators: a space, a non-breaking,
 * narrow non-breaking, thin or figure space (a formatted number, a French
 * locale, typeset text), a hyphen or a dot. A card number is some of its
 * groups; cardShaped keeps an address, a version, a date or a decimal from
 * reading as one. A run never starts at a decimal's fraction (`0.4111…`), but
 * does after a word's dot (`no.4111…`).
 */
const DIGIT_SPACE = String.raw`[ \x{a0}\x{2007}\x{2009}\x{202f}]`;
/** One separator: one or two spaces, or a dot, hyphen or slash with up to two spaces either side (`4111 - 1111`, `4111/1111`). */
const DIGIT_SEPARATOR = `(?:${DIGIT_SPACE}{0,2}[./-]${DIGIT_SPACE}{0,2}|${DIGIT_SPACE}{1,2})`;
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
/**
 * A run starts after neither a digit nor a digit and a dot. The search never
 * finds a run that starts so (a run is read whole, through any ".digit"), so
 * the check never sends it back over a run.
 */
const DIGIT_RUN_RE = new LinearRegex(`[0-9]+(?:${DIGIT_SEPARATOR}[0-9]+)*`, {
  needs: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  accept: ({ index }, text) => !isDigit(text[index - 1]) && !(text[index - 1] === "." && isDigit(text[index - 2])),
});
const DIGIT_SEPARATOR_RE = new LinearRegex(`(${DIGIT_SEPARATOR})`);
/**
 * The card networks' issuer prefixes (IIN ranges) and the lengths each
 * issues. A digit run is a card number only when a network could have issued
 * it: about one random id in ten passes the Luhn check, so the check alone
 * redacts order ids, lists of years and lists of five-digit numbers. `from`
 * and `to` are the first and last prefix, written with the same number of
 * digits. The ranges err towards hiding: every prefix a network issues from,
 * however few its cards (Maestro's 50, 56 to 58 and 6 cover several national
 * networks), and every length from 13 to 19 where a network issues more than
 * one. What is left out is what no network issues from at that length: a
 * leading 1 or 7, a 2 outside 2200 to 2205 and 2221 to 2720, a 3 outside 30,
 * 34 to 39 and a 19-digit 31, a 59, an 8 outside 81, 82 and 8600, and a 9
 * outside 9792 and 9860.
 */
const ANY_LENGTH = [13, 14, 15, 16, 17, 18, 19] as const;
const CARD_NETWORKS: ReadonlyArray<{ from: string; to: string; lengths: readonly number[] }> = [
  { from: "4", to: "4", lengths: ANY_LENGTH }, // Visa, Visa Electron
  { from: "51", to: "55", lengths: [16, 17, 18, 19] }, // Mastercard
  { from: "2221", to: "2720", lengths: [16, 17, 18, 19] }, // Mastercard
  { from: "2200", to: "2204", lengths: [16, 17, 18, 19] }, // Mir
  { from: "34", to: "34", lengths: [15] }, // American Express
  { from: "37", to: "37", lengths: [15] }, // American Express
  { from: "30", to: "30", lengths: ANY_LENGTH }, // Diners Club (300 to 305, 3095), JCB (3088 to 3102)
  { from: "31", to: "31", lengths: [19] }, // China T-Union
  { from: "2205", to: "2205", lengths: [16] }, // BORICA
  { from: "36", to: "36", lengths: ANY_LENGTH }, // Diners Club
  { from: "38", to: "39", lengths: ANY_LENGTH }, // Diners Club
  { from: "35", to: "35", lengths: [16, 17, 18, 19] }, // JCB (3528 to 3589), RuPay (353, 356)
  { from: "50", to: "50", lengths: ANY_LENGTH }, // Maestro, Dankort, Elo, Verve, RuPay
  { from: "56", to: "58", lengths: ANY_LENGTH }, // Maestro
  { from: "60", to: "69", lengths: ANY_LENGTH }, // Maestro, Discover, UnionPay, RuPay, Hipercard, InstaPayment
  { from: "81", to: "82", lengths: [16, 17, 18, 19] }, // RuPay, UnionPay
  { from: "8600", to: "8600", lengths: [16] }, // UzCard
  { from: "9792", to: "9792", lengths: [16] }, // Troy
  { from: "9860", to: "9860", lengths: [16] }, // Humo
  // Maestro's 12-digit cards, from the prefixes it issues them under only: a 12-digit id is common, so no wider range.
  { from: "5018", to: "5018", lengths: [12] },
  { from: "5020", to: "5020", lengths: [12] },
  { from: "5038", to: "5038", lengths: [12] },
  { from: "5893", to: "5893", lengths: [12] },
  { from: "6304", to: "6304", lengths: [12] },
  { from: "6759", to: "6759", lengths: [12] },
  { from: "6761", to: "6763", lengths: [12] },
];

/** Whether a network issues card numbers that start with these digits and are this long. */
function issuedByANetwork(digits: string): boolean {
  return CARD_NETWORKS.some(({ from, to, lengths }) => {
    if (!lengths.includes(digits.length)) return false;
    const prefix = digits.slice(0, from.length);
    return prefix >= from && prefix <= to;
  });
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function isCardNumber(digits: string): boolean {
  return issuedByANetwork(digits) && luhnValid(digits);
}

/**
 * Whether groups[i..j] are laid out as a card number is written: one run of
 * digits, or groups of at least four (4-4-4-4, 4-6-5) with a shorter last one
 * allowed. A list of small numbers (`320 375 414 768`) is not, whatever its
 * digits add up to. Across a dot every group is at most six digits, as a
 * card's groups are, so a decimal with a long whole part (`4111111111.111111`)
 * is not one either. `seps[k]` is the separator before groups[k + 1].
 */
function cardShaped(groups: readonly string[], seps: readonly string[], i: number, j: number): boolean {
  for (let k = i; k < j; k++) if (groups[k].length < 4) return false;
  if (seps.slice(i, j).some((s) => s.includes("."))) for (let k = i; k <= j; k++) if (groups[k].length > 6) return false;
  return true;
}

/**
 * Where the card numbers among a run's digit groups lie, as offsets into the
 * run. Each is the longest that starts at its group, so a date or a quantity
 * written just before a card number does not hide it. A group is never split:
 * digits inside a longer id stay.
 */
function cardSpansInRun(run: string): Array<{ from: number; to: number }> {
  const parts = DIGIT_SEPARATOR_RE.split(run).map((part) => part ?? "");
  const groups = parts.filter((_, i) => i % 2 === 0);
  const seps = parts.filter((_, i) => i % 2 === 1);
  const spans: Array<{ from: number; to: number }> = [];
  let offset = 0;
  let i = 0;
  while (i < groups.length) {
    let end = -1;
    let digits = "";
    // A group after a dot is a decimal's fraction or a version's part, never the start of a card number.
    const afterDot = i > 0 && parts[2 * i - 1] === ".";
    for (let j = i; !afterDot && j < groups.length && digits.length + groups[j].length <= 19; j++) {
      digits += groups[j];
      if (cardShaped(groups, seps, i, j) && isCardNumber(digits)) end = j;
    }
    if (i > 0) offset += parts[2 * i - 1].length;
    if (end === -1) {
      offset += groups[i].length;
      i += 1;
    } else {
      let to = offset;
      for (let k = i; k <= end; k++) to += groups[k].length + (k > i ? parts[2 * k - 1].length : 0);
      spans.push({ from: offset, to });
      offset = to;
      i = end + 1;
    }
  }
  return spans;
}

function redactCardsInRun({ text: run }: LinearMatch): string {
  let out = "";
  let last = 0;
  for (const { from, to } of cardSpansInRun(run)) {
    out += `${run.slice(last, from)}[card number redacted]`;
    last = to;
  }
  return out + run.slice(last);
}

/** The most a card number can take in text: 19 digits and a separator of up to five characters between groups. */
const CARD_WINDOW = 130;

/**
 * Where the card number that spans position `at` ends, or null if none does.
 * A credential read up to `at` that stops inside a card number leaves the rest
 * of the card in clear. Only the text within a card's length of `at` is read,
 * so asking at many places in one text stays linear.
 */
export function cardEndAcross(text: string, at: number): number | null {
  let from = Math.max(0, at - CARD_WINDOW);
  // A digit run is read whole, so the window starts where a run does.
  while (from > 0 && from < at && isDigit(text[from - 1])) from += 1;
  const window = text.slice(from, at + CARD_WINDOW);
  for (const run of DIGIT_RUN_RE.matchAll(window)) {
    for (const { from: start, to } of cardSpansInRun(run.text)) {
      const absStart = from + run.index + start;
      const absEnd = from + run.index + to;
      if (absStart < at && absEnd > at) return absEnd;
    }
  }
  return null;
}

/**
 * Words that say the number after them is a phone number, in the languages the
 * secret-field labels are read in. Whole words only: "hotel", "Intel" and
 * "telemetry" are not "tel".
 */
const PHONE_WORDS = [
  // Not "cell" (a table's) or "gsm" (a radio band): both are followed by lists of numbers more often than by a phone number.
  ...["phone", "telephone", "tel", "tél", "mobile", "cellphone", "call", "whatsapp", "contact", "ph"],
  ...["telefon", "telefone", "teléfono", "telefono", "téléphone", "telefoon", "telefonu", "móvil", "movil", "celular", "cellulare", "mobil"],
];
/** What may stand between the word and the number: punctuation, the quotes and arrow of a typed value, and a word for "number". */
const PHONE_GAP = String.raw`[${SPACE}:.#\-"'←„“”«»]`;
const NUMBER_WORD = String.raw`(?:number|no|nr|num|numero|número|numéro|nummer|numer)\.?${PHONE_GAP}*`;
/** The same word written onto the word for phone, as "Telefonnummer" and "phonenumber" are. */
const GLUED_NUMBER_WORD = "(?:number|nummer|nr|numero|número|numéro)?";
/**
 * A phone number written right after a word for one: international (a leading
 * +, then its groups, or one run) or national with separators (`(555)
 * 123-4567`, `030 123 45 67`). Group 1 is the number. Without the word nothing
 * is taken: a signed amount (`+1 234 567`) or a grouped count reads exactly
 * like an international number, and a fuzz of the shapes a run's text holds
 * (ids, dates, times, versions, prices, card-like numbers, lists) found the
 * word to be what keeps them apart.
 */
const PHONE_RE = new LinearRegex(
  // The word, not after a letter (notAfter), nor before one: the gap and the number never start with a letter, so a
  // word for "number" comes only after a gap. "T" for telephone only with its dot or colon ("T: +44 …"): "don't 0800 …"
  // is not one. The last group is the lookahead: no digit next, nor after one more word character or dot.
  String.raw`(?:(?:${PHONE_WORDS.join("|")})${GLUED_NUMBER_WORD}(?:${PHONE_GAP}+(?:${NUMBER_WORD})?)?|t[.:]${PHONE_GAP}*(?:${NUMBER_WORD})?)` +
    String.raw`(\+[1-9][0-9]{0,2}(?:[ .\-]?\(?[0-9]{1,5}\)?){1,5}|\(?[0-9]{1,5}\)?(?:[ .\-][0-9]{2,8}){1,4})` +
    // JavaScript's \w under the i and u flags holds the long s and the Kelvin sign too.
    String.raw`($|[^A-Za-z0-9_.\x{17f}\x{212a}]|[A-Za-z_.\x{17f}\x{212a}](?:$|[^0-9]))`,
  {
    ignoreCase: true,
    // Every word for a phone, or a part of it every spelling holds.
    needs: ["ph", "tel", "tél", "mobil", "call", "whatsapp", "contact", "t.", "t:", "vil", "celular", "cellulare"],
    lookahead: true,
    notAfter: String.raw`\p{L}`,
  },
);
/** A date after the word ("Phone: 2026-10-11") is not a number to hide. */
const DATE_SHAPED = new LinearRegex(String.raw`^(?:[0-9]{4}[-./][0-9]{1,2}[-./][0-9]{1,2}|[0-9]{1,2}[-./][0-9]{1,2}[-./][0-9]{2,4})$`);
const NOT_DIGIT = new LinearRegex("[^0-9]+");
const STARTS_PLUS_OR_ZERO = new LinearRegex(String.raw`^(?:\+|\(?0)`);
const STARTS_PLUS_BRACKET_OR_ZERO = new LinearRegex(String.raw`^(?:\+|\(|0)`);
const NATIONAL_LAYOUT = new LinearRegex(String.raw`^1[ .-][0-9]{3}[ .-][0-9]{3}[ .-][0-9]{4}$|^[6-9][0-9]{2}(?: [0-9]{2}){3}$`);
const PHONE_GROUP_SEPARATOR = new LinearRegex("[ .-]");

function redactPhone({ text: match, groups }: LinearMatch): string {
  const number = groups[1] ?? "";
  const digits = NOT_DIGIT.replace(number, "").length;
  if (digits < 7 || digits > 15 || DATE_SHAPED.test(number)) return match;
  // Dots group a French or an international number, which starts with 0 or +; a version or a dotted id does not.
  if (number.includes(".") && !STARTS_PLUS_OR_ZERO.test(number)) return match;
  // Without a leading +, 0 or bracket, it is laid out as 555 123 4567 is: at most three groups, the first of three digits
  // and the last of four or more; or as 1-800-555-0199 (a North American number with its country code) or 612 34 56 78
  // (a Spanish one) are. A list of numbers (`Mobile 100 200 300 400`) or of years (`2024 2025 2026`) is not.
  if (!STARTS_PLUS_BRACKET_OR_ZERO.test(number) && !NATIONAL_LAYOUT.test(number)) {
    const groups = PHONE_GROUP_SEPARATOR.split(number).map((group) => group ?? "");
    if (groups.length > 3 || groups[0].length !== 3 || groups[groups.length - 1].length < 4) return match;
  }
  return `${match.slice(0, match.length - number.length)}[phone redacted]`;
}

/**
 * Personal data a page, a flow or a typed value can put in text the tool
 * keeps: a phone number right after a word for one (PHONE_RE), an email address, its @ written out or percent-encoded (a reserved
 * example address and an image's `@2x` name excepted), and a card number
 * (digits that start as a card network's do, at a length it issues, and pass
 * the Luhn check, so an order number, a list of years or a timestamp stays).
 * Each replacement names what it removed.
 */
export function redactPersonal(text: string): string {
  const withoutIpAddresses = EMAIL_IP_RE.replace(text, "[email redacted]");
  let out = EMAIL_RE.replace(withoutIpAddresses, ({ text: m, groups, end }) => {
    const domain = groups[1] ?? "";
    if (RESERVED_DOMAIN_RE.test(domain) || DENSITY_DOMAIN_RE.test(domain)) return m;
    // `git@host:team/repo.git` is a repository's address over SSH, not a person's: a path follows the colon.
    if (SSH_PATH.test(withoutIpAddresses.slice(end, end + 2))) return m;
    return "[email redacted]";
  });
  out = SPELLED_EMAIL_RE.replace(out, redactSpelledEmail);
  out = PHONE_RE.replace(out, redactPhone);
  return DIGIT_RUN_RE.replace(out, redactCardsInRun);
}
