/**
 * The refresh broker through real browsers. The fixture's rotating sign-in
 * revokes a whole token family when a refresh token is presented twice, as an
 * identity provider with reuse detection does. Four sessions attach by one
 * role, so all four load the same refresh token; every access token is then
 * expired and all four pages refresh at once. With the broker, one refreshes
 * at a time with the token current at that moment, the family survives and
 * all four stay signed in. The contrast is the same four sessions with the
 * broker off: they present one token four times and the family is revoked.
 *
 * Token values are compared here, never printed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { profilePath, writeProfile } from "../../dist/engine/profiles.js";
import { lockPathFor, refreshTokenSlots } from "../../dist/engine/refresh.js";
import { captureState } from "../../dist/login-run.js";
import { BROWSER, check, expireFixtureAccess, isCurrentRefreshToken, refreshFamilies, type SmokeContext } from "./harness.ts";

export const title = "refresh broker";

const SIGNED_IN = "Signed in as a member";
const SIGNED_OUT = "You are signed out";
const LANES = 4;

/** Sign in through the fixture in a browser of its own and save the result as the role's profile. */
async function recordProfile(baseUrl: string, project: string): Promise<void> {
  const browser = await { chromium, firefox, webkit }[BROWSER].launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/rt-signin`);
    await page.waitForFunction((want) => document.querySelector("h1")?.textContent === want, SIGNED_IN, { timeout: 10000 });
    writeProfile(project, "member", await captureState(context));
  } finally {
    await browser.close();
  }
}

/** What a session's page settles on: signed in, signed out, or still checking after the wait. */
async function verdict(engine: BrowserEngine): Promise<"in" | "out" | "pending"> {
  for (let i = 0; i < 100; i++) {
    const text = await engine.snapshot(true);
    if (text.includes(SIGNED_IN)) return "in";
    if (text.includes(SIGNED_OUT)) return "out";
    await new Promise((r) => setTimeout(r, 100));
  }
  return "pending";
}

/** Attach LANES sessions by role, expire every access token, and load the app in all of them at once. */
async function fourLanes(baseUrl: string, project: string, refreshBroker: boolean, opened: BrowserEngine[]): Promise<Array<"in" | "out" | "pending">> {
  const lanes = Array.from({ length: LANES }, () => new BrowserEngine());
  opened.push(...lanes);
  for (const lane of lanes) await lane.attach({ url: `${baseUrl}/rt-app`, projectDir: project, mode: "read-only", role: "member", refreshBroker });
  const before = await Promise.all(lanes.map(verdict));
  check(
    `every lane starts signed in (broker ${refreshBroker ? "on" : "off"})`,
    before.every((v) => v === "in"),
    JSON.stringify(before),
  );
  expireFixtureAccess();
  await Promise.all(lanes.map((lane) => lane.navigate(`${baseUrl}/rt-app`)));
  return Promise.all(lanes.map(verdict));
}

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-refresh-"));
  const opened: BrowserEngine[] = [];
  try {
    // ---- Broker on: one family, four lanes, never revoked ------------------
    await recordProfile(baseUrl, project);
    // The sign-in's other half kept in sessionStorage, which the pages' storage state never holds: the write-back must keep it.
    const sessionHalf = [{ origin: new URL(baseUrl).origin, entries: [{ name: "id_token", value: "the-session-half" }] }];
    writeProfile(project, "member", { ...JSON.parse(fs.readFileSync(profilePath(project, "member"), "utf8")), sessionStorage: sessionHalf });
    const start = refreshFamilies();
    const brokered = await fourLanes(baseUrl, project, true, opened);
    const after = refreshFamilies();
    check("with the broker, no token family is revoked across four lanes", after.revoked === start.revoked, JSON.stringify({ start, after }));
    check(
      "...all four lanes stay signed in",
      brokered.every((v) => v === "in"),
      JSON.stringify(brokered),
    );
    check("...each lane refreshed once, in turn", after.rotations - start.rotations === LANES, JSON.stringify({ start, after }));
    const saved = JSON.parse(fs.readFileSync(profilePath(project, "member"), "utf8"));
    const slots = refreshTokenSlots(saved);
    check(
      "...the profile on disk holds the family's current refresh token",
      slots.length === 1 && isCurrentRefreshToken(slots[0].value),
      `${slots.length} slot(s)`,
    );
    check("...and no lock is left behind", !fs.existsSync(lockPathFor(profilePath(project, "member"))));
    check("...and it still holds the profile's sessionStorage", JSON.stringify(saved.sessionStorage) === JSON.stringify(sessionHalf));
    check("...and the profile is still owner-only", process.platform === "win32" || (fs.statSync(profilePath(project, "member")).mode & 0o077) === 0);
    const summaries = opened.map((e) => e.refreshSummary());
    check(
      "each lane can say it refreshed under the lock",
      summaries.every((s) => s.includes("under the role's lock")),
      JSON.stringify(summaries),
    );
    check(
      "...and three of them after another lane had rotated it",
      summaries.filter((s) => s.includes("after another session")).length === LANES - 1,
      JSON.stringify(summaries),
    );
    for (const engine of opened.splice(0)) await engine.close();

    // ---- The contrast: broker off, same four lanes -------------------------
    await recordProfile(baseUrl, project);
    const offStart = refreshFamilies();
    const unbrokered = await fourLanes(baseUrl, project, false, opened);
    const offAfter = refreshFamilies();
    check(
      "with the broker off, four lanes presenting one token get the family revoked",
      offAfter.revoked === offStart.revoked + 1,
      JSON.stringify({ offStart, offAfter }),
    );
    check(
      "...and lanes are signed out",
      unbrokered.some((v) => v === "out"),
      JSON.stringify(unbrokered),
    );
    check(
      "...and none says it brokered anything",
      opened.every((e) => e.refreshSummary() === ""),
    );
    for (const engine of opened.splice(0)) await engine.close();

    // ---- A login saved since that no longer holds the token's slot ---------
    // The role is signed in again as something the broker cannot map the
    // session's token onto (here a cookie sign-in, with no stored session).
    // The session's refresh goes out as is, and the new login is left alone.
    await recordProfile(baseUrl, project);
    const lone = new BrowserEngine();
    opened.push(lone);
    await lone.attach({ url: `${baseUrl}/rt-app`, projectDir: project, mode: "read-only", role: "member", refreshBroker: true });
    check("the lone lane starts signed in", (await verdict(lone)) === "in");
    const newLogin = {
      cookies: [
        { name: "fixture_session", value: "another-sign-in", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" },
      ],
      origins: [],
    };
    writeProfile(project, "member", newLogin);
    const savedLogin = fs.readFileSync(profilePath(project, "member"), "utf8");
    const loneStart = refreshFamilies();
    expireFixtureAccess();
    await lone.navigate(`${baseUrl}/rt-app`);
    check("a refresh whose slot is gone from the profile is still sent, and the lane stays signed in", (await verdict(lone)) === "in");
    check("...it did refresh", refreshFamilies().rotations === loneStart.rotations + 1, JSON.stringify({ loneStart, now: refreshFamilies() }));
    // Closing waits for any write-back still in flight, so what is on disk after it is final.
    await lone.close();
    check("...and the login saved since is not overwritten by the lane's state", fs.readFileSync(profilePath(project, "member"), "utf8") === savedLogin);
    check("...and no lock is left behind", !fs.existsSync(lockPathFor(profilePath(project, "member"))));
  } finally {
    for (const engine of opened) await engine.close().catch(() => {});
    fs.rmSync(project, { recursive: true, force: true });
  }
}
