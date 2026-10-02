/**
 * Settling after a page is left: a frame's request still in flight when the
 * page goes away must not hold every later wait to its cap.
 *
 * The fixture's frames, and on the first visit the page itself, each fetch a
 * body the server never finishes sending, so their requests are provably still
 * out when the page is left. On the next
 * page nothing is loading, so a snapshot there must settle in a fraction of the
 * cap. The contrast is the same snapshot taken while the frames are still on
 * the page, which does wait, because those requests really are in flight.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { SETTLE_CAP_MS } from "../../dist/engine/settle.js";
import { check, until, type SmokeContext } from "./harness.ts";

export const title = "settle after leaving";

/** Well under the cap, with room for a slow machine: a snapshot of a quiet page takes a few hundred ms. */
const QUICK_MS = SETTLE_CAP_MS / 2;

export async function run({ baseUrl, stats }: SmokeContext): Promise<void> {
  console.log("settle after leaving: a frame's request left in flight is counted out");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-settle-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "settle";
  try {
    const before = stats.heldBodies;
    await engine.attach({ url: `${baseUrl}/frames-pending.html?top=1`, projectDir, mode: "read-only" });
    await until("both frames and the page to send their held request", () => stats.heldBodies >= before + 3, 8000);

    const t0 = Date.now();
    const onPage = await engine.snapshot();
    const onPageMs = Date.now() - t0;
    check(
      "while the frames are on the page, their requests are waited for (the contrast)",
      onPageMs >= SETTLE_CAP_MS * 0.9,
      `took ${onPageMs} ms\n${onPage.slice(0, 400)}`,
    );

    await engine.navigate(`${baseUrl}/page2.html`);
    const t1 = Date.now();
    const next = await engine.snapshot();
    const nextMs = Date.now() - t1;
    check(
      "on the next page, the requests the left page and its frames sent are not waited for",
      nextMs < QUICK_MS,
      `took ${nextMs} ms (cap ${SETTLE_CAP_MS})\n${next.slice(0, 400)}`,
    );
    check("...and the snapshot is of the next page", /Healthy second page|Page 2/.test(next), next.slice(0, 400));

    // The page stays; one frame moves on and the other is removed. White-box: the page, to change its frames.
    const again = stats.heldBodies;
    await engine.navigate(`${baseUrl}/frames-pending.html`);
    await until("both frames to send their held request again", () => stats.heldBodies >= again + 2, 8000);
    const page = (engine as unknown as { page: Page }).page;
    const frameOne = page.frames().find((f) => f.url().includes("n=1"));
    if (!frameOne) throw new Error("fixture frame one not found");
    await frameOne.evaluate((to) => void (location.href = to), `${baseUrl}/page2.html`);
    await until("frame one to load its new page", () => frameOne.url().endsWith("/page2.html"), 8000);
    await page.evaluate(() => document.querySelector('[data-testid="pending-frame-two"]')?.remove());
    await until("frame two to be removed", () => !page.frames().some((f) => f.url().includes("n=2")), 8000);
    const t2 = Date.now();
    const same = await engine.snapshot();
    const sameMs = Date.now() - t2;
    check(
      "a frame that navigates away and a frame that is removed leave nothing waited for",
      sameMs < QUICK_MS,
      `took ${sameMs} ms (cap ${SETTLE_CAP_MS})\n${same.slice(0, 400)}`,
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
