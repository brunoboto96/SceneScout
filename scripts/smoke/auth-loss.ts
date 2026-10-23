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
  await crawlWaitsForLateSignIn(baseUrl, authProject, deadState, liveState);
}

/**
 * The crawl's per-route sign-in check on a route whose scripts send a signed-out visitor to sign-in 600 ms after load:
 * later than a crawl reads a route it does not watch, and inside the watch on the address, which holds the route until
 * its address has held still for a second since its document arrived (settle.ts CRAWL_URL_HELD_MS), whatever the
 * runner's timing.
 * Contrastive pair: the same route crawled with a saved sign-in that has gone stale (AUTH-REDIRECT) and one that signs
 * in (a healthy route), beside a route that never redirects.
 */
async function crawlWaitsForLateSignIn(baseUrl: string, authProject: string, deadState: string, liveState: string): Promise<void> {
  console.log("auth loss: the crawl's sign-in check waits for a redirect the app's scripts make after load");
  const crawlWith = async (state: string): Promise<string> => {
    const engine = new BrowserEngine();
    try {
      await engine.attach({ url: `${baseUrl}/covered.html`, projectDir: authProject, mode: "read-only", storageStatePath: state });
      return await engine.crawl(["/gated-soon.html", "/covered.html"]);
    } finally {
      await engine.close().catch(() => {});
    }
  };
  const line = (out: string, page: string): string => out.split("\n").find((l) => l.startsWith(`/${page} — `)) ?? "";
  const stale = await crawlWith(deadState);
  check(
    "a crawled route that redirects to sign-in 600 ms after load is AUTH-REDIRECT with a stale sign-in",
    /AUTH-REDIRECT/.test(line(stale, "gated-soon.html")),
    stale,
  );
  check("...while a route that stays put is not", line(stale, "covered.html") !== "" && !/AUTH-REDIRECT/.test(line(stale, "covered.html")), stale);
  const fresh = await crawlWith(liveState);
  check(
    "the same route crawled with a sign-in that works is a healthy page",
    line(fresh, "gated-soon.html") !== "" && !/AUTH-REDIRECT|REDIRECTED/.test(line(fresh, "gated-soon.html")),
    fresh,
  );
  await laterCallsSeeLateSignIn(baseUrl, authProject, deadState, liveState);
}

/**
 * A redirect to sign-in that the app's scripts make 1.5 s after load: later than a navigation watches its address, so
 * the navigation reports the route as reached, and only a later call can see the page has gone. With a saved sign-in,
 * each call compares the address with the one the last call ended on (authloss.ts lateSignInBounce).
 * Contrastive pair: the same page visited with a stale saved sign-in (each later call reports the bounce, the route is
 * not covered, and the third raises SESSION AUTH LOST) and with one that signs in (the page stays, nothing is said).
 */
async function laterCallsSeeLateSignIn(baseUrl: string, authProject: string, deadState: string, liveState: string): Promise<void> {
  console.log("auth loss: a redirect to sign-in after the navigation has returned is reported by the next call");
  const visit = async (state: string, rounds: number): Promise<{ navs: string[]; laters: string[]; unvisited: string[] }> => {
    const engine = new BrowserEngine();
    try {
      await engine.attach({ url: `${baseUrl}/covered.html`, projectDir: authProject, mode: "read-only", storageStatePath: state });
      engine.knownRoutes = ["/gated-later.html"];
      const navs: string[] = [];
      const laters: string[] = [];
      for (let i = 0; i < rounds; i++) {
        navs.push(await engine.navigate(`${baseUrl}/gated-later.html`));
        await new Promise((resolve) => setTimeout(resolve, 2500));
        // An action and a snapshot both look: the second round scrolls, the others read the page.
        laters.push(i === 1 ? await engine.scroll("bottom") : await engine.snapshot(true));
      }
      return { navs, laters, unvisited: engine.unvisitedKnownRoutes() };
    } finally {
      await engine.close().catch(() => {});
    }
  };
  const stale = await visit(deadState, 3);
  check(
    "the navigation returns before the page's late redirect (so only a later call can see it)",
    stale.navs.every((n) => !n.includes("REDIRECTED")),
    stale.navs.join("\n---\n"),
  );
  check(
    "a snapshot after the page went to sign-in on its own reports the bounce and the route as not covered",
    stale.laters[0].includes("SIGNED OUT AFTER LOAD") && stale.laters[0].includes("NOT counted as covered"),
    stale.laters[0],
  );
  check("...and so does an action (a scroll)", stale.laters[1].includes("SIGNED OUT AFTER LOAD"), stale.laters[1]);
  check("...the third such bounce in a row raises SESSION AUTH LOST", stale.laters[2].includes("SESSION AUTH LOST"), stale.laters[2]);
  check("...and the route stays in the completion contract", stale.unvisited.includes("/gated-later.html"), JSON.stringify(stale.unvisited));
  const fresh = await visit(liveState, 1);
  check(
    "the same page with a sign-in that works stays put, and the snapshot says nothing of sign-in",
    !/SIGNED OUT AFTER LOAD|REDIRECTED|AUTH LOST/.test(fresh.laters[0]),
    fresh.laters[0],
  );
  check("...and the route counts as covered", !fresh.unvisited.includes("/gated-later.html"), JSON.stringify(fresh.unvisited));
  await readWhileSignInLands(baseUrl, authProject, deadState, liveState);
  await signOutOnPurpose(baseUrl, authProject, liveState);
}

/**
 * A redirect to sign-in that lands while a call that only reads the page runs (gated-on-scroll.html sends a signed-out
 * visitor to sign-in on the first scroll). The scroll did not send the page there, so it is the page going on its own:
 * counted in place of the navigation that reached it, so three rounds of a navigation and a scroll reach SESSION AUTH
 * LOST. Contrastive pair: the same rounds signed in say nothing.
 */
async function readWhileSignInLands(baseUrl: string, authProject: string, deadState: string, liveState: string): Promise<void> {
  console.log("auth loss: a redirect to sign-in that lands while a scroll runs is the page going on its own");
  const rounds = async (state: string): Promise<string[]> => {
    const engine = new BrowserEngine();
    try {
      await engine.attach({ url: `${baseUrl}/covered.html`, projectDir: authProject, mode: "read-only", storageStatePath: state });
      const out: string[] = [];
      for (let i = 0; i < 3; i++) {
        await engine.navigate(`${baseUrl}/gated-on-scroll.html`);
        out.push(await engine.scroll("bottom"));
      }
      return out;
    } finally {
      await engine.close().catch(() => {});
    }
  };
  const stale = await rounds(deadState);
  check(
    "a scroll during which the page went to sign-in reports it as the page going on its own",
    stale[0].includes("SIGNED OUT AFTER LOAD") && stale[0].includes("while this call ran"),
    stale[0],
  );
  check("...and the third round in a row raises SESSION AUTH LOST", stale[2].includes("SESSION AUTH LOST"), stale[2]);
  const fresh = await rounds(liveState);
  check(
    "the same rounds signed in say nothing of sign-in",
    fresh.every((o) => !/SIGNED OUT|AUTH LOST|sign-in page/.test(o)),
    fresh.join("\n---\n"),
  );
}

/**
 * A tester who clicks "Sign out" lands on the sign-in page on purpose. The click is told where it went, but it is not
 * a lost sign-in: not counted toward SESSION AUTH LOST, and the page it left is not marked. Contrast: the gated pages
 * the session then cannot reach are bounces, and only three of those are the verdict.
 */
async function signOutOnPurpose(baseUrl: string, authProject: string, liveState: string): Promise<void> {
  console.log("auth loss: a click on Sign out is said, not counted as a lost sign-in");
  const engine = new BrowserEngine();
  try {
    await engine.attach({ url: `${baseUrl}/signout-link.html`, projectDir: authProject, mode: "read-only", storageStatePath: liveState });
    const snap = await engine.snapshot();
    const ref = /(e\d+) link "Sign out"/.exec(snap)?.[1];
    check("the account page offers its sign-out link", ref !== undefined, snap);
    if (!ref) return;
    const out = await engine.click(ref);
    check("the click is told it went to the sign-in page", /went from \/signout-link\.html to the sign-in page \/login/.test(out), out);
    check("...and it is not reported as a lost sign-in", !/SIGNED OUT|NOT counted as covered|AUTH LOST/.test(out), out);
    const nav1 = await engine.navigate(`${baseUrl}/gated.html`);
    const nav2 = await engine.navigate(`${baseUrl}/gated.html`);
    check("two bounces after the sign-out are not yet the verdict", !nav1.includes("AUTH LOST") && !nav2.includes("AUTH LOST"), nav2);
    const nav3 = await engine.navigate(`${baseUrl}/gated.html`);
    check("...and the third is", nav3.includes("SESSION AUTH LOST"), nav3);
  } finally {
    await engine.close().catch(() => {});
  }
}
