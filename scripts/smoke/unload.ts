/**
 * Writes a page sends as it is being left: a sendBeacon and a keepalive fetch
 * on pagehide (test-app/unload-writes.html). Chromium never hands them to the
 * context's route handler, so the engine judges them at the browser level
 * (browsers.ts `unloadWriteInterception`); Firefox and WebKit route them. On
 * every engine the verdict must be the policy's: sent where the mode allows
 * the write, and refused and reported where it does not.
 */
import { allowedUnloadWritesMayBeLost, unloadWriteInterception, writeRedirectHopsJudged } from "../../dist/browsers.js";
import { BrowserEngine, type WriteMode } from "../../dist/engine/browser.js";
import { BROWSER, check, settle, type SmokeContext } from "./harness.ts";

export const title = "unload writes";

const BEACON = "POST /api/unload/beacon";
const KEEPALIVE = "POST /api/unload/keepalive";

export async function run({ baseUrl, foreignBaseUrl, projectDir, stats }: SmokeContext): Promise<void> {
  const writes = (key: string): number => stats.writes[key] ?? 0;
  const how = `${BROWSER}, caught by ${unloadWriteInterception(BROWSER)}`;

  /**
   * Load the page in `mode` with `query`, leave it for another page, and hand back what the engine said (on attach and
   * on leaving) and how many of each write reached the server meanwhile.
   */
  const visit = async (mode: WriteMode, query: string): Promise<{ result: string; delta: (key: string) => number }> => {
    const engine = new BrowserEngine();
    const before = { ...stats.writes };
    try {
      const attached = await engine.attach({ url: `${baseUrl}/unload-writes.html${query}`, projectDir, mode });
      await settle(300);
      // Absolute: a relative target resolves against the attach URL, query included.
      const result = attached + "\n" + (await engine.navigate(`${baseUrl}/index.html`));
      // Absence has no event to wait for: give a request that did escape time to land.
      await settle(500);
      return { result, delta: (key: string) => writes(key) - (before[key] ?? 0) };
    } finally {
      await engine.close();
    }
  };
  const leave = async (mode: WriteMode, intent: "save" | "delete"): Promise<{ result: string; beacon: number; keepalive: number }> => {
    const { result, delta } = await visit(mode, intent === "delete" ? "?intent=delete" : "");
    return { result, beacon: delta(BEACON), keepalive: delta(KEEPALIVE) };
  };
  const mayBeLost = allowedUnloadWritesMayBeLost(BROWSER);
  const refusedBoth = (result: string, mode: WriteMode): boolean =>
    result.includes(`WRITE-POLICY blocked (${mode})`) && /POST \S*\/api\/unload\/beacon/.test(result) && /POST \S*\/api\/unload\/keepalive/.test(result);

  console.log("a draft saved on the way out: observe refuses it, read-only sends it");
  const observed = await leave("observe", "save");
  check(
    `observe (${how}): neither the beacon nor the keepalive fetch sent on pagehide reaches the server`,
    observed.beacon === 0 && observed.keepalive === 0,
    JSON.stringify(stats.writes),
  );
  check(
    `observe (${how}): both are reported as refused, in the result of the navigation that left the page`,
    refusedBoth(observed.result, "observe"),
    observed.result,
  );

  const readOnly = await leave("read-only", "save");
  // WebKit may cancel an unload write the route handler lets through once the page has gone (allowedUnloadWritesMayBeLost):
  // there the policy's verdict is asserted (let through, not refused), not the delivery.
  check(
    mayBeLost
      ? `read-only (${how}): the same plain writes are let through, at most once each (WebKit may cancel one the page no longer waits for)`
      : `read-only (${how}): the same plain writes reach the server, since read-only lets an ordinary POST through`,
    mayBeLost ? readOnly.beacon <= 1 && readOnly.keepalive <= 1 : readOnly.beacon === 1 && readOnly.keepalive === 1,
    JSON.stringify(stats.writes),
  );
  check(
    `read-only (${how}): nothing is reported as refused, and the writes are named as possible mutations`,
    !readOnly.result.includes("WRITE-POLICY blocked") && /may have mutated[^\n]*\/api\/unload\//.test(readOnly.result),
    readOnly.result,
  );

  console.log("a delete sent on the way out: read-only refuses it, destructive sends it");
  const refused = await leave("read-only", "delete");
  check(
    `read-only (${how}): a beacon and a keepalive fetch whose body is a delete command never reach the server`,
    refused.beacon === 0 && refused.keepalive === 0,
    JSON.stringify(stats.writes),
  );
  check(`read-only (${how}): both are reported as refused`, refusedBoth(refused.result, "read-only"), refused.result);

  const destructive = await leave("destructive", "delete");
  check(
    `destructive (${how}): the same delete commands reach the server, since destructive allows everything`,
    destructive.beacon === 1 && destructive.keepalive === 1,
    JSON.stringify(stats.writes),
  );

  console.log("an embed of another site writing to its own site as the page is left");
  const embed = await visit("read-only", `?frame=${encodeURIComponent(foreignBaseUrl)}`);
  check(
    `read-only (${how}): the embed's beacon and keepalive fetch to its own site never reach it, while the app's own plain writes go out`,
    embed.delta("POST /api/unload/embed-beacon") === 0 &&
      embed.delta("POST /api/unload/embed-keepalive") === 0 &&
      (mayBeLost ? embed.delta(BEACON) <= 1 && embed.delta(KEEPALIVE) <= 1 : embed.delta(BEACON) === 1 && embed.delta(KEEPALIVE) === 1),
    JSON.stringify(stats.writes),
  );
  check(
    `read-only (${how}): the embed's writes are reported as refused, as another site's frame's`,
    embed.result.includes("WRITE-POLICY blocked (read-only)") &&
      /\/api\/unload\/embed-beacon/.test(embed.result) &&
      /sent from a frame of http:\/\/127\.0\.0\.1/.test(embed.result),
    embed.result,
  );

  console.log("a delete beaconed to a URL where a harmless save was let through a moment before");
  const race = await visit("read-only", "?race=1");
  check(
    `read-only (${how}): the delete beacon never reaches the server and is reported as refused, although a plain save to the same URL was let through`,
    // The plain saves are allowed in read-only, so a refusal of this URL is the delete's.
    race.delta("POST /api/unload/race (delete)") === 0 && /WRITE-POLICY blocked \(read-only\)[^\n]*POST \S*\/api\/unload\/race/.test(race.result),
    `${race.result}\n${JSON.stringify(stats.writes)}`,
  );

  console.log("a write carried on by a 307 to a destructive address");
  const redirect = await visit("read-only", "?redirect=1");
  const hopsJudged = writeRedirectHopsJudged(BROWSER);
  check(
    hopsJudged
      ? `read-only (${how}): the plain save goes out, and its 307 hop to a delete address is refused and reported`
      : `read-only (${how}): the plain save goes out, and its 307 hop is sent unjudged (the route handler never sees a later hop: a known limit)`,
    redirect.delta("POST /api/unload/redirect") === 1 &&
      (hopsJudged
        ? redirect.delta("POST /api/unload/redirected/delete") === 0 && /POST \S*\/api\/unload\/redirected\/delete/.test(redirect.result)
        : redirect.delta("POST /api/unload/redirected/delete") === 1),
    `${redirect.result}\n${JSON.stringify(stats.writes)}`,
  );
  if (hopsJudged)
    check(
      `read-only (${how}): the refused hop is the policy's doing, not the app's: no request_failed filed for it, and not listed as a possible mutation`,
      !/request_failed[^\n]*\/api\/unload\/redirected\/delete/.test(redirect.result) &&
        !/may have mutated[^\n]*\/api\/unload\/redirected\/delete/.test(redirect.result),
      redirect.result,
    );

  console.log("a page closed with the session");
  const engine = new BrowserEngine();
  const before = { beacon: writes(BEACON), keepalive: writes(KEEPALIVE) };
  try {
    await engine.attach({ url: `${baseUrl}/unload-writes.html`, projectDir, mode: "observe" });
  } finally {
    await engine.close();
  }
  await settle(500);
  check(
    `observe (${how}): the writes a page sends as the session closes it never reach the server either`,
    writes(BEACON) === before.beacon && writes(KEEPALIVE) === before.keepalive,
    JSON.stringify(stats.writes),
  );
}
