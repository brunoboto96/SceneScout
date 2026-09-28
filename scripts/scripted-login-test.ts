/**
 * `scenescout login --script`: its configuration from the environment and
 * flags, the RFC 6238 one-time code, which field is which, when the form has
 * signed in or been refused, and the redaction every line goes through.
 *
 *   npx tsx --test scripts/scripted-login-test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLoginArgs } from "../src/engine/profiles.ts";
import {
  base32Decode,
  chooseFields,
  chooseSubmit,
  credentialRedactor,
  credentialValues,
  describeStep,
  fieldIdentity,
  hotp,
  LOGIN_ENV,
  nextStep,
  parseTotpSecret,
  readScriptedLogin,
  REDACTED,
  redactCredentials,
  secondsLeft,
  totp,
  urlMatches,
  type FieldInfo,
  type FieldKind,
  type Progress,
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
    assert.equal(ok.config.totp, undefined);
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
  assert.ok(good.ok && good.config.totp !== undefined);
  // An OTP selector with no secret to type into it is a configuration error, caught before the browser.
  const orphan = readScriptedLogin(new Map(), { ...ENV, [LOGIN_ENV.otpSelector]: "#code" });
  assert.equal(orphan.ok, false);
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
  const stray = parseLoginArgs(["http://127.0.0.1:3000", "--role", "member", "--success-url", "/a"], "/p");
  assert.deepEqual(stray, { ok: false, error: "--success-url only applies with --script" });
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
  assert.equal(chooseSubmit([{ ...signIn, disabled: true }]), null);
});

// ── the steps ───────────────────────────────────────────────────────────────

const progress = (entries: Array<[FieldKind, FieldInfo]> = [], submits = entries.length): Progress => ({
  submitted: new Map(entries.map(([k, f]) => [k, fieldIdentity(f)])),
  submits,
});
const opts = { hasTotp: true, successConfigured: false, successMatched: false };

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

test("a code field with no TOTP secret is stuck, naming the variable", () => {
  const code = field({ autocomplete: "one-time-code" });
  const step = nextStep(chooseFields([code]), progress([["password", field({ type: "password" })]]), { ...opts, hasTotp: false });
  assert.deepEqual(step, { kind: "stuck", reason: "the page asks for a one-time code and SCENESCOUT_LOGIN_TOTP_SECRET is not set" });
});

test("the success URL matches as a prefix when absolute, as contained text otherwise", () => {
  assert.equal(urlMatches("http://127.0.0.1:3000/account?x=1", "/account"), true);
  assert.equal(urlMatches("http://127.0.0.1:3000/signin?next=/account", "http://127.0.0.1:3000/account"), false);
  assert.equal(urlMatches("http://127.0.0.1:3000/account", "http://127.0.0.1:3000/account"), true);
  assert.equal(urlMatches("http://127.0.0.1:3000/signin?next=/account", "/account"), false, "a sign-in page returning to the path is not the path");
});

test("a step's line names the fields and the button, never a value", () => {
  assert.equal(describeStep(["username"], "Next"), 'Filled the username and clicked "Next".');
  assert.equal(describeStep(["username", "password"], null), "Filled the username and the password and pressed Enter.");
  assert.equal(describeStep(["username", "password", "otp"], "Go"), 'Filled the username, the password and the one-time code and clicked "Go".');
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
