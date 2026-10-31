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
import { serviceWorkerPolicy } from "../../dist/browsers.js";
import { BROWSER, check, eventually, heldPageCount, releaseHeldPages, settle, until, type ServerStats, type SmokeContext } from "./harness.ts";

export const title = "settle after leaving";

/** How many requests the engine counts as in flight, which is what its settle waits on (white-box). */
const inFlight = (engine: BrowserEngine): number => (engine as unknown as { requests: { count: number } }).requests.count;

/** How long one engine call below may run before it fails its check: past every limit the call has, far short of the job's. */
const STEP_BOUND_MS = 45_000;

/**
 * `work`'s answer, or, once it has run STEP_BOUND_MS, a line saying so with the engine's last steps (printed too), so
 * a stall names the step it is in and fails its check rather than the job's time limit.
 */
async function bounded(engine: BrowserEngine, label: string, work: Promise<string>): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const over = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      const said = `(${label} still running after ${STEP_BOUND_MS} ms; last steps:\n    ${engine.stepTraceLines().slice(-15).join("\n    ")})`;
      console.log(`  ${said}`);
      resolve(said);
    }, STEP_BOUND_MS);
  });
  try {
    return await Promise.race([work.catch((err: unknown) => `(${label} threw: ${err instanceof Error ? err.message : String(err)})`), over]);
  } finally {
    clearTimeout(timer);
  }
}

export async function run({ baseUrl, stats }: SmokeContext): Promise<void> {
  await leftFrames(baseUrl, stats);
  await downloadIsNotWaitedFor(baseUrl, stats);
  await crawlOfAPageThatMovesOnToNowhere(baseUrl);
  await crawlOfAPageThatMovesOnWhileRead(baseUrl);
  await pageThatLeavesForBlank(baseUrl);
  await actionOnAPageThatMovesOnWhileScanned(baseUrl);
  await scanGivenUpOnAddsNothingLate(baseUrl, "finds-while-leaving.html", "dom_injection");
  await scanGivenUpOnAddsNothingLate(baseUrl, "claims-while-leaving.html", "false_success");
  await actionOnAPageThatMovedOnBeforeIt(baseUrl);
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
    const out = await bounded(engine, "crawl", engine.crawl(["/leaves-for-held.html", "/leaves-for-page.html", "/leaves-twice.html"]));
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
    const went = await bounded(engine, "navigate", engine.navigate(`${baseUrl}/leaves-for-held.html`));
    check("a navigation to that page ends", /^OK: navigate /.test(went), went.slice(0, 600));
    const t1 = Date.now();
    const snap = await bounded(engine, "snapshot", engine.snapshot());
    const snapMs = Date.now() - t1;
    check(
      "a snapshot after a navigation to that page ends at the page-load limit, saying the navigation is pending, rather than hanging",
      snapMs < limitMs + 4000 && /^NAVIGATION PENDING: the page moved itself on to http[^\s]*\/page2\.html\?held=1/.test(snap),
      `${snapMs} ms\n${snap.slice(0, 300)}`,
    );
    await bounded(engine, "navigate", engine.navigate(`${baseUrl}/leaves-for-page.html`));
    const landed = await bounded(engine, "snapshot", engine.snapshot());
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

/**
 * A page that starts a navigation of its own, to an address that never answers, while it is being read: one as its
 * controls are read, the other once they have been, each after the engine's check for a navigation on its way, so the
 * race a loaded machine loses at random is lost here every time. Chromium holds every later read of such a page until
 * the navigation lands, so each read is released at the page-load limit and the route or snapshot is reported as a
 * navigation pending to where the page was going. Without that release the crawl and both snapshots never end.
 */
async function crawlOfAPageThatMovesOnWhileRead(baseUrl: string): Promise<void> {
  console.log("settle: a page that moves itself on while it is read ends at the page-load limit");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-settle-read-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "settle-read";
  const limitMs = 3000;
  try {
    await engine.attach({ url: `${baseUrl}/covered.html`, projectDir, mode: "read-only", navTimeoutMs: limitMs });
    const t0 = Date.now();
    const out = await bounded(engine, "crawl", engine.crawl(["/leaves-while-read.html", "/covered.html", "/leaves-after-read.html"]));
    const ms = Date.now() - t0;
    console.log(`  (crawl of three routes: ${ms} ms, page-load limit ${limitMs} ms)`);
    check(
      "the crawl ends, each held read released within twice the page-load limit",
      ms < limitMs * 6 + 6000 && /\/covered\.html — 200/.test(out),
      `${ms} ms\n${out}`,
    );
    for (const route of ["leaves-while-read", "leaves-after-read"]) {
      const pending = new RegExp(`/${route}\\.html — NAVIGATION PENDING`).test(out);
      const named = new RegExp(`/${route}\\.html: the page moved itself on to http[^\\s]*/page2\\.html\\?held=1, which had not loaded`).test(out);
      // Chromium holds the read; the other engines read the page that is still showing, which is a route read where it stood.
      check(
        `...the route whose page moved on ${route === "leaves-while-read" ? "while its controls were read" : "once its controls were read"} is a navigation pending to where it was going`,
        BROWSER === "chromium" ? pending && named : pending ? named : new RegExp(`/${route}\\.html — 200`).test(out),
        out,
      );
    }
    check("...and never as one to the blank page the read was released with", !/about:blank/.test(out), out);
    // On Chromium the crawl ended on a route whose read was released: the navigation was ended with it, so the page
    // left is not one a later read would wait on. The other engines read that route, and its navigation is still on its way.
    if (BROWSER === "chromium") {
      const t1 = Date.now();
      const after = await bounded(engine, "snapshot", engine.snapshot());
      check(
        "...and a snapshot after the crawl finds no navigation of that route's page still on its way",
        !/NAVIGATION PENDING/.test(after),
        `${Date.now() - t1} ms\n${after.slice(0, 300)}`,
      );
      check(
        "...and says the session is on the blank page the crawl left that route for, and to navigate to the route again, recording no state and no dead end",
        /^NOT A PAGE OF THE APP: the session is on about:blank, where SceneScout left http[^\s]*\/leaves-after-read\.html /.test(after) &&
          /scout_navigate to http[^\s]*\/leaves-after-read\.html to load it again/.test(after) &&
          !/DEAD END|^State: /m.test(after),
        after.slice(0, 400),
      );
    }
    // The same pages reached by a navigation and then read by a snapshot.
    for (const route of ["leaves-while-read", "leaves-after-read"]) {
      const went = await bounded(engine, "navigate", engine.navigate(`${baseUrl}/${route}.html`));
      const t2 = Date.now();
      const snap = await bounded(engine, "snapshot", engine.snapshot());
      const snapMs = Date.now() - t2;
      check(
        `a snapshot of the page that moves itself on ${route === "leaves-while-read" ? "while" : "once"} its controls are read ends at the page-load limit, and never names the blank page`,
        /^OK: navigate /.test(went) &&
          snapMs < limitMs + 4000 &&
          !/about:blank/.test(snap.split("\n")[0]) &&
          (BROWSER !== "chromium" || /^NAVIGATION PENDING: the page moved itself on to http[^\s]*\/page2\.html\?held=1/.test(snap)),
        `${snapMs} ms\n${went.slice(0, 200)}\n${snap.slice(0, 300)}`,
      );
      if (BROWSER === "chromium") {
        check(
          "...and says the page was left, to navigate to it again rather than snapshot again later",
          new RegExp(
            `\\nThe page was left for about:blank to end that navigation, and nothing of it was recorded: scout_navigate to http[^\\s]*/${route}\\.html to load it again`,
          ).test(snap) && !/again later/.test(snap),
          snap.slice(0, 500),
        );
        const next = await bounded(engine, "snapshot", engine.snapshot());
        check(
          "...and the snapshot after it records nothing of the blank page and reports no dead end",
          /^NOT A PAGE OF THE APP: /.test(next) && !/DEAD END|^State: /m.test(next),
          next.slice(0, 400),
        );
      }
    }
    await engine.close();
    check(
      "...and no state of the blank page is kept in the project's memory",
      !keptStateUrls(projectDir).some((u) => !/^https?:/.test(u)),
      keptStateUrls(projectDir).join("\n"),
    );
  } finally {
    releaseHeldPages();
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/** The address of every page state the project's memory keeps. */
function keptStateUrls(projectDir: string): string[] {
  const memory = JSON.parse(fs.readFileSync(path.join(projectDir, ".scenescout", "memory.json"), "utf8")) as { states?: Record<string, { url: string }> };
  return Object.values(memory.states ?? {}).map((s) => s.url);
}

/**
 * A page that sends itself to about:blank just after it loads, crawled and then navigated to and read. The blank page is
 * no page of the app: the crawl reports the route as not read, the snapshot says the session is not on the app, and
 * neither keeps a state of it nor reports a dead end. Contrastive pair: the same page moving on to a page of the app
 * (leaves-for-page.html), which is read where it landed.
 */
async function pageThatLeavesForBlank(baseUrl: string): Promise<void> {
  console.log("settle: a page that sends itself to about:blank is not recorded as a state of the app");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-settle-blank-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "settle-blank";
  try {
    await engine.attach({ url: `${baseUrl}/covered.html`, projectDir, mode: "read-only", navTimeoutMs: 3000 });
    const out = await bounded(engine, "crawl", engine.crawl(["/leaves-for-blank.html", "/leaves-for-page.html"]));
    check(
      "a crawled route whose page went to about:blank is not read, saying it left the app",
      /\/leaves-for-blank\.html — LOAD FAILED/.test(out) && /\/leaves-for-blank\.html: the page went to about:blank, which is not a page of the app/.test(out),
      out,
    );
    check("...and the same page moving on to a page of the app is read where it landed (the contrast)", /\/leaves-for-page\.html — 200/.test(out), out);
    await bounded(engine, "navigate", engine.navigate(`${baseUrl}/leaves-for-blank.html`));
    let left = "";
    await eventually(async () => /^NOT A PAGE OF THE APP: /.test((left = await bounded(engine, "snapshot", engine.snapshot()))), 5000, 250);
    check(
      "a snapshot once that page went to about:blank says the session is not on the app, with no state and no dead end",
      /^NOT A PAGE OF THE APP: the session is on about:blank, not a page of the app/.test(left) && !/DEAD END|^State: /m.test(left),
      left.slice(0, 400),
    );
    // A design audit, a journey and a write on the blank page are facts of no route of the app either.
    await bounded(engine, "design audit", engine.designAudit());
    engine.startJourney("a task begun on the blank page");
    engine.endJourney(false);
    await engine.close();
    const kept = keptStateUrls(projectDir);
    check(
      "...and the project's memory keeps the page of the app it landed on and no state of the blank page",
      kept.some((u) => /\/page2\.html/.test(u)) && !kept.some((u) => !/^https?:/.test(u)),
      kept.join("\n"),
    );
    const memoryText = fs.readFileSync(path.join(projectDir, ".scenescout", "memory.json"), "utf8");
    check(
      "...and records no route as covered by landing on the blank page",
      !/landed:blank|"blank"/.test(memoryText),
      memoryText.match(/.{0,80}blank.{0,80}/g)?.join("\n") ?? "",
    );
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * The scans after an action reading a page that starts a navigation of its own, to an address that never answers, after
 * their check for one: on Chromium the scan's read is held until the navigation lands, so it is skipped at the page-load
 * limit and the action ends. Without that the click never returns.
 */
async function actionOnAPageThatMovesOnWhileScanned(baseUrl: string): Promise<void> {
  console.log("settle: an action whose page moves itself on while it is scanned ends at the page-load limit");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-settle-scan-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "settle-scan";
  const limitMs = 3000;
  try {
    await engine.attach({ url: `${baseUrl}/leaves-while-scanned.html`, projectDir, mode: "read-only", navTimeoutMs: limitMs });
    const snap = await bounded(engine, "snapshot", engine.snapshot());
    const ref = /\[(e\d+)\] textbox "Note"/.exec(snap)?.[1] ?? /(e\d+)\s+textbox "Note"/.exec(snap)?.[1];
    check("the page's field is listed", ref !== undefined, snap.slice(0, 600));
    const typed = await bounded(engine, "type", engine.type(ref ?? "e1", '<marquee data-probe="1">x</marquee>'));
    check("typing the payload ends", /^OK: type/.test(typed), typed.slice(0, 400));
    const button = /\[(e\d+)\] button "Check"/.exec(snap)?.[1] ?? /(e\d+)\s+button "Check"/.exec(snap)?.[1];
    const t0 = Date.now();
    const clicked = await bounded(engine, "click", engine.click(button ?? "e2"));
    const ms = Date.now() - t0;
    console.log(`  (click: ${ms} ms, page-load limit ${limitMs} ms)`);
    check(
      "a click on a page that moves itself on while the scans after it read the page ends within twice the page-load limit",
      ms < limitMs * 2 + 4000 && /^OK: click/.test(clicked),
      `${ms} ms\n${clicked.slice(0, 400)}`,
    );
  } finally {
    releaseHeldPages();
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * A scan after an action whose read the page answers only after the action gave the scan up, with a navigation of the
 * page's own on its way (the fixture's service worker starts it while the page is busy in that read, so it starts after
 * the scan's check for one by construction). What the read finds then must not be added late, where the next action's
 * drain would report it as its own on the page the session has moved to (#732). Chromium only: the other browsers run
 * with service workers blocked, so the fixture cannot start the navigation there.
 */
async function scanGivenUpOnAddsNothingLate(baseUrl: string, fixture: string, kind: "dom_injection" | "false_success"): Promise<void> {
  console.log(`settle: a ${kind} scan given up on while the page moves on adds nothing once it lands`);
  if (serviceWorkerPolicy(BROWSER) !== "allow") {
    console.log(`  (skipped on ${BROWSER}: service workers are blocked there)`);
    return;
  }
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-settle-late-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "settle-late";
  const limitMs = 3000;
  const logged = (): number => engine.oracleLog.all.filter((v) => v.kind === kind).length;
  try {
    await engine.attach({ url: `${baseUrl}/${fixture}`, projectDir, mode: "read-only", navTimeoutMs: limitMs });
    const page = (engine as unknown as { page: Page }).page;
    await until("the fixture's service worker to control the page", async () => (await page.evaluate("!!navigator.serviceWorker.controller")) === true, 8000);
    const snap = await bounded(engine, "snapshot", engine.snapshot());
    const ref = (name: string): string | undefined => new RegExp(`(e\\d+)\\s+${name}`).exec(snap)?.[1];
    if (kind === "dom_injection") {
      const typed = await bounded(engine, "type", engine.type(ref('textbox "Note"') ?? "e1", '<marquee data-probe="1">x</marquee>'));
      check("typing the payload ends", /^OK: type/.test(typed), typed.slice(0, 400));
    }
    const clicked = await bounded(engine, "click", engine.click(ref(kind === "dom_injection" ? 'button "Show"' : 'button "Save"') ?? "e2"));
    check(
      `the click whose ${kind} scan the page holds ends with the page on its way and the scan's read unanswered`,
      /^OK: click/.test(clicked) && heldPageCount() === 2,
      `${heldPageCount()} held\n${clicked.slice(0, 400)}`,
    );
    releaseHeldPages("/covered.html");
    // The scan's read now completes; nothing marks that from outside, so the window is a wait (a slow machine can only miss a late finding).
    await settle(1500);
    if (kind === "dom_injection") {
      // Answered after the click had ended: the next action's to judge, which a contradiction scan starting late would take (white-box).
      const ledger = (engine as unknown as { watchedResponses: Array<{ url: string }> }).watchedResponses;
      check(
        "the request the page sent after the click had ended is left for the next action, not taken by the given-up scan",
        ledger.some((r) => r.url.includes("/covered.html")),
        JSON.stringify(ledger.map((r) => r.url)),
      );
    }
    releaseHeldPages();
    await until("the page to land where it was going", () => page.url().includes("/page2.html"), 8000);
    const next = await bounded(engine, "snapshot", engine.snapshot());
    check(
      `what the given-up ${kind} scan read is not reported by the next action, on the page the session moved to`,
      !next.includes(kind) && logged() === 0,
      `${logged()} logged\n${next.slice(0, 600)}`,
    );
  } finally {
    releaseHeldPages();
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * An action on a page that started a navigation of its own, to an address that never answers, before the action: on
 * Chromium every read of the page is held until the navigation lands. A click (the lookup of its target), a key press
 * and a scroll (the read before each), and a plan's step each end at the page-load limit and say a navigation is on
 * its way, and where to.
 */
async function actionOnAPageThatMovedOnBeforeIt(baseUrl: string): Promise<void> {
  console.log("settle: an action whose page started a navigation of its own before it ends at the page-load limit");
  const limitMs = 3000;
  const actions: Array<[string, (engine: BrowserEngine, ref: string) => Promise<string>]> = [
    ["a click", (engine, ref) => engine.click(ref)],
    ["a key press", (engine) => engine.press("Enter")],
    ["a scroll", (engine) => engine.scroll("bottom")],
    ["a plan's click step", (engine) => engine.runPlan([{ action: "click", target: "testid=between-go" }])],
  ];
  for (const [what, act] of actions) {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-settle-before-"));
    const engine = new BrowserEngine();
    engine.sessionKey = "settle-before";
    try {
      await engine.attach({ url: `${baseUrl}/leaves-between-actions.html`, projectDir, mode: "read-only", navTimeoutMs: limitMs });
      const snap = await bounded(engine, "snapshot", engine.snapshot());
      const ref = /\[(e\d+)\] button "Go on"/.exec(snap)?.[1] ?? /(e\d+)\s+button "Go on"/.exec(snap)?.[1];
      check(`the page's button is listed (before ${what})`, ref !== undefined, snap.slice(0, 600));
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const t0 = Date.now();
      const said = await bounded(engine, what, act(engine, ref ?? "e1"));
      const ms = Date.now() - t0;
      console.log(`  (${what}: ${ms} ms, page-load limit ${limitMs} ms)`);
      check(
        `${what} on a page whose own navigation is on its way ends within twice the page-load limit, saying so`,
        BROWSER !== "chromium" || (ms < limitMs * 2 + 4000 && /navigation of its own is on its way/.test(said) && /page2\.html\?held=1/.test(said)),
        `${ms} ms\n${said.slice(0, 400)}`,
      );
    } finally {
      releaseHeldPages();
      await engine.close();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }
}
