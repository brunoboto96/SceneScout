/**
 * Writes a page sends as it is being left: a sendBeacon and a keepalive fetch
 * on pagehide (test-app/unload-writes.html). Chromium never hands them to the
 * context's route handler, so the engine judges them at the browser level
 * (browsers.ts `unloadWriteInterception`); Firefox and WebKit route them. On
 * every engine the verdict must be the policy's: sent where the mode allows
 * the write, and refused and reported where it does not.
 */
import {
  allowedUnloadWritesMayBeLost,
  closeWaitsForLeavingWrites,
  frameUnloadWritesMayGoUnissued,
  unloadWriteInterception,
  writeRedirectHopsJudged,
} from "../../dist/browsers.js";
import { BrowserEngine, type WriteMode } from "../../dist/engine/browser.js";
import { BROWSER, check, eventually, settle, until, type SmokeContext } from "./harness.ts";

export const title = "unload writes";

const BEACON = "POST /api/unload/beacon";
const KEEPALIVE = "POST /api/unload/keepalive";

export async function run({ baseUrl, foreignBaseUrl, projectDir, stats }: SmokeContext): Promise<void> {
  const writes = (key: string): number => stats.writes[key] ?? 0;
  const how = `${BROWSER}, caught by ${unloadWriteInterception(BROWSER)}`;

  const mayBeLost = allowedUnloadWritesMayBeLost(BROWSER);
  /**
   * Load the page in `mode` with `query`, leave it for another page, and hand back what the engine said (on attach and
   * on leaving) and how many of each write reached the server meanwhile. `arrives` names the writes the mode lets
   * through: those are waited for, since on a loaded machine one can land well after the navigation returns.
   */
  const visit = async (
    mode: WriteMode,
    query: string,
    arrives: { beforeLeaving?: string[]; afterLeaving?: string[] } = {},
  ): Promise<{ result: string; delta: (key: string) => number }> => {
    const engine = new BrowserEngine();
    const before = { ...stats.writes };
    const delta = (key: string): number => writes(key) - (before[key] ?? 0);
    const landed = (keys: string[] = []) => eventually(() => keys.every((key) => delta(key) >= 1));
    try {
      const attached = await engine.attach({ url: `${baseUrl}/unload-writes.html${query}`, projectDir, mode });
      // The race page's saves are cancelled on timers up to 30 ms after load; there is no event for "all cancelled".
      await settle(300);
      if (query.includes("frame=")) {
        // The embed must have loaded, and armed its pagehide handler, before the page is left.
        const page = (engine as unknown as { page: import("playwright").Page }).page;
        await until("the embed of another site to load", async () => {
          const embed = page.frames().find((f) => f.url().includes("embedded=1"));
          return !!embed && (await embed.evaluate(() => document.readyState === "complete").catch(() => false));
        });
      }
      await landed(arrives.beforeLeaving);
      // Absolute: a relative target resolves against the attach URL, query included.
      const result = attached + "\n" + (await engine.navigate(`${baseUrl}/index.html`));
      // WebKit may cancel an unload write its route handler let through (allowedUnloadWritesMayBeLost): there only
      // destructive mode, which intercepts nothing, is sure to deliver.
      if (!mayBeLost || mode === "destructive") await landed(arrives.afterLeaving);
      // Absence has no event to wait for: give a request that did escape time to land.
      await settle(500);
      return { result, delta };
    } finally {
      await engine.close();
    }
  };
  const leave = async (mode: WriteMode, intent: "save" | "delete", sent: boolean): Promise<{ result: string; beacon: number; keepalive: number }> => {
    const { result, delta } = await visit(mode, intent === "delete" ? "?intent=delete" : "", sent ? { afterLeaving: [BEACON, KEEPALIVE] } : {});
    return { result, beacon: delta(BEACON), keepalive: delta(KEEPALIVE) };
  };
  const refusedBoth = (result: string, mode: WriteMode): boolean =>
    result.includes(`WRITE-POLICY blocked (${mode})`) && /POST \S*\/api\/unload\/beacon/.test(result) && /POST \S*\/api\/unload\/keepalive/.test(result);

  console.log("a draft saved on the way out: observe refuses it, read-only sends it");
  const observed = await leave("observe", "save", false);
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

  const readOnly = await leave("read-only", "save", true);
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
    `read-only (${how}): nothing is reported as refused, the writes are named as possible mutations, and the fixture raises no http_error`,
    !readOnly.result.includes("WRITE-POLICY blocked") &&
      /may have mutated[^\n]*\/api\/unload\//.test(readOnly.result) &&
      !/http_error[^\n]*\/api\/unload\//.test(readOnly.result),
    readOnly.result,
  );

  console.log("a delete sent on the way out: read-only refuses it, destructive sends it");
  const refused = await leave("read-only", "delete", false);
  check(
    `read-only (${how}): a beacon and a keepalive fetch whose body is a delete command never reach the server`,
    refused.beacon === 0 && refused.keepalive === 0,
    JSON.stringify(stats.writes),
  );
  check(`read-only (${how}): both are reported as refused`, refusedBoth(refused.result, "read-only"), refused.result);

  const destructive = await leave("destructive", "delete", true);
  check(
    `destructive (${how}): the same delete commands reach the server, since destructive allows everything`,
    destructive.beacon === 1 && destructive.keepalive === 1,
    JSON.stringify(stats.writes),
  );

  console.log("an embed of another site writing to its own site as the page is left");
  const embed = await visit("read-only", `?frame=${encodeURIComponent(foreignBaseUrl)}`, { afterLeaving: [BEACON, KEEPALIVE] });
  check(
    `read-only (${how}): the embed's beacon and keepalive fetch to its own site never reach it, while the app's own plain writes go out`,
    embed.delta("POST /api/unload/embed-beacon") === 0 &&
      embed.delta("POST /api/unload/embed-keepalive") === 0 &&
      (mayBeLost ? embed.delta(BEACON) <= 1 && embed.delta(KEEPALIVE) <= 1 : embed.delta(BEACON) === 1 && embed.delta(KEEPALIVE) === 1),
    JSON.stringify(stats.writes),
  );
  // Firefox may tear the frame down before its writes are issued (frameUnloadWritesMayGoUnissued): then nothing reaches
  // the route handler and there is nothing to report. The hard assertion, never reaching the server, is the one above.
  const embedReported =
    embed.result.includes("WRITE-POLICY blocked (read-only)") &&
    /\/api\/unload\/embed-beacon/.test(embed.result) &&
    /sent from a frame of http:\/\/127\.0\.0\.1/.test(embed.result);
  const embedLetThrough = /may have mutated[^\n]*\/api\/unload\/embed-/.test(embed.result);
  check(
    frameUnloadWritesMayGoUnissued(BROWSER)
      ? `read-only (${how}): the embed's writes are reported as refused, as another site's frame's, or were never issued; never let through`
      : `read-only (${how}): the embed's writes are reported as refused, as another site's frame's`,
    !embedLetThrough &&
      !/http_error[^\n]*\/api\/unload\//.test(embed.result) &&
      // Where the frame may be torn down first, one, both or neither may have been issued; any that was is refused.
      (embedReported || frameUnloadWritesMayGoUnissued(BROWSER)),
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
  const redirect = await visit("read-only", "?redirect=1", {
    // Where the hop is not judged it is sent on, and arrives after the save it carries on.
    beforeLeaving: ["POST /api/unload/redirect", ...(writeRedirectHopsJudged(BROWSER) ? [] : ["POST /api/unload/redirected/delete"])],
  });
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
  // Absence has no event to wait for: give a write the closing page did send time to land.
  await settle(500);
  check(
    `observe (${how}): the writes a page sends as the session closes it never reach the server either`,
    writes(BEACON) === before.beacon && writes(KEEPALIVE) === before.keepalive,
    JSON.stringify(stats.writes),
  );

  // Left and closed at once, a page in Firefox let the delete it beaconed on its way out reach the server about one time in
  // nine (closeWaitsForLeavingWrites). A loop, since one run proves little: 80 where the wait applies, a few elsewhere.
  const runs = closeWaitsForLeavingWrites(BROWSER) ? 80 : 10;
  console.log(`a foreign popup, left and closed by the engine, ${runs} times`);
  const popups = new BrowserEngine();
  const popupBefore = { beacon: writes(BEACON), keepalive: writes(KEEPALIVE) };
  let refusedEveryTime = 0;
  try {
    await popups.attach({ url: `${baseUrl}/index.html`, projectDir, mode: "read-only" });
    const inner = popups as unknown as { page: import("playwright").Page; blockedRequests: Array<{ sig: string }> };
    const context = inner.page.context();
    for (let i = 0; i < runs; i++) {
      inner.blockedRequests = [];
      const opened = context.waitForEvent("page", { timeout: 15000 });
      await inner.page.evaluate((u) => void window.open(u), `${foreignBaseUrl}/unload-writes.html?intent=delete`);
      await (await opened).waitForEvent("close", { timeout: 15000 });
      // Where the engine waits for the verdict, the refusal is recorded by the time the popup has closed.
      if (inner.blockedRequests.some((b) => /POST \S*\/api\/unload\/beacon/.test(b.sig))) refusedEveryTime += 1;
    }
  } finally {
    await popups.close();
  }
  // Absence has no event to wait for: give a write a closing popup did send time to land.
  await settle(500);
  const escaped = writes(BEACON) - popupBefore.beacon + (writes(KEEPALIVE) - popupBefore.keepalive);
  check(
    `read-only (${how}): in ${runs} foreign popups closed by the engine, no delete beaconed or kept alive as the popup was left reaches the server`,
    escaped === 0,
    `${escaped} arrived; ${JSON.stringify(stats.writes)}`,
  );
  if (closeWaitsForLeavingWrites(BROWSER))
    check(
      `read-only (${how}): each popup's beacon was refused before the popup was closed, in every one of the ${runs}`,
      refusedEveryTime === runs,
      `${refusedEveryTime}/${runs}`,
    );
}
