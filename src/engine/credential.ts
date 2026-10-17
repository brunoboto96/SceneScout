/**
 * Whether text a person wrote into the guided choices holds a credential: the
 * check that refuses an address, a journey or a ticket with a password, code
 * or token in it (guided.ts). It reads text a person pasted, which may be long
 * and is not under this tool's control, so every pattern here runs on the
 * linear-time engine (linear-regex.ts); memory-test holds this file to no
 * JavaScript regular expression.
 */
import { isSpace, LinearRegex, runEnd, SPACE } from "./linear-regex.js";
import { redactSecrets } from "./redact.js";
import { FIELD_WORDS, redactPersonal, secretParamName } from "./sensitive.js";

/** A character of a word in any script (a class's inside): `\b` reads only ASCII letters as letters. */
const WORD = String.raw`\p{L}\p{N}_`;
/** The lookahead that ends a word: what follows is not a word's character. */
const WORD_END = `($|[^${WORD}])`;

/**
 * A word that names a secret, as someone writes it in a sentence: "password",
 * "pw", "PIN", "login code", "token", "credentials" and the like, and the
 * word for a password in the languages a journey is most often written in.
 */
const SECRET_WORD = new LinearRegex(
  `(?:password|passwort|passphrase|passcode|pass code|pw|pwd|pin|one-time code|verification code|login code|sign-in code|security code|2fa code|two-factor code|mfa code|authenticator code|otp|token|api key|apikey|secret|credentials?|creds|mot de passe|contraseña|senha|wachtwoord|kennwort|passord|lösenord|hasło|пароль)${WORD_END}`,
  { ignoreCase: true, notAfter: WORD, lookahead: true },
);

/** "pass" names a secret only when a value is set against it: "pass: hunter2", "pass=…". */
const PASS_SET = new LinearRegex(`pass([${SPACE}]*[:=])`, { ignoreCase: true, notAfter: WORD, lookahead: true });

/** "Sign in" or "log in", then "with" within a short phrase: what follows is how they sign in ("sign in as bob with hunter2"). */
const SIGN_IN_WITH = new LinearRegex(String.raw`\b(?:sign|log)[${SPACE}-]?in\b[^.;\n]{0,60}?\bwith\b`, { ignoreCase: true });

/** A code as a sign-in asks for one: six to eight digits after the word "code" ("use the code 482913"). */
const DIGIT_CODE = new LinearRegex(`code[${SPACE}]*(?:is[${SPACE}]*|[:=][${SPACE}]*)?[0-9]{6,8}($|[^0-9])`, {
  ignoreCase: true,
  notAfter: WORD,
  lookahead: true,
});

/** How many words after a secret's name are read for its value ("the password for it is Summer2024!"). */
const VALUE_WINDOW = 5;

/**
 * Words that, straight after a secret's name, make the sentence about the
 * field: what follows is a value to test the field with, not one to sign in
 * with ("test the password strength meter with Summer2024!").
 */
const ABOUT_THE_FIELD = new Set([
  "strength",
  "meter",
  "field",
  "fields",
  "box",
  "input",
  "rules",
  "policy",
  "requirements",
  "validation",
  "complexity",
  "length",
]);
/** The word after a secret's name, when it is short enough to be one of ABOUT_THE_FIELD (the longest has twelve letters). */
const NEXT_WORD = new LinearRegex(String.raw`^(\p{L}{1,12})(?:$|[^\p{L}])`);

/** The word straight after the spaces at `from`, if it has at most twelve letters; "" when none. */
function nextShortWord(text: string, from: number): string {
  const start = runEnd(text, from, isSpace);
  if (start === from) return "";
  // Twelve letters take at most 24 code units; two more hold whatever follows them whole.
  return NEXT_WORD.exec(text.slice(start, start + 26))?.groups[1] ?? "";
}

/** "pass" then one word: "pass Summer2024!" names its value, "pass the cookie banner" does not. */
const PASS_WORD = new LinearRegex(`pass[${SPACE}]+([^${SPACE}]+)`, { ignoreCase: true, notAfter: WORD });

/** A user name and a value joined by a colon with no space, as a sign-in pair is written: "bob:Summer2024!". The value does not start with "//". */
const COLON_PAIR = new LinearRegex(String.raw`\p{L}[\p{L}\p{N}._@-]{0,40}:((?:[^${SPACE}/][^${SPACE}]{5,}|/[^${SPACE}/][^${SPACE}]{4,}))`, {
  ignoreCase: true,
  notAfter: WORD,
});

/**
 * A user name and a value either side of a slash with a space beside it, "bob
 * / Summer2024!", read only where the text is about signing in. Without the
 * space it is a path ("reports/2024/q3").
 */
const SLASH_PAIR = new LinearRegex(String.raw`\p{L}[\p{L}\p{N}._@-]{0,40}(?:[${SPACE}]+/[${SPACE}]*|/[${SPACE}]+)([^${SPACE}]{6,})`, {
  ignoreCase: true,
  notAfter: WORD,
});
const ABOUT_SIGNING_IN = new LinearRegex(String.raw`\b(?:(?:sign|log)[${SPACE}-]?in|login|user(?:name)?|account|credentials?|as)\b`, {
  ignoreCase: true,
});

/** A value to type when a prompt appears: "Enter Summer2024! when asked for the password". */
const ENTER_WHEN = new LinearRegex(String.raw`\b(?:enter|type|use)[${SPACE}]+([^${SPACE}]+)[${SPACE}]+(?:when|if|once)\b`, { ignoreCase: true });

/** An address written with its scheme: "https://…", up to the next space. */
const ADDRESS = new LinearRegex(`[^${SPACE}]+://[^${SPACE}]+`);

const TRAILING_PUNCTUATION = new LinearRegex(`["'”’)\\],.;:?]+$`);
const VERSION = new LinearRegex(String.raw`^v?[0-9]+(?:[.-][0-9]+)+[a-z]*$`, { ignoreCase: true });
const LETTER = new LinearRegex(String.raw`\p{L}`);

/** A pair's or a prompt's value: read as a value, with a letter in it, and neither a date nor a version. */
function pairValue(raw: string): boolean {
  const word = TRAILING_PUNCTUATION.replace(raw, "");
  if (!looksLikeValue(word) || !LETTER.test(word)) return false;
  return !VERSION.test(word);
}

const QUOTES_AROUND = new LinearRegex(`^["'“‘(\\[]+|["'”’)\\],.;:?]+$`);
const EMAIL = new LinearRegex(String.raw`^[^@${SPACE}]+@[^@${SPACE}]+\.\p{L}{2,}$`);
/** ASCII letters, as JavaScript's `i` without `u` read them: ignoring case would fold the long s and the Kelvin sign in. */
const SCHEME = new LinearRegex(String.raw`^[A-Za-z][A-Za-z0-9+.-]*://`);
const ITEM_NUMBER = new LinearRegex(String.raw`^#[0-9]+$`);
const SETTING = new LinearRegex(String.raw`^([\p{L}_-]+)=[\p{L}\p{N}_-]+$`);
const NUMBER = new LinearRegex(String.raw`\p{N}`);
const SYMBOL = new LinearRegex(String.raw`[^\p{L}\p{N}'’-]`);

/**
 * Whether a word reads as a credential's value rather than as English: at
 * least four characters with a digit in it, or with a symbol other than a
 * hyphen or an apostrophe. An email address is personal data, not a
 * credential, and does not count; nor do a link, a path on the site, a
 * numbered item ("#42") or a setting written as name=value ("role=editor").
 */
function looksLikeValue(raw: string): boolean {
  const word = QUOTES_AROUND.replace(raw, "");
  // Read first, as most words are letters only and this answers them.
  if (word.length < 4 || !(NUMBER.test(word) || SYMBOL.test(word))) return false;
  if (EMAIL.test(word) || SCHEME.test(word) || word.startsWith("/") || ITEM_NUMBER.test(word)) return false;
  const setting = SETTING.exec(word);
  return !setting || SECRET_WORD.test(setting.groups[1] ?? "");
}

const SET_VALUE = new LinearRegex(String.raw`^[${SPACE}]*[:=][${SPACE}]*["'“‘]?([^${SPACE}"'”’,;)/]{3,})["'”’]?[${SPACE}]*(?:$|[,;)/]|\.(?:[${SPACE}]|$))`);
const QUOTED_VALUE = new LinearRegex(String.raw`^[${SPACE}]*(?:is|was|[:=-])?[${SPACE}]*["'“‘]([^"'”’]{4,})["'”’]`);
const NOT_LETTER_OR_SPACE = new LinearRegex(String.raw`[^\p{L}${SPACE}]`);
const SPACE_RE = new LinearRegex(`[${SPACE}]`);
const SPACES = new LinearRegex(`[${SPACE}]+`);

/**
 * Whether the words after position `end` hold a value: one set against the
 * name with a colon or an equals sign ("Password: letmein"), a quoted one
 * straight after it, or one of the next few words that reads as a value.
 */
function valueFollows(text: string, end: number): boolean {
  const rest = text.slice(end, end + 120);
  const set = SET_VALUE.exec(rest);
  if (set && !FIELD_WORDS.has((set.groups[1] ?? "").toLowerCase())) return true;
  const quoted = QUOTED_VALUE.exec(rest)?.groups[1];
  if (quoted !== undefined && (NOT_LETTER_OR_SPACE.test(quoted) || !SPACE_RE.test(quoted))) return true;
  return SPACES.split(rest)
    .filter((word): word is string => Boolean(word))
    .slice(0, VALUE_WINDOW)
    .some(looksLikeValue);
}

/** Whether an address carries a credential under a query or fragment key the report's redaction does not know. */
function addressHoldsSecretParam(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return false;
  }
  const keys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()];
  // The same names the report's redaction masks (sensitive.ts SECRET_PARAM), so the two cannot drift apart.
  return keys.some(secretParamName);
}

/**
 * Whether text holds a credential: a shape the report's redaction would mask
 * (a key, a bearer token, `?password=…`, a value typed into a password field),
 * an address with a code, signature, key or session in its query, or one
 * written out in words: a word that names a secret, or "sign in … with",
 * followed by a value: one set against it with a colon ("Password:
 * letmein"), a quoted one, or within a few words one with a digit or a symbol
 * in it, such as "the PIN is 4821" or "the password for it is Summer2024!".
 * Otherwise words of letters only ("the password is required", "the login
 * code screen loads", "Password: required") read as a sentence about the
 * field, so a letters-only password written as "the password is hunter" is
 * not caught: that sentence cannot be told from "the password is required". Email
 * addresses are not credentials here: a journey may name the address to sign
 * up with.
 */
export function holdsCredential(text: string): boolean {
  if (redactSecrets(text) !== redactPersonal(text)) return true;
  if (addressHoldsSecretParam(text) || DIGIT_CODE.test(text)) return true;
  for (const re of [SECRET_WORD, PASS_SET, SIGN_IN_WITH])
    for (const m of re.matchAll(text)) {
      // "the password strength meter with …": the value tests the field.
      if (re === SECRET_WORD && ABOUT_THE_FIELD.has(nextShortWord(text, m.end).toLowerCase())) continue;
      if (valueFollows(text, m.end)) return true;
    }
  for (const re of [PASS_WORD, ENTER_WHEN]) for (const m of re.matchAll(text)) if (pairValue(m.groups[1] ?? "")) return true;
  // An address's host and port is not a pair, and a value with a slash in it is a path ("api:v2/orders").
  const withoutAddresses = ADDRESS.replace(text, " ");
  for (const m of COLON_PAIR.matchAll(withoutAddresses)) if (!(m.groups[1] ?? "").includes("/") && pairValue(m.groups[1] ?? "")) return true;
  if (ABOUT_SIGNING_IN.test(text)) for (const m of SLASH_PAIR.matchAll(text)) if (pairValue(m.groups[1] ?? "")) return true;
  return false;
}
