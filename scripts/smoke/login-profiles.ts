/**
 * Sign-in profiles through a real browser: one login saved as a role, two
 * sessions attached by that role, and both signed in — each in its own browser
 * context, so one signing out leaves the other signed in. The contrast is a
 * session attached without the role, which sees the signed-out page at the
 * same URL.
 *
 * The profile is recorded programmatically, headless, through the same capture
 * and write `scenescout login` uses; only the window and the Enter key are
 * left out.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, firefox, webkit, type Page } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { profilePath, writeProfile } from "../../dist/engine/profiles.js";
import { saveLogin, savedLine } from "../../dist/login-run.js";
import { BROWSER, check, SIGN_IN_COOKIE, type SmokeContext } from "./harness.ts";

export const title = "login profiles";

const SIGNED_IN = "Signed in as a member";
const SIGNED_OUT = "You are signed out";

/** The whole snapshot, never the diff: a revisited page with nothing changed would otherwise say nothing about what it shows. */
const pageText = (engine: BrowserEngine): Promise<string> => engine.snapshot(true);

const SESSION_IN = "Signed in with a session token";
const SESSION_OUT = "No session token: signed out";
const IDB_IN = "Signed in with an IndexedDB token";
const IDB_OUT = "No IndexedDB token: signed out";

/** The page text once it has settled on one of two answers (the IndexedDB page answers asynchronously). */
async function settledText(engine: BrowserEngine, answers: string[]): Promise<string> {
  let text = "";
  for (let i = 0; i < 20; i++) {
    text = await pageText(engine);
    if (answers.some((a) => text.includes(a))) return text;
    await new Promise((r) => setTimeout(r, 100));
  }
  return text;
}

export async function run({ baseUrl, foreignBaseUrl }: SmokeContext): Promise<void> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-login-"));
  const opened: BrowserEngine[] = [];
  const track = (engine: BrowserEngine): BrowserEngine => {
    opened.push(engine);
    return engine;
  };
  try {
    // ---- Record the login once, as `scenescout login` would ----------------
    const browser = await { chromium, firefox, webkit }[BROWSER].launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${baseUrl}/cookie-signin`);
      check("the fixture's sign-in lands on the signed-in page", (await page.textContent("h1")) === SIGNED_IN, await page.content());
      const options = { url: `${baseUrl}/cookie-account`, role: "member", projectDir: project };
      const saved = await saveLogin(context, options);
      check("the profile is saved under .scenescout/auth/<role>.json", saved.path === path.join(project, ".scenescout", "auth", "member.json"), saved.path);
      check("...holding the sign-in cookie", saved.summary.cookies >= 1, JSON.stringify(saved.summary));
      // What `scenescout login` prints once saved: how long the login lasts, read
      // from the cookie the fixture sets for an hour, by name and never by value.
      const printed = savedLine(options, saved);
      check(
        "login's output says how long the saved sign-in lasts, from the cookie that dates it",
        /\nLasts: about (59m\d\ds|1h00m) \(the last dated credential, cookie "fixture_session"\)\.\n/.test(printed),
        printed,
      );
      check("...and never prints the cookie's value", !printed.includes("=member"), printed);
    } finally {
      await browser.close();
    }
    const profileBefore = fs.readFileSync(profilePath(project, "member"), "utf8");

    // ---- Two lanes attach by the role -------------------------------------
    const laneA = track(new BrowserEngine());
    const laneB = track(new BrowserEngine());
    const outA = await laneA.attach({ url: `${baseUrl}/cookie-account`, projectDir: project, mode: "read-only", role: "member" });
    const outB = await laneB.attach({ url: `${baseUrl}/cookie-account`, projectDir: project, mode: "read-only", role: "member" });
    check("attach by role says which role it signed in as", outA.includes("role=member") && outB.includes("role=member"), outA);
    check("...and neither reports the profile as failing to sign in", !outA.includes("AUTH FAILED") && !outB.includes("AUTH FAILED"), outB);
    check("the sessions are labelled by the role", laneA.role === "member" && laneB.role === "member", `${laneA.role} / ${laneB.role}`);
    const snapA = await pageText(laneA);
    const snapB = await pageText(laneB);
    check("lane A sees the signed-in page", snapA.includes(SIGNED_IN), snapA);
    check("lane B, from the same login, sees the signed-in page", snapB.includes(SIGNED_IN), snapB);

    // Both keep working signed in: each navigates on, concurrently.
    await Promise.all([laneA.navigate(`${baseUrl}/cookie-account`), laneB.navigate(`${baseUrl}/cookie-account`)]);
    const [againA, againB] = [await pageText(laneA), await pageText(laneB)];
    check("both stay signed in as they navigate at the same time", againA.includes(SIGNED_IN), againA);
    check("...lane B too", againB.includes(SIGNED_IN), againB);

    // Each lane has its OWN context: lane A signing out leaves lane B signed in.
    await laneA.navigate(`${baseUrl}/cookie-signout`);
    const afterSignOutA = await pageText(laneA);
    check("lane A, signed out, sees the signed-out page", afterSignOutA.includes(SIGNED_OUT), afterSignOutA);
    await laneB.navigate(`${baseUrl}/cookie-account`);
    const stillB = await pageText(laneB);
    check("lane B stays signed in after lane A signs out: the lanes share a login, not a browser", stillB.includes(SIGNED_IN), stillB);
    check("signing out in a lane never rewrites the saved profile", fs.readFileSync(profilePath(project, "member"), "utf8") === profileBefore);
    check("the profile file stays owner-only", process.platform === "win32" || (fs.statSync(profilePath(project, "member")).mode & 0o777) === 0o600);

    // ---- The contrast: same URL, no role -----------------------------------
    const anonymous = track(new BrowserEngine());
    await anonymous.attach({ url: `${baseUrl}/cookie-account`, projectDir: project, mode: "read-only" });
    const snapAnon = await pageText(anonymous);
    check("a session attached without the role sees the signed-out page", snapAnon.includes(SIGNED_OUT) && !snapAnon.includes(SIGNED_IN), snapAnon);
    check("...and is labelled anonymous", anonymous.role === "anonymous", anonymous.role);

    // ---- Refusals ------------------------------------------------------------
    const refusal = async (opts: { role?: string; storageStatePath?: string }): Promise<string> => {
      const eng = track(new BrowserEngine());
      try {
        await eng.attach({ url: `${baseUrl}/cookie-account`, projectDir: project, mode: "read-only", ...opts });
        return "";
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    const missing = await refusal({ role: "auditor" });
    check(
      "a role nobody recorded is refused with the command that records it",
      missing.includes(`scenescout login ${baseUrl}/cookie-account --role auditor`),
      missing,
    );
    check("...and names the roles that are saved", missing.includes("Saved roles: member."), missing);
    const both = await refusal({ role: "member", storageStatePath: profilePath(project, "member") });
    check("role and storageStatePath together are refused", both.includes("not both"), both);
    const escape = await refusal({ role: "../member" });
    check("a role name that is a path is refused", escape.includes("not allowed"), escape);
    // A refused attach leaves a live session as it was.
    const failedReattach = await laneB
      .attach({ url: `${baseUrl}/cookie-account`, projectDir: project, mode: "read-only", role: "auditor" })
      .catch((e: Error) => e.message);
    check("a refused re-attach names the problem", failedReattach.includes("auditor"), failedReattach);
    check("...and leaves that session attached and signed in", laneB.attached && (await pageText(laneB)).includes(SIGNED_IN));

    // A profile someone loosened is still attached, and the attach says so.
    if (process.platform !== "win32") {
      fs.chmodSync(profilePath(project, "member"), 0o644);
      const loose = track(new BrowserEngine());
      const looseOut = await loose.attach({ url: `${baseUrl}/cookie-account`, projectDir: project, mode: "read-only", role: "member" });
      check("a profile others can read is called out at attach, with the fix", looseOut.includes("chmod 600"), looseOut);
      check("...and an owner-only one is not", !outA.includes("chmod 600"), outA);
      fs.chmodSync(profilePath(project, "member"), 0o600);
    }
    // A storage-state file that does not exist is refused before the live session is closed.
    const missingFile = await laneB
      .attach({ url: `${baseUrl}/cookie-account`, projectDir: project, mode: "read-only", storageStatePath: path.join(project, "nope.json") })
      .catch((e: Error) => e.message);
    check("a missing storage-state file is refused", missingFile.includes("does not exist"), missingFile);
    check("...and leaves that session attached and signed in", laneB.attached && (await pageText(laneB)).includes(SIGNED_IN));

    check(`the fixture's cookie is the one saved (${SIGN_IN_COOKIE})`, profileBefore.includes(SIGN_IN_COOKIE));

    // ---- sessionStorage: a token nowhere but this tab's sessionStorage ------
    // Recorded twice from one sign-in: by the capture `scenescout login` uses,
    // and by a bare storageState() — what the capture saved before sessionStorage
    // was kept. The one fact that differs between the two profiles is that.
    const recorder = await { chromium, firefox, webkit }[BROWSER].launch({ headless: true });
    try {
      const context = await recorder.newContext();
      const page = await context.newPage();
      await page.goto(`${baseUrl}/session-signin.html`);
      await page.waitForURL(`${baseUrl}/session-account.html`);
      check("the fixture's session sign-in lands signed in", (await page.textContent("h1")) === SESSION_IN, await page.content());
      const saved = await saveLogin(context, { url: baseUrl, role: "spa", projectDir: project });
      check("the capture keeps the origin's sessionStorage", saved.summary.sessionOrigins === 1, JSON.stringify(saved.summary));
      writeProfile(project, "spa-legacy", await context.storageState());
      // The IndexedDB sign-in, recorded the same two ways.
      await page.goto(`${baseUrl}/idb-signin.html`);
      await page.waitForFunction(() => document.querySelector("p")?.textContent === "Stored the IndexedDB token");
      const idb = await saveLogin(context, { url: baseUrl, role: "idb", projectDir: project });
      check("the capture keeps IndexedDB", idb.summary.indexedDBs >= 1, JSON.stringify(idb.summary));
      writeProfile(project, "idb-legacy", await context.storageState());
    } finally {
      await recorder.close();
    }
    const spaProfile = fs.readFileSync(profilePath(project, "spa"), "utf8");
    check("the session token is in the saved profile", spaProfile.includes("member-token"));
    check("...which stays owner-only", process.platform === "win32" || (fs.statSync(profilePath(project, "spa")).mode & 0o777) === 0o600);

    const spa = track(new BrowserEngine());
    const spaOut = await spa.attach({ url: `${baseUrl}/session-account.html`, projectDir: project, mode: "read-only", role: "spa" });
    check("attach by a role saved with sessionStorage never prints the token", !spaOut.includes("member-token"), spaOut);
    const spaSnap = await settledText(spa, [SESSION_IN, SESSION_OUT]);
    check("a lane restored from the profile is signed in by its sessionStorage token", spaSnap.includes(SESSION_IN), spaSnap);
    await spa.navigate(`${baseUrl}/session-account.html`);
    check("...and stays signed in as it navigates", (await settledText(spa, [SESSION_IN, SESSION_OUT])).includes(SESSION_IN));
    // The token belongs to the origin it was saved from: a frame from another origin gets nothing.
    // White-box: the frames themselves, read through the engine's page.
    await spa.navigate(`${baseUrl}/session-frames.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
    const spaPage = (spa as unknown as { page: Page }).page;
    const frameHeading = async (origin: string): Promise<string> => {
      for (let i = 0; i < 40; i++) {
        const frame = spaPage.frames().find((f) => f.url().startsWith(`${origin}/session-account.html`));
        const heading = frame ? await frame.textContent("h1").catch(() => null) : null;
        if (heading === SESSION_IN || heading === SESSION_OUT) return heading;
        await new Promise((r) => setTimeout(r, 100));
      }
      return "(no answer)";
    };
    const sameFrame = await frameHeading(baseUrl);
    const foreignFrame = await frameHeading(foreignBaseUrl);
    check("a frame from the saved origin is signed in", sameFrame === SESSION_IN, sameFrame);
    check("...and a frame from another origin gets nothing from the profile", foreignFrame === SESSION_OUT, foreignFrame);
    // Signing out in the lane is the app's own write; the restore must not undo it on the next page.
    await spa.navigate(`${baseUrl}/session-signout.html`);
    await spa.navigate(`${baseUrl}/session-account.html`);
    const afterOut = await settledText(spa, [SESSION_IN, SESSION_OUT]);
    check("a lane that signs out stays signed out: the token is restored once per tab, not on every page", afterOut.includes(SESSION_OUT), afterOut);

    // The same, for an app that signs out by clearing all of sessionStorage, in a fresh lane.
    const clearing = track(new BrowserEngine());
    await clearing.attach({ url: `${baseUrl}/session-account.html`, projectDir: project, mode: "read-only", role: "spa" });
    const clearingIn = await settledText(clearing, [SESSION_IN, SESSION_OUT]);
    check("a second lane from the profile starts signed in", clearingIn.includes(SESSION_IN), clearingIn);
    await clearing.navigate(`${baseUrl}/session-signout.html?clear`);
    await clearing.navigate(`${baseUrl}/session-account.html`);
    const afterClear = await settledText(clearing, [SESSION_IN, SESSION_OUT]);
    check("a lane whose sign-out clears all of sessionStorage stays signed out", afterClear.includes(SESSION_OUT), afterClear);

    const legacy = track(new BrowserEngine());
    await legacy.attach({ url: `${baseUrl}/session-account.html`, projectDir: project, mode: "read-only", role: "spa-legacy" });
    const legacySnap = await settledText(legacy, [SESSION_IN, SESSION_OUT]);
    check("the contrast: a profile saved without sessionStorage restores a signed-out lane", legacySnap.includes(SESSION_OUT), legacySnap);

    // ---- IndexedDB: the same pair ---------------------------------------------
    const idbLane = track(new BrowserEngine());
    await idbLane.attach({ url: `${baseUrl}/idb-account.html`, projectDir: project, mode: "read-only", role: "idb" });
    const idbSnap = await settledText(idbLane, [IDB_IN, IDB_OUT]);
    check("a lane restored from a profile with IndexedDB is signed in by its IndexedDB token", idbSnap.includes(IDB_IN), idbSnap);
    const idbLegacy = track(new BrowserEngine());
    await idbLegacy.attach({ url: `${baseUrl}/idb-account.html`, projectDir: project, mode: "read-only", role: "idb-legacy" });
    const idbLegacySnap = await settledText(idbLegacy, [IDB_IN, IDB_OUT]);
    check("the contrast: a profile saved without IndexedDB restores a signed-out lane", idbLegacySnap.includes(IDB_OUT), idbLegacySnap);
  } finally {
    for (const engine of opened) await engine.close().catch(() => {});
    fs.rmSync(project, { recursive: true, force: true });
  }
}
