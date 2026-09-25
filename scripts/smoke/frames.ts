/**
 * Frames: what a snapshot says about a page's embeds, and a write from a
 * cross-origin frame never reaching the server, against the same write from a
 * same-origin frame that does.
 */
import type { Frame, Page } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { check, until, type SmokeContext } from "./harness.ts";

export const title = "frames";

export async function run({ baseUrl, foreignBaseUrl, projectDir, stats }: SmokeContext): Promise<void> {
  const engine = new BrowserEngine();
  try {
    await engine.attach({ url: `${baseUrl}/frames.html?foreign=${encodeURIComponent(foreignBaseUrl)}`, projectDir, mode: "read-only" });
    // White-box: the frames themselves, which the engine does not act in yet.
    const page = (engine as unknown as { page: Page }).page;
    const frameAs = (as: string): Frame | undefined => page.frames().find((f) => f.url().includes(`as=${as}`));
    const framesLoaded = () =>
      until(
        "all three frames to load",
        async () => {
          for (const as of ["same", "foreign", "bridge"]) {
            const f = frameAs(as);
            if (!f || !(await f.evaluate(() => typeof (window as unknown as { sendNote?: unknown }).sendNote === "function").catch(() => false))) return false;
          }
          return true;
        },
        8000,
      );
    await framesLoaded();

    console.log("frames: the snapshot says what is embedded");
    const snap = await engine.snapshot();
    check("a snapshot lists the page's frames and says they were not explored", snap.includes("FRAMES not explored"), snap);
    check("...a same-origin frame by its path and title", /same-origin \/frame-child\.html\?as=same "Same-site widget" \d+×\d+/.test(snap), snap);
    check(
      "...a cross-origin frame by its origin, saying its writes are refused",
      /cross-origin http:\/\/127\.0\.0\.1:\d+\/frame-child\.html\?as=foreign "Third-party form" \d+×\d+ — writes it sends outside the app are refused/.test(
        snap,
      ),
      snap,
    );
    check("...and a 0×0 bridge only as a count", snap.includes("(+1 hidden frame)") && !snap.includes("as=bridge"), snap);
    check(
      "a page whose content is all in frames is not called a dead end",
      !snap.includes("DEAD END") && snap.includes("inside the frames listed above"),
      snap,
    );

    console.log("frames: a write from a cross-origin frame never leaves; the same write from a same-origin frame does");
    const sameStatus = await frameAs("same")!.evaluate(() => (window as unknown as { sendNote: () => Promise<unknown> }).sendNote());
    await until("the same-origin write to arrive", () => (stats.writes["POST /api/frame-note-same"] ?? 0) === 1, 5000).catch(() => {});
    check("a write from a same-origin frame reaches the server in read-only", stats.writes["POST /api/frame-note-same"] === 1, `status ${sameStatus}`);
    const foreignStatus = await frameAs("foreign")!.evaluate(() => (window as unknown as { sendNote: () => Promise<unknown> }).sendNote());
    await page.waitForTimeout(500);
    check(
      "a write from a cross-origin frame never reaches the server",
      stats.writes["POST /api/frame-note-foreign"] === undefined,
      JSON.stringify(stats.writes),
    );
    check("...and the frame's script is answered with a refusal, so its own handling runs", foreignStatus === 403, `status ${foreignStatus}`);
    const logged = (engine.memory?.actionLog ?? []).some(
      (e) => e.action === "write-policy:blocked" && /sent from a frame of http:\/\/127\.0\.0\.1:\d+/.test(e.target ?? ""),
    );
    check("...and the run's log says where it came from", logged);

    console.log("frames: a foreign frame's write into the app is the app's business");
    type Child = { sendToApp: (app: string) => Promise<string>; postToTop: () => void; openPopup: () => void };
    await frameAs("foreign")!.evaluate((app) => (window as unknown as Child).sendToApp(app), baseUrl);
    await until("the write into the app to arrive", () => stats.writes["POST /api/frame-to-app"] === 1, 5000).catch(() => {});
    check(
      "a foreign frame's write whose destination is the app goes through the ordinary rules",
      stats.writes["POST /api/frame-to-app"] === 1,
      JSON.stringify(stats.writes),
    );

    console.log("frames: a popup a foreign frame opens on its own site");
    const popups: Page[] = [];
    const onPopup = (p: Page) => popups.push(p);
    page.context().on("page", onPopup);
    await frameAs("foreign")!.evaluate(() => (window as unknown as Child).openPopup());
    await until("the popup to open", () => popups.length > 0, 5000).catch(() => {});
    await page.waitForTimeout(800);
    page.context().off("page", onPopup);
    check("the foreign frame's popup did open (so the next check means something)", popups.length > 0);
    check("...and its write never reaches the server", stats.writes["POST /api/frame-popup"] === undefined, JSON.stringify(stats.writes));

    console.log("frames: a form aimed at the top window, from each frame");
    await frameAs("foreign")!.evaluate(() => (window as unknown as Child).postToTop());
    await page.waitForTimeout(800);
    check(
      "a foreign frame's form aimed at the top window never reaches the server",
      stats.writes["POST /api/frame-top-foreign"] === undefined,
      JSON.stringify(stats.writes),
    );
    // The refused top-window navigation leaves the page on the browser's error page: load it again.
    const reload = async () => {
      await engine.navigate(`${baseUrl}/frames.html?foreign=${encodeURIComponent(foreignBaseUrl)}`);
      await framesLoaded();
    };
    await reload();
    // Its one-fact contrast: the same form to the same place, sent by the app's own page.
    await page.evaluate((url) => (window as unknown as { postOut: (u: string) => void }).postOut(url), `${foreignBaseUrl}/api/frame-top-foreign`);
    await until("the app's own form to the other site to arrive", () => stats.writes["POST /api/frame-top-foreign"] === 1, 5000).catch(() => {});
    check(
      "...while the app's own page posting the same form to that site is the app's behaviour, and arrives",
      stats.writes["POST /api/frame-top-foreign"] === 1,
      JSON.stringify(stats.writes),
    );
    await reload();
    // Last, because it navigates the whole page away.
    await frameAs("same")!.evaluate(() => (window as unknown as Child).postToTop());
    await until("the same-origin frame's top-window form to arrive", () => stats.writes["POST /api/frame-top-same"] === 1, 5000).catch(() => {});
    check("...while the same form in a same-origin frame does", stats.writes["POST /api/frame-top-same"] === 1, JSON.stringify(stats.writes));
  } finally {
    await engine.close().catch(() => {});
  }
}
