/**
 * `scenescout login --script` through the real CLI and a real browser, against
 * the fixture's two-step sign-in with a one-time code: the password appears
 * after "Next", the code on a page of its own. A right password and code save
 * a profile that attaches signed in; a wrong password, and a wrong TOTP
 * secret, fail with exit 1 and save nothing. The page echoes a wrong password
 * back, so the run's output is tested against a page that puts the
 * credentials on screen: no credential value may reach stdout, stderr or any
 * file under .scenescout/.
 *
 * The CLI runs as a child process, asynchronously: the fixture server lives in
 * this process and must keep answering while the child signs in.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { profilePath } from "../../dist/engine/profiles.js";
import { check, SCRIPTED_USER, type SmokeContext } from "./harness.ts";
import { leaked, leakedInFile } from "./secrets.ts";

export const title = "scripted login";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");

/** `scenescout login` through the built CLI, with no SCENESCOUT_LOGIN_ variable from this process: only `env`'s. */
export function login(args: string[], env: Record<string, string | undefined>): Promise<{ code: number | null; out: string; err: string }> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("SCENESCOUT_LOGIN_")) clean[k] = v;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "login", ...args], { env: clean, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/** Every file under a directory, read as text. */
export function filesUnder(dir: string): Array<{ file: string; text: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((d) => {
    if (!d.isFile()) return [];
    const file = path.join(d.parentPath, d.name);
    return [{ file, text: fs.readFileSync(file, "utf8") }];
  });
}

/** Each file under a directory that holds a secret, with the secrets it holds, as `file: secret, ...`. */
export function dirtyFiles(dir: string, secrets: string[]): string[] {
  return filesUnder(dir).flatMap((f) => {
    const found = leakedInFile(f.text, secrets);
    return found.length > 0 ? [`${f.file}: ${found.join(", ")}`] : [];
  });
}

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-scripted-"));
  const url = `${baseUrl}/scripted-signin`;
  const creds = {
    SCENESCOUT_LOGIN_USERNAME: SCRIPTED_USER.username,
    SCENESCOUT_LOGIN_PASSWORD: SCRIPTED_USER.password,
    SCENESCOUT_LOGIN_TOTP_SECRET: SCRIPTED_USER.totpSecret,
  };
  const secrets = [SCRIPTED_USER.username, SCRIPTED_USER.password, SCRIPTED_USER.totpSecret];
  let engine: BrowserEngine | undefined;
  try {
    // ---- Missing configuration fails before a browser starts ----------------
    const missing = await login([url, "--role", "member", "--script", "--project", project], { SCENESCOUT_LOGIN_USERNAME: SCRIPTED_USER.username });
    check("a missing password exits 1", missing.code === 1, `${missing.code} ${missing.err}`);
    check("...naming the variable to set", missing.err.includes("SCENESCOUT_LOGIN_PASSWORD is not set"), missing.err);
    check("...and never the username it was given", leaked(missing.out + missing.err, secrets).length === 0, missing.err);

    // ---- A right password and code --------------------------------------------
    const ok = await login([url, "--role", "member", "--script", "--project", project, "--success-url", "/cookie-account"], creds);
    check("the scripted sign-in exits 0", ok.code === 0, `${ok.code}\n${ok.out}\n${ok.err}`);
    check("...having filled the username and clicked Next", ok.out.includes('Filled the username and clicked "Next".'), ok.out);
    check("...then the password it revealed", ok.out.includes('Filled the password and clicked "Sign in".'), ok.out);
    check("...then the one-time code", ok.out.includes('Filled the one-time code and clicked "Verify".'), ok.out);
    check(
      "...and saved the role's profile",
      ok.out.includes(`Saved to ${profilePath(project, "member")}`) && fs.existsSync(profilePath(project, "member")),
      ok.out,
    );
    check("no credential value reaches stdout or stderr", leaked(ok.out + ok.err, secrets).length === 0, leaked(ok.out + ok.err, secrets).join(", "));
    const files = filesUnder(path.join(project, ".scenescout"));
    const dirty = dirtyFiles(path.join(project, ".scenescout"), secrets);
    check("no credential value is in any file under .scenescout/, the profile included", files.length > 0 && dirty.length === 0, dirty.join("\n"));
    check("the profile file is owner-only", process.platform === "win32" || (fs.statSync(profilePath(project, "member")).mode & 0o777) === 0o600);

    // With no success condition configured, leaving the sign-in fields behind is the signal.
    const detected = await login([url, "--role", "detected", "--script", "--project", project], creds);
    check(
      "with no success URL, the run still ends signed in",
      detected.code === 0 && detected.out.includes("now at " + `${baseUrl}/cookie-account`),
      `${detected.code}\n${detected.out}\n${detected.err}`,
    );
    check("...with nothing leaked", leaked(detected.out + detected.err, secrets).length === 0);

    engine = new BrowserEngine();
    const out = await engine.attach({ url: `${baseUrl}/cookie-account`, projectDir: project, mode: "read-only", role: "member" });
    check("the saved profile attaches by role", out.includes("role=member") && !out.includes("AUTH FAILED"), out);
    const page = await engine.snapshot(true);
    check("...signed in", page.includes("Signed in as a member"), page);

    // ---- A wrong password: the page echoes it; the output must not ----------
    const wrongPassword = "Wrong horse+battery&staple 99";
    const refused = await login([url, "--role", "refused", "--script", "--project", project], { ...creds, SCENESCOUT_LOGIN_PASSWORD: wrongPassword });
    check("a wrong password exits 1", refused.code === 1, `${refused.code}\n${refused.out}\n${refused.err}`);
    check("...saying the sign-in was refused", refused.err.includes("sign-in refused"), refused.err);
    check("...quoting what the page said, redacted", refused.err.includes("The page says:") && refused.err.includes("[redacted]"), refused.err);
    const leak = leaked(refused.out + refused.err, [...secrets, wrongPassword]);
    check("...without the wrong password or the username anywhere in its output", leak.length === 0, leak.join(", "));
    check("...and saves no profile", !fs.existsSync(profilePath(project, "refused")));

    // ---- A wrong TOTP secret -------------------------------------------------
    const otherSecret = "KRUG S4ZA NFZS AYJA";
    const badCode = await login([url, "--role", "badcode", "--script", "--project", project], { ...creds, SCENESCOUT_LOGIN_TOTP_SECRET: otherSecret });
    check("a code from the wrong secret exits 1", badCode.code === 1, `${badCode.code}\n${badCode.out}\n${badCode.err}`);
    check("...saying the code was refused", badCode.err.includes("code was refused"), badCode.err);
    check("...without the secret in its output", leaked(badCode.out + badCode.err, [...secrets, otherSecret]).length === 0, badCode.err);
    check("...and saves no profile", !fs.existsSync(profilePath(project, "badcode")));
  } finally {
    await engine?.close().catch(() => {});
    fs.rmSync(project, { recursive: true, force: true });
  }
}
