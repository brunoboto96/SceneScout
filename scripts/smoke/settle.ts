/**
 * Settling after a page is left: a frame's request still in flight when the
 * page goes away must not hold every later wait to its cap.
 *
 * The fixture's frames, and on the first visit the page itself, each fetch a
 * body the server never finishes sending, so their requests are provably still
 * out when the page is left. On the next page nothing is loading, so the
 * engine must count none of those requests as in flight, and a snapshot there
 * must not wait for them. The contrast is the same snapshot taken while the
 * frames are still on the page, which does wait, because those requests really
 * are in flight.
 *
 * What is asserted is the engine's own count of requests in flight, which is
 * what its settle waits on (white-box), not a fixed number of milliseconds: on
 * a loaded Windows runner a snapshot with nothing to wait for took over a
 * second. The held bodies never finish, so a request the engine failed to count
 * out is still counted after the snapshot's own wait. How long each snapshot took
 * is only reported, beside the contrast's, measured in the same run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { SETTLE_CAP_MS } from "../../dist/engine/settle.js";
import { check, until, type SmokeContext } from "./harness.ts";

export const title = "settle after leaving";

/** How many requests the engine counts as in flight, which is what its settle waits on (white-box). */
const inFlight = (engine: BrowserEngine): number => (engine as unknown as { requests: { count: number } }).requests.count;

export async function run({ baseUrl, stats }: SmokeContext): Promise<void> {
  console.log("settle after leaving: a frame's request left in flight is counted out");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-settle-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "settle";
  try {
    const before = stats.heldBodies;
    await engine.attach({ url: `${baseUrl}/frames-pending.html?top=1`, projectDir, mode: "read-only" });
    await until("both frames and the page to send their held request", () => stats.heldBodies >= before + 3, 8000);

    const heldOnPage = inFlight(engine);
    const t0 = Date.now();
    const onPage = await engine.snapshot();
    const onPageMs = Date.now() - t0;
    check(
      "while the frames are on the page, their requests are waited for (the contrast)",
      onPageMs >= SETTLE_CAP_MS * 0.9,
      `took ${onPageMs} ms\n${onPage.slice(0, 400)}`,
    );
    check("...because the engine counts the held requests as in flight", heldOnPage >= 3, `${heldOnPage} in flight`);

    await engine.navigate(`${baseUrl}/page2.html`);
    const heldNext = inFlight(engine);
    const t1 = Date.now();
    const next = await engine.snapshot();
    const nextMs = Date.now() - t1;
    check(
      "on the next page, the requests the left page and its frames sent are not waited for",
      heldNext === 0 && inFlight(engine) === 0,
      `${heldNext} in flight before the snapshot, ${inFlight(engine)} after; took ${nextMs} ms, the contrast ${onPageMs} ms (cap ${SETTLE_CAP_MS})\n${next.slice(0, 400)}`,
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
    // Read before the snapshot as well as after: a count that reached 0 only during the snapshot's wait was waited for.
    const heldSame = inFlight(engine);
    const t2 = Date.now();
    const same = await engine.snapshot();
    const sameMs = Date.now() - t2;
    check(
      "a frame that navigates away and a frame that is removed leave nothing waited for",
      heldSame === 0 && inFlight(engine) === 0,
      `${heldSame} in flight before the snapshot, ${inFlight(engine)} after; took ${sameMs} ms, the contrast ${onPageMs} ms (cap ${SETTLE_CAP_MS})\n${same.slice(0, 400)}`,
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
