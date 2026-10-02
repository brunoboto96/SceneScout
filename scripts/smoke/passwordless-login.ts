/**
 * `scenescout login --script` with no password, through the real CLI and a
 * real browser, against the fixture's passwordless sign-in: the email, then
 * "Send code" (enabled a moment after the email is typed, beside a button
 * that leads to a password; then a moment with no field on screen while the
 * code is "emailed"), then the code, as one field or as one box per digit
 * that submits itself.
 * The app keeps its access token in localStorage and its session in a cookie,
 * with a refresh-token cookie beside it.
 *
 * The pair: the fixture's one fixed code signs in and saves a profile that
 * attaches signed in; a wrong code exits 1 and saves nothing. The page echoes
 * a wrong code back, so the output is tested against a page that puts the
 * code on screen: no code may reach stdout or stderr, and once every run is
 * done no file under .scenescout/ holds one. A form that asks for a password,
 * with none configured, stops naming the variable to set.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { profilePath } from "../../dist/engine/profiles.js";
import { check, eventually, FIXED_OTP_CODE, OTP_SESSION_COOKIE, SCRIPTED_USER, type SmokeContext } from "./harness.ts";
import { filesUnder, leaked, login } from "./scripted-login.ts";

export const title = "passwordless scripted login";

const SIGNED_IN = "Signed in as a member";

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-passwordless-"));
  const url = `${baseUrl}/otp-signin`;
  const user = { SCENESCOUT_LOGIN_USERNAME: SCRIPTED_USER.username };
  const right = { ...user, SCENESCOUT_LOGIN_OTP_CODE: FIXED_OTP_CODE };
  const wrongCode = "135792";
  const secrets = [SCRIPTED_USER.username, FIXED_OTP_CODE, wrongCode];
  const signIn = (args: string[], env: Record<string, string>) => login([...args, "--script", "--project", project], env);
  let engine: BrowserEngine | undefined;
  try {
    // ---- One code field, the right code ---------------------------------------
    const ok = await signIn([url, "--role", "member", "--success-url", "/otp-account"], right);
    check("a passwordless sign-in with a fixed code exits 0", ok.code === 0, `${ok.code}\n${ok.out}\n${ok.err}`);
    check(
      "...having filled the email, waited for the button that sends the code to be enabled, and clicked it, not the one leading to a password",
      ok.out.includes('Filled the username and clicked "Send code".'),
      ok.out,
    );
    check("...then the code, clicking Verify once the complete code enabled it", ok.out.includes('Filled the one-time code and clicked "Verify".'), ok.out);
    check("...and saved the role's profile", fs.existsSync(profilePath(project, "member")), ok.out);
    check("no code or username reaches stdout or stderr", leaked(ok.out + ok.err, secrets).length === 0, leaked(ok.out + ok.err, secrets).join(", "));
    const files = filesUnder(path.join(project, ".scenescout"));
    const dirty = files.filter((f) => leaked(f.text, secrets).length > 0).map((f) => f.file);
    check("no code or username is in any file under .scenescout/, the profile included", files.length > 0 && dirty.length === 0, dirty.join(", "));

    if (fs.existsSync(profilePath(project, "member"))) {
      const saved = JSON.parse(fs.readFileSync(profilePath(project, "member"), "utf8")) as {
        cookies?: Array<{ name: string }>;
        origins?: Array<{ localStorage?: Array<{ name: string }> }>;
      };
      const cookies = (saved.cookies ?? []).map((c) => c.name);
      check(
        "the profile holds the session cookie and the refresh-token cookie",
        cookies.includes(OTP_SESSION_COOKIE) && cookies.includes("fixture_otp_refresh"),
        cookies.join(", "),
      );
      const stored = (saved.origins ?? []).flatMap((o) => (o.localStorage ?? []).map((e) => e.name));
      check("...and the access token the page kept in localStorage", stored.includes("access_token"), stored.join(", "));
    }

    engine = new BrowserEngine();
    const out = await engine.attach({ url: `${baseUrl}/otp-account`, projectDir: project, mode: "read-only", role: "member" });
    check("the saved profile attaches by role", out.includes("role=member") && !out.includes("AUTH FAILED"), out);
    const attached = engine;
    const signedIn = await eventually(async () => (await attached.snapshot(true)).includes(SIGNED_IN), 10_000);
    check("...signed in: the app's API took the token from localStorage and the session cookie", signedIn, await attached.snapshot(true));
    await engine.close();
    engine = undefined;

    // ---- No success URL: the moment while the code is sent is not a sign-in -----
    const detected = await signIn([url, "--role", "detected"], right);
    check(
      "with no success URL, the run waits through the sending of the code and ends signed in",
      detected.code === 0 && detected.out.includes("Filled the one-time code") && detected.out.includes(`now at ${baseUrl}/otp-account`),
      `${detected.code}\n${detected.out}\n${detected.err}`,
    );

    // ---- A wrong code: the page echoes it; the output must not ------------------
    const refused = await signIn([url, "--role", "refused"], { ...user, SCENESCOUT_LOGIN_OTP_CODE: wrongCode });
    check("a wrong code exits 1", refused.code === 1, `${refused.code}\n${refused.out}\n${refused.err}`);
    check(
      "...saying the code was refused and which variable to check",
      refused.err.includes("the code was refused") && refused.err.includes("SCENESCOUT_LOGIN_OTP_CODE"),
      refused.err,
    );
    check("...quoting what the page said, the code in it redacted", refused.err.includes("The page says:") && refused.err.includes("[redacted]"), refused.err);
    const leak = leaked(refused.out + refused.err, secrets);
    check("...without the code or the username anywhere in its output", leak.length === 0, leak.join(", "));
    check("...and saves no profile", !fs.existsSync(profilePath(project, "refused")));

    // ---- One box per digit, submitting itself once the last digit is in ---------
    const boxes = await signIn([`${url}?boxes`, "--role", "boxes", "--success-url", "/otp-account"], right);
    check(
      "a code split one digit per box signs in",
      boxes.code === 0 && fs.existsSync(profilePath(project, "boxes")),
      `${boxes.code}\n${boxes.out}\n${boxes.err}`,
    );
    check(
      "...typing one digit into each of the 6 boxes, which submit the code themselves: nothing presses Enter or clicks after them",
      boxes.out.includes("Filled the one-time code, one character in each of its 6 boxes; the page submitted it by itself."),
      boxes.out,
    );
    check("...with nothing leaked", leaked(boxes.out + boxes.err, secrets).length === 0, leaked(boxes.out + boxes.err, secrets).join(", "));

    const boxesWrong = await signIn([`${url}?boxes`, "--role", "boxeswrong"], { ...user, SCENESCOUT_LOGIN_OTP_CODE: wrongCode });
    check(
      "a wrong code in the boxes exits 1, refused",
      boxesWrong.code === 1 && boxesWrong.err.includes("the code was refused"),
      `${boxesWrong.code}\n${boxesWrong.err}`,
    );
    check("...with no code in its output", leaked(boxesWrong.out + boxesWrong.err, secrets).length === 0, boxesWrong.err);
    check("...and saves no profile", !fs.existsSync(profilePath(project, "boxeswrong")));

    // ---- A form that asks for a password, with none configured ------------------
    const asksPassword = await signIn([`${baseUrl}/scripted-signin`, "--role", "nopassword"], right);
    check("a password field with no password configured exits 1", asksPassword.code === 1, `${asksPassword.code}\n${asksPassword.out}\n${asksPassword.err}`);
    check(
      "...naming the variable to set",
      asksPassword.err.includes("the page asks for a password and SCENESCOUT_LOGIN_PASSWORD is not set"),
      asksPassword.err,
    );
    check("...and saves no profile", !fs.existsSync(profilePath(project, "nopassword")));

    // ---- A fixed code and a TOTP secret together --------------------------------
    const both = await signIn([url, "--role", "both"], { ...right, SCENESCOUT_LOGIN_TOTP_SECRET: SCRIPTED_USER.totpSecret });
    check(
      "a fixed code and a TOTP secret together exit 1 before a browser starts, naming both",
      both.code === 1 && both.err.includes("SCENESCOUT_LOGIN_OTP_CODE and SCENESCOUT_LOGIN_TOTP_SECRET are both set"),
      both.err,
    );
    check("...and quoting neither", leaked(both.out + both.err, [...secrets, SCRIPTED_USER.totpSecret]).length === 0, both.err);

    // ---- Every run done, the ones whose page echoed the code included ------------
    const allFiles = filesUnder(path.join(project, ".scenescout"));
    const anyDirty = allFiles.filter((f) => leaked(f.text, secrets).length > 0).map((f) => f.file);
    check("after every run, no file under .scenescout/ holds a code or the username", anyDirty.length === 0, anyDirty.join(", "));
  } finally {
    await engine?.close().catch(() => {});
    fs.rmSync(project, { recursive: true, force: true });
  }
}
