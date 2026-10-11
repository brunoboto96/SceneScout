/**
 * What must never be written down in clear: the value typed into a secret
 * field, and personal data (email addresses, card numbers) in any text the
 * tool keeps. Pure functions of what the page and the text say, so
 * memory-test table-tests them; browser.ts only gathers the facts.
 *
 * Masking errs towards hiding. A field wrongly taken for a secret costs a repro
 * one typed value; a password wrongly taken for an ordinary field is published
 * in the action log, the report and every issue exported from it.
 */

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
    whole: ["pwd", "senha", "haslo", "heslo", "пароль"],
    // German compounds put the head last, so a password's confirmation ends in "bestätigung", not in "passwort".
    suffix: [
      "password",
      "passwd",
      "passphrase",
      ...["passwort", "kennwort", "passwortbestatigung", "passwortbestaetigung", "kennwortbestatigung", "kennwortbestaetigung"],
      ...["passwortwiederholung", "contrasena", "wachtwoord", "losenord", "passord", "adgangskode", "salasana"],
    ],
    phrases: ["mot de passe", "palavra passe"],
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
    whole: ["token"],
    suffix: ["secret", "apikey"],
    phrases: ["api key", "recovery code", "backup code", "private key", "seed phrase", "recovery phrase", "security answer"],
  },
];

/**
 * The letters without their accents, so "Contraseña", "contrasena" and an
 * "ñ" written as "n" and a combining tilde all read alike. A name or an id is
 * usually typed without accents, so the word lists are written without them.
 */
function foldAccents(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[łŁ]/g, (c) => (c === "ł" ? "l" : "L"))
    .replace(/[øØ]/g, (c) => (c === "ø" ? "o" : "O"))
    .replace(/ß/g, "ss");
}

/** A name's words, lower-case: `newPassword` → new password, `PINCode` → pin code, `cvv2` → cvv. */
function wordsOf(text: string): string[] {
  return foldAccents(text)
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.replace(/\d+$/, ""))
    .filter((w) => w.length > 0);
}

/** Which kind of secret a field's name, label or placeholder names, if any. */
export function secretWordKind(text: string): SecretKind | null {
  // "2FA" splits into "2" and "fa" below, so it is read before the split.
  if (/(?:^|[^\p{L}\p{N}])2fa(?![\p{L}\p{N}])/iu.test(text)) return "one-time code";
  const words = wordsOf(text);
  if (words.length === 0) return null;
  const joined = ` ${words.join(" ")} `;
  for (const { kind, whole, suffix, phrases } of WORD_KINDS) {
    if (words.some((w) => whole.includes(w) || suffix.some((s) => w.endsWith(s)))) return kind;
    if (phrases.some((p) => joined.includes(` ${p} `))) return kind;
  }
  return null;
}

/** The input types a split code's boxes use (scripted-login.ts reads the same boxes). */
const SINGLE_CHARACTER_TYPES = new Set(["", "text", "tel", "number", "password"]);

/** Whether what is typed into this field is a secret, and which kind; null for an ordinary field. */
export function secretFieldKind(facts: SecretFieldFacts): SecretKind | null {
  if ((facts.type ?? "").trim().toLowerCase() === "password") return "password";
  for (const token of (facts.autocomplete ?? "").toLowerCase().split(/\s+/)) {
    const kind = AUTOCOMPLETE_KINDS[token];
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
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
/** `"<label>" ← "<value>"`, the shape a type entry names its field and value in. */
const TYPED_INTO_RE = new RegExp(String.raw`"((?:[^"\\]|\\.)*)" ← (${QUOTED})`, "g");
const EXISTING_RE = new RegExp(String.raw`existing content ${QUOTED}`, "g");

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
  for (const m of text.matchAll(TYPED_INTO_RE)) {
    const kind = secretWordKind(m[1]);
    if (!kind) continue;
    const start = m.index ?? 0;
    out += text.slice(last, start) + `"${m[1]}" ← ${maskedValue(kind)}`;
    last = start + m[0].length;
    hits += 1;
    // What the note says the field held before is the same secret's earlier value.
    const next = text.indexOf(" ← ", last);
    const rest = text.slice(last, next === -1 ? text.length : next);
    const cleaned = rest.replace(EXISTING_RE, () => {
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
const PARAM_RE = /(^|[?&;#\s"'(])((?:\p{L}|%[\dA-Fa-f]{2})[\p{L}\p{N}_.%[\]-]*)=([^&#;\s"')]+)/gu;

/** A parameter's name as a person wrote it: percent-escapes decoded (`has%C5%82o`), or left as they are when they do not decode. */
function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name; // A malformed escape is part of the name as written; it still names what it names.
  }
}

/** Mask the value of every parameter whose name names a secret (`pin=`, `otp=`, `password=`, `access_token=`), whatever its length. */
export function maskSecretParams(text: string): { text: string; hits: number } {
  let hits = 0;
  const out = text.replace(PARAM_RE, (m, before: string, name: string, value: string) => {
    // A form's nested names (`user[password]`, `user%5Bpassword%5D`) name the field last; a value already masked stays.
    if (value.startsWith("[") || !secretWordKind(decodedName(name).replace(/[[\]]/g, " "))) return m;
    hits += 1;
    return `${before}${name}=[redacted]`;
  });
  return { text: out, hits };
}

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
  return out.replace(/\b(fill|type|pressSequentially|insertText)\(.*$/gm, "$1((masked))");
}

// ---------------------------------------------------------------------------
// Personal data in text
// ---------------------------------------------------------------------------

/** Domains reserved for documentation (RFC 2606 / 6761) name nobody, so an address on one stays readable. */
const RESERVED_DOMAIN_RE = /^(?:[\p{L}\p{N}-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/iu;
/** An image's pixel-density suffix (`@2x` before its extension), which reads like an address but is a file name. */
const DENSITY_DOMAIN_RE = /^\d+(?:\.\d+)?x\./i;
/** An address in any script, its @ written out or percent-encoded (`%40`), as a query string carries it. Group 1 is the domain. */
const EMAIL_RE = /[\p{L}\p{N}._%+-]+(?:@|%40)([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:\p{L}{2,}|xn--[a-z0-9-]+))/giu;
/**
 * A run of digit groups split by single separators: a space, a non-breaking,
 * narrow non-breaking, thin or figure space (a formatted number, a French
 * locale, typeset text), a hyphen or a dot. A card number is some of its
 * groups; cardShaped keeps an address, a version, a date or a decimal from
 * reading as one. A run never starts at a decimal's fraction (`0.4111…`), but
 * does after a word's dot (`no.4111…`).
 */
const DIGIT_SEPARATOR = "[ \\u00a0\\u2007\\u2009\\u202f.-]";
const DIGIT_RUN_RE = new RegExp(String.raw`(?<!\d)(?<!\d\.)\d+(?:${DIGIT_SEPARATOR}\d+)*`, "g");
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
  if (seps.slice(i, j).includes(".")) for (let k = i; k <= j; k++) if (groups[k].length > 6) return false;
  return true;
}

/**
 * The card numbers among a run's digit groups, each the longest that starts at
 * its group, so a date or a quantity written just before a card number does
 * not hide it. A group is never split: digits inside a longer id stay.
 */
function redactCardsInRun(run: string): string {
  const parts = run.split(new RegExp(`(${DIGIT_SEPARATOR})`));
  const groups = parts.filter((_, i) => i % 2 === 0);
  const seps = parts.filter((_, i) => i % 2 === 1);
  let out = "";
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
    if (i > 0) out += parts[2 * i - 1];
    if (end === -1) {
      out += groups[i];
      i += 1;
    } else {
      out += "[card number redacted]";
      i = end + 1;
    }
  }
  return out;
}

/**
 * Personal data a page, a flow or a typed value can put in text the tool
 * keeps: an email address, its @ written out or percent-encoded (a reserved
 * example address and an image's `@2x` name excepted), and a card number
 * (digits that start as a card network's do, at a length it issues, and pass
 * the Luhn check, so an order number, a list of years or a timestamp stays).
 * Each replacement names what it removed.
 */
export function redactPersonal(text: string): string {
  return text
    .replace(EMAIL_RE, (m, domain: string) => (RESERVED_DOMAIN_RE.test(domain) || DENSITY_DOMAIN_RE.test(domain) ? m : "[email redacted]"))
    .replace(DIGIT_RUN_RE, redactCardsInRun);
}
