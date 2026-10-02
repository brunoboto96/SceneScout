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
import { chromium, firefox, webkit, type Page } from "playwright";
import { BROWSER, check, eventually, settle, until, WAIT_MS, type SmokeContext } from "./harness.ts";

export const title = "live view";

/**
 * Absence has no event to wait for: how long a stream that should stay as it is gets to change before a check says it
 * did not. A slow machine can only make it miss a late change, never fail a check that should pass.
 */
const ABSENT_MS = 1200;

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
    // A repaint has just happened: a stream still running would deliver it inside the window.
    await settle(ABSENT_MS);
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
 * The close-up against what can happen while it is open. The overlay covers
 * the header and the cards for a pointer, but not for the keyboard, so "Stream
 * all" and another card's close-up are both one Tab away; the session can
 * close under it; and a still can fail to capture once.
 */
async function closeUpFollowUps(
  page: Page,
  pushes: Map<string, unknown>,
  failShots: Map<string, number>,
  setNames: (names: string[]) => void,
  names: string[],
): Promise<void> {
  const all = page.getByTestId("live-all-toggle");
  const focusToggle = page.getByTestId("live-focus-stream-toggle");
  const press = async (testId: string): Promise<void> => {
    await page.getByTestId(testId).focus();
    await page.keyboard.press("Enter");
  };
  const streaming = (name: string): Promise<boolean> =>
    page
      .getByTestId(`live-card-toggle-${name}`)
      .getAttribute("aria-pressed")
      .then((v) => v === "true");

  // "Stream all" pressed while a close-up it did not start is open, twice:
  // off, then on. Closing the close-up afterwards must leave the card as
  // "Stream all" left it, not switch it back off.
  check("before: Stream all is on and agent-0 is not streaming", (await all.getAttribute("aria-pressed")) === "true" && !(await streaming("agent-0")));
  await page.getByTestId("live-card-image-agent-0").click();
  await until("the close-up to stream agent-0", async () => pushes.has("agent-0"));
  await press("live-all-toggle");
  await press("live-all-toggle");
  await until("Stream all to be back on", async () => (await all.getAttribute("aria-pressed")) === "true");
  await page.getByTestId("live-focus-close").click();
  // The check is that closing the close-up does NOT stop the stream: there is nothing to wait for.
  await settle(ABSENT_MS);
  check(
    "Stream all pressed from the keyboard while a close-up is open still holds for that card once it closes",
    (await streaming("agent-0")) && pushes.has("agent-0"),
    `card streaming ${await streaming("agent-0")}, stream open ${pushes.has("agent-0")}`,
  );

  // Another card's close-up opened from the keyboard while one is open hands
  // the first session back as it was.
  await all.click();
  await until("every stream to stop", async () => pushes.size === 0);
  await page.getByTestId("live-card-image-agent-1").click();
  await until("the close-up to stream agent-1", async () => pushes.has("agent-1"));
  await press("live-card-image-agent-2");
  await until("the second close-up to stream agent-2", async () => pushes.has("agent-2"));
  await until("agent-1's stream to stop", async () => !pushes.has("agent-1")).catch(() => {});
  check(
    "opening a second close-up from the keyboard stops the stream the first one started",
    !pushes.has("agent-1") && !(await streaming("agent-1")) && (await page.locator("#focus-name").textContent()) === "agent-2",
    `agent-1 stream open ${pushes.has("agent-1")}, card streaming ${await streaming("agent-1")}`,
  );
  await page.getByTestId("live-focus-close").click();
  await until("closing it to stop agent-2's stream", async () => !pushes.has("agent-2"));

  // The open close-up's own card, reached from the keyboard: opening it again
  // changes nothing, and its Stream toggle is a choice that outlasts the close-up.
  await page.getByTestId("live-card-image-agent-4").click();
  await until("the close-up to stream agent-4", async () => pushes.has("agent-4"));
  await press("live-card-image-agent-4");
  await page.getByTestId("live-focus-close").click();
  await until("closing it to stop agent-4's stream", async () => !pushes.has("agent-4")).catch(() => {});
  check("opening the same close-up again from the keyboard still hands the card back on close", !pushes.has("agent-4") && !(await streaming("agent-4")));
  await page.getByTestId("live-card-image-agent-4").click();
  await until("the close-up to stream agent-4 again", async () => pushes.has("agent-4"));
  await press("live-card-toggle-agent-4");
  await press("live-card-toggle-agent-4");
  await page.getByTestId("live-focus-close").click();
  // The check is that closing the close-up does NOT stop the stream: there is nothing to wait for.
  await settle(ABSENT_MS);
  check("the card's own toggle pressed behind the close-up is a choice that outlasts it", pushes.has("agent-4") && (await streaming("agent-4")));
  await page.getByTestId("live-card-toggle-agent-4").click();
  await until("agent-4's stream to stop", async () => !pushes.has("agent-4"));

  // A still that fails to capture once keeps the picture up. Watched with a
  // MutationObserver because the old blank lasted only until the next poll.
  await page.getByTestId("live-card-image-agent-3").click();
  await until("the close-up to stream agent-3", async () => pushes.has("agent-3"));
  await focusToggle.click();
  await until("agent-3's stream to stop", async () => !pushes.has("agent-3"));
  await until("the close-up to show a still", () =>
    page.locator("#focus-img").evaluate((i: HTMLImageElement) => /^.*\/shot\/agent-3\.jpg\?ts=/.test(i.src) && i.complete && i.naturalWidth > 0),
  );
  // The card behind the close-up polls the same still. Standing in for a
  // hidden tab stops its poll (and only its poll), so the failed capture below
  // is the close-up's and not the card's.
  // Strings, because the bundler wraps a named closure in a helper the page does not have.
  await page.evaluate(`Object.defineProperty(document, "hidden", { configurable: true, get: () => true })`);
  await page.evaluate(`(() => {
    const stage = document.getElementById("focus-stage");
    stage.blanked = false;
    new MutationObserver(() => { if (stage.classList.contains("empty")) stage.blanked = true; })
      .observe(stage, { attributes: true, attributeFilter: ["class"] });
  })()`);
  // The capture fails when the server next asks for one, once its shot cache has aged out: that is waited for.
  failShots.set("agent-3", 1);
  await until("the failing capture to be asked for", async () => !failShots.get("agent-3"));
  const before = await page.locator("#focus-img").getAttribute("src");
  // The still changes only when a capture loads, so a new one means the failed capture has been handled and passed.
  await eventually(async () => (await page.locator("#focus-img").getAttribute("src")) !== before);
  const blanked = await page.locator("#focus-stage").evaluate((n: HTMLElement & { blanked?: boolean }) => !!n.blanked);
  const after = await page.locator("#focus-img").getAttribute("src");
  check("one failed capture leaves the close-up's still on screen", !blanked, `stage went empty: ${blanked}`);
  check("...and the still carries on refreshing after it", !!after && after !== before, `${before} -> ${after}`);
  // Two in a row is a session with nothing to show, and the close-up says so.
  failShots.set("agent-3", 2);
  await until("both failing captures to be asked for", async () => !failShots.get("agent-3"));
  await until("the stage to say there is no frame", () => page.locator("#focus-stage").evaluate((n) => n.classList.contains("empty"))).catch(() => {});
  check("...while two failed captures in a row say there is no frame", await page.locator("#focus-stage").evaluate((n) => n.classList.contains("empty")));
  await page.evaluate(() => delete (document as { hidden?: boolean }).hidden);
  await page.getByTestId("live-focus-close").click();

  // The session closes while its close-up is open: its Stream button goes with it.
  await page.getByTestId("live-card-image-agent-7").click();
  await until("the close-up on agent-7", () => focusToggle.isVisible());
  setNames(names.filter((n) => n !== "agent-7"));
  await until("the close-up to say the session has closed", () =>
    page
      .locator("#focus-line")
      .textContent()
      .then((t) => t === "This session has closed."),
  );
  check("a session that closes under its close-up takes the Stream button with it", !(await focusToggle.isVisible()));
  await page.getByTestId("live-focus-close").click();
  setNames(names);
  await until("agent-7 to come back", () => page.getByTestId("live-card-agent-7").isVisible());
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
  // Sessions whose next still capture fails, and how many times.
  const failShots = new Map<string, number>();
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
    screenshot: async (session) => {
      const failing = failShots.get(session) ?? 0;
      if (failing > 0) {
        failShots.set(session, failing - 1);
        return null;
      }
      return jpeg;
    },
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
    await until("every session's stream to open", () => pushes.size === names.length);
    const pollsBefore = polls;
    const ticker = setInterval(() => {
      for (const push of pushes.values()) if (jpeg) push(jpeg);
    }, 100);
    let kept = false;
    try {
      kept = await eventually(() => polls - pollsBefore >= 2);
    } finally {
      clearInterval(ticker);
    }
    check(`with ${names.length} streams open the status poll keeps arriving`, kept, `${polls - pollsBefore} poll(s) in ${WAIT_MS} ms`);
    const src = await page.getByTestId("live-card-image-agent-7").locator("img").getAttribute("src");
    check("a streamed frame is shown from the shared connection", !!src && src.startsWith("data:image/jpeg;base64,"), String(src).slice(0, 40));
    check("one connection carries them all: no stream per image", (await page.locator("img[src*='.mjpg']").count()) === 0);

    await page.getByTestId("live-card-image-agent-0").click();
    const focusFeed = page.getByTestId("live-focus-feed");
    await until("the close-up's feed to render", () =>
      focusFeed
        .locator(".group")
        .count()
        .then((n) => n >= 2),
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
    await until("the timeline to fill from the long feed", () => ticks.count().then((n) => n > FEED_LINES));
    const drawn = await ticks.count();
    await ticks.nth(drawn - 1).click();
    await eventually(async () => (await ticks.nth(drawn - 1).getAttribute("aria-pressed")) === "true");
    check("picking a step leaves the whole run on the timeline", (await ticks.count()) === drawn, `${drawn} ticks, then ${await ticks.count()}`);
    check(
      "...and the step it picked is the one marked",
      (await ticks.nth(drawn - 1).getAttribute("aria-pressed")) === "true",
      String(await ticks.nth(drawn - 1).getAttribute("aria-pressed")),
    );
    await page.getByTestId("live-scrub-live").click();
    await eventually(async () => (await page.locator('#timeline button[aria-pressed="true"]').count()) === 0);
    check("going back to live leaves no step marked", (await page.locator('#timeline button[aria-pressed="true"]').count()) === 0);

    // The close-up's Stream button is the card's: switching it off there stops
    // the stream on both, and the choice outlasts the close-up.
    const focusToggle = page.getByTestId("live-focus-stream-toggle");
    const cardToggle = page.getByTestId("live-card-toggle-agent-0");
    check("the close-up shows its session streaming", (await focusToggle.getAttribute("aria-pressed")) === "true");
    await focusToggle.click();
    await until("the close-up's stream to stop", async () => !pushes.has("agent-0"));
    check("switching it off in the close-up switches the card off too", (await cardToggle.getAttribute("aria-pressed")) === "false");
    await page.getByTestId("live-focus-close").click();
    // The check is that closing the close-up does NOT start the stream again: there is nothing to wait for.
    await settle(ABSENT_MS);
    check("...and the choice outlasts the close-up", (await cardToggle.getAttribute("aria-pressed")) === "false" && !pushes.has("agent-0"));
    // Opening a close-up streams its session; closing it without touching the
    // button hands the card back as it was.
    await page.getByTestId("live-card-image-agent-0").click();
    await until("opening the close-up to stream it", async () => pushes.has("agent-0"));
    check("opening a close-up streams its session", (await focusToggle.getAttribute("aria-pressed")) === "true");
    await page.getByTestId("live-focus-close").click();
    await until("closing it to stop the stream it started", async () => !pushes.has("agent-0"));
    check("closing it untouched leaves the card as it was", (await cardToggle.getAttribute("aria-pressed")) === "false");

    await closeUpFollowUps(page, pushes, failShots, (next) => (names = next), names);

    // The run ends: the browsers are gone, so the page must hand over the report itself.
    names = [];
    await until("the finished panel", () => page.getByTestId("live-finished-state").isVisible());
    // The panel now asks whether the run has a page of its own before falling
    // back to the report, so the report follows it by a round trip rather than
    // arriving in the same tick.
    await until("the report to open itself", () => page.getByTestId("live-report-dialog").isVisible());
    check("the report opens by itself when the run finishes", true);
    await until("the report's file line", () =>
      page
        .getByTestId("live-report-meta")
        .textContent()
        .then((t) => /NOT saved: \/tmp\/demo\/\.scenescout\/report\.md/.test(t ?? "")),
    );
    check("...and says the report is not on disk, naming where it belongs", true, (await page.getByTestId("live-report-meta").textContent()) ?? "");
    const download = await Promise.all([page.waitForEvent("download", { timeout: WAIT_MS }), page.getByTestId("live-report-save").click()]).then((r) => r[0]);
    check("a viewer can keep a copy: the browser saves it, nothing is asked of the engine", download.suggestedFilename() === "scenescout-report.md");
    written = true;
    await until("the file line to follow scout_report writing it", () =>
      page
        .getByTestId("live-finished-where")
        .textContent()
        .then((t) => /^saved at \/tmp\/demo/.test(t ?? "")),
    );
    check("...and once the agent has written it, the page says where it is instead", true);
    await page.getByTestId("live-report-close").click();

    await page.getByTestId("live-report-toggle").click();
    const doc = page.getByTestId("live-report-doc");
    await until("the report to render", () =>
      doc
        .locator("h4")
        .count()
        .then((n) => n > 0),
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
    await until("the frames under the finding", () => shots.count().then((n) => n > 0));
    await shots.locator("summary").click();
    const shot = shots.locator("img").first();
    await until("the frame to load", () => shot.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0));
    // The panel re-reads the report every few seconds. Re-rendering an
    // unchanged document used to close whatever the reader had open. Each
    // re-read the panel has handled is counted, so the check waits for one.
    // Strings, because the bundler wraps a named closure in a helper the page does not have.
    await page.evaluate(`(() => {
      const json = Response.prototype.json;
      window.__reportReads = 0;
      Response.prototype.json = function () {
        const read = json.call(this);
        // Counted before the panel's own handler runs, in the same turn: once the count moves, that handler has run.
        if (new URL(this.url).pathname.endsWith("/api/report")) read.then(() => { window.__reportReads += 1; }, () => {});
        return read;
      };
    })()`);
    const openBefore = await shots.evaluate((d: HTMLDetailsElement) => d.open);
    await until("the panel to re-read the report", async () => Number(await page.evaluate("window.__reportReads")) > 0);
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
    await until("the viewer to land on the run's own page", () => fresh.title().then((t) => /^SceneScout run/.test(t)));
    check("a viewer arriving after the run ended is sent to the run's own page", fresh.url().endsWith("/run"), fresh.url());
    await fresh.reload();
    check("...and unlike a panel over a dead board, it is still there after a refresh", /^SceneScout run/.test(await fresh.title()), await fresh.title());
    await fresh.close();

    // The run's own page, once the engine behind it has exited: reloading the
    // address would get the browser's own error page and lose the tab.
    const run = await browser.newPage();
    // Each answer the run page's watch on the engine has handled is counted, so the check waits for the first.
    await run.addInitScript(`(() => {
      const fetchFn = window.fetch;
      window.__statusChecks = 0;
      window.fetch = function (...args) {
        const answer = fetchFn.apply(this, args);
        // Counted before the page's own handler runs, in the same turn: once the count moves, that handler has run.
        if (String(args[0]).endsWith("api/status")) answer.then(() => { window.__statusChecks += 1; }, () => { window.__statusChecks += 1; });
        return answer;
      };
    })()`);
    await run.goto(`http://127.0.0.1:${port}/${token}/run`);
    await until("the run page to hear from the engine", async () => Number(await run.evaluate("window.__statusChecks")) > 0);
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
    // Dismissing the question cancels the reload, which then never finishes: wait for the question, not the reload.
    const reloading = run.reload({ timeout: WAIT_MS }).catch(() => {});
    await eventually(() => asked);
    check("a refresh from there asks before throwing the page away", asked);
    await run.close();
    await reloading;
  } finally {
    await browser.close();
    await live.stop();
  }
}
