/**
 * `scenescout login --script`: its configuration from the environment and
 * flags, the RFC 6238 one-time code, which field is which, when the form has
 * signed in or been refused, the redaction every line goes through, and how
 * the smoke suites find a credential left in a file under .scenescout/.
 *
 *   npx tsx --test scripts/scripted-login-test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLoginArgs } from "../src/engine/profiles.ts";
import { leaked, leakedInFile } from "./smoke/secrets.ts";
import {
  afterTyping,
  base32Decode,
  chooseFields,
  chooseSubmit,
  codeBoxes,
  credentialRedactor,
  credentialValues,
  describeStep,
  fieldIdentity,
  hotp,
  LOGIN_ENV,
  nextStep,
  otpBoxes,
  parseOtpCode,
  parseTotpSecret,
  quotable,
  readScriptedLogin,
  REDACTED,
  redactCredentials,
  secondsLeft,
  splitCode,
  totp,
  unansweredSubmit,
  urlMatches,
  type FieldInfo,
  type FieldKind,
  type Progress,
  type Step,
  type StepOptions,
  type TotpAlgorithm,
} from "../src/engine/scripted-login.ts";

const ENV = { [LOGIN_ENV.username]: "member@example.test", [LOGIN_ENV.password]: "pa ss&word+1" };
const noFlags = new Map<string, string>();

// ── configuration ───────────────────────────────────────────────────────────

test("a scripted sign-in needs a username and a password from the environment, and names what is missing without a value", () => {
  const none = readScriptedLogin(noFlags, {});
  assert.equal(none.ok, false);
  if (!none.ok) {
    assert.equal(none.errors.length, 2);
    assert.match(none.errors[0], /SCENESCOUT_LOGIN_USERNAME is not set/);
    assert.match(none.errors[1], /SCENESCOUT_LOGIN_PASSWORD is not set/);
  }
  const onlyUser = readScriptedLogin(noFlags, { [LOGIN_ENV.username]: "member@example.test" });
  assert.equal(onlyUser.ok, false);
  if (!onlyUser.ok) assert.deepEqual(onlyUser.errors.length, 1);
  if (!onlyUser.ok) assert.ok(!onlyUser.errors.join(" ").includes("member@example.test"), "the error never quotes the value");
  const ok = readScriptedLogin(noFlags, ENV);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.config.username, "member@example.test");
    assert.equal(ok.config.password, "pa ss&word+1", "a password is used exactly as given, spaces included");
    assert.equal(ok.config.code, undefined);
    assert.equal(ok.config.timeoutMs, 60_000);
  }
});

test("a bad TOTP secret is refused at startup, naming the variable and never the value", () => {
  const bad = readScriptedLogin(noFlags, { ...ENV, [LOGIN_ENV.totpSecret]: "not-base32!!" });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.errors[0], /^SCENESCOUT_LOGIN_TOTP_SECRET is not a base32 secret/);
    assert.ok(!bad.errors[0].includes("not-base32!!"));
  }
  const good = readScriptedLogin(noFlags, { ...ENV, [LOGIN_ENV.totpSecret]: "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ" });
  assert.ok(good.ok && good.config.code?.kind === "totp");
  // An OTP selector with no secret to type into it is a configuration error, caught before the browser.
  const orphan = readScriptedLogin(new Map(), { ...ENV, [LOGIN_ENV.otpSelector]: "#code" });
  assert.equal(orphan.ok, false);
});

test("a passwordless sign-in: no password, and a fixed code or a TOTP secret for the code it asks for", () => {
  const user = { [LOGIN_ENV.username]: "member@example.test" };
  const fixed = readScriptedLogin(noFlags, { ...user, [LOGIN_ENV.otpCode]: " 482916\n" });
  assert.ok(fixed.ok, fixed.ok ? "" : fixed.errors.join("; "));
  if (fixed.ok) {
    assert.equal(fixed.config.password, undefined, "no password configured is no password, not an empty one");
    assert.deepEqual(fixed.config.code, { kind: "fixed", code: "482916" }, "the whitespace a pasted secret carries is trimmed");
  }
  const totpOnly = readScriptedLogin(noFlags, { ...user, [LOGIN_ENV.totpSecret]: "GEZD GNBV GY3T QOJQ" });
  assert.ok(totpOnly.ok && totpOnly.config.password === undefined && totpOnly.config.code?.kind === "totp");
  const withPassword = readScriptedLogin(noFlags, { ...ENV, [LOGIN_ENV.otpCode]: "A1B2C3" });
  assert.ok(withPassword.ok && withPassword.config.password === "pa ss&word+1" && withPassword.config.code?.kind === "fixed");
  // The username alone is not a sign-in.
  const nothing = readScriptedLogin(noFlags, user);
  assert.equal(nothing.ok, false);
  if (!nothing.ok) {
    assert.equal(nothing.errors.length, 1);
    assert.match(nothing.errors[0], /^SCENESCOUT_LOGIN_PASSWORD is not set: .*SCENESCOUT_LOGIN_OTP_CODE or SCENESCOUT_LOGIN_TOTP_SECRET instead/);
  }
  // A code variable set but blank (a CI secret that does not exist) is named, so "set it instead" is not the whole story.
  const blankCode = readScriptedLogin(noFlags, { ...user, [LOGIN_ENV.otpCode]: "" });
  assert.equal(blankCode.ok, false);
  if (!blankCode.ok) assert.match(blankCode.errors[0], /^SCENESCOUT_LOGIN_PASSWORD is not set: .*; SCENESCOUT_LOGIN_OTP_CODE is set but empty$/);
  // Passwordless is the password left unset. Set but empty is a CI secret that resolved to nothing, refused before a browser starts
  // even with a code to type, where an unset one with the same code is a passwordless sign-in.
  for (const env of [
    { ...user, [LOGIN_ENV.password]: "" },
    { ...user, [LOGIN_ENV.password]: "", [LOGIN_ENV.totpSecret]: "GEZD GNBV GY3T QOJQ" },
    { ...user, [LOGIN_ENV.password]: "", [LOGIN_ENV.otpCode]: "482916" },
  ]) {
    const empty = readScriptedLogin(noFlags, env);
    assert.equal(empty.ok, false, JSON.stringify(Object.keys(env)));
    if (!empty.ok)
      assert.deepEqual(empty.errors, [
        "SCENESCOUT_LOGIN_PASSWORD is set but empty: give the test user's password, or leave it unset for a passwordless sign-in",
      ]);
  }
});

test("a fixed code and a TOTP secret together, or a malformed code, are refused at startup without the value", () => {
  const both = readScriptedLogin(noFlags, { ...ENV, [LOGIN_ENV.otpCode]: "482916", [LOGIN_ENV.totpSecret]: "GEZD GNBV GY3T QOJQ" });
  assert.equal(both.ok, false);
  if (!both.ok) {
    assert.deepEqual(both.errors, [
      "SCENESCOUT_LOGIN_OTP_CODE and SCENESCOUT_LOGIN_TOTP_SECRET are both set: set the fixed code or the secret that generates codes, not both",
    ]);
  }
  for (const [raw, ok] of [
    ["482916", true],
    ["1234", true],
    ["ab12CD", true],
    ["123456789012", true],
    ["123", false],
    ["1234567890123", false],
    ["482 916", false],
    ["482-916", false],
    ["48291!", false],
  ] as const) {
    const r = readScriptedLogin(noFlags, { ...ENV, [LOGIN_ENV.otpCode]: raw });
    assert.equal(r.ok, ok, raw);
    if (!r.ok) {
      assert.match(r.errors[0], /^SCENESCOUT_LOGIN_OTP_CODE must be 4 to 12 letters or digits/, raw);
      assert.ok(!r.errors.join(" ").includes(raw), `the error never quotes ${raw}`);
    }
    assert.equal(parseOtpCode(raw).ok, ok, raw);
  }
  assert.equal(readScriptedLogin(noFlags, { ...ENV, [LOGIN_ENV.otpCode]: "   " }).ok, true, "a blank code is unset, and the password is enough");
});

test("a selector for a field there is nothing to type into is refused at startup", () => {
  const user = { [LOGIN_ENV.username]: "member@example.test", [LOGIN_ENV.otpCode]: "482916" };
  const pw = readScriptedLogin(new Map([["password-selector", "#pw"]]), user);
  assert.equal(pw.ok, false);
  if (!pw.ok) assert.deepEqual(pw.errors, ["a password selector is set but SCENESCOUT_LOGIN_PASSWORD is not: there is no password to type into it"]);
  const otp = readScriptedLogin(new Map([["otp-selector", "#code"]]), user);
  assert.ok(otp.ok, "an OTP selector with a fixed code has a code to type");
  const orphan = readScriptedLogin(new Map([["otp-selector", "#code"]]), ENV);
  assert.equal(orphan.ok, false);
  if (!orphan.ok) assert.match(orphan.errors[0], /neither SCENESCOUT_LOGIN_OTP_CODE nor SCENESCOUT_LOGIN_TOTP_SECRET is/);
});

test("selectors and the success condition come from flags or the environment, the flag winning", () => {
  const env = { ...ENV, [LOGIN_ENV.usernameSelector]: "#env-user", [LOGIN_ENV.successUrl]: "/from-env", [LOGIN_ENV.submitSelector]: "  " };
  const r = readScriptedLogin(
    new Map([
      ["success-url", "/from-flag"],
      ["success-selector", "#signed-in"],
    ]),
    env,
  );
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.config.selectors, { username: "#env-user" }, "a blank variable is unset");
    assert.deepEqual(r.config.success, { url: "/from-flag", selector: "#signed-in" });
  }
  for (const [raw, ok] of [
    ["30", true],
    ["5", true],
    ["600", true],
    ["4", false],
    ["601", false],
    ["1.5", false],
    ["soon", false],
  ] as const) {
    const t = readScriptedLogin(new Map([["timeout", raw]]), ENV);
    assert.equal(t.ok, ok, raw);
  }
});

test("--script is a switch, and its own flags are refused without it", () => {
  const p = parseLoginArgs(["http://127.0.0.1:3000/signin", "--role", "member", "--script", "--success-url", "/account", "--timeout=30"], "/p");
  assert.ok(p.ok);
  if (p.ok)
    assert.deepEqual(
      [...(p.options.script ?? [])],
      [
        ["success-url", "/account"],
        ["timeout", "30"],
      ],
    );
  const manual = parseLoginArgs(["http://127.0.0.1:3000", "--role", "member"], "/p");
  assert.ok(manual.ok && manual.options.script === undefined);
  const stray = parseLoginArgs(["http://127.0.0.1:3000", "--role", "member", "--success-selector", "#in"], "/p");
  assert.deepEqual(stray, { ok: false, error: "--success-selector only applies with --script" });
  // --success-url is the one the window reads too: it goes to the window, not into a script map.
  const windowed = parseLoginArgs(["http://127.0.0.1:3000", "--role", "member", "--success-url", "/a"], "/p");
  assert.ok(windowed.ok && windowed.options.script === undefined && windowed.options.successUrl === "/a");
  // No flag carries a credential: one would sit in the process list and the shell history.
  const cred = parseLoginArgs(["http://127.0.0.1:3000", "--role", "member", "--script", "--password", "x"], "/p");
  assert.deepEqual(cred, { ok: false, error: "unknown option --password" });
});

// ── TOTP ────────────────────────────────────────────────────────────────────

test("HOTP matches the RFC 4226 appendix D values", () => {
  const key = Buffer.from("12345678901234567890");
  const want = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  want.forEach((code, counter) => assert.equal(hotp(key, counter), code, `counter ${counter}`));
});

test("TOTP matches the RFC 6238 appendix B values for SHA1, SHA256 and SHA512", () => {
  const seeds: Record<TotpAlgorithm, Buffer> = {
    SHA1: Buffer.from("12345678901234567890"),
    SHA256: Buffer.from("12345678901234567890123456789012"),
    SHA512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
  };
  const table: Array<[number, string, string, string]> = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [time, sha1, sha256, sha512] of table) {
    for (const [algorithm, code] of [
      ["SHA1", sha1],
      ["SHA256", sha256],
      ["SHA512", sha512],
    ] as const) {
      assert.equal(totp({ key: seeds[algorithm], algorithm, digits: 8, period: 30 }, time), code, `${algorithm} at ${time}`);
    }
  }
});

test("a base32 secret decodes as authenticator apps show it, and an otpauth URI carries its own parameters", () => {
  assert.deepEqual(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), Buffer.from("12345678901234567890"));
  assert.deepEqual(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq"), Buffer.from("12345678901234567890"), "case, spaces and dashes are ignored");
  assert.deepEqual(base32Decode("MZXW6==="), Buffer.from("foo"), "padding is ignored");
  for (const bad of ["", "1890", "ABC!", "===="]) assert.equal(base32Decode(bad), null, bad);

  const uri = parseTotpSecret("otpauth://totp/Example:member?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA1&digits=8&period=30");
  assert.ok(uri.ok);
  if (uri.ok) assert.equal(totp(uri.params, 59), "94287082", "the URI's digits are honoured");
  const plain = parseTotpSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.ok(plain.ok);
  if (plain.ok) assert.equal(totp(plain.params, 59), "287082", "a plain secret is SHA1, 6 digits, 30 seconds");
  for (const bad of [
    "otpauth://hotp/x?secret=GEZDGNBV",
    "otpauth://totp/x?secret=GEZDGNBV&digits=4",
    "otpauth://totp/x?secret=GEZDGNBV&algorithm=MD5",
    "otpauth://totp/x",
  ]) {
    assert.equal(parseTotpSecret(bad).ok, false, bad);
  }
  assert.equal(secondsLeft({ period: 30 }, 59), 1);
  assert.equal(secondsLeft({ period: 30 }, 60), 30);
});

// ── which field is which ────────────────────────────────────────────────────

let next = 0;
const field = (over: Partial<FieldInfo>): FieldInfo => ({
  index: next++,
  tag: "input",
  type: "text",
  name: "",
  id: "",
  autocomplete: "",
  label: "",
  text: "",
  inputmode: "",
  maxLength: -1,
  filled: false,
  disabled: false,
  ...over,
});
const button = (text: string, type = "submit"): FieldInfo => field({ tag: "button", type, text });

test("the username field is found by autocomplete, type, then the words around it", () => {
  const cases: Array<[string, FieldInfo[], number | undefined]> = [];
  const search = field({ name: "q", label: "Search", type: "search" });
  const byAuto = field({ name: "ident", autocomplete: "username" });
  cases.push(["autocomplete=username", [search, byAuto], byAuto.index]);
  const email = field({ type: "email", name: "x" });
  cases.push(["type=email", [search, email], email.index]);
  const byLabel = field({ id: "login-id", label: "Email address" });
  cases.push(["a label saying email", [byLabel], byLabel.index]);
  const promo = field({ name: "promo_code", label: "Promo code for your account" });
  cases.push(["a promo field is not the username", [promo], undefined]);
  const plain = field({ name: "city", label: "City" });
  cases.push(["an unrelated field is not the username", [plain], undefined]);
  const strong = field({ autocomplete: "email", name: "e" });
  const weak = field({ name: "user_name" });
  cases.push(["autocomplete beats a name, whatever the order", [weak, strong], strong.index]);
  for (const [why, fields, want] of cases) assert.equal(chooseFields(fields).username?.index, want, why);
});

test("the password field is the current password; a new-password field only when it is the only one", () => {
  const current = field({ type: "password", autocomplete: "current-password" });
  const fresh = field({ type: "password", autocomplete: "new-password" });
  assert.equal(chooseFields([fresh, current]).password?.index, current.index);
  const plainPw = field({ type: "password" });
  assert.equal(chooseFields([fresh, plainPw]).password?.index, plainPw.index);
  assert.equal(chooseFields([fresh]).password?.index, fresh.index);
  assert.equal(chooseFields([field({ name: "password", type: "text" })]).password, undefined, "a text field named password is not a password field");
});

test("the one-time-code field is found by autocomplete or its words, and is never taken for the username", () => {
  const byAuto = field({ autocomplete: "one-time-code", inputmode: "numeric" });
  assert.deepEqual(Object.keys(chooseFields([byAuto])), ["otp"]);
  const byLabel = field({ id: "mfa", label: "Verification code" });
  assert.equal(chooseFields([byLabel]).otp?.index, byLabel.index);
  const accountCode = field({ name: "account_code", label: "Enter the code from your authenticator app" });
  const chosen = chooseFields([accountCode]);
  assert.equal(chosen.otp?.index, accountCode.index);
  assert.equal(chosen.username, undefined, "a code field whose label says account is still the code field");
  const zip = field({ name: "zip_code", label: "Postal code" });
  assert.equal(chooseFields([zip]).otp, undefined, "a postal code is not a one-time code");
});

test("a single code field is found by autocomplete, its words, or a numeric box sized for a code; a phone or card number is not one", () => {
  const cases: Array<[string, FieldInfo, boolean]> = [
    ["inputmode numeric, sized for a code, named nowhere", field({ inputmode: "numeric", maxLength: 6 }), true],
    ["type=tel, numeric, 8 long", field({ type: "tel", inputmode: "numeric", maxLength: 8 }), true],
    ["named verification", field({ name: "verification" }), true],
    ["labelled Verification", field({ label: "Verification" }), true],
    ["named otp", field({ name: "otp" }), true],
    ["the code we emailed", field({ label: "Enter the code we emailed you" }), true],
    ["masked, autocomplete=one-time-code", field({ type: "password", autocomplete: "one-time-code" }), true],
    ["numeric with no length", field({ inputmode: "numeric" }), false],
    ["numeric, too long for a code", field({ inputmode: "numeric", maxLength: 16 }), false],
    ["numeric, labelled Phone", field({ inputmode: "numeric", maxLength: 10, label: "Phone" }), false],
    ["numeric, autocomplete=tel", field({ type: "tel", inputmode: "numeric", maxLength: 10, autocomplete: "tel" }), false],
    ["numeric, a card number", field({ inputmode: "numeric", maxLength: 12, name: "card_number" }), false],
    ["text with no signal", field({ maxLength: 6 }), false],
  ];
  for (const [why, f, want] of cases) assert.equal(chooseFields([f]).otp?.index === f.index, want, why);
  const masked = field({ type: "password", autocomplete: "one-time-code" });
  assert.equal(chooseFields([masked]).password, undefined, "a masked code field is the code, not a password");
  const emailWithCode = field({ type: "email", name: "email", label: "Email: we will send you a code" });
  const step1 = chooseFields([emailWithCode]);
  assert.deepEqual(Object.keys(step1), ["username"], "an email field whose label mentions a code is the username");
  const maskedByName = field({ type: "password", name: "otp" });
  assert.deepEqual(Object.keys(chooseFields([maskedByName])), ["otp"], "a masked field named otp is the code");
  const passcode = field({ type: "password", label: "Passcode" });
  assert.deepEqual(Object.keys(chooseFields([passcode])), ["password"], "a masked passcode is the password");
  const postcode = field({ inputmode: "numeric", maxLength: 8, label: "Post code" });
  assert.equal(chooseFields([postcode]).otp, undefined, "a post code is not a one-time code");
  const shapeFirst = field({ inputmode: "numeric", maxLength: 6 });
  const named = field({ name: "code" });
  assert.equal(chooseFields([shapeFirst, named]).otp?.index, named.index, "a field named as the code wins over one known by its shape");
  const accountNumber = field({ inputmode: "numeric", maxLength: 10, label: "Account number" });
  assert.deepEqual(Object.keys(chooseFields([accountNumber])), ["username"], "a numeric account number is the username, not a code");
  const emailed = field({ name: "code", label: "Enter the code we sent to your email" });
  assert.equal(chooseFields([emailed]).username, undefined, "a code field whose label says email is still the code field");
});

/** `n` single-character boxes in a row, as a code split one character per box lays them out. */
const boxesOf = (n: number, over: Partial<FieldInfo> = {}): FieldInfo[] =>
  Array.from({ length: n }, (_, i) => field({ inputmode: "numeric", maxLength: 1, label: `Digit ${i + 1} of the code we emailed`, ...over }));

test("a code split one character per box is chosen by its first box, and no box is the username or the password", () => {
  const six = boxesOf(6);
  const chosen = chooseFields(six);
  assert.deepEqual(Object.keys(chosen), ["otp"], "a box labelled with the word email is not the username");
  assert.equal(chosen.otp?.index, six[0].index);
  assert.deepEqual(
    otpBoxes(six, chosen.otp!)?.map((b) => b.index),
    six.map((b) => b.index),
  );
  const masked = boxesOf(4, { type: "password", label: "" });
  assert.equal(chooseFields(masked).password, undefined, "masked boxes are the code, not a password");
  assert.equal(chooseFields(masked).otp?.index, masked[0].index);
  // Later boxes disabled until the earlier ones are filled are still the code.
  const gated = boxesOf(6).map((b, i) => (i > 0 ? { ...b, disabled: true } : b));
  assert.equal(codeBoxes(gated)?.length, 6);
  assert.equal(codeBoxes(boxesOf(6).map((b) => ({ ...b, disabled: true }))), null, "a code whose first box is disabled cannot be typed yet");
  // A selector naming one box of the code names the code.
  const forced = boxesOf(6);
  forced[3].forced = "otp";
  assert.equal(chooseFields(forced).otp?.index, forced[0].index);
  // A single code field next to nothing split is not a box.
  const single = field({ autocomplete: "one-time-code", maxLength: 6 });
  assert.equal(otpBoxes([single], single), null);
});

test("only a run of 4 to 10 adjacent one-character boxes is a split code; a split date, card or short run is not", () => {
  assert.equal(codeBoxes(boxesOf(3)), null, "three boxes");
  assert.equal(codeBoxes(boxesOf(11)), null, "eleven boxes");
  assert.equal(codeBoxes(boxesOf(4))?.length, 4);
  assert.equal(codeBoxes(boxesOf(10))?.length, 10);
  const date = [field({ maxLength: 2, label: "Day" }), field({ maxLength: 2, label: "Month" }), field({ maxLength: 4, label: "Year" })];
  assert.equal(codeBoxes(date), null, "a split date");
  const card = Array.from({ length: 4 }, () => field({ inputmode: "numeric", maxLength: 4 }));
  assert.equal(codeBoxes(card), null, "a card number in groups of four");
  const broken = [...boxesOf(3), button("Paste"), ...boxesOf(3)];
  assert.equal(codeBoxes(broken), null, "a control between the boxes ends the run");
  const emails = boxesOf(4, { type: "email" });
  assert.equal(codeBoxes(emails), null, "email fields are never code boxes");
});

test("a code is split one character per box, and a code of another length is refused naming where it comes from, never quoting it", () => {
  assert.deepEqual(splitCode("482916", 6, "fixed"), { ok: true, chars: ["4", "8", "2", "9", "1", "6"] });
  const fixed = splitCode("482916", 4, "fixed");
  assert.deepEqual(fixed, {
    ok: false,
    error: "the page splits the code into 4 boxes, one character each, and SCENESCOUT_LOGIN_OTP_CODE has a different number of characters",
  });
  const generated = splitCode("94287082", 6, "totp");
  assert.equal(generated.ok, false);
  if (!generated.ok) {
    assert.match(generated.error, /SCENESCOUT_LOGIN_TOTP_SECRET generates have 8 digits \(an otpauth:\/\/ URI's digits parameter sets how many\)$/);
    assert.ok(!generated.error.includes("94287082"));
  }
});

test("a passwordless first step: the email and the button that sends the code, never one that leads elsewhere", () => {
  const email = field({ type: "email", name: "email", autocomplete: "email" });
  const send = button("Send code", "button");
  const provider = button("Continue with another provider", "button");
  assert.deepEqual(Object.keys(chooseFields([email, send, provider])), ["username"]);
  assert.equal(chooseSubmit([provider, send])?.index, send.index, "a JavaScript button that sends the code moves the form on");
  for (const text of [
    "Send me a code",
    "Get a code",
    "Get one-time code",
    "Request login code",
    "Email me a code",
    "Text me",
    "Continue with email",
    "Continue with your email",
  ]) {
    const b = button(text, "button");
    assert.equal(chooseSubmit([button("Continue with Google", "button"), b])?.index, b.index, text);
  }
});

test("on the code step the button that submits it is chosen, never one that sends a new code or changes the address", () => {
  const verify = button("Verify");
  for (const text of [
    "Resend code",
    "Re-send code",
    "Send a new code",
    "Send it again",
    "Use a different email",
    "Change email",
    "Didn’t get a code?",
    "Not you?",
  ]) {
    const away = button(text, "button");
    assert.equal(chooseSubmit([away, verify])?.index, verify.index, text);
    assert.equal(chooseSubmit([away]), null, `${text} alone is never clicked`);
  }
  const again = button("Sign in again");
  assert.equal(chooseSubmit([again])?.index, again.index, "again in a sign-in button's text does not lead elsewhere");
});

test("a configured selector wins for its kind", () => {
  const guess = field({ type: "email" });
  const forced = field({ name: "weird", forced: "username" });
  assert.equal(chooseFields([guess, forced]).username?.index, forced.index);
  const go = button("Sign in");
  const custom = button("→", "button");
  custom.forced = "submit";
  assert.equal(chooseSubmit([go, custom])?.index, custom.index);
});

test("the submit button says go and does not lead elsewhere; none found means press Enter", () => {
  const google = button("Continue with Google", "button");
  const forgot = button("Forgot password?", "button");
  const next1 = button("Next");
  assert.equal(chooseSubmit([google, forgot, next1])?.index, next1.index);
  const another = button("Continue with another provider", "button");
  const nextButton = button("Next", "button");
  assert.equal(chooseSubmit([another, nextButton])?.index, nextButton.index, '"continue with …" leads to another sign-in, not on');
  const signUp = button("Sign up");
  const signIn = button("Sign in");
  assert.equal(chooseSubmit([signUp, signIn])?.index, signIn.index);
  const verify = field({ type: "submit", text: "Verify" });
  assert.equal(chooseSubmit([verify])?.index, verify.index, "an input type=submit counts");
  const typeless = field({ tag: "button", type: "", text: "Go" });
  assert.equal(chooseSubmit([google, typeless])?.index, typeless.index, "a button with no type is a submit button");
  assert.equal(chooseSubmit([google, forgot]), null);
  // A disabled button is still the one to submit with: a form often enables it only once complete, and the run waits for it.
  assert.equal(chooseSubmit([{ ...signIn, disabled: true }])?.index, signIn.index);
});

test("a button that signs in or verifies wins over one that sends a code or continues with an email, wherever each is on the page", () => {
  const verify = button("Verify");
  const sms = field({ tag: "button", type: "", text: "Send a code to my phone" });
  assert.equal(chooseSubmit([sms, verify])?.index, verify.index, "a code page that also offers to text a code");
  const textMe = button("Text me a code", "button");
  assert.equal(chooseSubmit([textMe, { ...verify, disabled: true }])?.index, verify.index, "a disabled Verify is waited for, not passed over");
  const withEmail = button("Continue with email");
  const signIn = button("Sign in");
  assert.equal(chooseSubmit([withEmail, signIn])?.index, signIn.index, "a password form beside an email-code option");
  // At the same rank an enabled button comes before a disabled one.
  const hidden = { ...button("Sign in"), disabled: true };
  const shown = button("Sign in");
  assert.equal(chooseSubmit([hidden, shown])?.index, shown.index);
  // With no password configured, a button that leads to a password leads elsewhere.
  const withPassword = button("Sign in with a password", "button");
  const send = button("Send code", "button");
  assert.equal(chooseSubmit([withPassword, send], { passwordless: true })?.index, send.index);
  assert.equal(chooseSubmit([withPassword, send])?.index, withPassword.index, "the same page, a password configured");
});

test("after typing: the page that took the step itself is not submitted again, and one that is still checking is waited for", () => {
  const email = field({ type: "email", name: "email", filled: true });
  const send = button("Send code", "button");
  const shown = new Set<FieldKind>(["username"]);
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [email, send] }, shown), { kind: "click", button: send });
  assert.deepEqual(afterTyping(["username"], { left: true, fields: [] }, shown), { kind: "moved" }, "another URL, or gone mid-navigation");
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [send] }, shown), { kind: "moved" }, "the field typed into is gone");
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [{ ...email, filled: false }, send] }, shown), { kind: "moved" }, "emptied");
  // The label can change as the field is typed into (a hint inside its label): it is the same field, not the page moving on.
  const relabelled = { ...email, label: "Email: looks good" };
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [relabelled, send] }, shown), { kind: "click", button: send });
  const disabledSend = { ...send, disabled: true };
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [email, disabledSend] }, shown), { kind: "wait", button: disabledSend });
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [email] }, shown), { kind: "enter", field: email }, "no button: Enter");
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [{ ...email, disabled: true }] }, shown), { kind: "wait", button: null });
});

test("after typing a split code: boxes disabled once full are still the code, and boxes emptied mean the page took it", () => {
  const full = boxesOf(6).map((b) => ({ ...b, filled: true }));
  const verify = button("Verify");
  const shown = new Set<FieldKind>(["otp"]);
  assert.deepEqual(afterTyping(["otp"], { left: false, fields: [...full, verify] }, shown), { kind: "click", button: verify });
  const locked = full.map((b) => ({ ...b, disabled: true }));
  assert.deepEqual(
    afterTyping(["otp"], { left: false, fields: [...locked, verify] }, shown),
    { kind: "click", button: verify },
    "boxes disabled once full, waiting for a click, have not moved on",
  );
  const busy = { ...verify, disabled: true };
  assert.deepEqual(afterTyping(["otp"], { left: false, fields: [...full, busy] }, shown), { kind: "wait", button: busy }, "still checking the code");
  const cleared = full.map((b) => ({ ...b, filled: false }));
  assert.deepEqual(afterTyping(["otp"], { left: false, fields: [...cleared, busy] }, shown), { kind: "moved" }, "refused and cleared: the page took it");
});

test("after the username alone in a passwordless run, a disabled sign-in button is waiting for a code nobody asked for: send one", () => {
  const email = field({ type: "email", name: "email", filled: true });
  const signIn = { ...button("Sign in"), disabled: true };
  const send = button("Send code", "button");
  const shown = new Set<FieldKind>(["username"]);
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [email, signIn, send] }, shown, { passwordless: true }), {
    kind: "click",
    button: send,
  });
  // With a password configured the disabled button is waited for, and so is a disabled Verify once the code itself is typed.
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [email, signIn, send] }, shown), { kind: "wait", button: signIn });
  const code = field({ autocomplete: "one-time-code", filled: true });
  const verify = { ...button("Verify"), disabled: true };
  const textMe = button("Text me a code", "button");
  assert.deepEqual(afterTyping(["otp"], { left: false, fields: [code, verify, textMe] }, new Set<FieldKind>(["otp"]), { passwordless: true }), {
    kind: "wait",
    button: verify,
  });
});

test("after typing: a sign-in field the typing revealed is filled before anything is submitted", () => {
  const email = field({ type: "email", name: "email", filled: true });
  const pw = field({ type: "password", name: "password" });
  const signIn = button("Sign in");
  const shown = new Set<FieldKind>(["username"]);
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [email, pw, signIn] }, shown), { kind: "fill-more" });
  // A password field shown from the start was the page's, not the typing's: submit.
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [email, pw, signIn] }, new Set<FieldKind>(["username", "password"])), {
    kind: "click",
    button: signIn,
  });
  // A numeric field known only by its shape is no reason to hold the submit back.
  const shape = field({ inputmode: "numeric", maxLength: 6 });
  assert.deepEqual(afterTyping(["username"], { left: false, fields: [email, shape, signIn] }, shown), { kind: "click", button: signIn });
});

// ── the steps ───────────────────────────────────────────────────────────────

const progress = (entries: Array<[FieldKind, FieldInfo]> = [], submits = entries.length): Progress => ({
  submitted: new Map(entries.map(([k, f]) => [k, fieldIdentity(f)])),
  submits,
});
const opts: StepOptions = { hasPassword: true, code: "totp", successConfigured: false, successMatched: false };

test("a two-step form: username, then the password it reveals, then the code", () => {
  const user = field({ type: "email", name: "email" });
  const pw = field({ type: "password", name: "password" });
  const code = field({ autocomplete: "one-time-code", name: "code" });
  assert.deepEqual(nextStep(chooseFields([user]), progress(), opts), { kind: "fill", fill: ["username"] });
  // The same page, the username kept on screen filled in: only the password is typed.
  const both = chooseFields([{ ...user, filled: true }, pw]);
  assert.deepEqual(nextStep(both, progress([["username", user]]), opts), { kind: "fill", fill: ["password"] });
  assert.deepEqual(
    nextStep(
      chooseFields([code]),
      progress([
        ["username", user],
        ["password", pw],
      ]),
      opts,
    ),
    { kind: "fill", fill: ["otp"] },
  );
  // One page with both fields: both at once.
  assert.deepEqual(nextStep(chooseFields([user, pw]), progress(), opts), { kind: "fill", fill: ["username", "password"] });
});

test("a field typed in a step the page held back (it showed another field first) is typed again, not taken as refused", () => {
  const user = field({ type: "email", name: "email" });
  const pw = field({ type: "password", name: "password", filled: true });
  const code = field({ autocomplete: "one-time-code", name: "code" });
  // The username went in an earlier step; the password was typed, then a code field appeared before anything was submitted.
  const onPage = chooseFields([{ ...user, filled: true }, pw, code]);
  assert.deepEqual(nextStep(onPage, progress([["username", user]]), opts), { kind: "fill", fill: ["password", "otp"] });
  // Recorded as submitted when it was only typed, the same page would read as the password coming back.
  assert.equal(
    nextStep(
      onPage,
      progress(
        [
          ["username", user],
          ["password", pw],
        ],
        1,
      ),
      opts,
    ).kind,
    "refused",
  );
});

test("signed in: no sign-in field left after a submit, or the configured success matched", () => {
  const user = field({ type: "email", name: "email" });
  const pw = field({ type: "password", name: "password" });
  const done = progress([
    ["username", user],
    ["password", pw],
  ]);
  assert.deepEqual(nextStep({}, done, opts), { kind: "done" });
  // Nothing on screen before any submit is a form still rendering, not a sign-in.
  assert.deepEqual(nextStep({}, progress(), opts), { kind: "wait" });
  // With a success condition configured, only it decides.
  assert.deepEqual(nextStep({}, done, { ...opts, successConfigured: true }), { kind: "wait" });
  assert.deepEqual(nextStep({}, done, { ...opts, successConfigured: true, successMatched: true }), { kind: "done" });
  // A match before any submit is the sign-in page matching, not a sign-in: fill the form.
  const user2 = field({ type: "email", name: "email" });
  assert.deepEqual(nextStep(chooseFields([user2]), progress(), { ...opts, successConfigured: true, successMatched: true }), {
    kind: "fill",
    fill: ["username"],
  });
  // The app's own email field after signing in is a different field, not the form back.
  const newsletter = field({ type: "email", name: "newsletter", label: "Get our newsletter" });
  assert.deepEqual(nextStep(chooseFields([newsletter]), done, opts), { kind: "done" });
});

test("refused: a submitted field comes back, and the contrast where it does not", () => {
  const user = field({ type: "email", name: "email", label: "Email" });
  const pw = field({ type: "password", name: "password" });
  const code = field({ autocomplete: "one-time-code", name: "code" });
  const afterPassword = progress([
    ["username", user],
    ["password", pw],
  ]);
  assert.equal(nextStep(chooseFields([user, pw]), afterPassword, opts).kind, "refused", "both fields back");
  assert.equal(nextStep(chooseFields([{ ...user }]), afterPassword, opts).kind, "refused", "the first step back, empty");
  assert.equal(
    nextStep(chooseFields([{ ...user, filled: true }]), afterPassword, opts).kind,
    "wait",
    "the username field still filled in, with no password field, is not the form back: wait for the page to move on",
  );
  const afterCode = progress([
    ["username", user],
    ["password", pw],
    ["otp", code],
  ]);
  const refusedCode = nextStep(chooseFields([code]), afterCode, opts);
  assert.equal(refusedCode.kind, "refused");
  assert.match(refusedCode.kind === "refused" ? refusedCode.reason : "", /clock/);
  // A code field before any code was typed is the next step, not a refusal.
  assert.equal(nextStep(chooseFields([code]), afterPassword, opts).kind, "fill");
});

test("a code field with no code or TOTP secret is stuck, naming both variables", () => {
  const code = field({ autocomplete: "one-time-code" });
  const step = nextStep(chooseFields([code]), progress([["password", field({ type: "password" })]]), { ...opts, code: undefined });
  assert.deepEqual(step, {
    kind: "stuck",
    reason: "the page asks for a one-time code and neither SCENESCOUT_LOGIN_OTP_CODE nor SCENESCOUT_LOGIN_TOTP_SECRET is set",
  });
});

test("a passwordless sign-in: the username, then the code it reveals, with no password asked for", () => {
  const passwordless: StepOptions = { ...opts, hasPassword: false, code: "fixed" };
  const email = field({ type: "email", name: "email" });
  const code = field({ autocomplete: "one-time-code", name: "code" });
  assert.deepEqual(nextStep(chooseFields([email]), progress(), passwordless), { kind: "fill", fill: ["username"] });
  // After the username alone, a page with no field is on its way to the code step (sending a code takes a moment), not signed in.
  assert.deepEqual(nextStep({}, progress([["username", email]]), passwordless), { kind: "wait" });
  assert.deepEqual(nextStep(chooseFields([code]), progress([["username", email]]), passwordless), { kind: "fill", fill: ["otp"] });
  // The address kept on screen, filled, beside the code field: only the code is typed.
  assert.deepEqual(nextStep(chooseFields([{ ...email, filled: true }, code]), progress([["username", email]]), passwordless), {
    kind: "fill",
    fill: ["otp"],
  });
  const afterCode = progress([
    ["username", email],
    ["otp", code],
  ]);
  assert.deepEqual(nextStep({}, afterCode, passwordless), { kind: "done" }, "once the code went, no field left is signed in");
  const boxes = boxesOf(6);
  assert.deepEqual(nextStep(chooseFields(boxes), progress([["username", email]]), passwordless), { kind: "fill", fill: ["otp"] });
  assert.equal(
    nextStep(
      chooseFields(boxes),
      progress([
        ["username", email],
        ["otp", boxes[0]],
      ]),
      passwordless,
    ).kind,
    "refused",
    "the boxes back, emptied, after the code went: the code was refused",
  );
});

test("a password field with no password configured is stuck naming the variable; with one configured it is filled", () => {
  const passwordless: StepOptions = { ...opts, hasPassword: false, code: "fixed" };
  const email = field({ type: "email", name: "email" });
  const pw = field({ type: "password", name: "password" });
  const stuck = { kind: "stuck", reason: "the page asks for a password and SCENESCOUT_LOGIN_PASSWORD is not set" };
  assert.deepEqual(nextStep(chooseFields([email, pw]), progress(), passwordless), stuck, "nothing is typed into a form that needs a password");
  assert.deepEqual(nextStep(chooseFields([{ ...email, filled: true }, pw]), progress([["username", email]]), passwordless), stuck);
  assert.deepEqual(nextStep(chooseFields([email, pw]), progress(), opts), { kind: "fill", fill: ["username", "password"] });
});

test("a numeric field known only by its shape is the code only while a code is still to be typed, or when it is the same field back", () => {
  const user = field({ type: "email", name: "email" });
  const pw = field({ type: "password", name: "password" });
  const code = field({ autocomplete: "one-time-code", name: "code" });
  const shape = field({ inputmode: "numeric", maxLength: 6 });
  const orderNumber = field({ inputmode: "numeric", maxLength: 10, label: "Order" });
  // Signed in with a password and a code: a numeric field of the app's own is not the code coming back.
  const afterCode = progress([
    ["username", user],
    ["password", pw],
    ["otp", code],
  ]);
  assert.deepEqual(nextStep(chooseFields([orderNumber]), afterCode, opts), { kind: "done" });
  // Signed in with a password, no code configured: not a code page the run is stuck on.
  const afterPassword = progress([
    ["username", user],
    ["password", pw],
  ]);
  assert.deepEqual(nextStep(chooseFields([orderNumber]), afterPassword, { ...opts, code: undefined }), { kind: "done" });
  // A code configured and still to be typed after the username: the numeric field is the code field.
  const passwordless: StepOptions = { ...opts, hasPassword: false, code: "fixed" };
  assert.deepEqual(nextStep(chooseFields([shape]), progress([["username", user]]), passwordless), { kind: "fill", fill: ["otp"] });
  // Before the username has gone it is not, so the code is never typed into a numeric field on the first page.
  assert.deepEqual(nextStep(chooseFields([user, shape]), progress(), passwordless), { kind: "fill", fill: ["username"] });
  // A first page asking for the password alone (the username carried in its link), then the numeric code field.
  assert.deepEqual(nextStep(chooseFields([shape]), progress([["password", pw]]), opts), { kind: "fill", fill: ["otp"] });
  // The same field back after the code went: refused.
  const sent = progress([
    ["username", user],
    ["otp", shape],
  ]);
  assert.equal(nextStep(chooseFields([shape]), sent, passwordless).kind, "refused");
});

test("a refused code names what to check: the fixed code, or the TOTP secret and the clock", () => {
  const code = field({ autocomplete: "one-time-code" });
  const sent = progress([["otp", code]]);
  const reason = (o: StepOptions): string => {
    const step = nextStep(chooseFields([code]), sent, o);
    return step.kind === "refused" ? step.reason : step.kind;
  };
  assert.match(reason({ ...opts, code: "fixed" }), /the code was refused \(check SCENESCOUT_LOGIN_OTP_CODE is the code the app accepts\)$/);
  assert.match(reason(opts), /the code was refused \(check the TOTP secret and the runner's clock\)$/);
});

test("a submitted field counts as refused only once the page has answered: the very field still holding the value is a page not yet moved on", () => {
  const user = field({ type: "email", name: "email" });
  const pw = field({ type: "password", name: "password" });
  const code = field({ autocomplete: "one-time-code", name: "code" });
  const afterPassword = progress([
    ["username", user],
    ["password", pw],
  ]);
  const afterCode = progress([["otp", code]]);
  const late: StepOptions = { ...opts, code: "fixed", timedOutAfterS: 60 };
  const cases: Array<[string, Partial<Record<FieldKind, FieldInfo>>, Progress, StepOptions, Step["kind"]]> = [
    // The element the code was typed into, still holding it, just after the submit: the app has not answered yet.
    ["the same code field, still filled, just after the submit", chooseFields([{ ...code, typed: true, filled: true }]), afterCode, opts, "wait"],
    ["the same password field, still filled, just after the submit", chooseFields([{ ...pw, typed: true, filled: true }]), afterPassword, opts, "wait"],
    // The app emptied the very field it was typed into: it answered, and said no.
    ["the same code field, emptied by the app", chooseFields([{ ...code, typed: true, filled: false }]), afterCode, opts, "refused"],
    ["the same password field, emptied by the app", chooseFields([{ ...pw, typed: true, filled: false }]), afterPassword, opts, "refused"],
    // Drawn again (a new element, or a new page) with nothing typed in it: refused.
    ["the code field re-rendered, empty", chooseFields([{ ...code }]), afterCode, opts, "refused"],
    ["the password field re-rendered, empty", chooseFields([{ ...pw }]), afterPassword, opts, "refused"],
    ["the code field re-rendered, the browser keeping its value", chooseFields([{ ...code, filled: true }]), afterCode, opts, "refused"],
    // The deadline passed with the same field still holding what was typed: a timeout, not a refusal.
    ["the same code field, still filled, at the timeout", chooseFields([{ ...code, typed: true, filled: true }]), afterCode, late, "timeout"],
    ["the same password field, still filled, at the timeout", chooseFields([{ ...pw, typed: true, filled: true }]), afterPassword, late, "timeout"],
    ["the code field emptied by the app, at the timeout", chooseFields([{ ...code, typed: true }]), afterCode, late, "refused"],
  ];
  for (const [what, onPage, sent, o, want] of cases) assert.equal(nextStep(onPage, sent, o).kind, want, what);
  const timedOut = nextStep(chooseFields([{ ...code, typed: true, filled: true }]), afterCode, late);
  assert.deepEqual(timedOut, {
    kind: "timeout",
    reason: "the sign-in did not finish within 60s: the one-time code was submitted and the page still shows it in the same field",
  });
  // A password still shown in its field beside the code field the submit revealed: the code is filled, not the password taken as refused.
  assert.deepEqual(nextStep(chooseFields([{ ...pw, typed: true, filled: true }, code]), afterPassword, opts), { kind: "fill", fill: ["otp"] });
});

test("a submitted code or password the page disables while it checks it is not a sign-in: no field showing is not done until the page answers", () => {
  const code = field({ autocomplete: "one-time-code", name: "code" });
  const pw = field({ type: "password", name: "password" });
  const afterCode = progress([["otp", code]]);
  const afterPassword = progress([["password", pw]]);
  // What the page shows: the very element typed into, disabled while the app checks it, still holding the value.
  const cases: Array<[string, FieldInfo[], Progress, FieldKind | undefined]> = [
    ["the code field, disabled while checked, still holding the code", [{ ...code, typed: true, filled: true, disabled: true }], afterCode, "otp"],
    ["the password field, disabled, still holding the password", [{ ...pw, typed: true, filled: true, disabled: true }], afterPassword, "password"],
    ["the same field, enabled again and still holding it", [{ ...code, typed: true, filled: true }], afterCode, "otp"],
    ["the field emptied by the app", [{ ...code, typed: true, disabled: true }], afterCode, undefined],
    ["the field drawn again, disabled", [{ ...code, filled: true, disabled: true }], afterCode, undefined],
    ["a code field that was typed into but not submitted", [{ ...code, typed: true, filled: true, disabled: true }], progress(), undefined],
    ["no field at all", [], afterCode, undefined],
  ];
  for (const [what, fields, sent, want] of cases) assert.equal(unansweredSubmit(fields, sent.submitted), want, what);
  // A disabled field is not chosen, so the page reads as having no sign-in field: with the code still being checked, that is not done.
  const checking: StepOptions = { ...opts, code: "fixed", checking: "otp" };
  assert.deepEqual(nextStep(chooseFields([{ ...code, typed: true, filled: true, disabled: true }]), afterCode, checking), { kind: "wait" });
  assert.deepEqual(nextStep({}, afterCode, { ...opts, code: "fixed" }), { kind: "done" }, "the contrast: nothing being checked, no field is signed in");
  assert.deepEqual(nextStep({}, afterCode, { ...checking, timedOutAfterS: 30 }), {
    kind: "timeout",
    reason: "the sign-in did not finish within 30s: the one-time code was submitted and the page still shows it in the same field",
  });
});

test("the success URL matches as a prefix when absolute, as contained text otherwise", () => {
  assert.equal(urlMatches("http://127.0.0.1:3000/account?x=1", "/account"), true);
  assert.equal(urlMatches("http://127.0.0.1:3000/signin?next=/account", "http://127.0.0.1:3000/account"), false);
  assert.equal(urlMatches("http://127.0.0.1:3000/account", "http://127.0.0.1:3000/account"), true);
  assert.equal(urlMatches("http://127.0.0.1:3000/signin?next=/account", "/account"), false, "a sign-in page returning to the path is not the path");
});

test("a step's line names the fields and how they went, never a value", () => {
  assert.equal(describeStep(["username"], { button: "Next" }), 'Filled the username and clicked "Next".');
  assert.equal(describeStep(["username", "password"], "enter"), "Filled the username and the password and pressed Enter.");
  assert.equal(describeStep(["username", "password", "otp"], { button: "Go" }), 'Filled the username, the password and the one-time code and clicked "Go".');
  assert.equal(
    describeStep(["otp"], { button: "Verify" }, { codeBoxes: 6 }),
    'Filled the one-time code, one character in each of its 6 boxes, and clicked "Verify".',
  );
  assert.equal(
    describeStep(["otp"], "page", { codeBoxes: 6 }),
    "Filled the one-time code, one character in each of its 6 boxes; the page submitted it by itself.",
  );
  assert.equal(describeStep(["otp"], "page"), "Filled the one-time code; the page submitted it by itself.");
});

// ── redaction ───────────────────────────────────────────────────────────────

test("every form of a credential is redacted: as typed, URL-encoded, with + for spaces, the username in any case", () => {
  const secret = "GEZD GNBV GY3T QOJQ";
  const r = credentialRedactor({ username: "Member@Example.test", password: "pa ss&word+1" }, secret);
  const lines = [
    "refused Member@Example.test",
    "refused member@example.test",
    "at /signin?login_hint=Member%40Example.test",
    "body password=pa+ss%26word%2B1",
    "body password=pa%20ss%26word%2B1",
    "at /signin?login_hint=member%40example.test",
    "typed pa ss&word+1",
    `secret ${secret}`,
    "secret GEZDGNBVGY3TQOJQ",
  ];
  for (const line of lines) {
    const out = r.redact(line);
    assert.ok(out.includes(REDACTED), line);
    for (const v of ["member@example.test", "Member", "pa ss", "ss&word", "ss%26word", "GEZD", "QOJQ"])
      assert.ok(!out.toLowerCase().includes(v.toLowerCase()), `${v} left in ${out}`);
  }
  assert.equal(
    r.redact("Signed in: now at http://127.0.0.1:3000/account."),
    "Signed in: now at http://127.0.0.1:3000/account.",
    "a line with no credential is untouched",
  );
  r.add("123456");
  assert.equal(r.redact("typed code 123456"), `typed code ${REDACTED}`, "a value added while running (a typed code) is redacted from then on");
});

test("the longest value is replaced first, so one credential containing another is not left half-printed", () => {
  assert.equal(redactCredentials("x hunter22 y", ["hunter2", "hunter22"]), `x ${REDACTED} y`);
  assert.deepEqual(credentialValues({ username: "a b", password: "c" }).sort(), ["a b", "a%20b", "a+b", "c"].sort());
});

test("a fixed one-time code is redacted like the password, in any case, and a passwordless run redacts the rest", () => {
  const r = credentialRedactor({ username: "member@example.test", code: { kind: "fixed", code: "Ab12Cd" } });
  for (const line of ["The code Ab12Cd is not right.", "The code AB12CD is not right.", "at /verify?code=ab12cd", "refused member@example.test"]) {
    const out = r.redact(line);
    assert.ok(out.includes(REDACTED), line);
    assert.ok(!/ab12cd|member@example/i.test(out), `${line} → ${out}`);
  }
  const digits = credentialRedactor({ username: "member@example.test", code: { kind: "fixed", code: "482916" } });
  assert.equal(digits.redact('The page says: "The code 482916 is not right."'), `The page says: "The code ${REDACTED} is not right."`);
  assert.equal(digits.redact("Signed in: now at http://127.0.0.1:3000/account."), "Signed in: now at http://127.0.0.1:3000/account.");
  assert.deepEqual(credentialValues({ username: "u", otpCode: "4829" }).sort(), ["4829", "u"]);
  // A TOTP source has no fixed value: its codes are added as they are typed.
  const totpRun = credentialRedactor({ username: "u", code: { kind: "totp", params: { key: Buffer.from("k"), algorithm: "SHA1", digits: 6, period: 30 } } });
  assert.equal(totpRun.redact("typed 287082"), "typed 287082");
  totpRun.add("287082");
  assert.equal(totpRun.redact("typed 287082"), `typed ${REDACTED}`);
});

test("page text is redacted before it is shortened, so a credential cut in half is never printed in part", () => {
  const r = credentialRedactor({ username: "member+ci@example.test", code: { kind: "fixed", code: "482916" } });
  const label = "Send a code to the address member+ci@example.test";
  assert.equal(quotable(label, r.redact, 40), "Send a code to the address [redacted]");
  assert.ok(r.redact(label.slice(0, 40)).includes("member+ci"), "shortened first, the cut address no longer matches the redaction");
  assert.equal(quotable("  The code\n 482916   is not right ", r.redact, 200), "The code [redacted] is not right");
});

test("the smoke leak check: a credential kept anywhere in a saved file is found, a cookie expiry whose fraction spells the code is not", () => {
  const secrets = ["member@example.test", "482916"];
  const profile = (cookie: object, storage: object[] = []) =>
    JSON.stringify({
      cookies: [{ name: "session", value: "Ocju__4VRrpmJV7KvJJY2BEW6rFdd_a3", path: "/", ...cookie }],
      origins: [{ origin: "http://127.0.0.1:3000", localStorage: storage }],
    });
  // The pair: the same expiry, once as a number the browser chose and once as a value the page kept.
  const chance = profile({ expires: 1790946905.482916 });
  assert.deepEqual(leaked(chance, secrets), ["482916"], "searched as raw text, the expiry's microseconds read as the code");
  assert.deepEqual(leakedInFile(chance, secrets), []);
  assert.deepEqual(leakedInFile(profile({ expires: 1790946905.5 }, [{ name: "expiry", value: "1790946905.482916" }]), secrets), ["482916"]);
  // A credential kept in any shape a run could keep it is still found.
  for (const [kept, want] of [
    [profile({ value: "482916" }), "482916"],
    [profile({}, [{ name: "otp", value: "code=482916&step=2" }]), "482916"],
    [profile({}, [{ name: "otp", value: 482916 }]), "482916"],
    [profile({}, [{ name: "482916", value: "1" }]), "482916"],
    [profile({}, [{ name: "login", value: JSON.stringify({ email: "Member@Example.test" }) }]), "member@example.test"],
    [profile({}, [{ name: "login", value: "email=member%40example.test" }]), "member%40example.test"],
  ] as const) {
    assert.ok(leakedInFile(kept, secrets).includes(want), kept);
  }
  // A file that is not JSON is searched whole.
  assert.deepEqual(leakedInFile("signed in as member@example.test\n", secrets), ["member@example.test"]);
});
