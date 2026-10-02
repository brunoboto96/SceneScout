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
import { BROWSER, check, eventually, expireFixtureAccess, isCurrentRefreshToken, refreshFamilies, WAIT_MS, type SmokeContext } from "./harness.ts";

export const title = "refresh broker";

const SIGNED_IN = "Signed in as a member";
const SIGNED_OUT = "You are signed out";
const LANES = 4;

/** Sign in through the fixture in a browser of its own and save the result as the role's profile. */
async function recordProfile(baseUrl: string, project: string, opts: { idb?: boolean } = {}): Promise<void> {
  const browser = await { chromium, firefox, webkit }[BROWSER].launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/rt-signin${opts.idb ? "?idb=1" : ""}`);
    await page.waitForFunction((want) => document.querySelector("h1")?.textContent === want, SIGNED_IN, { timeout: WAIT_MS });
    writeProfile(project, "member", await captureState(context));
  } finally {
    await browser.close();
  }
}

/** What a session's page settles on: signed in, signed out, or still checking after the wait. */
async function verdict(engine: BrowserEngine): Promise<"in" | "out" | "pending"> {
  let seen: "in" | "out" | "pending" = "pending";
  // Spaced out, since each look is a snapshot, and several sessions look at once. Twice the usual bound for that.
  await eventually(
    async () => {
      const text = await engine.snapshot(true);
      seen = text.includes(SIGNED_IN) ? "in" : text.includes(SIGNED_OUT) ? "out" : "pending";
      return seen !== "pending";
    },
    2 * WAIT_MS,
    100,
  );
  return seen;
}

/** The IndexedDB marker the rotating sign-in keeps with idb=1, as it stands in a saved profile. */
function holdsIdbMarker(profile: { origins?: Array<{ indexedDB?: unknown }> }): boolean {
  return (profile.origins ?? []).some((o) => JSON.stringify(o.indexedDB ?? []).includes("rt-idb-marker"));
}

/**
 * Attach LANES sessions by role, expire every access token, and load the app
 * in all of them at once. Each lane's verdict comes back with what its action
 * results said: the load's, and one more load's after it has settled, since a
 * write-back can finish after the action that started it.
 */
async function fourLanes(
  baseUrl: string,
  project: string,
  refreshBroker: boolean,
  opened: BrowserEngine[],
): Promise<{ verdicts: Array<"in" | "out" | "pending">; results: string[] }> {
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
  const loads = await Promise.all(lanes.map((lane) => lane.navigate(`${baseUrl}/rt-app`)));
  const verdicts = await Promise.all(lanes.map(verdict));
  const again = await Promise.all(lanes.map((lane) => lane.navigate(`${baseUrl}/rt-app`)));
  return { verdicts, results: loads.map((r, i) => r + again[i]) };
}

export async function run({ baseUrl, foreignBaseUrl }: SmokeContext): Promise<void> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-refresh-"));
  const opened: BrowserEngine[] = [];
  try {
    // ---- Broker on: one family, four lanes, never revoked ------------------
    await recordProfile(baseUrl, project, { idb: true });
    check("the recorded profile holds the sign-in's IndexedDB marker", holdsIdbMarker(JSON.parse(fs.readFileSync(profilePath(project, "member"), "utf8"))));
    // The sign-in's other half kept in sessionStorage, which the pages' storage state never holds: the write-back must keep it.
    const sessionHalf = [{ origin: new URL(baseUrl).origin, entries: [{ name: "id_token", value: "the-session-half" }] }];
    writeProfile(project, "member", { ...JSON.parse(fs.readFileSync(profilePath(project, "member"), "utf8")), sessionStorage: sessionHalf });
    const start = refreshFamilies();
    const { verdicts: brokered, results } = await fourLanes(baseUrl, project, true, opened);
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
    check("...and its IndexedDB, which a plain storage state leaves out", holdsIdbMarker(saved));
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
    // What each lane's own action results said, which is where a lane looks when it meets a 401.
    check(
      "one lane's action result says it refreshed under the lock",
      results.filter((r) => r.includes("↻ token refreshed under the role's lock")).length === 1,
      JSON.stringify(results.map((r) => r.split("\n").filter((l) => l.includes("↻") || l.includes("refresh")))),
    );
    check(
      "...and three say another session had rotated the token",
      results.filter((r) => r.includes("↻ another session had rotated the role's token")).length === LANES - 1,
      JSON.stringify(results.map((r) => r.split("\n").filter((l) => l.includes("↻") || l.includes("refresh")))),
    );
    check(
      "...and none names a token",
      results.every((r) => !refreshTokenSlots(saved).some((t) => r.includes(t.value))),
    );
    for (const engine of opened.splice(0)) await engine.close();

    // ---- The contrast: broker off, same four lanes -------------------------
    await recordProfile(baseUrl, project);
    const offStart = refreshFamilies();
    const { verdicts: unbrokered, results: offResults } = await fourLanes(baseUrl, project, false, opened);
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
    check(
      "...in its summary or in an action result",
      offResults.every((r) => !r.includes("the role's token") && !r.includes("could not be brokered")),
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

    // ---- scout_request after the page rotated its access token -------------
    // The page refreshes (a POST with no Authorization header) and then only
    // reads, with the new access token; the API takes only that one. The
    // replay must carry the page's latest credential, not one from a write.
    await recordProfile(baseUrl, project);
    const replayer = new BrowserEngine();
    opened.push(replayer);
    await replayer.attach({ url: `${baseUrl}/rt-app`, projectDir: project, mode: "observe", role: "member" });
    check("the replaying lane starts signed in", (await verdict(replayer)) === "in");
    expireFixtureAccess();
    await replayer.navigate(`${baseUrl}/rt-app`);
    check("...and is still signed in once its page has rotated the access token", (await verdict(replayer)) === "in");
    const replayed = await replayer.apiRequest({ method: "GET", path: "/rt-api/me" });
    check(
      "scout_request after a rotation carries the page's current credential and gets 200",
      replayed.startsWith("GET /rt-api/me 200"),
      replayed.split("\n")[0],
    );
    check("...with no stale-credential warning", !replayed.includes("may be stale"));
    await replayer.close();

    // The contrast: a page whose own calls carry no Authorization header, beside a
    // widget sending a bearer token to another origin. The replay sends none.
    const bare = new BrowserEngine();
    opened.push(bare);
    await bare.attach({ url: `${baseUrl}/foreign-bearer.html?foreign=${encodeURIComponent(foreignBaseUrl)}`, projectDir: project, mode: "observe" });
    await eventually(async () => (await bare.snapshot(true)).includes("Loaded"), WAIT_MS, 100);
    const none = await bare.apiRequest({ method: "GET", path: "/api/auth-echo" });
    check("a replay from a page that sent no credential to its origin sends none, not another origin's", none.includes('"authorization":"none"'), none);
    await bare.close();
  } finally {
    for (const engine of opened) await engine.close().catch(() => {});
    fs.rmSync(project, { recursive: true, force: true });
  }
}
