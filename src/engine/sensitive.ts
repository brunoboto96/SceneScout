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
  { kind: "password", whole: ["pwd"], suffix: ["password", "passwd", "passphrase"], phrases: [] },
  { kind: "one-time code", whole: ["pin", "onetime", "otpcode"], suffix: ["otp", "passcode"], phrases: ["one time", "verification code", "pass code"] },
  {
    kind: "card",
    whole: ["cvc", "cvv", "csc", "ccv", "ccnum"],
    suffix: ["cardnumber", "ccnumber"],
    phrases: ["security code", "card number", "card no", "cc number", "cc num", "cc csc", "cc exp"],
  },
  { kind: "secret", whole: ["token"], suffix: ["secret", "apikey"], phrases: ["api key"] },
];

/** A name's words, lower-case: `newPassword` → new password, `PINCode` → pin code, `cvv2` → cvv. */
function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.replace(/\d+$/, ""))
    .filter((w) => w.length > 0);
}

/** Which kind of secret a field's name, label or placeholder names, if any. */
export function secretWordKind(text: string): SecretKind | null {
  const words = wordsOf(text);
  if (words.length === 0) return null;
  const joined = ` ${words.join(" ")} `;
  for (const { kind, whole, suffix, phrases } of WORD_KINDS) {
    if (words.some((w) => whole.includes(w) || suffix.some((s) => w.endsWith(s)))) return kind;
    if (phrases.some((p) => joined.includes(` ${p} `))) return kind;
  }
  return null;
}

/** Whether what is typed into this field is a secret, and which kind; null for an ordinary field. */
export function secretFieldKind(facts: SecretFieldFacts): SecretKind | null {
  if ((facts.type ?? "").trim().toLowerCase() === "password") return "password";
  for (const token of (facts.autocomplete ?? "").toLowerCase().split(/\s+/)) {
    const kind = AUTOCOMPLETE_KINDS[token];
    if (kind) return kind;
  }
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

// ---------------------------------------------------------------------------
// Personal data in text
// ---------------------------------------------------------------------------

/** Domains reserved for documentation (RFC 2606 / 6761) name nobody, so an address on one stays readable. */
const RESERVED_DOMAIN_RE = /^(?:[\p{L}\p{N}-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/iu;
/** An image's pixel-density suffix (`@2x` before its extension), which reads like an address but is a file name. */
const DENSITY_DOMAIN_RE = /^\d+(?:\.\d+)?x\./i;
/** An address in any script, its @ written out or percent-encoded (`%40`), as a query string carries it. Group 1 is the domain. */
const EMAIL_RE = /[\p{L}\p{N}._%+-]+(?:@|%40)([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:\p{L}{2,}|xn--[a-z0-9-]+))/giu;
/** A run of digit groups split by single spaces or hyphens; a card number is some of its groups. */
const DIGIT_RUN_RE = /(?<![\d.])\d+(?:[ -]\d+)*/g;
/** A card number's first digit: the networks issue from 2 to 6 and 8, so a millisecond timestamp (a leading 1) is never one. */
const CARD_FIRST_DIGIT_RE = /^[2-68]/;

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
  return digits.length >= 13 && digits.length <= 19 && CARD_FIRST_DIGIT_RE.test(digits) && luhnValid(digits);
}

/**
 * Whether groups[i..j] are laid out as a card number is written: one run of
 * digits, or groups of at least four (4-4-4-4, 4-6-5) with a shorter last one
 * allowed. A list of small numbers (`320 375 414 768`) is not, whatever its
 * digits add up to.
 */
function cardShaped(groups: readonly string[], i: number, j: number): boolean {
  for (let k = i; k < j; k++) if (groups[k].length < 4) return false;
  return true;
}

/**
 * The card numbers among a run's digit groups, each the longest that starts at
 * its group, so a date or a quantity written just before a card number does
 * not hide it. A group is never split: digits inside a longer id stay.
 */
function redactCardsInRun(run: string): string {
  const parts = run.split(/([ -])/);
  const groups = parts.filter((_, i) => i % 2 === 0);
  let out = "";
  let i = 0;
  while (i < groups.length) {
    let end = -1;
    let digits = "";
    for (let j = i; j < groups.length && digits.length + groups[j].length <= 19; j++) {
      digits += groups[j];
      if (cardShaped(groups, i, j) && isCardNumber(digits)) end = j;
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
 * (digits that start as a card network's do and pass the Luhn check, so an
 * order number or a timestamp stays). Each replacement names what it removed.
 */
export function redactPersonal(text: string): string {
  return text
    .replace(EMAIL_RE, (m, domain: string) => (RESERVED_DOMAIN_RE.test(domain) || DENSITY_DOMAIN_RE.test(domain) ? m : "[email redacted]"))
    .replace(DIGIT_RUN_RE, redactCardsInRun);
}
