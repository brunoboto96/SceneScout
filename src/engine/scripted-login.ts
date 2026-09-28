/**
 * The rules of `scenescout login <url> --role <name> --script`: a sign-in
 * with no person at the keyboard, for CI. The username, the password and an
 * optional TOTP secret come from the environment; the browser fills the
 * identity provider's form with them and the session is saved as the role's
 * profile exactly as the manual login saves it.
 *
 * Everything here is Playwright-free so it can be table-tested: which
 * environment variables and flags configure a run, the RFC 6238 one-time
 * code, which input on a page is the username, the password or the code,
 * which button moves the form on, what counts as signed in or refused, and
 * the redaction every line of output goes through. The browser half is in
 * login-run.ts.
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

export interface ScriptedLogin {
  username: string;
  password: string;
  totp?: TotpParams;
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
  const password = env[LOGIN_ENV.password] ?? "";
  if (username.trim() === "") errors.push(`${LOGIN_ENV.username} is not set: the test user's username or email`);
  if (password === "") errors.push(`${LOGIN_ENV.password} is not set: the test user's password`);
  let totp: TotpParams | undefined;
  const rawSecret = env[LOGIN_ENV.totpSecret];
  if (rawSecret !== undefined && rawSecret.trim() !== "") {
    const parsed = parseTotpSecret(rawSecret);
    if (parsed.ok) totp = parsed.params;
    else errors.push(`${LOGIN_ENV.totpSecret} ${parsed.error}`);
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
  if (selectors.otp && !totp) errors.push(`an OTP selector is set but ${LOGIN_ENV.totpSecret} is not: there is no code to type into it`);
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
  return { ok: true, config: { username, password, ...(totp ? { totp } : {}), selectors, success, timeoutMs: timeoutS * 1000 } };
}

// ── redaction ───────────────────────────────────────────────────────────────

export const REDACTED = "[redacted]";

/**
 * Every form a credential could take in text: as typed, URL-encoded (a query
 * string, a form body), and with `+` for spaces. The TOTP secret as given,
 * and its base32 without spaces or padding, so a reformatted echo is caught.
 */
export function credentialValues(config: Pick<ScriptedLogin, "username" | "password"> & { totpSecretRaw?: string }): string[] {
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
  if (config.totpSecretRaw) {
    add(config.totpSecretRaw);
    add(config.totpSecretRaw.replace(/[\s=-]/g, "").toUpperCase());
  }
  return [...out].filter((v) => v.length > 0);
}

/**
 * Replace every credential value in a line, longest first so a value
 * containing another is not left half-printed. Case-sensitive except for the
 * username, which identity providers commonly echo lower-cased.
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

/** The redactor for one scripted sign-in: every form of each credential, the username also without regard to case. */
export function credentialRedactor(config: Pick<ScriptedLogin, "username" | "password">, totpSecretRaw?: string): Redactor {
  const values = credentialValues({ ...config, ...(totpSecretRaw ? { totpSecretRaw } : {}) });
  const username = config.username.trim();
  const anyCase = username ? [username, encodeURIComponent(username)] : [];
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
  /\b(otp|one[\s_-]?time|totp|mfa|2fa|two[\s_-]?factor|verification[\s_-]?code|auth(entication|enticator)?[\s_-]?code|security[\s_-]?code|passcode|code)\b/i;
const USER_WORDS = /(user(name)?|e-?mail|login|account|identifier|\bid\b)/i;
const NOT_USER = /(search|query|coupon|promo)/i;
const TEXTLIKE = new Set(["text", "email", "tel", "number", ""]);

const describe = (f: FieldInfo): string => `${f.name} ${f.id} ${f.label}`.replace(/[_-]+/g, " ");

function isOtp(f: FieldInfo): boolean {
  if (f.tag !== "input" || !TEXTLIKE.has(f.type)) return false;
  if (f.autocomplete.split(/\s+/).includes("one-time-code")) return true;
  return OTP_WORDS.test(describe(f)) && !/(zip|postal|country|promo|coupon)/i.test(describe(f));
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
 * sign-in password.
 */
export function chooseFields(fields: readonly FieldInfo[]): Partial<Record<FieldKind, FieldInfo>> {
  const usable = fields.filter((f) => !f.disabled && f.tag !== "button");
  const out: Partial<Record<FieldKind, FieldInfo>> = {};
  for (const kind of ["username", "password", "otp"] as const) {
    const forced = usable.find((f) => f.forced === kind);
    if (forced) out[kind] = forced;
  }
  if (!out.password) {
    const pw = usable.filter((f) => f.tag === "input" && f.type === "password");
    out.password = pw.find((f) => f.autocomplete.includes("current-password")) ?? pw.find((f) => !f.autocomplete.includes("new-password")) ?? pw[0];
  }
  const taken = new Set([out.username?.index, out.password?.index, out.otp?.index].filter((i) => i !== undefined));
  if (!out.otp) out.otp = usable.find((f) => !taken.has(f.index) && isOtp(f));
  if (out.otp) taken.add(out.otp.index);
  if (!out.username) {
    const candidates = usable.filter((f) => !taken.has(f.index) && isUsername(f));
    out.username = candidates.sort((a, b) => usernameRank(a) - usernameRank(b) || a.index - b.index)[0];
  }
  for (const k of Object.keys(out) as FieldKind[]) if (!out[k]) delete out[k];
  return out;
}

const GO_WORDS = /\b(sign[\s-]?in|log[\s-]?in|login|continue|next|verify|submit|confirm|proceed)\b/i;
/** Buttons that lead away from a password sign-in: another provider, another flow. */
const AWAY_WORDS =
  /\b(forgot|reset|sign[\s-]?up|register|create|continue with|provider|google|microsoft|github|apple|facebook|sso|single sign|passkey|magic link|cancel|back|resend|remember)\b/i;

/**
 * Pick the button that moves the form on. A configured selector wins; else a
 * submit button whose text says go (sign in, next, continue, verify), else
 * any submit button that does not lead elsewhere. Null means press Enter in
 * the last field filled, which submits any form with a single text field.
 */
export function chooseSubmit(fields: readonly FieldInfo[]): FieldInfo | null {
  const buttons = fields.filter((f) => !f.disabled && (f.tag === "button" || (f.tag === "input" && (f.type === "submit" || f.type === "button"))));
  const forced = buttons.find((f) => f.forced === "submit");
  if (forced) return forced;
  const isSubmit = (f: FieldInfo): boolean => f.type === "submit" || (f.tag === "button" && f.type === "");
  const clean = buttons.filter((f) => !AWAY_WORDS.test(f.text));
  return clean.find((f) => GO_WORDS.test(f.text) && isSubmit(f)) ?? clean.find((f) => GO_WORDS.test(f.text)) ?? clean.find(isSubmit) ?? null;
}

// ── the steps ───────────────────────────────────────────────────────────────

export type Step =
  { kind: "done" } | { kind: "fill"; fill: FieldKind[] } | { kind: "refused"; reason: string } | { kind: "wait" } | { kind: "stuck"; reason: string };

/** What makes a field the same field when a form comes back: its name, id, type, autocomplete and label, never its value. */
export function fieldIdentity(f: FieldInfo): string {
  return [f.tag, f.type, f.name, f.id, f.autocomplete, f.label].join("|");
}

/** What has been submitted so far, and the identity of each field it was typed into. */
export interface Progress {
  submitted: Map<FieldKind, string>;
  submits: number;
}

/**
 * Decide the next step from what is on the page now.
 *
 * - Signed in: the success URL or selector matched when one is configured;
 *   with neither, at least one submit went through and no sign-in field is
 *   left: no password or code field, and no username field unless it is a
 *   different field from the one the username went into (an app's own email
 *   field, say).
 * - Refused: a field already submitted is back — the password field after the
 *   password went, the code field after the code went, or the same username
 *   field, empty, after the password went: the provider sent the form back.
 * - A code field with no TOTP secret configured is stuck, with the variable
 *   to set.
 * - Otherwise fill what is showing and has not been submitted, or wait.
 */
export function nextStep(
  chosen: Partial<Record<FieldKind, FieldInfo>>,
  progress: Progress,
  opts: { hasTotp: boolean; successConfigured: boolean; successMatched: boolean },
): Step {
  // A success match before anything was submitted is the sign-in page itself matching (`/signin?next=/dashboard`).
  if (opts.successMatched && progress.submits > 0) return { kind: "done" };
  const { submitted } = progress;
  const sameUsername = chosen.username !== undefined && submitted.get("username") === fieldIdentity(chosen.username);
  if (submitted.has("password") && chosen.password) {
    return { kind: "refused", reason: "the password field came back after the password was submitted: the username or password was refused" };
  }
  if (submitted.has("password") && sameUsername && !chosen.username!.filled) {
    return { kind: "refused", reason: "the sign-in form came back after the password was submitted: the username or password was refused" };
  }
  if (submitted.has("otp") && chosen.otp) {
    return {
      kind: "refused",
      reason: "the one-time-code field came back after a code was submitted: the code was refused (check the TOTP secret and the runner's clock)",
    };
  }
  const usernameIsSignIn = chosen.username !== undefined && (!submitted.has("username") || sameUsername);
  if (!chosen.password && !chosen.otp && !usernameIsSignIn) {
    if (progress.submits === 0 || opts.successConfigured) return { kind: "wait" };
    return { kind: "done" };
  }
  if (chosen.otp && !opts.hasTotp) {
    return { kind: "stuck", reason: `the page asks for a one-time code and ${LOGIN_ENV.totpSecret} is not set` };
  }
  const fill = (["username", "password", "otp"] as const).filter((k) => chosen[k] && !submitted.has(k));
  return fill.length > 0 ? { kind: "fill", fill } : { kind: "wait" };
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

/** One line for what a step did, naming the kinds of field and the button, never a value. */
export function describeStep(fill: readonly FieldKind[], button: string | null): string {
  const names: Record<FieldKind, string> = { username: "the username", password: "the password", otp: "the one-time code" };
  const list = fill.map((k) => names[k]);
  const joined = list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  const how = button ? `clicked "${button.trim().slice(0, 40)}"` : "pressed Enter";
  return `Filled ${joined} and ${how}.`;
}
