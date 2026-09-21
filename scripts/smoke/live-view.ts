/**
 * The live view against a real browser: a frame of a real page, served over
 * real HTTP, without the viewer leaving a trace in the run it is watching.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { feedForSession, FEED_LINES, LiveServer, StatusBoard, type LiveProvider } from "../../dist/engine/live.js";
import { buildReplayHtml, resolveFrame } from "../../dist/engine/replay.js";
import { chromium, firefox, webkit } from "playwright";
import { BROWSER, check, until, type SmokeContext } from "./harness.ts";

export const title = "live view";

const isJpeg = (buf: Buffer | null | undefined): boolean => !!buf && buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8;

function get(port: number, urlPath: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("live view: frames of a real page, and a viewer that leaves no trace");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-live-"));
  const engine = new BrowserEngine();
  engine.sessionKey = "watched";
  const board = new StatusBoard();
  const provider: LiveProvider = {
    snapshot: () => ({ pid: process.pid, version: "smoke", at: new Date().toISOString(), sessions: board.list() }),
    activity: (session, limit) => feedForSession(engine.memory?.actionLog ?? [], session, limit),
    report: () => null,
    replay: () => null,
    frame: async (rel) => {
      const file = resolveFrame(path.join(projectDir, ".scenescout", "recordings"), rel);
      try {
        return file ? await fs.promises.readFile(file) : null;
      } catch {
        return null;
      }
    },
    screenshot: (session) => (session === "watched" ? engine.liveShot() : Promise.resolve(null)),
    startStream: (session, onFrame) => (session === "watched" ? engine.startScreencast(onFrame) : Promise.resolve(null)),
  };
  const live = new LiveServer(provider);
  try {
    await engine.attach({ url: baseUrl, projectDir, mode: "read-only", record: true, objective: "Watch the  demo  app" });
    check(
      "the objective given at attach reaches the live view, whitespace collapsed",
      engine.liveDescription.objective === "Watch the demo app",
      JSON.stringify(engine.liveDescription),
    );
    check(
      "...and the card says what it is doing from the moment it attaches",
      engine.liveDescription.task === "Attaching and taking stock",
      JSON.stringify(engine.liveDescription),
    );
    await engine.navigate("/");
    await engine.startJourney("Find the dashboard's broken chart");
    check(
      "the active journey's goal is what the session is doing",
      engine.liveDescription.task === "Find the dashboard's broken chart",
      JSON.stringify(engine.liveDescription),
    );
    await engine.navigate("/page2.html");
    engine.endJourney(true);
    check(
      "...and the task underneath it comes back when the journey ends",
      engine.liveDescription.task === "Attaching and taking stock",
      JSON.stringify(engine.liveDescription),
    );
    await engine.navigate("/");
    const tagged = feedForSession(engine.memory?.actionLog ?? [], "watched", 60);
    check(
      "a feed line taken during the journey carries its goal, and one taken after it does not",
      tagged.some((l) => l.action === "navigate" && l.target?.endsWith("/page2.html") && l.task === "Find the dashboard's broken chart") &&
        tagged.at(-1)?.action === "navigate" &&
        tagged.at(-1)?.task === undefined,
      JSON.stringify(tagged.slice(-4)),
    );
    board.update("watched", { role: engine.role, phase: "idle", tool: "scout_navigate", url: engine.currentUrl, ...engine.liveDescription });

    // The action log is the repro trace attached to findings. Somebody
    // glancing at the dashboard is not a step anyone should replay.
    const logged = (): number => (engine.memory?.actionLog ?? []).length;
    const before = logged();
    const shot = await engine.liveShot();
    check("a watcher's frame is a JPEG of the page", isJpeg(shot), `length ${shot?.length ?? 0}`);
    check("...and taking it logs no action", logged() === before, `${before} -> ${logged()}`);
    await engine.screenshot();
    check("...while the agent's own screenshot still does", logged() === before + 1, `${before} -> ${logged()}`);

    const frames: Buffer[] = [];
    const stop = await engine.startScreencast((jpeg) => frames.push(jpeg));
    // A screencast emits on REPAINT, so the page needs something to repaint and
    // the wait has to survive a loaded machine: this failed once at 8s with one
    // navigation while two dozen other browsers were running. Keep repainting
    // until a frame arrives rather than waiting longer on a single one.
    for (let i = 0; i < 6 && frames.length === 0; i += 1) {
      await engine.navigate(i % 2 === 0 ? "/page2.html" : "/");
      await until("a streamed frame", () => frames.length > 0, 5000).catch(() => {});
    }
    check("a stream delivers frames while it is open", frames.length > 0 && isJpeg(frames[0]), `${frames.length} frame(s)`);
    await stop();
    const atStop = frames.length;
    await engine.navigate("/");
    await new Promise((r) => setTimeout(r, 1200));
    check("...and none after it is stopped", frames.length === atStop, `${atStop} -> ${frames.length}`);
    check("stopping a stream logs no action either", !(engine.memory?.actionLog ?? []).some((e) => /screencast|liveShot/i.test(e.action)));

    const { port, token } = await live.start();
    const status = await get(port, `/${token}/api/status`);
    const sessions = (JSON.parse(status.body.toString()) as { sessions: Array<{ session: string; browser?: string; mode?: string }> }).sessions;
    check(
      "the status API describes the real session",
      sessions.length === 1 && sessions[0]?.session === "watched" && sessions[0]?.mode === "read-only",
      status.body.toString().slice(0, 300),
    );
    const feed = (JSON.parse((await get(port, `/${token}/api/activity?session=watched`)).body.toString()) as { feed: Array<{ action: string }> }).feed;
    check(
      "the activity feed reports what this session really did",
      feed.some((l) => l.action === "navigate") && feed.some((l) => l.action === "attach"),
      JSON.stringify(feed.slice(0, 4)),
    );

    const thumb = await get(port, `/${token}/shot/watched.jpg`);
    check(
      "a thumbnail of the real page comes back over HTTP",
      thumb.status === 200 && isJpeg(thumb.body),
      `status ${thumb.status}, ${thumb.body.length} bytes`,
    );
    check("...and a stranger to the token gets nothing", (await get(port, `/not-the-token/shot/watched.jpg`)).status === 404);

    // A recorded run really writes frames, and the steps really carry them.
    await engine.crawl(["/", "/covered.html"]);
    await engine.snapshot();
    const kept = fs.existsSync(path.join(projectDir, ".scenescout", "recordings", "watched"))
      ? fs.readdirSync(path.join(projectDir, ".scenescout", "recordings", "watched"))
      : [];
    check("a recorded run writes a frame per action under its own session", kept.length >= 3, `${kept.length} frame(s): ${kept.slice(0, 3).join(", ")}`);
    check("...named in the order they were taken, by the action that took them", /^0001-\w+\.jpg$/.test(kept.sort()[0] ?? ""), kept.sort()[0] ?? "(none)");
    // The breadth pass is where most routes are covered, and it used to leave
    // no picture of any of them: a real run kept 9 frames out of 67 actions,
    // none from a crawl.
    const crawled = (engine.memory?.actionLog ?? []).filter((e) => e.action === "crawl");
    check(
      "every crawled route keeps a frame, not one for the whole sweep",
      crawled.length >= 2 && crawled.every((e) => e.frame),
      `${crawled.filter((e) => e.frame).length} of ${crawled.length} crawled route(s) framed`,
    );
    // run_plan is the recommended way to run a sequence, so its steps are where
    // most of a recorded run happens.
    await engine.runPlan([{ action: "navigate", target: "/covered.html" }]);
    const planned = (engine.memory?.actionLog ?? []).filter((e) => e.action.startsWith("plan:"));
    check(
      "every plan step keeps a frame too",
      planned.length > 0 && planned.every((e) => e.frame),
      `${planned.filter((e) => e.frame).length} of ${planned.length} plan step(s) framed`,
    );

    const shots = (engine.memory?.actionLog ?? []).filter((e) => e.action === "snapshot");
    check(
      "…and so does a snapshot, which is the action taken to look at something",
      shots.length > 0 && shots.every((e) => e.frame),
      `${shots.filter((e) => e.frame).length} of ${shots.length}`,
    );

    const trail = feedForSession(engine.memory?.actionLog ?? [], "watched", 50);
    const framed = trail.filter((l) => l.frame);
    check("...and each step carries the frame it kept, all the way to the page's feed", framed.length >= 3, `${framed.length} of ${trail.length} step(s)`);
    check(
      "...as a path under recordings/<session>/, which is what the frame route is asked for",
      framed.every((l) => (l.frame ?? "").startsWith("recordings/watched/")),
      JSON.stringify(framed.slice(0, 2).map((l) => l.frame)),
    );
    const onDisk = fs.statSync(path.join(projectDir, ".scenescout", framed[0]?.frame ?? "")).size;
    check("...and the frame is a real image, not an empty file", onDisk > 1000, `${onDisk} bytes`);

    const asked = await get(port, `/${token}/record/${framed[0]?.frame ?? "recordings/watched/0001-x.jpg"}`);
    check(
      "a frame the feed named is served back at the run's own route",
      asked.status === 200 && isJpeg(asked.body),
      `status ${asked.status}, ${asked.body.length} bytes`,
    );
    check("...while a path out of the recordings directory is not", (await get(port, `/${token}/record/..%2f..%2f..%2fetc%2fpasswd`)).status === 404);

    await engine.close();
    check("a closed session says it cannot stream, instead of streaming nothing under a LIVE tag", (await engine.startScreencast(() => {})) === null);

    await viewerKeepsUp(shot);
  } finally {
    await live.stop();
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * The page itself, in a real browser, with more sessions streaming than a
 * browser allows connections to one host. With a stream per <img> the status
 * poll queued behind the streams and the page froze; over one shared
 * connection it keeps polling, and the close-up's feed links each group of
 * actions to the journey it served.
 */
async function viewerKeepsUp(jpeg: Buffer | null): Promise<void> {
  console.log("live view: the page keeps up with every session streaming");
  let names = Array.from({ length: 8 }, (_, i) => `agent-${i}`);
  let written = false;
  // Flipped on once the unrecorded path has been checked, so both are.
  let recorded = false;
  let stopped = false;
  const at = new Date().toISOString();
  const pushes = new Map<string, (frame: Buffer) => void>();
  let polls = 0;
  const provider: LiveProvider = {
    snapshot: () => {
      // Standing in for an engine that has exited: the page's watch sees the
      // request fail, which is what a stopped server gives it.
      if (stopped) throw new Error("the engine has gone");
      return {
        pid: process.pid,
        version: "smoke",
        at: new Date().toISOString(),
        report: { path: "/tmp/demo/.scenescout/report.md", written },
        sessions: names.map((session) => ({
          session,
          role: "clerk",
          phase: "idle",
          tool: "scout_snapshot",
          url: "http://app.test/",
          since: at,
          at,
          objective: `Task of ${session}`,
        })),
      };
    },
    // Only the status poll asks for the short feed, so this counts status polls and nothing else.
    activity: (session, limit) => {
      if (limit === FEED_LINES) polls += 1;
      return [
        { at, action: "journey:start", target: `Goal of ${session}`, url: "http://app.test/", task: `Goal of ${session}` },
        { at, action: "click", target: "Save", url: "http://app.test/", task: `Goal of ${session}` },
        { at, action: "journey:end", target: `Goal of ${session}`, url: "http://app.test/", result: "completed", task: `Goal of ${session}` },
        { at, action: "snapshot", url: "http://app.test/" },
        // More than the status poll carries, so the close-up's timeline can be
        // told apart from the six lines the board already has.
        ...Array.from({ length: limit > FEED_LINES ? 12 : 0 }, (_, i) => ({
          at,
          action: "click",
          target: `row ${i}`,
          url: "http://app.test/",
          ...(recorded ? { frame: "recordings/agent-0/0001-click.jpg" } : {}),
        })),
      ];
    },
    report: () => ({
      at,
      evidence: recorded
        ? [{ id: "abc123", frames: [{ at, action: "click", detail: 'button "Save"', frame: "recordings/agent-0/0001-click.jpg" }] }]
        : undefined,
      markdown: [
        "# SceneScout Report",
        "",
        "| Metric | Value |",
        "|---|---|",
        "| Open findings | 1 (1 high) |",
        "",
        "### 🔴 [HIGH] A title from the tested app: <script>alert(1)</script>",
        "",
        "- **Id:** `abc123` · **Category:** http-error",
        "- **Evidence:** `GET /api/things → HTTP 500`",
        "",
        "<details><summary>Repro trace (last actions before finding)</summary>",
        "",
        '1. click button "Save" @ http://app.test/',
        "2. snapshot @ http://app.test/ <img src=x onerror=alert(1)>",
        "",
        "</details>",
        "",
        "```ts",
        'test("regression", async ({ page }) => {',
        '  await page.goto("/");',
        "});",
        "```",
      ].join("\n"),
    }),
    replay: () =>
      recorded
        ? buildReplayHtml({
            markdown: "## Findings\n",
            sessions: [],
            project: "demo",
            at: new Date().toISOString(),
            version: "smoke",
            framePrefix: "record/",
            savedAt: "/p/demo/.scenescout",
          })
        : null,
    frame: async (rel) => (recorded && rel === "recordings/agent-0/0001-click.jpg" ? jpeg : null),
    screenshot: async () => jpeg,
    startStream: async (session, onFrame) => {
      pushes.set(session, onFrame);
      return async () => {
        pushes.delete(session);
      };
    },
  };
  const live = new LiveServer(provider);
  const { port, token } = await live.start();
  const browser = await { chromium, firefox, webkit }[BROWSER].launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/${token}/`);
    await page.getByTestId("live-all-toggle").click();
    await until("every session's stream to open", () => pushes.size === names.length, 8000);
    const pollsBefore = polls;
    const ticker = setInterval(() => {
      for (const push of pushes.values()) if (jpeg) push(jpeg);
    }, 100);
    try {
      await new Promise((r) => setTimeout(r, 2500));
    } finally {
      clearInterval(ticker);
    }
    check(`with ${names.length} streams open the status poll keeps arriving`, polls - pollsBefore >= 2, `${polls - pollsBefore} poll(s) in 2.5s`);
    const src = await page.getByTestId("live-card-image-agent-7").locator("img").getAttribute("src");
    check("a streamed frame is shown from the shared connection", !!src && src.startsWith("data:image/jpeg;base64,"), String(src).slice(0, 40));
    check("one connection carries them all: no stream per image", (await page.locator("img[src*='.mjpg']").count()) === 0);

    await page.getByTestId("live-card-image-agent-0").click();
    const focusFeed = page.getByTestId("live-focus-feed");
    await until(
      "the close-up's feed to render",
      () =>
        focusFeed
          .locator(".group")
          .count()
          .then((n) => n >= 2),
      5000,
    );
    const groups = await focusFeed.locator(".group").count();
    check("the close-up's feed is grouped by journey", groups === 2, `${groups} group(s)`);
    await focusFeed.locator(".group").first().hover();
    const hovered = await page.getByTestId("live-focus-task").textContent();
    const head = await page.locator("#focus-task-head").textContent();
    check(
      "pointing at a group shows the goal those actions served",
      hovered === "Goal of agent-0" && head === "Doing, for these actions",
      `${head}: ${hovered}`,
    );
    await page.locator("#focus-name").hover();
    check("...and leaving it goes back to what it is doing now", (await page.locator("#focus-task-head").textContent()) === "Doing now");
    // The timeline is drawn from the close-up's long feed, not from the six
    // lines the status poll carries — and picking a step must not shrink it.
    const ticks = page.locator("#timeline button");
    await until("the timeline to fill from the long feed", () => ticks.count().then((n) => n > FEED_LINES), 8000);
    const drawn = await ticks.count();
    await ticks.nth(drawn - 1).click();
    await page.waitForTimeout(500);
    check("picking a step leaves the whole run on the timeline", (await ticks.count()) === drawn, `${drawn} ticks, then ${await ticks.count()}`);
    check(
      "...and the step it picked is the one marked",
      (await ticks.nth(drawn - 1).getAttribute("aria-pressed")) === "true",
      String(await ticks.nth(drawn - 1).getAttribute("aria-pressed")),
    );
    await page.getByTestId("live-scrub-live").click();
    await page.waitForTimeout(400);
    check("going back to live leaves no step marked", (await page.locator('#timeline button[aria-pressed="true"]').count()) === 0);

    await page.getByTestId("live-focus-close").click();

    // The run ends: the browsers are gone, so the page must hand over the report itself.
    names = [];
    await until("the finished panel", () => page.getByTestId("live-finished-state").isVisible(), 8000);
    // The panel now asks whether the run has a page of its own before falling
    // back to the report, so the report follows it by a round trip rather than
    // arriving in the same tick.
    await until("the report to open itself", () => page.getByTestId("live-report-dialog").isVisible(), 8000);
    check("the report opens by itself when the run finishes", true);
    await until(
      "the report's file line",
      () =>
        page
          .getByTestId("live-report-meta")
          .textContent()
          .then((t) => /NOT saved: \/tmp\/demo\/\.scenescout\/report\.md/.test(t ?? "")),
      8000,
    );
    check("...and says the report is not on disk, naming where it belongs", true, (await page.getByTestId("live-report-meta").textContent()) ?? "");
    const download = await Promise.all([page.waitForEvent("download", { timeout: 8000 }), page.getByTestId("live-report-save").click()]).then((r) => r[0]);
    check("a viewer can keep a copy: the browser saves it, nothing is asked of the engine", download.suggestedFilename() === "scenescout-report.md");
    written = true;
    await until(
      "the file line to follow scout_report writing it",
      () =>
        page
          .getByTestId("live-finished-where")
          .textContent()
          .then((t) => /^saved at \/tmp\/demo/.test(t ?? "")),
      8000,
    );
    check("...and once the agent has written it, the page says where it is instead", true);
    await page.getByTestId("live-report-close").click();

    await page.getByTestId("live-report-toggle").click();
    const doc = page.getByTestId("live-report-doc");
    await until(
      "the report to render",
      () =>
        doc
          .locator("h4")
          .count()
          .then((n) => n > 0),
      5000,
    );
    const title = await doc.locator("h4").first().textContent();
    check(
      "the report's markdown is rendered as elements",
      (await doc.locator("table td").count()) === 2 && (await doc.locator("li strong").count()) === 3,
      `${await doc.locator("table td").count()} cell(s), ${await doc.locator("li strong").count()} bold run(s)`,
    );
    check(
      "...and a finding's title from the tested app is text, never markup",
      title === "🔴 [HIGH] A title from the tested app: <script>alert(1)</script>" && (await doc.locator("script").count()) === 0,
      String(title),
    );
    const fence = await doc.locator("pre code").first().textContent();
    check(
      "the repro trace folds under its summary and the test skeleton keeps its lines verbatim",
      (await doc.locator("details > summary").count()) === 1 &&
        (await doc.locator("details ol li").count()) === 2 &&
        fence === 'test("regression", async ({ page }) => {\n  await page.goto("/");\n});' &&
        (await doc.locator("img").count()) === 0,
      `summary ${await doc.locator("details > summary").count()}, items ${await doc.locator("details ol li").count()}, fence ${JSON.stringify(fence)}`,
    );

    // The same run, recorded. The finding now carries the frames it was found
    // on, and the run has a page of its own that a refresh cannot kill.
    recorded = true;
    const shots = doc.getByTestId("live-report-evidence-abc123");
    await until("the frames under the finding", () => shots.count().then((n) => n > 0), 8000);
    await shots.locator("summary").click();
    const shot = shots.locator("img").first();
    await until("the frame to load", () => shot.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), 8000);
    // The panel re-reads the report every few seconds. Re-rendering an
    // unchanged document used to close whatever the reader had open.
    const openBefore = await shots.evaluate((d: HTMLDetailsElement) => d.open);
    await page.waitForTimeout(6000);
    check(
      "an accordion the reader opened is still open after the panel re-reads the report",
      openBefore && (await shots.evaluate((d: HTMLDetailsElement) => d.open)),
      `open before ${openBefore}, after ${await shots.evaluate((d: HTMLDetailsElement) => d.open)}`,
    );
    check(
      "a finding's frames hang under it, fetched from the run's own route",
      (await shot.getAttribute("src")) === "record/recordings/agent-0/0001-click.jpg",
      String(await shot.getAttribute("src")),
    );

    const fresh = await browser.newPage();
    await fresh.goto(`http://127.0.0.1:${port}/${token}/`);
    await until("the viewer to land on the run's own page", () => fresh.title().then((t) => /^SceneScout run/.test(t)), 8000);
    check("a viewer arriving after the run ended is sent to the run's own page", fresh.url().endsWith("/run"), fresh.url());
    await fresh.reload();
    check("...and unlike a panel over a dead board, it is still there after a refresh", /^SceneScout run/.test(await fresh.title()), await fresh.title());
    await fresh.close();

    // The run's own page, once the engine behind it has exited: reloading the
    // address would get the browser's own error page and lose the tab.
    const run = await browser.newPage();
    await run.goto(`http://127.0.0.1:${port}/${token}/run`);
    await run.waitForTimeout(1200);
    check("the run's page says nothing about an exit while the engine is up", !(await run.getByTestId("run-engine-gone").isVisible()));
    let asked = false;
    run.on("dialog", async (d) => {
      asked = d.type() === "beforeunload";
      await d.dismiss();
    });
    stopped = true;
    await until("the page to notice the engine has gone", () => run.getByTestId("run-engine-gone").isVisible(), 20000);
    check(
      "...and once it has, says so and names the copy that survives",
      /report\.html/.test((await run.getByTestId("run-engine-gone").innerText()) ?? ""),
      (await run.getByTestId("run-engine-gone").innerText()) ?? "",
    );
    await run.getByTestId("run-copy-path").click();
    await run.reload({ timeout: 5000 }).catch(() => {});
    await run.waitForTimeout(800);
    check("a refresh from there asks before throwing the page away", asked);
    await run.close();
  } finally {
    await browser.close();
    await live.stop();
  }
}
