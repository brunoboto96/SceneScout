/**
 * Re-attaching a role session once when its sign-in is lost, through a real
 * browser. The fixture's revocable sign-in ends every session on demand, as a
 * server does; a fresh login is then saved over the role's profile, as another
 * process refreshing it would. The role session recovers from that profile once
 * and carries on; a second revoke is reported. The contrast is a session
 * attached with the same file as a plain storage state, which reports the loss
 * as it always has.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { profilePath, writeProfile } from "../../dist/engine/profiles.js";
import { captureState } from "../../dist/login-run.js";
import { BROWSER, check, revokeFixtureTokens, type SmokeContext } from "./harness.ts";

export const title = "re-attach on auth lost";

const SIGNED_IN = "Signed in as a member";

/** Sign in through the fixture in a browser of its own and save the result as the role's profile. */
async function recordProfile(baseUrl: string, project: string): Promise<void> {
  const browser = await { chromium, firefox, webkit }[BROWSER].launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/token-signin`);
    check("the fixture's revocable sign-in lands signed in", (await page.textContent("h1")) === SIGNED_IN, await page.content());
    writeProfile(project, "member", await captureState(context));
  } finally {
    await browser.close();
  }
}

/** Navigate to three guarded routes in turn; returns the third navigation's result. */
async function threeGuarded(engine: BrowserEngine, baseUrl: string): Promise<string[]> {
  const out: string[] = [];
  for (const route of ["/token-orders", "/token-settings", "/token-profile"]) out.push(await engine.navigate(`${baseUrl}${route}`));
  return out;
}

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-reattach-"));
  const opened: BrowserEngine[] = [];
  const track = (engine: BrowserEngine): BrowserEngine => {
    opened.push(engine);
    return engine;
  };
  try {
    await recordProfile(baseUrl, project);
    const role = track(new BrowserEngine());
    const file = track(new BrowserEngine());
    await role.attach({ url: `${baseUrl}/token-home`, projectDir: project, mode: "read-only", role: "member" });
    // Same saved file, attached as a plain storage state: not a role session.
    await file.attach({ url: `${baseUrl}/token-home`, projectDir: project, mode: "read-only", storageStatePath: profilePath(project, "member") });
    check("the role session starts signed in", (await role.snapshot(true)).includes(SIGNED_IN));
    check("the file session starts signed in", (await file.snapshot(true)).includes(SIGNED_IN));

    // ---- The server ends every session; a fresh login replaces the profile --
    check("the fixture revokes the live session both share", revokeFixtureTokens() === 1);
    await recordProfile(baseUrl, project);

    const [r1, r2, r3] = await threeGuarded(role, baseUrl);
    check("the first bounces are reported as before", r1.includes("REDIRECTED") && r2.includes("REDIRECTED") && !r2.includes("RE-ATTACHED"), r2);
    check("at the verdict the role session re-attaches from its latest profile", r3.includes("SESSION RE-ATTACHED") && r3.includes("role 'member'"), r3);
    check("...and is not reported dead", !r3.includes("SESSION AUTH LOST"), r3);
    check("...and names the routes the loss bounced as still to visit", r3.includes("/token-orders") && r3.includes("/token-settings"), r3);
    check("it is back on the page it asked for", role.currentUrl.endsWith("/token-profile"), role.currentUrl);
    check("...signed in", (await role.snapshot(true)).includes(SIGNED_IN));
    const onward = await role.navigate(`${baseUrl}/token-orders`);
    check("and it carries on signed in", !onward.includes("REDIRECTED") && (await role.snapshot(true)).includes(SIGNED_IN), onward);
    check("the session can say what its re-attach did", role.reattachSummary().includes("re-attached once"), role.reattachSummary());

    // ---- The contrast: the same file, attached without a role ------------
    const [, , f3] = await threeGuarded(file, baseUrl);
    check("a session not attached by role reports the loss as before", f3.includes("SESSION AUTH LOST"), f3);
    check("...and does not re-attach, although its file was refreshed", !f3.includes("RE-ATTACHED") && file.reattachSummary() === "", f3);

    // ---- A second loss is reported, not retried ----------------------------
    revokeFixtureTokens();
    await recordProfile(baseUrl, project);
    const [, , again] = await threeGuarded(role, baseUrl);
    check("a second loss of the same session is reported", again.includes("SESSION AUTH LOST"), again);
    check("...not re-attached, and says why", !again.includes("SESSION RE-ATTACHED") && again.includes("already re-attached once"), again);

    // ---- A sweep re-attaches and visits the bounced routes again -----------
    const sweeper = track(new BrowserEngine());
    await sweeper.attach({ url: `${baseUrl}/token-home`, projectDir: project, mode: "read-only", role: "member" });
    revokeFixtureTokens();
    await recordProfile(baseUrl, project);
    const crawl = await sweeper.crawl(["/token-orders", "/token-settings", "/token-profile", "/token-home"]);
    check("a crawl that loses the sign-in re-attaches once", crawl.includes("SESSION RE-ATTACHED"), crawl);
    check("...and does not end with the loss verdict", !crawl.includes("SESSION AUTH LOST"), crawl);
    const health = sweeper.lastCrawlHealth;
    check(
      "the bounced routes were visited again signed in, and only the signed-in visits are kept",
      health.every((h) => !h.loginRedirect) &&
        ["/token-orders", "/token-settings", "/token-profile", "/token-home"].every((p) => health.some((h) => h.path === p)),
      JSON.stringify(health.map((h) => [h.path, h.loginRedirect])),
    );
  } finally {
    for (const engine of opened) await engine.close().catch(() => {});
    fs.rmSync(project, { recursive: true, force: true });
  }
}
