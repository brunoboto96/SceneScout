/**
 * Generated inputs for the detectors in sensitive.ts, labelled secret or not,
 * for measuring how often each one misses a real secret and how often it
 * alters text that holds none (#538). The generator is seeded, so a run is
 * repeatable; memory-test holds the rates the Safety model guide publishes
 * equal to a fresh run, and running this file prints them:
 *
 *   npx tsx scripts/sensitive-fuzz.ts [cases] [seed]
 *
 * Every shape comes in pairs: a real one and a near miss that differs in the
 * one fact that makes it a secret. Values are invented (random letters and
 * digits, made-up domains). A generator written beside the detectors it
 * scores shares its author's blind spots, so the rates are a floor on what is
 * missed, not a measurement of any real app.
 */
import fs from "node:fs";
import { maskSecretFieldValues, maskSecretParams, redactPersonal, secretFieldKind, type SecretFieldFacts } from "../src/engine/sensitive.ts";
import { rng } from "./policy-fuzz.ts";

export type Detector = "secret field" | "typed value" | "secret parameter" | "email address" | "phone number" | "card number";

export interface SensitiveCase {
  detector: Detector;
  /** The shape the case was generated from, for reading the misses. */
  shape: string;
  /** Whether the input holds something that must not survive. */
  secret: boolean;
  /** secret field: what the page says about the field. */
  facts?: SecretFieldFacts;
  /** The other detectors: the text read. */
  text?: string;
  /** The text: the part of it that is the secret. */
  hidden?: string;
}

const DETECTORS: readonly Detector[] = ["secret field", "typed value", "secret parameter", "email address", "phone number", "card number"];

/** The function each text detector is scored through: the one redact.ts calls. */
const TEXT_DETECTORS: Record<Exclude<Detector, "secret field">, (text: string) => string> = {
  "typed value": (text) => maskSecretFieldValues(text).text,
  "secret parameter": (text) => maskSecretParams(text).text,
  "email address": redactPersonal,
  "phone number": redactPersonal,
  "card number": redactPersonal,
};

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

type Style = "camel" | "snake" | "kebab" | "spaced" | "title" | "upper";
const STYLES: readonly Style[] = ["camel", "snake", "kebab", "spaced", "title", "upper"];

/** Words written as a field name or label in one of the usual styles. */
function styled(words: readonly string[], style: Style): string {
  switch (style) {
    case "camel":
      return words.map((w, i) => (i === 0 ? w : cap(w))).join("");
    case "snake":
      return words.join("_");
    case "kebab":
      return words.join("-");
    case "spaced":
      return words.join(" ");
    case "title":
      return words.map(cap).join(" ");
    case "upper":
      return words.join("_").toUpperCase();
  }
}

// Names that name a secret, as separate words. The words are the requirement ("this field holds a password");
// the detector's own word lists are not read to write them.
const SECRET_NAMES: ReadonlyArray<readonly string[]> = [
  ["password"],
  ["new", "password"],
  ["confirm", "password"],
  ["user", "password"],
  ["current", "password"],
  ["pass", "phrase"],
  ["one", "time", "code"],
  ["verification", "code"],
  ["security", "code"],
  ["otp"],
  ["pin"],
  ["card", "number"],
  ["cvv"],
  ["cvc"],
  ["api", "key"],
  ["access", "token"],
  ["client", "secret"],
  ["secret"],
  ["token"],
  ["recovery", "code"],
  ["private", "key"],
];
/** Names in other languages, written plain and accented. */
const SECRET_LABELS_OTHER_LANGUAGES = [
  "Passwort",
  "Kennwort",
  "Contraseña",
  "Contrasena",
  "Mot de passe",
  "Senha",
  "Wachtwoord",
  "Lösenord",
  "Código de verificación",
  "Verifizierungscode",
  "Numéro de carte",
  "Numero della carta",
  "Пароль",
];
// Names that are not a secret, in pairs with the secret they resemble.
const ORDINARY_NAMES = [
  "username",
  "email",
  "first name",
  "last name",
  "search",
  "quantity",
  "comment",
  "street address",
  "company",
  "city",
  "message",
  "title",
];
const LOOKALIKE_NAMES = [
  ...["passwordless", "secretary", "spinner", "pinned", "tokenizer", "tokens", "tokenize", "pinterest", "keyboard", "passage", "bypass"],
  ...["pass rate", "boarding pass", "random seed", "pin on map", "pin location"],
];
const ABOUT_A_SECRET = [
  ...["password hint", "password strength", "password policy", "token count", "token expiry", "otp enabled", "pin length", "api key count"],
  ...["secret santa", "password visible", "client secret expires"],
];
const OTHER_CODES = ["promo code", "postal code", "zip code", "country code", "area code", "discount code", "error code", "gift code", "tracking code"];

const AUTOCOMPLETE_SECRETS = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "section-login current-password",
  "shipping one-time-code",
];
const AUTOCOMPLETE_ORDINARY = [
  "email",
  "username",
  "given-name",
  "family-name",
  "street-address",
  "postal-code",
  "tel",
  "organization",
  "off",
  "on",
  "section-login username",
];

/** A made-up secret value: letters and digits, with a marker that cannot be a real credential's. */
function fakeValue(r: () => number): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "zz";
  for (let i = 0; i < 6 + Math.floor(r() * 12); i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

function digits(r: () => number, n: number, first = 0): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String(i === 0 && first > 0 ? 1 + Math.floor(r() * 9) : Math.floor(r() * 10));
  return s;
}

/** The Luhn check digit that completes `body`. */
function luhnCheckDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

/** A number of `length` digits that starts with `prefix` and passes the Luhn check; with `valid` false, one that does not. */
function luhnNumber(r: () => number, prefix: string, length: number, valid = true): string {
  const body = prefix + digits(r, length - prefix.length - 1);
  const check = luhnCheckDigit(body);
  return body + (valid ? check : String((Number(check) + 1 + Math.floor(r() * 9)) % 10));
}

/** Card networks by the number a person would recognise them by: a prefix to start from and the lengths issued. */
const CARDS: ReadonlyArray<{ prefixes: readonly string[]; lengths: readonly number[] }> = [
  { prefixes: ["4"], lengths: [13, 16, 19] },
  { prefixes: ["51", "52", "53", "54", "55"], lengths: [16] },
  { prefixes: ["34", "37"], lengths: [15] },
  { prefixes: ["6011", "65"], lengths: [16] },
  { prefixes: ["3528", "3589"], lengths: [16] },
  { prefixes: ["36"], lengths: [14] },
];

/** Digit groups written as a card number is: runs of four, an American Express as 4-6-5. */
function grouped(number: string, separator: string): string {
  const sizes = number.length === 15 ? [4, 6, 5] : [];
  if (sizes.length === 0) return number.match(/.{1,4}/g)!.join(separator);
  const out: string[] = [];
  let at = 0;
  for (const size of sizes) {
    out.push(number.slice(at, at + size));
    at += size;
  }
  return out.join(separator);
}

const FIRST_NAMES = ["maya", "li", "sam", "jordan", "kim", "alex", "noor", "dana", "ravi"];
const LAST_NAMES = ["okafor", "lindqvist", "tanaka", "moreau", "silva", "novak"];
const DOMAIN_WORDS = ["brightwave", "oakline", "tidepool", "quillworks", "northfield", "lumenbay"];
const TLDS = ["com", "io", "org", "co.uk", "de", "app", "net", "fr"];
const RESERVED_DOMAINS = ["example.com", "example.org", "example.net", "mail.example.com", "corp.test", "app.invalid", "box.localhost"];
const SPOKEN_TLDS = ["com", "org", "net", "io", "de"];

const PHONE_WORDS = ["Phone", "Tel", "Telephone", "Mobile", "Call", "WhatsApp", "Contact", "Telefon", "Teléfono", "Téléphone"];
/** Words that sit before a number without saying it is a phone number. */
const NOT_PHONE_WORDS = ["Order", "Invoice", "Ref", "Total", "Hotel", "Intel", "Telemetry", "Version", "Balance", "Ticket"];

/** Generate `n` cases, in equal shares per detector and about half secret. */
export function sensitiveCases(n = 3000, seed = 538): SensitiveCase[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const chance = (p: number): boolean => r() < p;
  const style = (): Style => pick(STYLES);
  const withSuffix = (name: string): string => (chance(0.2) ? name + String(1 + Math.floor(r() * 3)) : name);
  const secretName = (): string => withSuffix(styled(pick(SECRET_NAMES), style()));
  const ordinaryName = (): string => styled(pick(ORDINARY_NAMES).split(" "), style());
  const field = (shape: string, secret: boolean, facts: SecretFieldFacts): SensitiveCase => ({ detector: "secret field", shape, secret, facts });
  const text = (detector: Detector, shape: string, secret: boolean, body: string, hidden?: string): SensitiveCase => ({
    detector,
    shape,
    secret,
    text: body,
    hidden,
  });

  const fieldCases: Array<() => SensitiveCase> = [
    () => field("type=password", true, { type: "password", name: ordinaryName() }),
    () => field("password shown by a toggle", true, { type: "text", name: ordinaryName(), wasPassword: true }),
    () => field("autocomplete token", true, { type: "text", autocomplete: pick(AUTOCOMPLETE_SECRETS), name: ordinaryName() }),
    () => field("one box per character", true, { type: pick(["text", "tel", "number"]), maxLength: 1, name: `digit ${1 + Math.floor(r() * 6)}` }),
    () => field("secret in the name", true, { type: "text", name: secretName() }),
    () => field("secret in the id", true, { type: "text", id: secretName() }),
    () => field("secret in the label", true, { type: "text", label: [ordinaryName(), styled(pick(SECRET_NAMES), pick(["spaced", "title"]))] }),
    () => field("secret in the placeholder", true, { type: "text", placeholder: `Enter your ${styled(pick(SECRET_NAMES), "spaced")}` }),
    () => field("label in another language", true, { type: "text", label: pick(SECRET_LABELS_OTHER_LANGUAGES) }),
    () =>
      field("plain text field", false, {
        type: pick(["text", "email", "search", "tel"]),
        name: ordinaryName(),
        label: pick(ORDINARY_NAMES),
        placeholder: pick(ORDINARY_NAMES),
      }),
    () => field("autocomplete for another field", false, { type: "text", autocomplete: pick(AUTOCOMPLETE_ORDINARY), name: ordinaryName() }),
    () => field("field name that starts like a secret", false, { type: "text", name: styled(pick(LOOKALIKE_NAMES).split(" "), style()) }),
    () => field("setting about a secret", false, { type: "text", name: styled(pick(ABOUT_A_SECRET).split(" "), style()) }),
    () => field("code that is not a sign-in code", false, { type: "text", label: pick(OTHER_CODES) }),
    () => field("single-character box that is not a code", false, { type: pick(["checkbox", "radio", "email"]), maxLength: 1, name: ordinaryName() }),
  ];

  const loginPaths = ["/login", "/search", "/api/session", "/cb", "/account/security"];
  const queryAround = (): [string, string] =>
    pick<[string, string]>([
      ["", ""],
      ["?page=2&", "&sort=asc"],
      ["?", ""],
      ["?lang=en&", ""],
    ]);
  const paramCases: Array<() => SensitiveCase> = [
    () => {
      const value = fakeValue(r);
      const name = pick(["password", "pin", "otp", "access_token", "api_key", "client_secret", "token", "passwd", "secret", "cvv"]);
      const [a, b] = queryAround();
      return text("secret parameter", "secret named in a query", true, `${pick(loginPaths)}${a || "?"}${name}=${value}${b}`, value);
    },
    () => {
      const value = fakeValue(r);
      const name = pick(["code", "sig", "signature", "X-Amz-Signature", "key", "session", "sid", "auth", "nonce", "jwt"]);
      return text("secret parameter", "credential name outside a field's vocabulary", true, `${pick(loginPaths)}?${name}=${value}`, value);
    },
    () => {
      const value = fakeValue(r);
      return text("secret parameter", "form body", true, `username=maya&${pick(["password", "pin", "otp"])}=${value}&remember=1`, value);
    },
    () => {
      const value = fakeValue(r);
      const name = pick(["user[password]", "user%5Bpassword%5D", "account[token]", "login[pin]"]);
      return text("secret parameter", "nested form name", true, `${name}=${value}`, value);
    },
    () => {
      const value = fakeValue(r);
      return text("secret parameter", "fragment", true, `/cb#${pick(["access_token", "id_token", "token"])}=${value}&state=abc`, value);
    },
    () => {
      const name = pick(["page", "sort", "q", "lang", "id", "filter", "ref", "utm_source", "limit"]);
      return text(
        "secret parameter",
        "ordinary parameter",
        false,
        `/search?${name}=${pick(["2", "name", "en", "asc", "42", "docs"])}&${name === "q" ? "page" : "q"}=widgets`,
      );
    },
    () => {
      const name = pick([
        "token_count",
        "passwordless",
        "country_code",
        "codec",
        "monkey",
        "keyboard",
        "pin_location",
        "password_hint_enabled",
        "session_timeout",
      ]);
      return text("secret parameter", "parameter name that starts like a secret", false, `/search?${name}=${pick(["5", "1", "NL", "h264", "true", "30"])}`);
    },
    () => text("secret parameter", "secret word as a value", false, `/search?q=${pick(["password", "pin", "token", "reset+password", "otp"])}&page=1`),
  ];

  const typedCases: Array<() => SensitiveCase> = [
    () => {
      const value = fakeValue(r);
      const label = styled(pick(SECRET_NAMES), pick(["title", "spaced"]));
      return text("typed value", "secret field's typed value", true, `textbox "${label}" ← "${value}"`, value);
    },
    () => {
      const value = fakeValue(r);
      const label = styled(pick(SECRET_NAMES), "title");
      return text("typed value", "previous content quoted", true, `textbox "${label}" ← "${value}" (existing content "${value}x")`, value);
    },
    () => {
      const value = fakeValue(r);
      return text("typed value", "value with an escaped quote", true, `textbox "${cap(pick(["password", "pin", "token"]))}" ← "${value}\\"${value}"`, value);
    },
    () => text("typed value", "ordinary field's typed value", false, `textbox "${cap(pick(ORDINARY_NAMES))}" ← "${fakeValue(r)}"`),
    () => text("typed value", "field about a secret", false, `textbox "${cap(pick(ABOUT_A_SECRET))}" ← "${fakeValue(r)}"`),
    () => text("typed value", "field that starts like a secret", false, `textbox "${cap(pick(LOOKALIKE_NAMES))}" ← "${fakeValue(r)}"`),
    () =>
      text(
        "typed value",
        "secret word typed into an ordinary field",
        false,
        `textbox "${cap(pick(ORDINARY_NAMES))}" ← "${pick(["password", "pin", "hunter", "token"])}"`,
      ),
  ];

  const emailCases: Array<() => SensitiveCase> = [
    () => {
      const sep = pick([".", "_", "-", ""]);
      const local = `${pick(FIRST_NAMES)}${sep}${pick(LAST_NAMES)}`;
      const address = `${local}@${pick(DOMAIN_WORDS)}.${pick(TLDS)}`;
      return text(
        "email address",
        "address in a sentence",
        true,
        pick([`Contact ${address} for access`, `Signed in as ${address}`, `"${address}" saved`]),
        address,
      );
    },
    () => {
      const address = `${pick(FIRST_NAMES)}+${pick(["news", "tag", "qa1"])}@${pick(DOMAIN_WORDS)}.${pick(TLDS)}`;
      return text("email address", "plus-tagged address", true, `Sent to ${address}.`, address);
    },
    () => {
      const local = `${pick(FIRST_NAMES)}.${pick(LAST_NAMES)}`;
      const domain = `${pick(DOMAIN_WORDS)}.${pick(TLDS)}`;
      return text("email address", "percent-encoded address in a link", true, `/verify?email=${local}%40${domain}&step=2`, local);
    },
    () => {
      const address = `${pick(FIRST_NAMES)}@${pick(DOMAIN_WORDS)}.${pick(TLDS)}`;
      return text("email address", "address followed by a colon", true, `${address}: password reset sent`, address);
    },
    () => {
      const local = pick(FIRST_NAMES);
      const domain = pick(DOMAIN_WORDS);
      const tld = pick(SPOKEN_TLDS);
      return text("email address", "address with its @ and dot spelled out", true, `write to ${local} [at] ${domain} [dot] ${tld} today`, local);
    },
    () => {
      const address = `${pick(["josé", "zoë", "søren", "müller"])}@${pick(DOMAIN_WORDS)}.${pick(TLDS)}`;
      return text("email address", "address with a non-ASCII local part", true, `User ${address} joined`, address);
    },
    () => text("email address", "address on a reserved example domain", false, `Contact ${pick(FIRST_NAMES)}@${pick(RESERVED_DOMAINS)} for access`),
    () => text("email address", "image file with a density suffix", false, `<img src="/img/${pick(DOMAIN_WORDS)}@${pick(["2x", "3x", "1.5x"])}.png">`),
    () => text("email address", "repository address over SSH", false, `git clone git@${pick(DOMAIN_WORDS)}.${pick(TLDS)}:${pick(LAST_NAMES)}/repo.git`),
    () =>
      text(
        "email address",
        "package specifier",
        false,
        `npm install ${pick(DOMAIN_WORDS)}@${1 + Math.floor(r() * 9)}.${Math.floor(r() * 20)}.${Math.floor(r() * 20)}`,
      ),
    () => text("email address", "handle without a domain", false, `Follow @${pick(DOMAIN_WORDS)} and @${pick(FIRST_NAMES)} for news`),
    () =>
      text("email address", "at and dot in prose", false, `meet ${pick(["at noon", "at the door"])} and look at the dot matrix at ${pick(DOMAIN_WORDS)} today`),
  ];

  const intl = (): string => {
    const cc = pick(["44", "49", "33", "1", "61", "31"]);
    const groups = [digits(r, 2 + Math.floor(r() * 2), 1), digits(r, 3 + Math.floor(r() * 2)), digits(r, 4)];
    return `+${cc} ${groups.join(pick([" ", " ", "-", "."]))}`;
  };
  const national = (): string =>
    pick([
      `(${digits(r, 3, 1)}) ${digits(r, 3, 1)}-${digits(r, 4)}`,
      `${digits(r, 3, 1)} ${digits(r, 3)} ${digits(r, 4)}`,
      `0${digits(r, 2, 1)} ${digits(r, 3)} ${digits(r, 2)} ${digits(r, 2)}`,
    ]);
  const phoneCases: Array<() => SensitiveCase> = [
    () => {
      const number = intl();
      return text("phone number", "international number after a phone word", true, `${pick(PHONE_WORDS)}: ${number}`, number);
    },
    () => {
      const number = national();
      return text("phone number", "national number after a phone word", true, `${pick(PHONE_WORDS)} ${number}`, number);
    },
    () => {
      const number = intl();
      return text("phone number", "typed into a phone field", true, `textbox "${pick(PHONE_WORDS)} number" ← "${number}"`, number);
    },
    () => {
      const number = intl();
      return text("phone number", "number with no word for a phone before it", false, `${pick(NOT_PHONE_WORDS.slice(0, 3))} ${number}`);
    },
    () => {
      const number = national();
      return text("phone number", "number after a word that contains tel", false, `${pick(["Hotel", "Intel", "Telemetry"])} ${number}`);
    },
    () =>
      text(
        "phone number",
        "date after a phone word",
        false,
        `${pick(PHONE_WORDS)}: ${2020 + Math.floor(r() * 9)}-${pick(["01", "10", "12"])}-${pick(["03", "11", "27"])}`,
      ),
    () =>
      text(
        "phone number",
        "list of years after a phone word",
        false,
        `${pick(PHONE_WORDS)} ${[2023, 2024, 2025, 2026].slice(0, 3 + Math.floor(r() * 2)).join(" ")}`,
      ),
    () => text("phone number", "number too short to be a phone number", false, `${pick(PHONE_WORDS)}: ${digits(r, 3, 1)}-${digits(r, 3)}`),
    () =>
      text(
        "phone number",
        "dotted version after a phone word",
        false,
        `${pick(PHONE_WORDS)} ${1 + Math.floor(r() * 9)}.${Math.floor(r() * 20)}.${Math.floor(r() * 20)}.${Math.floor(r() * 99)}`,
      ),
  ];

  const cardNumber = (valid = true, prefixPick?: string, length?: number): string => {
    const net = pick(CARDS);
    return luhnNumber(r, prefixPick ?? pick(net.prefixes), length ?? pick(net.lengths), valid);
  };
  const cardCases: Array<() => SensitiveCase> = [
    () => {
      const number = cardNumber();
      return text("card number", "card number in one run", true, `${pick(["Card", "Paid with", "Number:"])} ${number}`, number);
    },
    () => {
      const number = cardNumber();
      const written = grouped(number, pick([" ", "-"]));
      return text("card number", "card number in groups", true, `${pick(["Card", "Paid with", "Number:"])} ${written}`, written);
    },
    () => {
      const number = cardNumber();
      return text("card number", "card number in a sentence", true, `Order 18 charged to ${number}, receipt sent`, number);
    },
    () => {
      const number = luhnNumber(r, pick(["4", "51", "55"]), 16);
      const written = grouped(number, " ");
      return text("card number", "card number with non-breaking spaces", true, `Card ${written}`, written);
    },
    () => {
      const number = cardNumber(false);
      return text("card number", "right layout, check digit wrong", false, `Card ${grouped(number, pick([" ", "-", ""]))}`);
    },
    () => text("card number", "passes the check, no network issues it", false, `Order ${luhnNumber(r, pick(["1", "7", "12", "75"]), pick([13, 16, 19]))}`),
    () => text("card number", "millisecond timestamp", false, `created ${1700000000000 + Math.floor(r() * 99999999999)}`),
    () => text("card number", "list of years", false, `Totals for ${[0, 1, 2, 3].map(() => 2015 + Math.floor(r() * 12)).join(" ")}`),
    () => text("card number", "decimal with a long whole part", false, `Balance ${digits(r, 10, 1)}.${digits(r, 6)}`),
  ];

  const byDetector: Record<Detector, Array<() => SensitiveCase>> = {
    "secret field": fieldCases,
    "typed value": typedCases,
    "secret parameter": paramCases,
    "email address": emailCases,
    "phone number": phoneCases,
    "card number": cardCases,
  };
  // Each shape is drawn in turn, so every shape appears about equally often whatever the lists' lengths.
  const out: SensitiveCase[] = [];
  for (let i = 0; i < n; i++) {
    const list = byDetector[DETECTORS[i % DETECTORS.length]];
    out.push(list[Math.floor(i / DETECTORS.length) % list.length]());
  }
  return out;
}

/** Whether the detector got this case wrong: a secret left readable, or text with none altered. */
export function isWrong(c: SensitiveCase): boolean {
  if (c.detector === "secret field") return (secretFieldKind(c.facts!) !== null) !== c.secret;
  const out = TEXT_DETECTORS[c.detector](c.text!);
  return c.secret ? out.includes(c.hidden!) : out !== c.text;
}

export interface SensitiveRates {
  secret: number;
  ordinary: number;
  missed: number;
  falseAlarms: number;
  missRate: number;
  falseAlarmRate: number;
  wrongShapes: Record<string, number>;
}

/** Score the detectors on the cases: one detector, or all of them. */
export function sensitiveRates(cases: readonly SensitiveCase[], detector?: Detector): SensitiveRates {
  const rates: SensitiveRates = { secret: 0, ordinary: 0, missed: 0, falseAlarms: 0, missRate: 0, falseAlarmRate: 0, wrongShapes: {} };
  for (const c of cases) {
    if (detector && c.detector !== detector) continue;
    const wrong = isWrong(c);
    if (c.secret) rates.secret += 1;
    else rates.ordinary += 1;
    if (!wrong) continue;
    if (c.secret) rates.missed += 1;
    else rates.falseAlarms += 1;
    rates.wrongShapes[c.shape] = (rates.wrongShapes[c.shape] ?? 0) + 1;
  }
  rates.missRate = rates.secret ? rates.missed / rates.secret : 0;
  rates.falseAlarmRate = rates.ordinary ? rates.falseAlarms / rates.ordinary : 0;
  return rates;
}

/** The corpus size and seed behind the numbers the Safety model guide publishes. */
export const PUBLISHED_CASES = 6000;
export const PUBLISHED_SEED = 538;
export const RATES_BEGIN = "<!-- sensitive-rates:begin (generated by `npm run sensitive-rates`; do not edit by hand) -->";
export const RATES_END = "<!-- sensitive-rates:end -->";

/** What each shape looks like, for the guide's tables: every generated shape needs one. */
const SHAPE_NOTES: Record<string, string> = {
  "type=password": '`<input type="password">`',
  "password shown by a toggle": "a password box turned to `type=text` by a show-password button",
  "autocomplete token": '`autocomplete="current-password"`, `one-time-code`, `cc-number`',
  "one box per character": "a code split into boxes with `maxlength=1`",
  "secret in the name": '`name="newPassword"`, `api_key`, `CLIENT-SECRET`',
  "secret in the id": '`id="confirm-password"`',
  "secret in the label": 'a label reading "Verification code"',
  "secret in the placeholder": 'placeholder "Enter your PIN"',
  "label in another language": '"Passwort", "Contraseña", "Mot de passe", "Пароль"',
  "plain text field": '`name="username"`, "Search", "City"',
  "autocomplete for another field": '`autocomplete="email"`, `given-name`, `off`',
  "field name that starts like a secret": '`passwordless`, `secretary`, `spinner`, `tokenizer`, "Boarding pass"',
  "setting about a secret": '`password_hint`, "Password strength", `token_count`',
  "code that is not a sign-in code": '"Promo code", "Postal code", "Country code"',
  "single-character box that is not a code": "a `maxlength=1` checkbox, radio or email box",
  "secret named in a query": "`/login?password=…`, `?pin=…`, `?access_token=…`",
  "credential name outside a field's vocabulary": "`?code=…`, `?sig=…`, `?X-Amz-Signature=…`, `?sid=…`",
  "form body": "`username=maya&password=…`",
  "nested form name": "`user[password]=…`, `user%5Bpassword%5D=…`",
  fragment: "`/cb#access_token=…&state=…`",
  "ordinary parameter": "`?page=2&q=widgets`",
  "parameter name that starts like a secret": "`?token_count=5`, `?passwordless=1`, `?country_code=NL`, `?pin_location=…`",
  "secret word as a value": "`?q=password`",
  "secret field's typed value": '`textbox "Password" ← "…"`',
  "previous content quoted": 'a typed entry that quotes `existing content "…"`',
  "value with an escaped quote": 'a typed value holding `\\"`',
  "ordinary field's typed value": '`textbox "City" ← "…"`',
  "field that starts like a secret": '`textbox "Boarding pass" ← "…"`',
  "field about a secret": '`textbox "Password hint" ← "…"`',
  "secret word typed into an ordinary field": '`textbox "Comment" ← "password"`',
  "address in a sentence": '"Signed in as maya.okafor@…"',
  "plus-tagged address": "`maya+news@…`",
  "percent-encoded address in a link": "`?email=maya%40…`",
  "address followed by a colon": "`maya@…: password reset sent`",
  "address with its @ and dot spelled out": "`maya [at] domain [dot] com`",
  "address with a non-ASCII local part": "`josé@…`",
  "address on a reserved example domain": "`maya@example.com`, `@corp.test`",
  "image file with a density suffix": "an image file named with a density suffix, `@2x` before its extension",
  "repository address over SSH": "`git@host:team/repo.git`",
  "package specifier": "`npm install pkg@1.4.2`",
  "handle without a domain": "`Follow @name`",
  "at and dot in prose": '"meet at noon", "the dot matrix"',
  "international number after a phone word": '"Phone: +44 20 7946 0958"',
  "national number after a phone word": '"Tel (555) 123-4567", "Mobile 030 123 45 67"',
  "typed into a phone field": '`textbox "Phone number" ← "+44 …"`',
  "number with no word for a phone before it": '"Order +44 20 7946 0958"',
  "number after a word that contains tel": '"Hotel 555 123 4567", "Intel …"',
  "date after a phone word": '"Phone: 2026-10-11"',
  "list of years after a phone word": '"Mobile 2024 2025 2026"',
  "number too short to be a phone number": '"Phone: 555-123"',
  "dotted version after a phone word": '"Contact" followed by a dotted version number',
  "card number in one run": '"Card 4111…" (16 digits, no spaces)',
  "card number in groups": '"Card 4111 1111 …", "3782-822463-10005"',
  "card number in a sentence": '"Order 18 charged to 4111…"',
  "card number with non-breaking spaces": "a card typeset with non-breaking spaces",
  "right layout, check digit wrong": "a card's digits with the last digit changed",
  "passes the check, no network issues it": "a 13-, 16- or 19-digit order id that starts with 1 or 7",
  "millisecond timestamp": "`created 1700000000000`",
  "list of years": '"Totals for 2023 2024 2025 2026"',
  "decimal with a long whole part": '"Balance 4111111111.111111"',
};

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** The markdown the guide publishes between its markers: totals per detector, then every shape, from one seeded run. */
export function ratesMarkdown(n = PUBLISHED_CASES, seed = PUBLISHED_SEED): string {
  const cases = sensitiveCases(n, seed);
  const shapes = new Map<string, { detector: Detector; secret: boolean; total: number; wrong: number }>();
  for (const c of cases) {
    const e = shapes.get(c.shape) ?? { detector: c.detector, secret: c.secret, total: 0, wrong: 0 };
    if (e.detector !== c.detector || e.secret !== c.secret)
      throw new Error(`sensitive-fuzz: shape "${c.shape}" is used by two detectors or on both sides of the verdict`);
    e.total += 1;
    if (isWrong(c)) e.wrong += 1;
    shapes.set(c.shape, e);
  }
  const row = (shape: string): string => {
    const e = shapes.get(shape)!;
    const note = SHAPE_NOTES[shape];
    if (!note) throw new Error(`sensitive-fuzz: shape "${shape}" has no entry in SHAPE_NOTES`);
    return `| ${e.detector} | ${shape} | ${note} | ${e.total} | ${e.wrong} (${pct(e.wrong / e.total)}) |`;
  };
  const byDetector = (secret: boolean): string[] =>
    DETECTORS.flatMap((d) =>
      [...shapes.keys()]
        .filter((s) => shapes.get(s)!.detector === d && shapes.get(s)!.secret === secret)
        .sort()
        .map(row),
    );
  const total = (d: Detector): string => {
    const x = sensitiveRates(cases, d);
    return `| ${d} | ${x.missed} of ${x.secret} (${pct(x.missRate)}) | ${x.falseAlarms} of ${x.ordinary} (${pct(x.falseAlarmRate)}) |`;
  };
  const all = sensitiveRates(cases);
  return [
    RATES_BEGIN,
    "",
    `Run: ${cases.length.toLocaleString("en-US")} generated inputs, seed ${seed}, in equal shares per detector.`,
    "",
    "| Detector | Secrets left readable | Text without a secret altered |",
    "| --- | --- | --- |",
    ...DETECTORS.map(total),
    `| All six | ${all.missed} of ${all.secret} (${pct(all.missRate)}) | ${all.falseAlarms} of ${all.ordinary} (${pct(all.falseAlarmRate)}) |`,
    "",
    "Secret shapes (a miss is a secret left readable, or a field not taken for one):",
    "",
    "| Detector | Shape | Looks like | Inputs | Misses |",
    "| --- | --- | --- | --- | --- |",
    ...byDetector(true),
    "",
    "Near-miss shapes (a false alarm is text or a field with no secret in it, altered or masked):",
    "",
    "| Detector | Shape | Looks like | Inputs | False alarms |",
    "| --- | --- | --- | --- | --- |",
    ...byDetector(false),
    "",
    RATES_END,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "--write-guide") {
  const file = new URL("../docs/guide/Safety-model.md", import.meta.url);
  const text = fs.readFileSync(file, "utf8");
  const a = text.indexOf(RATES_BEGIN);
  const b = text.indexOf(RATES_END);
  if (a < 0 || b < 0) throw new Error("Safety-model.md has no sensitive-rates markers");
  fs.writeFileSync(file, text.slice(0, a) + ratesMarkdown() + text.slice(b + RATES_END.length));
  console.log("Safety-model.md updated");
} else if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const cases = sensitiveCases(Number(process.argv[2] ?? PUBLISHED_CASES), Number(process.argv[3] ?? PUBLISHED_SEED));
  for (const d of DETECTORS) {
    const x = sensitiveRates(cases, d);
    console.log(`${d}: missed ${x.missed}/${x.secret} (${pct(x.missRate)}), altered ${x.falseAlarms}/${x.ordinary} (${pct(x.falseAlarmRate)})`);
    if (x.missed || x.falseAlarms) console.log(`  wrong: ${JSON.stringify(x.wrongShapes)}`);
  }
  if (process.env.SHOW) {
    for (const c of cases) if (isWrong(c)) console.log(c.secret ? "MISS" : "FALSE", c.detector, c.shape, JSON.stringify(c.facts ?? c.text));
  }
}
