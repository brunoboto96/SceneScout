/**
 * The refresh broker with a refresh token held in an HttpOnly cookie, through
 * real browsers. The fixture app keeps its access token in localStorage and
 * its refresh token in a cookie, and refreshes with a POST that carries
 * nothing but that cookie; the fixture server revokes the whole token family
 * when a refresh token is presented a second time.
 *
 * Scoped to "/", the cookie rides on every request the app makes: its
 * scripts, stylesheet and image, and a burst of plain GETs. None of those is
 * a refresh, so none may wait on the role's lock, and the app must load whole.
 * Four sessions of one role then refresh at once, and the broker must still
 * serialise the refresh POSTs: the family survives, all four stay signed in.
 * The contrast is the same app with the cookie scoped to the refresh endpoint
 * alone, which only the refresh call carries. Last, an app whose refresh
 * endpoint is not named for one: the broker learns it from the cookie its
 * response rotates, and every session of the role brokers it from then on.
 *
 * Token values are compared here, never printed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import type { WriteMode } from "../../dist/engine/policy.js";
import { profilePath, writeProfile } from "../../dist/engine/profiles.js";
import { endpointsPathFor, lockPathFor, readLearnedEndpoints, refreshTokenSlots } from "../../dist/engine/refresh.js";
import { captureState } from "../../dist/login-run.js";
import { BROWSER, check, expireFixtureAccess, isCurrentRefreshToken, refreshFamilies, type SmokeContext } from "./harness.ts";

export const title = "refresh broker (cookie)";

const SIGNED_IN = "Signed in as a member";
const SIGNED_OUT = "You are signed out";
const LOADED = "App loaded: 4 scripts, its stylesheet, its image and 12 requests";
const INCOMPLETE = "App incomplete";
const LANES = 4;

/** Sign in through the fixture in a browser of its own and save the result as the role's profile. */
async function recordProfile(baseUrl: string, project: string, query: string): Promise<void> {
  const browser = await { chromium, firefox, webkit }[BROWSER].launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/rc-signin?${query}`);
    await page.waitForFunction((want) => document.querySelector("h1")?.textContent === want, SIGNED_IN, { timeout: 10000 });
    writeProfile(project, "member", await captureState(context));
  } finally {
    await browser.close();
  }
}

/** What a lane's page settles on: whether it is signed in, and whether its scripts, stylesheet, image and GETs all arrived. */
async function settled(engine: BrowserEngine): Promise<{ signedIn: "in" | "out" | "pending"; loaded: "whole" | "incomplete" | "pending" }> {
  let text = "";
  for (let i = 0; i < 100; i++) {
    text = await engine.snapshot(true);
    const signed = text.includes(SIGNED_IN) || text.includes(SIGNED_OUT);
    const assets = text.includes(LOADED) || text.includes(INCOMPLETE);
    if (signed && assets) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    signedIn: text.includes(SIGNED_IN) ? "in" : text.includes(SIGNED_OUT) ? "out" : "pending",
    loaded: text.includes(LOADED) ? "whole" : text.includes(INCOMPLETE) ? "incomplete" : "pending",
  };
}

/** The broker's entries in a lane's action log. Every request it took the role's lock for writes one "refresh-broker" entry. */
function brokered(engine: BrowserEngine): Array<{ action: string; target: string }> {
  return (engine.memory?.actionLog ?? []).filter((e) => e.action.startsWith("refresh-broker")).map((e) => ({ action: e.action, target: e.target ?? "" }));
}

/** How many requests a lane took the role's lock for, and the paths they went to. */
function lockTaken(engine: BrowserEngine): string[] {
  return brokered(engine)
    .filter((e) => e.action === "refresh-broker")
    .map((e) => e.target.split(" with ")[0]);
}

/** Wait until `ok` holds, polling for up to `ms`; returns whether it did. */
async function until(ok: () => boolean, ms = 5000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return ok();
}

/** The role's profile on disk holds the family's current refresh token, and nothing was left locked. */
function profileIsCurrent(project: string): boolean {
  const slots = refreshTokenSlots(JSON.parse(fs.readFileSync(profilePath(project, "member"), "utf8")));
  return slots.length === 1 && isCurrentRefreshToken(slots[0].value) && !fs.existsSync(lockPathFor(profilePath(project, "member")));
}

async function attachLanes(baseUrl: string, project: string, mode: WriteMode, count: number, opened: BrowserEngine[]): Promise<BrowserEngine[]> {
  const lanes = Array.from({ length: count }, () => new BrowserEngine());
  opened.push(...lanes);
  for (const lane of lanes) await lane.attach({ url: `${baseUrl}/rc-app`, projectDir: project, mode, role: "member" });
  return lanes;
}

/**
 * Four lanes of one role, each loading the whole app with the refresh cookie
 * on, then all refreshing at once. `scope` says where the cookie goes; the
 * checks are the same for both, because the broker must behave the same.
 */
async function fourLanes(baseUrl: string, project: string, scope: "root" | "endpoint", opened: BrowserEngine[]): Promise<void> {
  const label = scope === "root" ? 'scoped to "/"' : "scoped to the refresh endpoint";
  await recordProfile(baseUrl, project, `scope=${scope}`);
  // Observe mode: every GET and the refresh go out, nothing else does.
  const lanes = await attachLanes(baseUrl, project, "observe", LANES, opened);
  const first = await Promise.all(lanes.map(settled));
  check(
    `cookie ${label}: every lane loads the whole app, scripts, stylesheet, image and 12 GETs`,
    first.every((s) => s.loaded === "whole"),
    JSON.stringify(first),
  );
  check(
    `cookie ${label}: ...and starts signed in`,
    first.every((s) => s.signedIn === "in"),
    JSON.stringify(first),
  );
  check(
    `cookie ${label}: ...and not one of those requests touched the refresh lock`,
    lanes.every((lane) => brokered(lane).length === 0),
    JSON.stringify(lanes.map(brokered)),
  );

  const start = refreshFamilies();
  expireFixtureAccess();
  await Promise.all(lanes.map((lane) => lane.navigate(`${baseUrl}/rc-app`)));
  const after = await Promise.all(lanes.map(settled));
  const end = refreshFamilies();
  check(`cookie ${label}: four lanes refreshing at once revoke no token family`, end.revoked === start.revoked, JSON.stringify({ start, end }));
  check(
    `cookie ${label}: ...all four stay signed in`,
    after.every((s) => s.signedIn === "in"),
    JSON.stringify(after),
  );
  check(
    `cookie ${label}: ...and load whole again`,
    after.every((s) => s.loaded === "whole"),
    JSON.stringify(after),
  );
  check(`cookie ${label}: ...each lane refreshed once, in turn`, end.rotations - start.rotations === LANES, JSON.stringify({ start, end }));
  check(
    `cookie ${label}: ...each lane took the lock for its refresh POST and for nothing else`,
    lanes.every((lane) => JSON.stringify(lockTaken(lane)) === JSON.stringify(["POST /rc-auth/refresh"])),
    JSON.stringify(lanes.map(lockTaken)),
  );
  check(
    `cookie ${label}: ...and never let a request through unbrokered`,
    lanes.every((lane) => brokered(lane).every((e) => !e.action.endsWith(":unbrokered") && !e.action.endsWith(":error"))),
    JSON.stringify(lanes.map(brokered)),
  );
  check(`cookie ${label}: ...the profile on disk holds the family's current token, and no lock is left`, await until(() => profileIsCurrent(project)));
  for (const engine of opened.splice(0)) await engine.close();
}

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-refresh-cookie-"));
  const opened: BrowserEngine[] = [];
  try {
    await fourLanes(baseUrl, project, "root", opened);
    await fourLanes(baseUrl, project, "endpoint", opened);

    // ---- A refresh endpoint not named for one: learned from its response ----
    // Read-only mode: observe would refuse a POST to a path that is not an auth flow.
    await recordProfile(baseUrl, project, "scope=root&refresh=odd");
    const [scout] = await attachLanes(baseUrl, project, "read-only", 1, opened);
    check(
      "odd endpoint: the first lane loads whole and signed in",
      JSON.stringify(await settled(scout)) === JSON.stringify({ signedIn: "in", loaded: "whole" }),
    );
    const oddStart = refreshFamilies();
    expireFixtureAccess();
    await scout.navigate(`${baseUrl}/rc-app`);
    check("odd endpoint: its first refresh goes out unbrokered and works", (await settled(scout)).signedIn === "in");
    check("...one rotation, no revocation", refreshFamilies().rotations === oddStart.rotations + 1 && refreshFamilies().revoked === oddStart.revoked);
    const endpoints = endpointsPathFor(profilePath(project, "member"));
    check(
      "...the broker learns the endpoint from the cookie its response rotated, for every session of the role",
      await until(() => readLearnedEndpoints(endpoints).includes("POST /rc-api/keepalive")),
      JSON.stringify(readLearnedEndpoints(endpoints)),
    );
    check("...the learned list is owner-only", process.platform === "win32" || (fs.existsSync(endpoints) && (fs.statSync(endpoints).mode & 0o077) === 0));
    check("...and the rotation is written back, so the profile holds the current token", await until(() => profileIsCurrent(project)));
    check(
      "...and the lane says so",
      brokered(scout).some((e) => e.action === "refresh-broker:learned" && e.target.includes("saved to the profile")),
      JSON.stringify(brokered(scout)),
    );

    const rest = await attachLanes(baseUrl, project, "read-only", LANES - 1, opened);
    const lanes = [scout, ...rest];
    check(
      "odd endpoint: three more lanes attach signed in",
      (await Promise.all(rest.map(settled))).every((s) => s.signedIn === "in"),
    );
    const roundStart = refreshFamilies();
    const before = lanes.map((lane) => lockTaken(lane).length);
    expireFixtureAccess();
    await Promise.all(lanes.map((lane) => lane.navigate(`${baseUrl}/rc-app`)));
    const round = await Promise.all(lanes.map(settled));
    const roundEnd = refreshFamilies();
    check(
      "odd endpoint: four lanes refreshing at once revoke no token family",
      roundEnd.revoked === roundStart.revoked,
      JSON.stringify({ roundStart, roundEnd }),
    );
    check(
      "...all four stay signed in",
      round.every((s) => s.signedIn === "in"),
      JSON.stringify(round),
    );
    check("...each refreshed once, in turn", roundEnd.rotations - roundStart.rotations === LANES, JSON.stringify({ roundStart, roundEnd }));
    check(
      "...each lane brokered the learned endpoint, including those that learned it from the file",
      lanes.every((lane, i) => lockTaken(lane).slice(before[i]).join() === "POST /rc-api/keepalive"),
      JSON.stringify(lanes.map((lane, i) => lockTaken(lane).slice(before[i]))),
    );
    check("...and the profile holds the current token", await until(() => profileIsCurrent(project)));
  } finally {
    for (const engine of opened) await engine.close().catch(() => {});
    fs.rmSync(project, { recursive: true, force: true });
  }
}
