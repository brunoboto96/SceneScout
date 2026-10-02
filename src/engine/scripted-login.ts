/**
 * The rules of `scenescout login <url> --role <name> --script`: a sign-in
 * with no person at the keyboard, for CI. The username, the password (none
 * for a passwordless sign-in) and the one-time code, from a TOTP secret or a
 * fixed code a test environment accepts, come from the environment; the
 * browser fills the identity provider's form with them and the session is
 * saved as the role's profile exactly as the manual login saves it.
 *
 * Everything here is Playwright-free so it can be table-tested: which
 * environment variables and flags configure a run, the RFC 6238 one-time
 * code, which input on a page is the username, the password or the code
 * (one field, or one box per character), which button moves the form on,
 * what counts as signed in or refused, and the redaction every line of
 * output goes through. The browser half is in login-run.ts.
 *
 * A credential value is never printed, logged or written. Each value, and
 * each of its URL-encoded forms, is replaced before any line leaves the
 * process, including text the page itself shows (a page that echoes what
 * was typed).
 */
import { createHmac } from "node:crypto";

// ── configuration ───────────────────────────────────────────────────────────

/** The environment variables a scripted sign-in reads. */
export const LOGIN_ENV = {
  username: "SCENESCOUT_LOGIN_USERNAME",
  password: "SCENESCOUT_LOGIN_PASSWORD",
  totpSecret: "SCENESCOUT_LOGIN_TOTP_SECRET",
  otpCode: "SCENESCOUT_LOGIN_OTP_CODE",
  usernameSelector: "SCENESCOUT_LOGIN_USERNAME_SELECTOR",
  passwordSelector: "SCENESCOUT_LOGIN_PASSWORD_SELECTOR",
  otpSelector: "SCENESCOUT_LOGIN_OTP_SELECTOR",
  submitSelector: "SCENESCOUT_LOGIN_SUBMIT_SELECTOR",
  successUrl: "SCENESCOUT_LOGIN_SUCCESS_URL",
  successSelector: "SCENESCOUT_LOGIN_SUCCESS_SELECTOR",
} as const;

/** Flags `--script` accepts, each overriding the environment variable of the same meaning. Credentials have no flag: a flag is visible in the process list and the shell history. */
export const SCRIPT_FLAGS = [
  "username-selector",
  "password-selector",
  "otp-selector",
  "submit-selector",
  "success-url",
  "success-selector",
  "timeout",
] as const;
export type ScriptFlag = (typeof SCRIPT_FLAGS)[number];

/** How long a scripted sign-in may take in all, by default, and the bounds `--timeout` must stay within. */
export const DEFAULT_TIMEOUT_S = 60;
export const MIN_TIMEOUT_S = 5;
export const MAX_TIMEOUT_S = 600;

/** The kinds of field a sign-in form asks for. */
export type FieldKind = "username" | "password" | "otp";

export interface Selectors {
  username?: string;
  password?: string;
  otp?: string;
  submit?: string;
}

/** Where the one-time code comes from: a TOTP secret that generates it, or a fixed code a test environment accepts. */
export type CodeSource = { kind: "totp"; params: TotpParams } | { kind: "fixed"; code: string };

export interface ScriptedLogin {
  username: string;
  /** Unset for a passwordless sign-in: the username, then a one-time code. */
  password?: string;
  code?: CodeSource;
  selectors: Selectors;
  success: { url?: string; selector?: string };
  timeoutMs: number;
}

/**
 * Read a scripted sign-in's configuration at startup, collecting every
 * problem before anything launches. Each problem names the variable or flag,
 * never its value.
 */
export function readScriptedLogin(
  flags: ReadonlyMap<string, string>,
  env: Record<string, string | undefined>,
): { ok: true; config: ScriptedLogin } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const username = env[LOGIN_ENV.username] ?? "";
  const rawPassword = env[LOGIN_ENV.password];
  if (username.trim() === "") errors.push(`${LOGIN_ENV.username} is not set: the test user's username or email`);
  const rawSecret = env[LOGIN_ENV.totpSecret] ?? "";
  const rawCode = env[LOGIN_ENV.otpCode] ?? "";
  const hasSecret = rawSecret.trim() !== "";
  const hasCode = rawCode.trim() !== "";
  const codeGiven = hasSecret || hasCode;
  let code: CodeSource | undefined;
  if (hasSecret && hasCode) {
    errors.push(`${LOGIN_ENV.otpCode} and ${LOGIN_ENV.totpSecret} are both set: set the fixed code or the secret that generates codes, not both`);
  } else if (hasSecret) {
    const parsed = parseTotpSecret(rawSecret);
    if (parsed.ok) code = { kind: "totp", params: parsed.params };
    else errors.push(`${LOGIN_ENV.totpSecret} ${parsed.error}`);
  } else if (hasCode) {
    const parsed = parseOtpCode(rawCode);
    if (parsed.ok) code = { kind: "fixed", code: parsed.code };
    else errors.push(`${LOGIN_ENV.otpCode} ${parsed.error}`);
  }
  // Passwordless means the password is left unset. Set but empty is a secret that resolved to nothing (a CI secret that does not
  // exist reads as ""), refused here rather than found out when the form asks for it.
  if (rawPassword === "") {
    errors.push(`${LOGIN_ENV.password} is set but empty: give the test user's password, or leave it unset for a passwordless sign-in`);
  } else if (rawPassword === undefined && !codeGiven) {
    // A code variable that is set but blank is most likely a CI secret that does not exist: say so rather than "set it".
    const blank = [LOGIN_ENV.otpCode, LOGIN_ENV.totpSecret].filter((name) => env[name] !== undefined);
    errors.push(
      `${LOGIN_ENV.password} is not set: the test user's password (for a passwordless sign-in that asks only for a one-time code, set ${LOGIN_ENV.otpCode} or ${LOGIN_ENV.totpSecret} instead)` +
        (blank.length > 0 ? `; ${blank.join(" and ")} ${blank.length > 1 ? "are" : "is"} set but empty` : ""),
    );
  }
  const pick = (flag: ScriptFlag, name: string): string | undefined => {
    const v = flags.get(flag) ?? env[name];
    return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
  };
  const selectors: Selectors = {};
  const u = pick("username-selector", LOGIN_ENV.usernameSelector);
  const p = pick("password-selector", LOGIN_ENV.passwordSelector);
  const o = pick("otp-selector", LOGIN_ENV.otpSelector);
  const s = pick("submit-selector", LOGIN_ENV.submitSelector);
  if (u) selectors.username = u;
  if (p) selectors.password = p;
  if (o) selectors.otp = o;
  if (s) selectors.submit = s;
  if (selectors.otp && !codeGiven) {
    errors.push(`an OTP selector is set but neither ${LOGIN_ENV.otpCode} nor ${LOGIN_ENV.totpSecret} is: there is no code to type into it`);
  }
  if (selectors.password && rawPassword === undefined)
    errors.push(`a password selector is set but ${LOGIN_ENV.password} is not: there is no password to type into it`);
  const success: ScriptedLogin["success"] = {};
  const successUrl = pick("success-url", LOGIN_ENV.successUrl);
  const successSelector = pick("success-selector", LOGIN_ENV.successSelector);
  if (successUrl) success.url = successUrl;
  if (successSelector) success.selector = successSelector;
  let timeoutS = DEFAULT_TIMEOUT_S;
  const rawTimeout = flags.get("timeout");
  if (rawTimeout !== undefined) {
    const n = Number(rawTimeout);
    if (!Number.isInteger(n) || n < MIN_TIMEOUT_S || n > MAX_TIMEOUT_S)
      errors.push(`--timeout must be a whole number of seconds from ${MIN_TIMEOUT_S} to ${MAX_TIMEOUT_S}`);
    else timeoutS = n;
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      username,
      ...(rawPassword !== undefined ? { password: rawPassword } : {}),
      ...(code ? { code } : {}),
      selectors,
      success,
      timeoutMs: timeoutS * 1000,
    },
  };
}

/** The shortest and longest fixed one-time code accepted. */
const MIN_OTP_CODE = 4;
const MAX_OTP_CODE = 12;

/**
 * Read a fixed one-time code: letters and digits only, as the code field
 * takes it, with the whitespace a pasted secret often carries trimmed. The
 * error never quotes the value.
 */
export function parseOtpCode(raw: string): { ok: true; code: string } | { ok: false; error: string } {
  const code = raw.trim();
  if (!new RegExp(`^[A-Za-z0-9]{${MIN_OTP_CODE},${MAX_OTP_CODE}}$`).test(code)) {
    return {
      ok: false,
      error: `must be ${MIN_OTP_CODE} to ${MAX_OTP_CODE} letters or digits, with no spaces or dashes: the code exactly as the code field takes it`,
    };
  }
  return { ok: true, code };
}

// ── redaction ───────────────────────────────────────────────────────────────

export const REDACTED = "[redacted]";

/**
 * Every form a credential could take in text: as typed, URL-encoded (a query
 * string, a form body), and with `+` for spaces. The TOTP secret as given,
 * and its base32 without spaces or padding, so a reformatted echo is caught.
 * A fixed one-time code is a credential like the password.
 */
export function credentialValues(config: Pick<ScriptedLogin, "username" | "password"> & { otpCode?: string; totpSecretRaw?: string }): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined): void => {
    if (!v) return;
    out.add(v);
    const enc = encodeURIComponent(v);
    out.add(enc);
    out.add(enc.replace(/%20/g, "+"));
    const trimmed = v.trim();
    if (trimmed) out.add(trimmed);
  };
  add(config.username);
  add(config.password);
  add(config.otpCode);
  if (config.totpSecretRaw) {
    add(config.totpSecretRaw);
    add(config.totpSecretRaw.replace(/[\s=-]/g, "").toUpperCase());
  }
  return [...out].filter((v) => v.length > 0);
}

/**
 * Replace every credential value in a line, longest first so a value
 * containing another is not left half-printed. Case-sensitive except for the
 * values given as `caseInsensitive`: the username, which identity providers
 * commonly echo lower-cased, and a fixed one-time code.
 */
export function redactCredentials(text: string, values: readonly string[], caseInsensitive: readonly string[] = []): string {
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
  for (const v of [...caseInsensitive].sort((a, b) => b.length - a.length)) {
    if (v) out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), REDACTED);
  }
  return out;
}

/** Redacts the credentials a run was given, and any value (a typed one-time code) added while it runs. */
export interface Redactor {
  redact(text: string): string;
  add(value: string): void;
}

/** The redactor for one scripted sign-in: every form of each credential, the username and a fixed code also without regard to case. */
export function credentialRedactor(config: Pick<ScriptedLogin, "username" | "password" | "code">, totpSecretRaw?: string): Redactor {
  const otpCode = config.code?.kind === "fixed" ? config.code.code : undefined;
  const values = credentialValues({
    username: config.username,
    ...(config.password !== undefined ? { password: config.password } : {}),
    ...(otpCode ? { otpCode } : {}),
    ...(totpSecretRaw ? { totpSecretRaw } : {}),
  });
  const username = config.username.trim();
  const anyCase = [...(username ? [username, encodeURIComponent(username)] : []), ...(otpCode ? [otpCode] : [])];
  return {
    redact: (text) => redactCredentials(text, values, anyCase),
    add: (value) => {
      if (value) values.push(value);
    },
  };
}

// ── TOTP (RFC 6238) ─────────────────────────────────────────────────────────

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpParams {
  key: Buffer;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode RFC 4648 base32, ignoring case, spaces, dashes and padding. Null for anything else. */
export function base32Decode(input: string): Buffer | null {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (clean.length === 0) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length > 0 ? Buffer.from(bytes) : null;
}

/**
 * Read a TOTP secret: base32 as authenticator apps show it, or the
 * `otpauth://totp/...` URI a QR code carries (its algorithm, digits and
 * period are honoured). The error never quotes the value.
 */
export function parseTotpSecret(raw: string): { ok: true; params: TotpParams } | { ok: false; error: string } {
  const text = raw.trim();
  let secret = text;
  let algorithm: TotpAlgorithm = "SHA1";
  let digits = 6;
  let period = 30;
  if (/^otpauth:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, error: "is not a valid otpauth:// URI" };
    }
    if (url.host.toLowerCase() !== "totp") return { ok: false, error: "is an otpauth URI but not a TOTP one (only time-based codes are supported)" };
    secret = url.searchParams.get("secret") ?? "";
    const alg = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
    if (alg !== "SHA1" && alg !== "SHA256" && alg !== "SHA512") return { ok: false, error: "names an algorithm other than SHA1, SHA256 or SHA512" };
    algorithm = alg;
    digits = Number(url.searchParams.get("digits") ?? "6");
    period = Number(url.searchParams.get("period") ?? "30");
    if (!Number.isInteger(digits) || digits < 6 || digits > 8) return { ok: false, error: "asks for a code length other than 6 to 8 digits" };
    if (!Number.isInteger(period) || period < 1 || period > 300) return { ok: false, error: "asks for a period outside 1 to 300 seconds" };
  }
  const key = base32Decode(secret);
  if (!key) return { ok: false, error: "is not a base32 secret (letters A–Z and digits 2–7) or an otpauth:// URI" };
  return { ok: true, params: { key, algorithm, digits, period } };
}

/** RFC 4226 HOTP for one counter value. */
export function hotp(key: Buffer, counter: number, digits = 6, algorithm: TotpAlgorithm = "SHA1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 TOTP at a Unix time in seconds. */
export function totp(params: TotpParams, unixSeconds: number): string {
  return hotp(params.key, Math.floor(unixSeconds / params.period), params.digits, params.algorithm);
}

/** Seconds until the code at this time stops being current. */
export function secondsLeft(params: Pick<TotpParams, "period">, unixSeconds: number): number {
  return params.period - (Math.floor(unixSeconds) % params.period);
}

/** With fewer seconds than this left, wait for the next code rather than type one that expires in transit. */
export const TOTP_MIN_SECONDS_LEFT = 3;

// ── which field is which ────────────────────────────────────────────────────

/** What the page reports about one visible form control. `label` joins the label text, aria-label and placeholder. */
export interface FieldInfo {
  index: number;
  tag: "input" | "textarea" | "select" | "button";
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  label: string;
  /** Button text, for a button or a submit input. */
  text: string;
  inputmode: string;
  maxLength: number;
  filled: boolean;
  disabled: boolean;
  /** Set when the element matched a configured selector for that kind. */
  forced?: FieldKind | "submit";
}

const OTP_WORDS =
  /\b(otp|one[\s_-]?time|totp|mfa|2fa|two[\s_-]?factor|verification([\s_-]?code)?|auth(entication|enticator)?[\s_-]?code|security[\s_-]?code|passcode|code)\b/i;
const USER_WORDS = /(user(name)?|e-?mail|login|account|identifier|\bid\b)/i;
const NOT_USER = /(search|query|coupon|promo)/i;
const TEXTLIKE = new Set(["text", "email", "tel", "number", ""]);
/** Words that make a field's "code" some other code: a postal code, a country code, a promotion. */
const NOT_CODE = /(zip|postal|post\s?code|country|promo|coupon)/i;
/** A numeric field these words describe is a number of another kind, not a one-time code. */
const OTHER_NUMBER = /(phone|mobile|card|amount|quantity|year)/i;

const describe = (f: FieldInfo): string => `${f.name} ${f.id} ${f.label}`.replace(/[_-]+/g, " ");
const autocompletes = (f: FieldInfo, token: string): boolean => f.autocomplete.split(/\s+/).includes(token);

/**
 * Why a field is a single one-time-code field, if it is. "named": its
 * autocomplete is one-time-code, or else the words of its name, id and label
 * say code, OTP or verification (a code field masked as a password field
 * included, unless its words say password or passcode). "shape": only its
 * shape says so, a numeric field (inputmode="numeric") 4 to 12 characters
 * long with no autocomplete purpose of its own, whose words do not say phone,
 * card, postal code or username. Short of autocomplete="one-time-code", a
 * field that is the username by its type or autocomplete is never the code,
 * whatever its label says ("Email: we will send you a code").
 */
function otpEvidence(f: FieldInfo): "named" | "shape" | null {
  if (f.tag !== "input") return null;
  if (autocompletes(f, "one-time-code")) return TEXTLIKE.has(f.type) || f.type === "password" ? "named" : null;
  if (f.type === "email" || autocompletes(f, "username") || autocompletes(f, "email")) return null;
  const words = describe(f);
  if (f.type === "password") return OTP_WORDS.test(words) && !/pass(word|code)/i.test(words) ? "named" : null;
  if (!TEXTLIKE.has(f.type) || NOT_CODE.test(words)) return null;
  if (OTP_WORDS.test(words)) return "named";
  const unnamedPurpose = f.autocomplete === "" || f.autocomplete === "off";
  const sized = f.inputmode === "numeric" && f.maxLength >= MIN_OTP_CODE && f.maxLength <= MAX_OTP_CODE;
  return sized && unnamedPurpose && !OTHER_NUMBER.test(words) && !USER_WORDS.test(words) ? "shape" : null;
}

/** A code field known only by its shape, not chosen by a selector: the sign-in's only in the steps signInFields allows. */
function shapeOnlyOtp(f: FieldInfo): boolean {
  return f.forced !== "otp" && otpEvidence(f) === "shape";
}

/** The fewest and most boxes a one-time code split one character per box is laid out in. */
const MIN_CODE_BOXES = 4;
const MAX_CODE_BOXES = 10;

/**
 * A one-time code split into one box per character: a run of 4 to 10 text
 * inputs that each take one character (maxlength 1), side by side with no
 * other control between them, the first of them enabled. Later boxes may be
 * disabled until the earlier ones are filled. A split date, phone or card
 * number has boxes of 2 to 4 characters, so it is never taken for one.
 */
export function codeBoxes(fields: readonly FieldInfo[]): FieldInfo[] | null {
  const isBox = (f: FieldInfo): boolean => f.tag === "input" && f.maxLength === 1 && ((TEXTLIKE.has(f.type) && f.type !== "email") || f.type === "password");
  const runs: FieldInfo[][] = [];
  for (const f of fields.filter(isBox).sort((a, b) => a.index - b.index)) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1].index === f.index - 1) run.push(f);
    else runs.push([f]);
  }
  return runs.find((r) => r.length >= MIN_CODE_BOXES && r.length <= MAX_CODE_BOXES && !r[0].disabled) ?? null;
}

/** The boxes of a split code that `otp` (the field chosen for the code) is the first of, or null when it is a single field. */
export function otpBoxes(fields: readonly FieldInfo[], otp: FieldInfo): FieldInfo[] | null {
  const boxes = codeBoxes(fields);
  return boxes && boxes[0].index === otp.index ? boxes : null;
}

/**
 * One character per box, or why the code cannot fill these boxes: the number
 * of boxes and where the code comes from, never the code itself.
 */
export function splitCode(code: string, boxes: number, source: CodeSource["kind"]): { ok: true; chars: string[] } | { ok: false; error: string } {
  const chars = [...code];
  if (chars.length === boxes) return { ok: true, chars };
  const from =
    source === "fixed"
      ? `${LOGIN_ENV.otpCode} has a different number of characters`
      : `the codes ${LOGIN_ENV.totpSecret} generates have ${chars.length} digits (an otpauth:// URI's digits parameter sets how many)`;
  return { ok: false, error: `the page splits the code into ${boxes} boxes, one character each, and ${from}` };
}

function isUsername(f: FieldInfo): boolean {
  if (f.tag !== "input" || !TEXTLIKE.has(f.type) || f.type === "number") return false;
  const ac = f.autocomplete.split(/\s+/);
  if (ac.includes("username") || ac.includes("email")) return true;
  if (f.type === "email") return true;
  return USER_WORDS.test(describe(f)) && !NOT_USER.test(describe(f));
}

/** Rank so the strongest signal wins: autocomplete, then the type, then the words around it. */
function usernameRank(f: FieldInfo): number {
  const ac = f.autocomplete.split(/\s+/);
  if (ac.includes("username") || ac.includes("email")) return 0;
  if (f.type === "email") return 1;
  return 2;
}

/**
 * Pick the username, password and one-time-code fields among the visible
 * controls. A configured selector wins for its kind; otherwise the first
 * control that fits, by autocomplete, type, then name/id/label words. A
 * password field for a NEW password (autocomplete="new-password") is chosen
 * only when it is the only one: a sign-up form's confirm field is not the
 * sign-in password. A code field named as one wins over one known only by its
 * shape. A code split one character per box is chosen by its first box
 * (otpBoxes gives the rest), and none of its boxes is taken for the username
 * or the password.
 */
export function chooseFields(fields: readonly FieldInfo[]): Partial<Record<FieldKind, FieldInfo>> {
  const usable = fields.filter((f) => !f.disabled && f.tag !== "button");
  const out: Partial<Record<FieldKind, FieldInfo>> = {};
  for (const kind of ["username", "password", "otp"] as const) {
    const forced = usable.find((f) => f.forced === kind);
    if (forced) out[kind] = forced;
  }
  const boxes = codeBoxes(fields);
  const inBoxes = new Set(boxes?.map((b) => b.index));
  // A selector naming one box of a split code names the code.
  if (boxes && (!out.otp || inBoxes.has(out.otp.index))) out.otp = boxes[0];
  if (!out.password) {
    const pw = usable.filter((f) => f.tag === "input" && f.type === "password" && !inBoxes.has(f.index) && otpEvidence(f) === null);
    out.password = pw.find((f) => f.autocomplete.includes("current-password")) ?? pw.find((f) => !f.autocomplete.includes("new-password")) ?? pw[0];
  }
  const taken = new Set([...inBoxes, out.username?.index, out.password?.index, out.otp?.index].filter((i) => i !== undefined));
  if (!out.otp) {
    const free = usable.filter((f) => !taken.has(f.index));
    out.otp = free.find((f) => otpEvidence(f) === "named") ?? free.find((f) => otpEvidence(f) === "shape");
  }
  if (out.otp) taken.add(out.otp.index);
  if (!out.username) {
    const candidates = usable.filter((f) => !taken.has(f.index) && isUsername(f));
    out.username = candidates.sort((a, b) => usernameRank(a) - usernameRank(b) || a.index - b.index)[0];
  }
  for (const k of Object.keys(out) as FieldKind[]) if (!out[k]) delete out[k];
  return out;
}

/** Words on a button that signs in or moves the sign-in on. */
const GO_WORDS = /\b(sign[\s-]?in|log[\s-]?in|login|continue|next|verify|submit|confirm|proceed)\b/i;
/**
 * Words on a button that sends a one-time code, or continues with an email, a
 * phone or a code: the way on in a passwordless sign-in, and second to a
 * button that signs in or verifies wherever both are on a page (a page asking
 * for a code may also offer to text one).
 */
const SEND_WORDS = /\b(send|(get|request)( me)?( a| the| my)?( [\w-]+)? code|(e-?mail|text) me|continue with)\b/i;
/**
 * Buttons that lead away from this sign-in: another provider, another flow,
 * another address, or a new code in place of the one being typed. "Continue
 * with" leads to another provider, except with an email, a phone or a code.
 */
const AWAY_WORDS =
  /\b(forgot|reset|sign[\s-]?up|register|create|continue with(?! (your |my |a |an |work |personal )?(e-?mail|phone|([\w-]+ )?code))|provider|google|microsoft|github|apple|facebook|sso|single sign|passkey|magic link|cancel|back|re-?send|remember|new code|another|(send|try)\b.*\bagain|different|change|edit|instead|didn['’]?t|did not|not you)\b/i;

/** What changes which button moves the form on. */
export interface SubmitOptions {
  /** No password is configured, so a button that leads to a password ("Sign in with a password") leads elsewhere. */
  passwordless?: boolean;
}

/**
 * Pick the button that moves the form on, enabled or not: a form often
 * enables its button only once it is complete, and the caller waits for it.
 * A configured selector wins. Otherwise, in this order, the first on the page
 * of: a submit button whose text signs in or verifies (sign in, next,
 * continue, verify), any button with such text, a submit button whose text
 * sends a code or continues with an email, any button with such text, any
 * other submit button; at the same rank an enabled button before a disabled
 * one. A button that leads elsewhere (another provider, a reset, a new code,
 * another address, or a password the run does not have) is never chosen.
 * Null means press Enter in the field just filled, which submits a form with
 * a single text field.
 */
export function chooseSubmit(fields: readonly FieldInfo[], opts: SubmitOptions = {}): FieldInfo | null {
  const buttons = fields.filter((f) => f.tag === "button" || (f.tag === "input" && (f.type === "submit" || f.type === "button")));
  const forced = buttons.find((f) => f.forced === "submit");
  if (forced) return forced;
  const isSubmit = (f: FieldInfo): boolean => f.type === "submit" || (f.tag === "button" && f.type === "");
  const rank = (f: FieldInfo): number | null => {
    if (AWAY_WORDS.test(f.text) || (opts.passwordless && /\bpassword\b/i.test(f.text))) return null;
    const submit = isSubmit(f);
    if (SEND_WORDS.test(f.text)) return submit ? 2 : 3;
    if (GO_WORDS.test(f.text)) return submit ? 0 : 1;
    return submit ? 4 : null;
  };
  let best: FieldInfo | null = null;
  let bestKey = Infinity;
  for (const f of buttons) {
    const r = rank(f);
    const key = r === null ? Infinity : r * 2 + (f.disabled ? 1 : 0);
    if (key < bestKey) {
      best = f;
      bestKey = key;
    }
  }
  return best;
}

/** What a step does once its fields are typed, from the page read again a moment later. */
export type AfterTyping =
  | { kind: "moved" }
  | { kind: "fill-more" }
  | { kind: "click"; button: FieldInfo }
  | { kind: "enter"; field: FieldInfo }
  | { kind: "wait"; button: FieldInfo | null };

/**
 * Decide how to submit what a step typed, from the page as it is now; the
 * caller reads the page again and asks again while the answer is wait.
 *
 * - moved: the page left (another URL, or gone mid-navigation), or no field
 *   of a kind just typed is on it any more, or it has been emptied. The page
 *   took the step itself (a code that submits itself once complete), so
 *   nothing is submitted again.
 * - fill-more: the same page now asks for a sign-in field it did not show
 *   before the typing (a password field enabled once the email is valid).
 *   Fill that before submitting.
 * - click: the button chooseSubmit picks, enabled. After the username alone
 *   in a passwordless run, a disabled button that signs in is waiting for a
 *   code nobody has asked for yet: an enabled button that sends one is
 *   clicked instead.
 * - wait: that button is disabled (the page is checking what was typed, or
 *   enables it only once the form is complete), or there is no button and
 *   the field just typed into is disabled.
 * - enter: no button, so Enter in the field just typed into.
 *
 * A typed field is looked for again by its kind, disabled fields included,
 * not by its label, which can change as it is typed into: a page that
 * disables its code boxes once they are full, waiting for a click, has not
 * moved on.
 */
export function afterTyping(
  typed: readonly FieldKind[],
  page: { left: boolean; fields: readonly FieldInfo[] },
  shownBefore: ReadonlySet<FieldKind>,
  opts: SubmitOptions = {},
): AfterTyping {
  if (page.left || typed.length === 0) return { kind: "moved" };
  const stillThere = chooseFields(page.fields.map((f) => ({ ...f, disabled: false })));
  if (typed.some((k) => !stillThere[k]?.filled)) return { kind: "moved" };
  const chosen = chooseFields(page.fields);
  const asksMore = (["username", "password", "otp"] as const).some((k) => {
    const f = chosen[k];
    if (!f || f.filled || typed.includes(k) || shownBefore.has(k)) return false;
    return k !== "otp" || !shapeOnlyOtp(f);
  });
  if (asksMore) return { kind: "fill-more" };
  const button = chooseSubmit(page.fields, opts);
  if (button?.disabled && opts.passwordless && typed.length === 1 && typed[0] === "username") {
    const send = chooseSubmit(
      page.fields.filter((f) => !f.disabled),
      opts,
    );
    if (send && SEND_WORDS.test(send.text)) return { kind: "click", button: send };
  }
  if (button) return button.disabled ? { kind: "wait", button } : { kind: "click", button };
  const field = chosen[typed[typed.length - 1]];
  return field ? { kind: "enter", field } : { kind: "wait", button: null };
}

// ── the steps ───────────────────────────────────────────────────────────────

export type Step =
  { kind: "done" } | { kind: "fill"; fill: FieldKind[] } | { kind: "refused"; reason: string } | { kind: "wait" } | { kind: "stuck"; reason: string };

/** What makes a field the same field when a form comes back: its name, id, type, autocomplete and label, never its value. */
export function fieldIdentity(f: FieldInfo): string {
  return [f.tag, f.type, f.name, f.id, f.autocomplete, f.label].join("|");
}

/**
 * What has been submitted so far, and the identity of each field it was typed
 * into. A field typed but not yet submitted (the page asked for another field
 * first) is not in it: it is typed again with the step that submits.
 */
export interface Progress {
  submitted: Map<FieldKind, string>;
  submits: number;
}

/** What a run was given to type, and how it will know it is signed in. */
export interface StepOptions {
  hasPassword: boolean;
  /** Where the one-time code comes from; unset when no code was configured. */
  code?: CodeSource["kind"];
  successConfigured: boolean;
  successMatched: boolean;
}

/**
 * Decide the next step from what is on the page now.
 *
 * - Signed in: the success URL or selector matched when one is configured;
 *   with neither, a password or a code went through and no sign-in field is
 *   left: no password or code field, and no username field unless it is a
 *   different field from the one the username went into (an app's own email
 *   field, say). After the username alone, a page with no field is still on
 *   its way to the next one (sending a code takes a moment), not signed in.
 * - Refused: a field already submitted is back — the password field after the
 *   password went, the code field after the code went, or the same username
 *   field, empty, after the password went: the provider sent the form back.
 * - A password field with no password configured, or a code field with no
 *   code or TOTP secret configured, is stuck, with the variable to set.
 * - Otherwise fill what is showing and has not been submitted, or wait.
 */
export function nextStep(onPage: Partial<Record<FieldKind, FieldInfo>>, progress: Progress, opts: StepOptions): Step {
  // A success match before anything was submitted is the sign-in page itself matching (`/signin?next=/dashboard`).
  if (opts.successMatched && progress.submits > 0) return { kind: "done" };
  const { submitted } = progress;
  const chosen = signInFields(onPage, submitted, opts);
  const sameUsername = chosen.username !== undefined && submitted.get("username") === fieldIdentity(chosen.username);
  if (submitted.has("password") && chosen.password) {
    return { kind: "refused", reason: "the password field came back after the password was submitted: the username or password was refused" };
  }
  if (submitted.has("password") && sameUsername && !chosen.username!.filled) {
    return { kind: "refused", reason: "the sign-in form came back after the password was submitted: the username or password was refused" };
  }
  if (submitted.has("otp") && chosen.otp) {
    const check = opts.code === "fixed" ? `check ${LOGIN_ENV.otpCode} is the code the app accepts` : "check the TOTP secret and the runner's clock";
    return { kind: "refused", reason: `the one-time-code field came back after a code was submitted: the code was refused (${check})` };
  }
  const usernameIsSignIn = chosen.username !== undefined && (!submitted.has("username") || sameUsername);
  if (!chosen.password && !chosen.otp && !usernameIsSignIn) {
    const credentialSent = submitted.has("password") || submitted.has("otp");
    if (progress.submits === 0 || opts.successConfigured || !credentialSent) return { kind: "wait" };
    return { kind: "done" };
  }
  if (chosen.password && !opts.hasPassword) {
    return { kind: "stuck", reason: `the page asks for a password and ${LOGIN_ENV.password} is not set` };
  }
  if (chosen.otp && !opts.code) {
    return { kind: "stuck", reason: `the page asks for a one-time code and neither ${LOGIN_ENV.otpCode} nor ${LOGIN_ENV.totpSecret} is set` };
  }
  const fill = (["username", "password", "otp"] as const).filter((k) => chosen[k] && !submitted.has(k));
  return fill.length > 0 ? { kind: "fill", fill } : { kind: "wait" };
}

/**
 * The chosen fields that belong to the sign-in. A code field known only by
 * its shape (a numeric field sized for a code) does only while a code is
 * configured and still to be typed after the username or the password has
 * gone, or when it is the very field the code went into. Otherwise it is the app's own field
 * (an order number on the signed-in page) and is left out, so it is neither
 * filled nor read as the code coming back.
 */
function signInFields(
  chosen: Partial<Record<FieldKind, FieldInfo>>,
  submitted: ReadonlyMap<FieldKind, string>,
  opts: StepOptions,
): Partial<Record<FieldKind, FieldInfo>> {
  const otp = chosen.otp;
  if (!otp || !shapeOnlyOtp(otp)) return chosen;
  // After the username or the password: a first page may ask for the password alone, the username carried in its link.
  const stillToType = opts.code !== undefined && (submitted.has("username") || submitted.has("password")) && !submitted.has("otp");
  if (stillToType || submitted.get("otp") === fieldIdentity(otp)) return chosen;
  const rest = { ...chosen };
  delete rest.otp;
  return rest;
}

/**
 * Whether a page URL is the configured success URL: an absolute URL matches
 * as a prefix, anything else as text contained in the path (`/dashboard`),
 * never the query, where a sign-in page carries where it will return to.
 */
export function urlMatches(pageUrl: string, want: string): boolean {
  if (/^https?:\/\//i.test(want)) return pageUrl.startsWith(want);
  let pathname: string;
  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    return false; // Not a URL (about:blank before the first load, say): nothing to match.
  }
  return pathname.includes(want);
}

/**
 * How a step ended: a button clicked (its text), Enter pressed, the page
 * submitting the fields itself once filled, or the page asking for another
 * field before anything could be submitted.
 */
export type SubmittedBy = { button: string } | "enter" | "page" | "more";

/** The fields a step filled, as words: "the username and the password", "the one-time code, one character in each of its 6 boxes". */
export function filledNames(fill: readonly FieldKind[], opts: { codeBoxes?: number } = {}): string {
  const names: Record<FieldKind, string> = {
    username: "the username",
    password: "the password",
    otp: opts.codeBoxes ? `the one-time code, one character in each of its ${opts.codeBoxes} boxes` : "the one-time code",
  };
  const list = fill.map((k) => names[k]);
  return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** One line for what a step did, naming the kinds of field and how it ended, never a value. */
export function describeStep(fill: readonly FieldKind[], by: SubmittedBy, opts: { codeBoxes?: number } = {}): string {
  const joined = filledNames(fill, opts);
  if (by === "page") return `Filled ${joined}; the page submitted it by itself.`;
  if (by === "more") return `Filled ${joined}; the page then asked for another field before submitting.`;
  const how = by === "enter" ? "pressed Enter" : `clicked "${by.button.trim().slice(0, 40)}"`;
  // The code's own clause ends in a comma before "and", as the code is always the last field named.
  return `Filled ${joined}${opts.codeBoxes ? "," : ""} and ${how}.`;
}

/**
 * Page text fit to quote: whitespace collapsed, every credential redacted,
 * then cut to `max` characters. Redaction comes first: a credential cut in
 * half would no longer match it and would be printed in part.
 */
export function quotable(text: string, redact: (text: string) => string, max: number): string {
  return redact(text.replace(/\s+/g, " ").trim()).slice(0, max);
}
