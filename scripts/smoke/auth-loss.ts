/**
 * Auth loss, driven through a real browser: detection, reporting, and the rule that a bounced route is not coverage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "auth loss";

export async function run({ baseUrl, projectDir }: SmokeContext): Promise<void> {
  // ---- Auth loss, driven through a real browser -------------------------
  // Everything below was previously only reachable by hand-writing outcome
  // strings into the store, which cannot pin the DETECTION half: the login
  // heuristic, the settle-before-reading-URL ordering, the warning lines, or
  // the streak. /gated.html redirects client-side AFTER hydration, so a
  // revert of the settle reorder fails these rather than passing quietly.
  console.log("auth loss: detection, reporting, and non-coverage");
  // The storage state sits inside the project: a storageStatePath outside it is refused (fenceStorageState).
  const authProject = fs.mkdtempSync(path.join(os.tmpdir(), "ft-authproj-"));
  const deadState = path.join(authProject, "expired-fixture.json");
  fs.writeFileSync(deadState, JSON.stringify({ cookies: [], origins: [] }));
  const engDead = new BrowserEngine();
  try {
    const attachOut = await engDead.attach({
      url: `${baseUrl}/gated.html`,
      projectDir: authProject,
      mode: "read-only",
      storageStatePath: deadState,
    });
    check("attach detects a storage state that did not sign in", attachOut.includes("AUTH FAILED"), attachOut);
    check("...and names the file to regenerate", attachOut.includes("expired-fixture.json"), attachOut);

    // Absolute URLs: this engine attached AT /gated.html, so its baseUrl
    // carries that path and a relative target would concatenate onto it.
    engDead.knownRoutes = ["/gated.html"];
    const nav1 = await engDead.navigate(`${baseUrl}/gated.html`);
    check("a post-hydration bounce is detected at all", nav1.includes("REDIRECTED"), nav1);
    check("...and is called out as a login page, not a plain redirect", nav1.includes("NOT counted as covered"), nav1);
    check(
      "a bounced route stays in the completion contract",
      engDead.unvisitedKnownRoutes().includes("/gated.html"),
      JSON.stringify(engDead.unvisitedKnownRoutes()),
    );

    const nav2 = await engDead.navigate(`${baseUrl}/gated.html`);
    check("two bounces is not yet a verdict", !nav2.includes("SESSION AUTH LOST"), nav2);
    const nav3 = await engDead.navigate(`${baseUrl}/gated.html`);
    check("three consecutive bounces raises SESSION AUTH LOST", nav3.includes("SESSION AUTH LOST"), nav3);

    // Asking for the login page ON PURPOSE is the anonymous auth-surface
    // pass, not a symptom — it must neither warn nor feed the streak.
    const navLogin = await engDead.navigate(`${baseUrl}/login`);
    check("navigating to /login deliberately is not a bounce", !navLogin.includes("REDIRECTED"), navLogin);

    // A guard that fires LATE. Nothing is in flight while it waits, so no
    // amount of waiting on requests reaches it: the page goes quiet, the URL
    // is read, and the gated route is recorded as reached. This is the same
    // bug gated.html pins, with the timing a loaded machine produces — and it
    // is why a bounce verdict watches the URL until it holds still instead of
    // reading it once.
    engDead.knownRoutes = ["/gated-slow.html"];
    const slow = await engDead.navigate(`${baseUrl}/gated-slow.html`);
    check("a guard that redirects long after the page goes quiet is still a bounce", slow.includes("REDIRECTED"), slow);
    check("...and the route it asked for is not counted as covered", slow.includes("NOT counted as covered"), slow);
  } finally {
    await engDead.close().catch(() => {});
  }
  try {
    await attachVerdictWaitsForLateSignIn(baseUrl, authProject, deadState);
  } finally {
    fs.rmSync(authProject, { recursive: true, force: true });
  }
}

/**
 * The attach's sign-in verdict on an app that sends a signed-out visitor to sign-in from its scripts after load. Read
 * before that redirect, a stale profile passed as signed in. Contrastive pair: the same page attached with a storage
 * state that signs in (the page stays put, and the attach is clean) and one that does not (AUTH FAILED).
 */
async function attachVerdictWaitsForLateSignIn(baseUrl: string, authProject: string, deadState: string): Promise<void> {
  console.log("auth loss: the attach's sign-in verdict waits for a redirect the app's scripts make after load");
  const liveState = path.join(authProject, "signed-in-fixture.json");
  fs.writeFileSync(
    liveState,
    JSON.stringify({ cookies: [], origins: [{ origin: new URL(baseUrl).origin, localStorage: [{ name: "smoke-auth", value: "yes" }] }] }),
  );
  const attachAt = async (page: string, state: string): Promise<{ out: string; ms: number }> => {
    const engine = new BrowserEngine();
    try {
      const started = Date.now();
      const out = await engine.attach({ url: `${baseUrl}/${page}`, projectDir: authProject, mode: "read-only", storageStatePath: state });
      return { out, ms: Date.now() - started };
    } finally {
      await engine.close().catch(() => {});
    }
  };
  const late = await attachAt("gated-late.html", deadState);
  check("a stale profile on a page that redirects to sign-in 600 ms after load is AUTH FAILED", late.out.includes("AUTH FAILED"), late.out);
  check("...and names the sign-in page it landed on", /attaching landed on http[^\s]*\/login\?redirectTo=/.test(late.out), late.out);
  const signedIn = await attachAt("gated-late.html", liveState);
  check("the same page with a profile that signs in attaches cleanly", !signedIn.out.includes("AUTH FAILED"), signedIn.out);
  console.log(`  (attach with a saved sign-in on a page that stays put: ${signedIn.ms} ms)`);
  const slowLogin = await attachAt("gated-slow-login.html", deadState);
  check(
    "a stale profile whose sign-in page answers slowly is AUTH FAILED: the verdict waits for the navigation on its way",
    slowLogin.out.includes("AUTH FAILED"),
    slowLogin.out,
  );
  const slowSignedIn = await attachAt("gated-slow-login.html", liveState);
  check("...and the same page signed in attaches cleanly", !slowSignedIn.out.includes("AUTH FAILED"), slowSignedIn.out);
}
