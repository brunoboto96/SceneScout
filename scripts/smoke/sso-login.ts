/**
 * Signing in from the conversation: the window scout_login opens saves by
 * itself once the person is signed in, through a sign-in that goes to a
 * stand-in single sign-on provider on another origin and back.
 *
 * The person is played by this suite, acting in the window's own page. Each
 * stop on the way is a place the window must not save: the app's sign-in
 * page, the provider's form, and the app with no session yet while it
 * exchanges the code (held open by the fixture until the suite lets it go).
 * Only once the app holds its session is the profile saved and the window
 * closed. The contrast is a window closed on the provider, which saves
 * nothing.
 *
 * Headless: the window is the same browser and the same watch, only not shown.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { profilePath } from "../../dist/engine/profiles.js";
import { startLoginWindow, type PendingLogin } from "../../dist/login-run.js";
import { check, eventually, heldPageCount, releaseHeldPages, settle, SSO_PROVIDER_COOKIE, SSO_SESSION_COOKIE, until, type SmokeContext } from "./harness.ts";

export const title = "sign-in window (SSO)";

/** Looks the window takes at 500 ms each: long enough that a save would have happened if the rule allowed one. */
const NOT_SAVED_FOR_MS = 1500;

export async function run({ baseUrl, foreignBaseUrl }: SmokeContext): Promise<void> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-sso-login-"));
  const opened: PendingLogin[] = [];
  const engines: BrowserEngine[] = [];
  const startUrl = `${baseUrl}/sso/signin?provider=${encodeURIComponent(foreignBaseUrl)}`;
  const file = profilePath(project, "member");
  try {
    const pending = await startLoginWindow({ url: startUrl, role: "member", projectDir: project }, { headless: true });
    opened.push(pending);
    const page = pending.window.page;
    let settled: Awaited<PendingLogin["done"]> | undefined;
    void pending.done.then((r) => (settled = r));

    // ---- The app's sign-in page: a link to the provider, no field ---------------
    await until("the window reads the app's sign-in page", () => pending.progress().reason === "sign-in-screen");
    await settle(NOT_SAVED_FOR_MS);
    check("on the app's sign-in page, nothing is saved", !fs.existsSync(file) && settled === undefined, JSON.stringify(pending.progress()));

    // ---- The provider, on another origin ----------------------------------------
    await page.click('[data-testid="signin-provider-link"]');
    await until("the window reads the provider's page", () => pending.progress().reason === "away");
    await page.fill('[data-testid="provider-email-input"]', "member@example.test");
    await page.fill('[data-testid="provider-password-input"]', "any password");
    await settle(NOT_SAVED_FOR_MS);
    check("on the identity provider, nothing is saved", !fs.existsSync(file) && settled === undefined, JSON.stringify(pending.progress()));

    // ---- Back on the app, before it has a session ---------------------------------
    await page.click('[data-testid="provider-signin-submit"]');
    await until("the app's code exchange is held", () => heldPageCount() > 0);
    // Waited for as a check, not a crash: a window that saves here never reads "no-session", and that is the failure to name.
    await eventually(() => pending.progress().reason === "no-session" || settled !== undefined);
    check(
      "back on the app with no session yet, the window waits",
      pending.progress().reason === "no-session" && settled === undefined,
      JSON.stringify(settled ?? pending.progress()),
    );
    check("...on the app's own page, past the callback", new URL(pending.progress().url).pathname === "/sso/finishing", pending.progress().url);
    const providerCookie = (await pending.window.context.cookies()).find((c) => c.name === SSO_PROVIDER_COOKIE);
    check("the provider's own session cookie is in the browser", providerCookie !== undefined);
    await settle(NOT_SAVED_FOR_MS);
    check("back on the app with no session yet, nothing is saved", !fs.existsSync(file) && settled === undefined, JSON.stringify(pending.progress()));

    // ---- The app holds its session: saved, window closed ---------------------------
    releaseHeldPages();
    const outcome = await pending.done;
    check("once the app holds its session, the window saves", outcome.ok, JSON.stringify(outcome));
    if (outcome.ok) {
      check(
        "...naming the session it saw appear, by name only",
        outcome.detected.includes(`cookie "${SSO_SESSION_COOKIE}"`) && !outcome.detected.includes("=member"),
        outcome.detected,
      );
      check("...back on the app's signed-in page", outcome.detected.includes("/sso/home"), outcome.detected);
      check("...into the role's profile", outcome.saved.path === file, outcome.saved.path);
    }
    check("the window is closed once it has saved", !pending.window.browser.isConnected());
    const saved = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { cookies?: { name: string }[] }) : {};
    check(
      "the profile holds the app's session cookie",
      (saved.cookies ?? []).some((c) => c.name === SSO_SESSION_COOKIE),
      JSON.stringify(saved.cookies?.map((c) => c.name)),
    );

    // The saved sign-in works: a session attached by the role lands signed in.
    const engine = new BrowserEngine();
    engines.push(engine);
    await engine.attach({ url: `${baseUrl}/sso/home`, projectDir: project, mode: "read-only", role: "member" });
    const text = await engine.snapshot(true);
    check("a session attached by the role is signed in", text.includes("Signed in through the identity provider"), text.slice(0, 400));

    // ---- The contrast: the window closed on the provider saves nothing -------------
    const project2 = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-sso-login-"));
    try {
      const abandoned = await startLoginWindow({ url: startUrl, role: "member", projectDir: project2 }, { headless: true });
      opened.push(abandoned);
      await until("the second window reads the sign-in page", () => abandoned.progress().reason === "sign-in-screen");
      await abandoned.window.page.click('[data-testid="signin-provider-link"]');
      await until("the second window reads the provider's page", () => abandoned.progress().reason === "away");
      await abandoned.window.page.close();
      const closed = await abandoned.done;
      check("a window closed on the provider saves nothing", !closed.ok && !fs.existsSync(profilePath(project2, "member")), JSON.stringify(closed));
      check("...and says the window was closed", !closed.ok && /closed before the sign-in finished/.test(closed.error), JSON.stringify(closed));
    } finally {
      fs.rmSync(project2, { recursive: true, force: true });
    }

    // A window that is never finished closes on its own after its time, saving nothing.
    const project3 = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-sso-login-"));
    try {
      const timed = await startLoginWindow({ url: startUrl, role: "member", projectDir: project3 }, { headless: true, maxMs: 1500 });
      opened.push(timed);
      const out = await timed.done;
      check(
        "a window left open past its time closes and saves nothing",
        !out.ok && /did not finish in time/.test(out.error) && !fs.existsSync(profilePath(project3, "member")),
        JSON.stringify(out),
      );
      check("...and its browser is gone", await eventually(() => !timed.window.browser.isConnected()));
    } finally {
      fs.rmSync(project3, { recursive: true, force: true });
    }
  } finally {
    releaseHeldPages();
    await Promise.allSettled([...opened.map((p) => p.cancel()), ...engines.map((e) => e.close())]);
    fs.rmSync(project, { recursive: true, force: true });
  }
}
