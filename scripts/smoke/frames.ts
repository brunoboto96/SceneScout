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
    await until(
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

    console.log("frames: the snapshot says what is embedded");
    const snap = await engine.snapshot();
    check("a snapshot lists the page's frames and says they were not explored", snap.includes("FRAMES not explored"), snap);
    check("...a same-origin frame by its path and title", /same-origin \/frame-child\.html\?as=same "Same-site widget" \d+×\d+/.test(snap), snap);
    check(
      "...a cross-origin frame by its origin, saying its writes are never sent",
      /cross-origin http:\/\/127\.0\.0\.1:\d+\/frame-child\.html\?as=foreign "Third-party form" \d+×\d+ — writes from it are never sent/.test(snap),
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
  } finally {
    await engine.close().catch(() => {});
  }
}
