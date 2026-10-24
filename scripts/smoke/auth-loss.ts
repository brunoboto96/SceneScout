/**
 * Auth loss, driven through a real browser: detection, reporting, and the rule that a bounced route is not coverage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { URL_NAVIGATING_CAP_MS } from "../../dist/engine/settle.js";
import { check, type ServerStats, type SmokeContext } from "./harness.ts";

export const title = "auth loss";

export async function run({ baseUrl, foreignBaseUrl, projectDir, stats }: SmokeContext): Promise<void> {
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
    await hashRoutedSignIn(baseUrl, authProject, deadState);
    await navigationToAFileIsNotWaitedFor(baseUrl, stats, authProject, deadState);
    await interruptedLoadIsWhereThePageWent(baseUrl, authProject, deadState);
    await signInOnAnotherOrigin(baseUrl, foreignBaseUrl, authProject, deadState);
  } finally {
    fs.rmSync(authProject, { recursive: true, force: true });
  }
}

/**
 * With a saved sign-in, a navigation's verdict waits for a navigation the page has on its way, up to
 * URL_NAVIGATING_CAP_MS. A page that moves itself to a file is answered with a download, which never commits; Firefox
 * keeps that request open until the whole file has arrived, and counted as on its way it held the navigation to that
 * cap. The file takes longer than the cap to send (SLOW_FILE_MS), and is still arriving when the navigation returns.
 */
async function navigationToAFileIsNotWaitedFor(baseUrl: string, stats: ServerStats, authProject: string, deadState: string): Promise<void> {
  console.log("auth loss: a page that moves itself to a file the browser downloads is not waited for as a navigation on its way");
  const engine = new BrowserEngine();
  try {
    await engine.attach({ url: `${baseUrl}/covered.html`, projectDir: authProject, mode: "read-only", storageStatePath: deadState });
    const started = Date.now();
    const out = await engine.navigate(`${baseUrl}/file-on-load.html`);
    const ms = Date.now() - started;
    const stillSending = stats.slowFilesOpen;
    console.log(`  (navigation to a page that moves itself to a file: ${ms} ms)`);
    check("a navigation whose page moves itself to a file returns before the cap for a navigation on its way", ms < URL_NAVIGATING_CAP_MS, `${ms} ms\n${out}`);
    check("...while that file was still arriving", stillSending > 0, `files still sending: ${stillSending}`);
  } finally {
    await engine.close().catch(() => {});
  }
}

/**
 * Firefox under load fails page.goto with "Navigation to … is interrupted by another navigation to …" when the page's
 * own redirect (redirects-at-once.html moves itself on as it loads) lands before the asked-for load finishes; the call
 * used to throw that. Where the page went is now reported, and judged: a redirect to sign-in is a bounce. The browser's
 * interruption is made certain here, on every browser, by failing the load as Firefox does once the page has committed
 * (the redirect is the page's own, and real). Contrastive pair: a load that really failed is still a failure.
 */
async function interruptedLoadIsWhereThePageWent(baseUrl: string, authProject: string, deadState: string): Promise<void> {
  console.log("auth loss: a load the page's own redirect interrupted reports where the page went, and a bounce is judged");
  const engine = new BrowserEngine();
  try {
    await engine.attach({ url: `${baseUrl}/covered.html`, projectDir: authProject, mode: "read-only", storageStatePath: deadState });
    const page = (engine as unknown as { page: Page }).page;
    const pageProto = Object.getPrototypeOf(page) as { goto: Page["goto"] };
    const real = pageProto.goto;
    let interrupted = 0;
    pageProto.goto = async function (this: Page, url: string, options?: Parameters<Page["goto"]>[1]) {
      const stale = url.includes("/page2.html?stale=1");
      if (!url.includes("/redirects-at-once.html") && !stale) return real.call(this, url, options);
      await real.call(this, url, { ...options, waitUntil: "commit" });
      interrupted += 1;
      // A stale interruption names a page the session loaded before this load began, as an earlier load committing late does.
      const to = stale ? "/covered.html" : (new URL(url).searchParams.get("to") ?? "/page2.html");
      throw new Error(`page.goto: Navigation to "${url}" is interrupted by another navigation to "${new URL(to, url).href}"`);
    };
    try {
      const outcome = async (target: string): Promise<string> => {
        try {
          return await engine.navigate(target);
        } catch (err) {
          return `THREW ${err instanceof Error ? err.message : String(err)}`;
        }
      };
      const toLogin = await outcome(`${baseUrl}/redirects-at-once.html?to=/login`);
      check(
        "a load the page's redirect to sign-in interrupted is a bounce to sign-in, not a failed call",
        interrupted === 1 && toLogin.includes("REDIRECTED") && toLogin.includes("NOT counted as covered"),
        `interrupted ${interrupted}\n${toLogin}`,
      );
      const toPage = await outcome(`${baseUrl}/redirects-at-once.html`);
      check(
        "...and one its redirect to another page interrupted reports that page as where it landed",
        interrupted === 2 && /landed on \/page2\.html/.test(toPage) && !toPage.includes("NOT counted as covered") && !toPage.startsWith("THREW"),
        `interrupted ${interrupted}\n${toPage}`,
      );
      const stale = await outcome(`${baseUrl}/page2.html?stale=1`);
      check(
        "a load interrupted by an earlier navigation committing late is still the load's failure, not a redirect to it",
        interrupted === 3 && stale.startsWith("THREW") && stale.includes("interrupted by another navigation") && !stale.includes("REDIRECTED"),
        `interrupted ${interrupted}\n${stale}`,
      );
      const crawled = await engine.crawl(["/redirects-at-once.html"]);
      check(
        "a crawled route whose own redirect interrupted its load is read where it landed, not a failed load",
        interrupted === 4 && !crawled.includes("LOAD FAILED") && /\/redirects-at-once\.html — moved on by the page/.test(crawled),
        `interrupted ${interrupted}\n${crawled}`,
      );
      const dropped = await outcome(`${baseUrl}/drop-connection`);
      check(
        "a load that really failed is still reported as a failure (the contrast)",
        dropped.startsWith("THREW") && !dropped.includes("moved itself on"),
        dropped,
      );
    } finally {
      pageProto.goto = real;
    }
  } finally {
    await engine.close().catch(() => {});
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
  // Every round, not only the first: a round whose redirect has not landed by the time the scroll returns is lost to
  // the next round's navigation, which cancels it, and the verdict then comes a round late.
  check(
    "each scroll during which the page went to sign-in reports it as the page going on its own",
    stale.every((o) => o.includes("SIGNED OUT AFTER LOAD") && o.includes("while this call ran")),
    stale.join("\n---\n"),
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
    // Signed out on purpose, the gated pages it then cannot reach are the sign-out's doing: each is still not covered,
    // but none counts toward SESSION AUTH LOST, however many there are. (The verdict on the same three bounces without
    // a sign-out is the first check of this suite.)
    const navs: string[] = [];
    for (let i = 0; i < 4; i++) navs.push(await engine.navigate(`${baseUrl}/gated.html`));
    check(
      "the gated pages after the sign-out are each reported as not covered",
      navs.every((n) => n.includes("NOT counted as covered")),
      navs.join("\n---\n"),
    );
    check(
      "...and say the session signed out on purpose",
      navs.every((n) => n.includes("signed out on purpose")),
      navs.join("\n---\n"),
    );
    check(
      "...and none of them, the third included, is SESSION AUTH LOST",
      navs.every((n) => !n.includes("AUTH LOST")),
      navs.join("\n---\n"),
    );
  } finally {
    await engine.close().catch(() => {});
  }
  await signInRanOutOnClick(baseUrl, authProject, liveState);
}

/**
 * The contrast to signOutOnPurpose: a click that lands on the sign-in page because the app answered its request 401
 * (expired-click.html) is a sign-in that ran out, not a sign-out. The click is still only told, but the gated pages
 * after it count as before, and the third is the verdict.
 */
async function signInRanOutOnClick(baseUrl: string, authProject: string, liveState: string): Promise<void> {
  console.log("auth loss: a click sent to sign-in after a 401 is a sign-in that ran out, not a sign-out");
  const engine = new BrowserEngine();
  try {
    await engine.attach({ url: `${baseUrl}/expired-click.html`, projectDir: authProject, mode: "read-only", storageStatePath: liveState });
    const snap = await engine.snapshot();
    const ref = /(e\d+) button "Load reports"/.exec(snap)?.[1];
    check("the reports page offers its button", ref !== undefined, snap);
    if (!ref) return;
    const out = await engine.click(ref);
    check("the click is told it went to the sign-in page", /went from \/expired-click\.html to the sign-in page \/login/.test(out), out);
    check(
      "...and that the sign-in may have run out, not that the session signed out",
      out.includes("may have run out") && !out.includes("Until the session signs in again"),
      out,
    );
    const navs: string[] = [];
    for (let i = 0; i < 3; i++) navs.push(await engine.navigate(`${baseUrl}/gated.html`));
    check(
      "the gated pages after it are not taken for a sign-out",
      navs.every((n) => !n.includes("signed out on purpose")),
      navs.join("\n---\n"),
    );
    check("...and the third is SESSION AUTH LOST", !navs[1].includes("AUTH LOST") && navs[2].includes("SESSION AUTH LOST"), navs.join("\n---\n"));
  } finally {
    await engine.close().catch(() => {});
  }
}

/**
 * A hash-routed app (hash-app.html) keeps its routes in the fragment, so its guard sends a signed-out visitor to
 * /hash-app.html#/login: the path does not change, and only the fragment says this is a sign-in page. Contrastive pairs:
 * the same route with a sign-in that works stays put, and a guard that sends the visitor to #/loginhelp (a route that
 * only starts like a sign-in route) is an ordinary redirect. Both the navigation's own check and a later call's are held.
 */
async function hashRoutedSignIn(baseUrl: string, authProject: string, deadState: string): Promise<void> {
  console.log("auth loss: a hash-routed app's sign-in route (#/login) is a sign-in page");
  const liveState = path.join(authProject, "signed-in-fixture.json");
  const withEngine = async <T>(state: string, run: (engine: BrowserEngine) => Promise<T>): Promise<T> => {
    const engine = new BrowserEngine();
    try {
      await engine.attach({ url: `${baseUrl}/covered.html`, projectDir: authProject, mode: "read-only", storageStatePath: state });
      return await run(engine);
    } finally {
      await engine.close().catch(() => {});
    }
  };
  const stale = await withEngine(deadState, (engine) => engine.navigate(`${baseUrl}/hash-app.html#/reports`));
  check("a navigation to a hash route that the guard sends to #/login is a bounce", stale.includes("NOT counted as covered"), stale);
  const fresh = await withEngine(liveState, (engine) => engine.navigate(`${baseUrl}/hash-app.html#/reports`));
  check("...while the same route signed in stays put", !/REDIRECTED|NOT counted/.test(fresh), fresh);
  const nearMiss = await withEngine(deadState, (engine) => engine.navigate(`${baseUrl}/hash-app.html?to=loginhelp#/reports`));
  check(
    "...and a guard that sends it to #/loginhelp is an ordinary redirect, not a sign-in page",
    nearMiss.includes("REDIRECTED") && !nearMiss.includes("NOT counted as covered"),
    nearMiss,
  );
  const thrice = await withEngine(deadState, async (engine) => {
    const out: string[] = [];
    for (let i = 0; i < 3; i++) out.push(await engine.navigate(`${baseUrl}/hash-app.html#/reports`));
    return out;
  });
  check("three hash-route bounces in a row raise SESSION AUTH LOST", thrice[2].includes("SESSION AUTH LOST"), thrice.join("\n---\n"));
  const later = async (state: string): Promise<{ nav: string; snap: string }> =>
    withEngine(state, async (engine) => {
      const nav = await engine.navigate(`${baseUrl}/hash-app.html?late=1#/reports`);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return { nav, snap: await engine.snapshot(true) };
    });
  const lateStale = await later(deadState);
  check("a hash-route guard that fires after the navigation returns is not seen by the navigation", !lateStale.nav.includes("REDIRECTED"), lateStale.nav);
  check(
    "...and the next call reports it, naming the sign-in route in the fragment",
    lateStale.snap.includes("SIGNED OUT AFTER LOAD") && lateStale.snap.includes("/hash-app.html#/login"),
    lateStale.snap,
  );
  const lateFresh = await later(liveState);
  check("...while signed in, the next call says nothing of sign-in", !/SIGNED OUT|REDIRECTED/.test(lateFresh.snap), lateFresh.snap);
}

/**
 * An app that signs in through a single sign-on provider on another origin (sso-gated.html, the provider being the
 * harness's second origin) sends a signed-out visitor to the provider's authorize endpoint 1.5 s after load. The next
 * call sees the page has gone to a sign-in page on another origin. Contrastive pairs: the same page sending the visitor
 * to an ordinary page of that other site is not a sign-in, and the same page signed in stays put.
 */
async function signInOnAnotherOrigin(baseUrl: string, foreignBaseUrl: string, authProject: string, deadState: string): Promise<void> {
  console.log("auth loss: a page that goes to a sign-in provider on another origin is a bounce");
  const liveState = path.join(authProject, "signed-in-fixture.json");
  const visit = async (state: string, to: string): Promise<{ nav: string; snap: string; unvisited: string[] }> => {
    const engine = new BrowserEngine();
    try {
      await engine.attach({ url: `${baseUrl}/covered.html`, projectDir: authProject, mode: "read-only", storageStatePath: state });
      engine.knownRoutes = ["/sso-gated.html"];
      const nav = await engine.navigate(`${baseUrl}/sso-gated.html?idp=${encodeURIComponent(foreignBaseUrl)}&to=${encodeURIComponent(to)}`);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const snap = await engine.snapshot(true);
      return { nav, snap, unvisited: engine.unvisitedKnownRoutes() };
    } finally {
      await engine.close().catch(() => {});
    }
  };
  const authorize = "/sso-provider/authorize?client_id=smoke-app&state=smoke-state-value&return=x";
  const stale = await visit(deadState, authorize);
  check("the navigation returns before the page leaves for the provider", !stale.nav.includes("REDIRECTED"), stale.nav);
  check(
    "the next call reports the page went to the provider's sign-in on its own, naming its origin and path",
    stale.snap.includes("SIGNED OUT AFTER LOAD") && stale.snap.includes(`${foreignBaseUrl}/sso-provider/authorize`),
    stale.snap,
  );
  const notice = stale.snap.split("\n").find((l) => l.includes("SIGNED OUT AFTER LOAD")) ?? "";
  check("...without the provider's query in the notice (it carries the sign-in's state)", notice !== "" && !notice.includes("smoke-state-value"), stale.snap);
  check("...and the route it was on is not covered", stale.unvisited.includes("/sso-gated.html"), JSON.stringify(stale.unvisited));
  const ordinary = await visit(deadState, "/covered.html");
  check(
    "the same page going to an ordinary page of another site is not a sign-in, and nothing is said",
    !/SIGNED OUT|NOT counted|AUTH LOST/.test(ordinary.snap),
    ordinary.snap,
  );
  const noRequest = await visit(deadState, "/sso-provider/authorize?state=smoke-state-value&return=x");
  check(
    "...nor is the same endpoint of another site asked no sign-in (a payment step's /authorize)",
    !/SIGNED OUT|NOT counted|AUTH LOST/.test(noRequest.snap),
    noRequest.snap,
  );
  const fresh = await visit(liveState, authorize);
  check("...and signed in, the page stays and nothing is said", !/SIGNED OUT|NOT counted|AUTH LOST/.test(fresh.snap), fresh.snap);

  // The same provider reached at once (?soon=1), inside what the navigation watches: the origin fence takes the page
  // back to the app, and the navigation is judged by where it went, not the app page it was taken back to.
  // A project of its own: the visits above, in the same project and role, already count /sso-gated.html as covered.
  const navigations = async (state: string, to: string): Promise<{ navs: string[]; unvisited: string[] }> => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "ft-authsso-"));
    const engine = new BrowserEngine();
    try {
      const copy = path.join(project, path.basename(state));
      fs.copyFileSync(state, copy);
      await engine.attach({ url: `${baseUrl}/covered.html`, projectDir: project, mode: "read-only", storageStatePath: copy });
      engine.knownRoutes = ["/sso-gated.html"];
      const navs: string[] = [];
      for (let i = 0; i < 3; i++) {
        navs.push(await engine.navigate(`${baseUrl}/sso-gated.html?soon=1&idp=${encodeURIComponent(foreignBaseUrl)}&to=${encodeURIComponent(to)}`));
      }
      return { navs, unvisited: engine.unvisitedKnownRoutes() };
    } finally {
      await engine.close().catch(() => {});
      fs.rmSync(project, { recursive: true, force: true });
    }
  };
  const soon = await navigations(deadState, authorize);
  check(
    "a navigation the app sends straight to the provider's sign-in is a bounce, though the fence took the page back",
    soon.navs.every((n) => n.includes("NOT counted as covered")),
    soon.navs.join("\n---\n"),
  );
  check("...the third in a row raises SESSION AUTH LOST", soon.navs[2].includes("SESSION AUTH LOST"), soon.navs[2]);
  check("...and the route is not covered", soon.unvisited.includes("/sso-gated.html"), JSON.stringify(soon.unvisited));
  const soonOrdinary = await navigations(deadState, "/covered.html");
  check(
    "the same navigation sent straight to an ordinary page of another site is no bounce",
    soonOrdinary.navs.every((n) => !/NOT counted|AUTH LOST/.test(n)),
    soonOrdinary.navs.join("\n---\n"),
  );
  const soonFresh = await navigations(liveState, authorize);
  check(
    "...and signed in, the navigation reaches the page",
    soonFresh.navs.every((n) => !/REDIRECTED|NOT counted/.test(n)),
    soonFresh.navs.join("\n---\n"),
  );
}
