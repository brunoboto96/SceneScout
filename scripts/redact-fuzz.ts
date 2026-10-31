/**
 * Generated text, labelled credential or not, for measuring how often the
 * credential shapes redact.ts removes from free text are missed and how often
 * text that holds none is altered, and the same for the guided choices'
 * credential check in credential.ts (#538). The generator is seeded, so a run
 * is repeatable; memory-test holds the rates the Safety model guide publishes
 * equal to a fresh run, and running this file prints them:
 *
 *   npx tsx scripts/redact-fuzz.ts [cases] [seed]
 *
 * Every shape comes in pairs: a real credential and a near miss that differs
 * in the one fact that makes it one. Values are random letters and digits
 * built at run time, so no tracked file holds a credential's shape. A
 * generator written beside the patterns it scores shares its author's blind
 * spots, so the rates are a floor on what is missed, not a measurement of any
 * real app.
 */
import fs from "node:fs";
import { holdsCredential } from "../src/engine/credential.ts";
import { redactSecrets } from "../src/engine/redact.ts";
import { rng } from "./policy-fuzz.ts";

export type RedactDetector =
  | "provider key"
  | "bearer or basic token"
  | "JSON web token"
  | "private key block"
  | "value after a secret's name"
  | "PIN or sign-in code"
  | "guided-choice credential";

export interface RedactCase {
  detector: RedactDetector;
  /** The shape the case was generated from, for reading the misses. */
  shape: string;
  /** Whether the text holds a credential. */
  secret: boolean;
  text: string;
  /** A redaction detector's secret case: the part of the text that must not survive. */
  hidden?: string;
}

const DETECTORS: readonly RedactDetector[] = [
  "provider key",
  "bearer or basic token",
  "JSON web token",
  "private key block",
  "value after a secret's name",
  "PIN or sign-in code",
  "guided-choice credential",
];

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGITS = "0123456789";
const ALNUM = LOWER + UPPER + DIGITS;
const BASE64URL = `${ALNUM}_-`;

/** How much of a secret left in the output counts as leaking it: the whole of a short one, or any eight characters of a longer one. */
const LEAK = 8;

/** Whether any LEAK characters in a row of `hidden` survive in `out`. */
function leaks(out: string, hidden: string): boolean {
  const len = Math.min(LEAK, hidden.length);
  for (let i = 0; i + len <= hidden.length; i++) if (out.includes(hidden.slice(i, i + len))) return true;
  return false;
}

/** Whether the detector got this case wrong: a credential left readable, or text with none altered (or, for the guided check, refused). */
export function isWrong(c: RedactCase): boolean {
  if (c.detector === "guided-choice credential") return holdsCredential(c.text) !== c.secret;
  const out = redactSecrets(c.text);
  return c.secret ? leaks(out, c.hidden!) : out !== c.text;
}

/** Generate `n` cases, in equal shares per detector and about half credentials. */
export function redactCases(n = 3500, seed = 538): RedactCase[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const from = (alphabet: string, len: number): string => {
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)];
    return s;
  };
  /** A random run that holds at least one digit and one of the alphabet's letters, as a generated key nearly always does. */
  const mixed = (alphabet: string, len: number): string => {
    const s = from(alphabet, len - 2);
    const at = Math.floor(r() * (s.length + 1));
    const letters = [...alphabet].filter((ch) => LOWER.includes(ch.toLowerCase())).join("");
    return s.slice(0, at) + from(DIGITS, 1) + from(letters, 1) + s.slice(at);
  };
  const digits = (len: number): string => from(DIGITS, len);
  const lead = (): string => pick(["Error: ", "Request failed with ", "Saved config: ", "", "The response quoted ", "Log line: "]);
  const tail = (): string => pick(["", ".", " (see logs)", " and was rejected", ", retrying"]);
  const secret = (detector: RedactDetector, shape: string, before: string, value: string, after = "", end = tail()): RedactCase => ({
    detector,
    shape,
    secret: true,
    text: `${lead()}${before}${value}${after}${end}`,
    hidden: value,
  });
  const plain = (detector: RedactDetector, shape: string, text: string): RedactCase => ({ detector, shape, secret: false, text });

  // Each provider key: the prefix kept, the rest the secret.
  const providerKeys: ReadonlyArray<() => [string, string]> = [
    () => [`sk-ant-api0${int(1, 3)}-`, mixed(BASE64URL, int(60, 95))],
    () => [`xox${pick(["b", "p", "a", "e"])}-`, `${digits(12)}-${digits(12)}-${mixed(ALNUM, 24)}`],
    () => ["AIza", mixed(BASE64URL, 35)],
    () => ["glpat-", mixed(BASE64URL, 20)],
    () => ["npm_", mixed(ALNUM, 36)],
    () => [`${pick(["sk", "pk", "rk"])}_${pick(["live", "test"])}_`, mixed(ALNUM, int(24, 99))],
    () => ["sk-proj-", mixed(BASE64URL, int(48, 120))],
    () => [`gh${pick(["p", "o", "u", "s", "r"])}_`, mixed(ALNUM, 36)],
    () => ["AKIA", mixed(UPPER + DIGITS, 16)],
    () => ["github_pat_", `${mixed(ALNUM, 22)}_${mixed(ALNUM, 59)}`],
    () => ["whsec_", mixed(ALNUM, 32)],
    () => ["SG.", `${mixed(BASE64URL, 22)}.${mixed(BASE64URL, 43)}`],
    () => ["hf_", mixed(ALNUM, 34)],
    () => ["xapp-", `1-${mixed(UPPER + DIGITS, 11)}-${digits(13)}-${mixed(ALNUM, 64)}`],
    () => [`sk-${pick(["svcacct", "admin"])}-`, mixed(BASE64URL, int(60, 120))],
    () => ["ASIA", mixed(UPPER + DIGITS, 16)],
  ];
  // A key with no prefix of its own (hex, or base64 as some secret access keys are): nothing in it says key.
  const unprefixedKey = (): string => pick([from("0123456789abcdef", 32), mixed(`${ALNUM}/+`, 40)]);
  const keyCases: Array<() => RedactCase> = [
    () => {
      const [prefix, rest] = pick(providerKeys)();
      return secret("provider key", "key with a provider's prefix", prefix, rest);
    },
    () => {
      const [prefix, rest] = pick(providerKeys)();
      return secret("provider key", "key quoted in JSON", `{"${pick(["key", "apiKey", "credential", "value"])}":"${prefix}`, rest, '"}');
    },
    () => secret("provider key", "key with no prefix of its own", "", unprefixedKey()),
    () =>
      plain(
        "provider key",
        "prefix named in prose",
        `${pick(["Keys start with the ", "Paste the key, it begins ", "Rotate any ", "The "])}${pick(["sk-ant-", "ghp_", "glpat-", "npm_", "AKIA", "AIza", "xoxb-", "sk_live_", "github_pat_", "whsec_", "hf_", "SG."])}${pick([" prefix.", " and is shown once.", " key now.", " part"])}`,
      ),
    () =>
      plain(
        "provider key",
        "identifier shaped like a key",
        pick([
          `${pick(["pk", "sk", "rk"])}_${pick(["customer", "default", "primary", "order", "widget"])}_${pick(["identifier", "settings", "lookup", "reference"])}`,
          `hf_${pick(["hub", "model", "cache"])}_${pick(["download", "revision", "dir"])}`,
          `SG.${pick(["Header", "Footer"])}.${pick(["Title", "Link"])}`,
          `${pick(["sk", "pk", "rk"])}-${pick(["test", "live", "admin"])}-${pick(["results", "preview", "coverage"])}-${pick(["page", "panel", "widget"])}`,
          `${pick(["sk", "pk"])}_live_${pick(["preview", "search"])}_${pick(["widget", "results"])}`,
        ]),
      ),
    () =>
      plain(
        "provider key",
        "prefix inside a longer word",
        `${pick(["risk", "disk", "task", "desk"])}_${pick(["score", "usage", "queue"])}_${digits(int(2, 6))}${pick(["days", "items", "rows"])}`,
      ),
    () =>
      plain(
        "provider key",
        "ordinary page value",
        pick([
          `commit ${from("0123456789abcdef", 40)} merged`,
          `id ${from("0123456789abcdef", 8)}-${from("0123456789abcdef", 4)}-4${from("0123456789abcdef", 3)}-a${from("0123456789abcdef", 3)}-${from("0123456789abcdef", 12)}`,
          `sha256:${from("0123456789abcdef", 64)}`,
          `<img src="data:image/png;base64,iVBORw0KGgo${from(`${ALNUM}+/`, int(40, 160))}==">`,
          `class="css-${from(LOWER + DIGITS, 6)} sc-${from(LOWER + UPPER, 6)} ${pick(["btn-primary", "MuiButton-root", "tw-flex"])}"`,
          `Order #${pick(["", "A-", "SO-"])}${digits(int(6, 10))} shipped`,
        ]),
      ),
    () => plain("provider key", "key too short to be issued", `${pick(["ghp_", "glpat-", "npm_", "AKIA"])}${from(ALNUM, int(3, 7))}`),
  ];

  const base64 = (s: string): string => Buffer.from(s).toString("base64");
  const tokenCases: Array<() => RedactCase> = [
    () => secret("bearer or basic token", "bearer token", `Authorization: ${pick(["Bearer", "bearer", "BEARER"])} `, mixed(`${ALNUM}._~+/-`, int(24, 64))),
    () => secret("bearer or basic token", "bearer token of letters only", "Authorization: Bearer ", from(LOWER + UPPER, int(20, 40))),
    () =>
      secret(
        "bearer or basic token",
        "basic credentials",
        "Authorization: Basic ",
        base64(`${pick(["maya", "sam", "admin", "qa-lead", "svc"])}:${from(LOWER + DIGITS, int(8, 16))}`),
      ),
    () =>
      plain(
        "bearer or basic token",
        "scheme word in prose",
        `${pick(["Basic", "Bearer"])} ${pick(["authentication-required", "token-based-authentication-flow", "internationalization", "configuration"])} ${pick(["is enabled", "applies", "failed"])}.`,
      ),
    () =>
      plain(
        "bearer or basic token",
        "scheme word before short words",
        `${pick(["Bearer", "Basic"])} ${pick(["tokens expire after an hour", "auth is off", "plan users see this", "access only"])}.`,
      ),
  ];

  const jwt = (): string => `eyJ${mixed(BASE64URL, int(16, 40))}.eyJ${mixed(BASE64URL, int(30, 120))}.${mixed(BASE64URL, 43)}`;
  const jwtCases: Array<() => RedactCase> = [
    () => secret("JSON web token", "three-part token", pick(["token=", "id_token: ", "session ", "Cookie: jwt="]), jwt()),
    () => secret("JSON web token", "token in a JSON body", '{"access_token":"', jwt(), '"}'),
    () =>
      plain(
        "JSON web token",
        "token prefix named in prose",
        `A JSON web token starts with ${pick(["eyJ", "the letters eyJ"])} ${pick(["because its header is JSON.", "when encoded."])}`,
      ),
    () => plain("JSON web token", "short value that starts the same way", `header eyJ${from(ALNUM, int(3, 10))}`),
  ];

  const dashes = "-".repeat(5);
  const pemBody = (): string => Array.from({ length: int(2, 6) }, () => from(`${ALNUM}+/`, 64)).join("\n");
  const pemKind = (): string =>
    pick(["RSA PRIVATE KEY", "EC PRIVATE KEY", "PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]);
  const pemCases: Array<() => RedactCase> = [
    () => {
      const kind = pemKind();
      const body = pemBody();
      return { ...secret("private key block", "whole block", `${dashes}BEGIN ${kind}${dashes}\n`, body, `\n${dashes}END ${kind}${dashes}`) };
    },
    () => secret("private key block", "block cut off before its end", `${dashes}BEGIN ${pemKind()}${dashes}\n`, pemBody()),
    () =>
      plain(
        "private key block",
        "public key or certificate block",
        `${dashes}BEGIN ${pick(["PUBLIC KEY", "CERTIFICATE", "RSA PUBLIC KEY", "CERTIFICATE REQUEST"])}${dashes}\n${from(ALNUM, 40)}\n${dashes}END CERTIFICATE${dashes}`,
      ),
    () =>
      plain(
        "private key block",
        "private key named in prose",
        `${pick(["Upload your private key", "The private key file is missing", "BEGIN PRIVATE KEY line not found"])}.`,
      ),
  ];

  const secretWord = (): string =>
    pick(["password", "Password", "PASSWORD", "passwd", "secret", "client_secret", "api_key", "apiKey", "token", "access_token", "passphrase"]);
  const valueCases: Array<() => RedactCase> = [
    () =>
      secret(
        "value after a secret's name",
        "value set with a colon or equals",
        `${secretWord()}${pick([": ", "=", " = ", ":"])}`,
        mixed(LOWER + DIGITS, int(6, 20)),
      ),
    () => secret("value after a secret's name", "value in a JSON pair", `{"${secretWord()}":"`, from(`${ALNUM}!#$%`, int(4, 20)), '"}'),
    () =>
      secret(
        "value after a secret's name",
        "letters-only value ending its clause",
        `${pick(["password", "passphrase", "secret"])}: `,
        from(LOWER, int(6, 12)),
        "",
        pick([",", ";", "", "."]),
      ),
    () =>
      secret(
        "value after a secret's name",
        "token after its word, no separator but a space",
        `${pick(["token", "secret", "api key", "password"])} `,
        mixed(ALNUM, int(16, 40)),
      ),
    () =>
      secret(
        "value after a secret's name",
        "name outside the patterns",
        `${pick(["aws_secret_access_key", "private_key", "credential", "auth_token", "client-secret", "session_key", "signing_key"])}${pick([": ", "=", " = "])}`,
        mixed(`${ALNUM}/+`, int(20, 40)),
      ),
    () =>
      plain(
        "value after a secret's name",
        "word about the field",
        `${cap(secretWord())}: ${pick(["required", "missing", "invalid", "expired", "revoked", "too short"])}.`,
      ),
    () =>
      plain(
        "value after a secret's name",
        "sentence about the field",
        `${cap(secretWord())} ${pick(["requirements are not enforced", "must be at least twelve characters", "reset emails are delayed", "rotation is overdue"])}.`,
      ),
    () =>
      plain(
        "value after a secret's name",
        "request setting named credentials",
        `fetch(url, { credentials: ${pick(["'include'", '"omit"', "'same-origin'", "include"])} })`,
      ),
    () => plain("value after a secret's name", "value shown masked", `${secretWord()}: ${"•".repeat(int(4, 12))}`),
    () =>
      plain(
        "value after a secret's name",
        "name that holds a secret's word",
        `${pick(["token_count", "password_hint", "secret_santa", "api_key_count", "token_expiry"])}: ${pick([digits(int(1, 3)), "enabled", "none"])}`,
      ),
  ];

  const codeCases: Array<() => RedactCase> = [
    () =>
      secret(
        "PIN or sign-in code",
        "PIN after its word",
        `${pick(["PIN", "PIN code", "pin", "PIN number"])}${pick([" ", ": ", " is ", "#"])}`,
        digits(int(4, 8)),
      ),
    () =>
      secret(
        "PIN or sign-in code",
        "sign-in code after its word",
        `${pick(["code", "Your verification code is", "OTP", "passcode", "login code:", "2FA code", "security code"])} `,
        digits(int(6, 8)),
      ),
    () => secret("PIN or sign-in code", "code in two groups of three", `${pick(["Your code is", "code:", "OTP"])} `, `${digits(3)} ${digits(3)}`),
    () =>
      plain(
        "PIN or sign-in code",
        "code of another kind",
        `${pick(["error", "status", "postal", "promo", "order", "tracking", "invoice", "coupon", "zip", "discount"])} code ${digits(6)}`,
      ),
    () => plain("PIN or sign-in code", "number too short or too long for a code", `${pick(["code", "PIN"])} ${pick([digits(3), `0${digits(int(9, 13))}`])}`),
    () =>
      plain(
        "PIN or sign-in code",
        "date or range after the word",
        `code ${pick([`20${digits(2)}-${int(10, 12)}-${int(10, 28)}`, `${digits(6)}-${digits(6)}`])}`,
      ),
  ];

  const user = (): string => pick(["maya", "sam.okafor", "qa-lead", "admin", "li"]);
  const pw = (): string => `${cap(from(LOWER, int(4, 8)))}${digits(int(2, 4))}${pick(["!", "#", "", "?"])}`;
  const guidedCases: Array<() => RedactCase> = [
    () => ({
      detector: "guided-choice credential",
      shape: "password written in a sentence",
      secret: true,
      text: `${pick(["Sign in as", "Use the account"])} ${user()}, the ${pick(["password", "pw", "passphrase"])} ${pick(["is", "for it is", ":"])} ${pw()}`,
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "PIN or code in a sentence",
      secret: true,
      text: pick([`The PIN is ${digits(4)}`, `Use the code ${digits(6)}`, `the login code is ${digits(8)}`, `OTP: ${digits(6)}`]),
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "sign in with a value",
      secret: true,
      text: `${pick(["Sign in", "Log in", "Login"])} as ${user()} with ${pw()} and check the dashboard`,
    }),
    () => ({ detector: "guided-choice credential", shape: "user and value joined by a colon", secret: true, text: `Account ${user()}:${pw()}` }),
    () => ({ detector: "guided-choice credential", shape: "user and value either side of a slash", secret: true, text: `Log in with ${user()} / ${pw()}` }),
    () => ({ detector: "guided-choice credential", shape: "value to type when asked", secret: true, text: `Enter ${pw()} when asked for the password` }),
    () => ({
      detector: "guided-choice credential",
      shape: "key or token pasted",
      secret: true,
      text: `Use ${pick(["Authorization: Bearer ", "token ", "api_key="])}${mixed(ALNUM, 32)} for the API`,
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "address with a secret in its query",
      secret: true,
      text: `https://app.example.com/${pick(["reset", "invite", "cb"])}?${pick(["token", "code", "sig", "key"])}=${mixed(ALNUM, 24)}`,
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "letters-only password in a sentence",
      secret: true,
      text: `The password is ${from(LOWER, int(6, 10))}`,
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "sentence about the password field",
      secret: false,
      text: `${pick(["Check the password is required", "The login code screen loads", "Password: required", "Reset the password and confirm the email arrives", "The PIN field accepts only digits"])}`,
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "value that tests the field",
      secret: false,
      text: `Test the password ${pick(["strength meter", "rules", "field", "validation"])} with ${pw()}`,
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "path, version or item number",
      secret: false,
      text: `${pick(["Open reports/2024/q3", "Check release v2.4.1", "Look at item #42 on the board", "Call api:v2/orders", "Visit https://app.example.com:8443/home"])}`,
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "user named without a value",
      secret: false,
      text: `Sign in as ${user()} and ${pick(["open the settings", "create a widget", "check the export"])}`,
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "address to sign up with",
      secret: false,
      text: `Sign up with ${user().replace(".", "")}@example.com and confirm the email`,
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "pass in its other meaning",
      secret: false,
      text: `${pick(["Pass the cookie banner", "Make sure the checks pass", "Boarding pass page"])} then ${pick(["open the cart", "search for widgets"])}`,
    }),
    () => ({
      detector: "guided-choice credential",
      shape: "setting written as name=value",
      secret: false,
      text: `Run with ${pick(["role=editor", "theme=dark", "lang=en"])} and open the dashboard`,
    }),
  ];

  const byDetector: Record<RedactDetector, Array<() => RedactCase>> = {
    "provider key": keyCases,
    "bearer or basic token": tokenCases,
    "JSON web token": jwtCases,
    "private key block": pemCases,
    "value after a secret's name": valueCases,
    "PIN or sign-in code": codeCases,
    "guided-choice credential": guidedCases,
  };
  // Each shape is drawn in turn, so every shape appears about equally often whatever the lists' lengths.
  const out: RedactCase[] = [];
  for (let i = 0; i < n; i++) {
    const list = byDetector[DETECTORS[i % DETECTORS.length]];
    out.push(list[Math.floor(i / DETECTORS.length) % list.length]());
  }
  return out;
}

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

export interface RedactRates {
  secret: number;
  ordinary: number;
  missed: number;
  falseAlarms: number;
  missRate: number;
  falseAlarmRate: number;
  wrongShapes: Record<string, number>;
}

/** Score the detectors on the cases: one detector, a list of them, or all. */
export function redactRates(cases: readonly RedactCase[], detector?: RedactDetector | readonly RedactDetector[]): RedactRates {
  const keep = detector === undefined ? null : new Set(typeof detector === "string" ? [detector] : detector);
  const rates: RedactRates = { secret: 0, ordinary: 0, missed: 0, falseAlarms: 0, missRate: 0, falseAlarmRate: 0, wrongShapes: {} };
  for (const c of cases) {
    if (keep && !keep.has(c.detector)) continue;
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

export const REDACTION_DETECTORS: readonly RedactDetector[] = DETECTORS.filter((d) => d !== "guided-choice credential");

/** The corpus size and seed behind the numbers the Safety model guide publishes. */
export const PUBLISHED_CASES = 7000;
export const PUBLISHED_SEED = 538;
export const RATES_BEGIN = "<!-- redact-rates:begin (generated by `npm run redact-rates`; do not edit by hand) -->";
export const RATES_END = "<!-- redact-rates:end -->";

/** What each shape looks like, for the guide's tables: every generated shape needs one. */
const SHAPE_NOTES: Record<string, string> = {
  "key with a provider's prefix":
    "`sk-ant-…`, `xoxb-…`, `AIza…`, `glpat-…`, `npm_…`, `sk_live_…`, `sk-proj-…`, `ghp_…`, `AKIA…`, `github_pat_…`, `whsec_…`, `SG.….…`, `hf_…`, `xapp-…`, `sk-svcacct-…`, `sk-admin-…`, `ASIA…`",
  "key quoted in JSON": '`{"apiKey":"ghp_…"}`',
  "key with no prefix of its own": "32 hex digits, or 40 characters of base64, with no name before them",
  "prefix named in prose": '"Keys start with the `ghp_` prefix."',
  "identifier shaped like a key": "`pk_customer_identifier`, `hf_hub_download`, `SG.Header.Title`, `sk-test-results-page`",
  "ordinary page value": "a commit SHA, a UUID, a `sha256:` digest, `data:image/png;base64,…`, CSS class names, an order number",
  "prefix inside a longer word": "`risk_score_7days`, `disk_usage_12rows`",
  "key too short to be issued": "`ghp_` or `AKIA` and a few characters",
  "bearer token": "`Authorization: Bearer …` with a digit in it",
  "bearer token of letters only": "`Authorization: Bearer …` of letters only",
  "basic credentials": "`Authorization: Basic …`, base64 of `user:password`",
  "scheme word in prose": '"Basic authentication-required is enabled.", "Bearer internationalization applies."',
  "scheme word before short words": '"Bearer tokens expire after an hour."',
  "three-part token": "`eyJ….eyJ….…` after `token=` or `Cookie: jwt=`",
  "token in a JSON body": '`{"access_token":"eyJ…"}`',
  "token prefix named in prose": '"A JSON web token starts with eyJ …"',
  "short value that starts the same way": "`eyJ` and a few characters",
  "whole block": "a PEM or PGP private key, `BEGIN` to `END`",
  "block cut off before its end": "a private key's `BEGIN` line and body, no `END`",
  "public key or certificate block": "`BEGIN PUBLIC KEY`, `BEGIN CERTIFICATE`",
  "private key named in prose": '"Upload your private key."',
  "value set with a colon or equals": "`password: …`, `client_secret=…`",
  "value in a JSON pair": '`{"password":"…"}`',
  "letters-only value ending its clause": "`password: …` of letters only, then a comma or the end",
  "token after its word, no separator but a space": "`token …` with digits and letters",
  "name outside the patterns": "`aws_secret_access_key = …`, `private_key: …`, `auth_token=…`, `signing_key=…`",
  "word about the field": '"Password: required.", "Token: revoked."',
  "sentence about the field": '"Password requirements are not enforced."',
  "request setting named credentials": "`fetch(url, { credentials: 'include' })`",
  "value shown masked": "`password: ••••••`",
  "name that holds a secret's word": "`token_count: 3`, `password_hint: enabled`",
  "PIN after its word": '"PIN 4821", "PIN code: 482193"',
  "sign-in code after its word": '"Your verification code is 482913", "OTP 48291355"',
  "code in two groups of three": '"Your code is 482 913"',
  "code of another kind": '"error code 404123", "promo code 482913", "postal code …"',
  "number too short or too long for a code": '"code 123", "PIN 48291355012"',
  "date or range after the word": '"code 2026-10-31", "code 100000-199999"',
  "password written in a sentence": '"Sign in as maya, the password is Summer24!"',
  "PIN or code in a sentence": '"The PIN is 4821", "Use the code 482913"',
  "sign in with a value": '"Log in as maya with Summer24!"',
  "user and value joined by a colon": '"Account maya:Summer24!"',
  "user and value either side of a slash": '"Log in with maya / Summer24!"',
  "value to type when asked": '"Enter Summer24! when asked for the password"',
  "key or token pasted": '"Use token … for the API"',
  "address with a secret in its query": "`https://…/reset?token=…`",
  "letters-only password in a sentence": '"The password is hunter"',
  "sentence about the password field": '"Check the password is required", "Password: required"',
  "value that tests the field": '"Test the password strength meter with Summer24!"',
  "path, version or item number": '"Open reports/2024/q3", "Check release v2.4.1", "item #42"',
  "user named without a value": '"Sign in as maya and open the settings"',
  "address to sign up with": '"Sign up with maya@example.com"',
  "pass in its other meaning": '"Pass the cookie banner"',
  "setting written as name=value": '"Run with role=editor"',
};

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** The markdown the guide publishes between its markers: totals per detector, then every shape, from one seeded run. */
export function ratesMarkdown(n = PUBLISHED_CASES, seed = PUBLISHED_SEED): string {
  const cases = redactCases(n, seed);
  const shapes = new Map<string, { detector: RedactDetector; secret: boolean; total: number; wrong: number }>();
  for (const c of cases) {
    const e = shapes.get(c.shape) ?? { detector: c.detector, secret: c.secret, total: 0, wrong: 0 };
    if (e.detector !== c.detector || e.secret !== c.secret)
      throw new Error(`redact-fuzz: shape "${c.shape}" is used by two detectors or on both sides of the verdict`);
    e.total += 1;
    if (isWrong(c)) e.wrong += 1;
    shapes.set(c.shape, e);
  }
  const row = (shape: string): string => {
    const e = shapes.get(shape)!;
    const note = SHAPE_NOTES[shape];
    if (!note) throw new Error(`redact-fuzz: shape "${shape}" has no entry in SHAPE_NOTES`);
    return `| ${e.detector} | ${shape} | ${note} | ${e.total} | ${e.wrong} (${pct(e.wrong / e.total)}) |`;
  };
  const byDetector = (secret: boolean): string[] =>
    DETECTORS.flatMap((d) =>
      [...shapes.keys()]
        .filter((s) => shapes.get(s)!.detector === d && shapes.get(s)!.secret === secret)
        .sort()
        .map(row),
    );
  const total = (label: string, x: RedactRates): string =>
    `| ${label} | ${x.missed} of ${x.secret} (${pct(x.missRate)}) | ${x.falseAlarms} of ${x.ordinary} (${pct(x.falseAlarmRate)}) |`;
  return [
    RATES_BEGIN,
    "",
    `Run: ${cases.length.toLocaleString("en-US")} generated inputs, seed ${seed}, in equal shares per detector.`,
    "",
    "| Detector | Credentials left readable (or let through) | Text without a credential altered (or refused) |",
    "| --- | --- | --- |",
    ...REDACTION_DETECTORS.map((d) => total(d, redactRates(cases, d))),
    total("All six credential shapes", redactRates(cases, REDACTION_DETECTORS)),
    total("guided-choice credential", redactRates(cases, "guided-choice credential")),
    "",
    "Credential shapes (a miss is a credential left readable, or for the guided check let through):",
    "",
    "| Detector | Shape | Looks like | Inputs | Misses |",
    "| --- | --- | --- | --- | --- |",
    ...byDetector(true),
    "",
    "Near-miss shapes (a false alarm is text with no credential in it altered, or for the guided check refused):",
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
  if (a < 0 || b < 0) throw new Error("Safety-model.md has no redact-rates markers");
  fs.writeFileSync(file, text.slice(0, a) + ratesMarkdown() + text.slice(b + RATES_END.length));
  console.log("Safety-model.md updated");
} else if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const cases = redactCases(Number(process.argv[2] ?? PUBLISHED_CASES), Number(process.argv[3] ?? PUBLISHED_SEED));
  for (const d of DETECTORS) {
    const x = redactRates(cases, d);
    console.log(`${d}: missed ${x.missed}/${x.secret} (${pct(x.missRate)}), altered ${x.falseAlarms}/${x.ordinary} (${pct(x.falseAlarmRate)})`);
    if (x.missed || x.falseAlarms) console.log(`  wrong: ${JSON.stringify(x.wrongShapes)}`);
  }
  if (process.env.SHOW) for (const c of cases) if (isWrong(c)) console.log(c.secret ? "MISS" : "FALSE", c.detector, c.shape, JSON.stringify(c.text));
}
