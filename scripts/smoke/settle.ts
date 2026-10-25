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
import { check, eventually, releaseHeldPages, until, type ServerStats, type SmokeContext } from "./harness.ts";

export const title = "settle after leaving";

/** How many requests the engine counts as in flight, which is what its settle waits on (white-box). */
const inFlight = (engine: BrowserEngine): number => (engine as unknown as { requests: { count: number } }).requests.count;

export async function run({ baseUrl, stats }: SmokeContext): Promise<void> {
  await leftFrames(baseUrl, stats);
  await downloadIsNotWaitedFor(baseUrl, stats);
  await crawlOfAPageThatMovesOnToNowhere(baseUrl);
}

async function leftFrames(baseUrl: string, stats: ServerStats): Promise<void> {
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

/**
 * A page that moves itself to a file the browser downloads: Firefox keeps the download's request open until the whole
 * file has arrived, and counted in flight it held every settle wait to SETTLE_CAP_MS. The download event ends it.
 * Contrastive pair: the same file, from the same server, still arriving, fetched by the page's own script, which is
 * the page's request and is waited for.
 */
async function downloadIsNotWaitedFor(baseUrl: string, stats: ServerStats): Promise<void> {
  console.log("settle: a file the browser downloads is not waited for; the same file fetched by the page is");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-settle-file-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "settle-file";
  try {
    await engine.attach({ url: `${baseUrl}/covered.html`, projectDir, mode: "read-only" });
    const before = stats.slowFilesOpen;
    await engine.navigate(`${baseUrl}/file-on-load.html`);
    await until("the file to start arriving", () => stats.slowFilesOpen > before, 8000);
    const counted = await eventually(() => inFlight(engine) === 0, 1500);
    const stillSending = stats.slowFilesOpen > before;
    const t0 = Date.now();
    await engine.snapshot();
    const downloadMs = Date.now() - t0;
    check(
      "a download still arriving is not counted in flight, so a snapshot does not wait for it",
      counted && stillSending,
      `${inFlight(engine)} in flight, files still sending: ${stats.slowFilesOpen - before}; snapshot took ${downloadMs} ms (cap ${SETTLE_CAP_MS})`,
    );

    const fetching = stats.slowFilesOpen;
    await engine.navigate(`${baseUrl}/file-by-fetch.html`);
    await until("the fetched file to start arriving", () => stats.slowFilesOpen > fetching, 8000);
    const t1 = Date.now();
    const held = inFlight(engine);
    await engine.snapshot();
    const fetchMs = Date.now() - t1;
    check(
      "...while the same file fetched by the page is counted in flight, and waited for (the contrast)",
      held >= 1 && fetchMs >= SETTLE_CAP_MS * 0.9,
      `${held} in flight; snapshot took ${fetchMs} ms, the download's ${downloadMs} ms (cap ${SETTLE_CAP_MS})`,
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * A crawl of a route whose page moves itself on, just after it loads, to an address that never answers (the fixture
 * server holds it back). Chromium held the read of that route until the navigation landed, so the crawl hung past
 * 40 s. It now waits for the navigation within the page-load limit, then reports the navigation as pending and goes
 * on. Contrastive pair: the same page moving on to the same address answered at once, which is read where it landed.
 */
async function crawlOfAPageThatMovesOnToNowhere(baseUrl: string): Promise<void> {
  console.log("settle: a crawled page that moves itself on to an address that never answers ends at the page-load limit");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-settle-crawl-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "settle-crawl";
  const limitMs = 3000;
  try {
    await engine.attach({ url: `${baseUrl}/covered.html`, projectDir, mode: "read-only", navTimeoutMs: limitMs });
    const t0 = Date.now();
    const out = await engine.crawl(["/leaves-for-held.html", "/leaves-for-page.html", "/leaves-twice.html"]);
    const ms = Date.now() - t0;
    console.log(`  (crawl of both routes: ${ms} ms, page-load limit ${limitMs} ms)`);
    check(
      "the route whose page moved on to an address that never answered is reported as a navigation pending, at the page-load limit",
      /\/leaves-for-held\.html — NAVIGATION PENDING/.test(out) &&
        /\/leaves-for-held\.html: the page moved itself on to http[^\s]*\/page2\.html\?held=1, which had not loaded when the page-load limit \(3000 ms\) ran out/.test(
          out,
        ),
      out,
    );
    check(
      "...and so is a page that lands on one that moves on again at once, rather than read between the two",
      /\/leaves-twice\.html — NAVIGATION PENDING/.test(out),
      out,
    );
    check("...and the crawl went on within the limit of each, not hanging on either", ms < limitMs * 3 + 6000, `${ms} ms\n${out}`);
    check(
      "the same page moving on to an address that answered is read where it landed (the contrast)",
      /\/leaves-for-page\.html — 200/.test(out) && !/\/leaves-for-page\.html — NAVIGATION PENDING/.test(out),
      out,
    );
    const t1 = Date.now();
    await engine.navigate(`${baseUrl}/leaves-for-held.html`);
    const snap = await engine.snapshot();
    const snapMs = Date.now() - t1;
    check(
      "a snapshot after a navigation to that page ends at the page-load limit, saying the navigation is pending, rather than hanging",
      snapMs < limitMs + 4000 && /^NAVIGATION PENDING: the page moved itself on to http[^\s]*\/page2\.html\?held=1/.test(snap),
      `${snapMs} ms\n${snap.slice(0, 300)}`,
    );
    await engine.navigate(`${baseUrl}/leaves-for-page.html`);
    const landed = await engine.snapshot();
    check(
      "...and after the same page moving on to an address that answered, the snapshot is of where it landed",
      /Page 2|second page/i.test(landed),
      landed.slice(0, 300),
    );
  } finally {
    releaseHeldPages();
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}
