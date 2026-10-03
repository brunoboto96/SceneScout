/**
 * The live view: the per-session status board, and the rules the server that
 * shows it has to keep (ADR 7). Everything here runs over real HTTP against a
 * fake provider, so no browser is needed.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classify,
  feedForSession,
  formatDuration,
  formatStatus,
  localClock,
  formatSessionLine,
  FEED_LINES,
  FEED_LINES_MAX,
  LiveServer,
  SHOT_MAX_AGE_MS,
  StatusBoard,
  STUCK_AFTER_MS,
  watchTarget,
  wholeSessions,
  writeStatusFile,
  type ActivityLine,
  type LiveProvider,
  type LoggedAction,
  type StatusResponse,
  type SessionStatus,
  liveEngines,
  liveTokenFileName,
  statusFileName,
} from "../src/engine/live.ts";
import { LIVE_PAGE } from "../src/engine/live-page.ts";
import {
  countFindings,
  MCP_APP_MIME,
  paneData,
  paneText,
  STATUS_PANE_URI,
  STATUS_POLL_MS,
  STATUS_POLL_TOOL,
  STATUS_TOOL,
  type PaneFinding,
  type PaneFindings,
  type PaneInput,
} from "../src/engine/status-pane.ts";
import { statusPanePage } from "../src/engine/status-pane-page.ts";
import * as mod from "../mods/scenescout-mod/hooks/pane.js";
import {
  decideOpen,
  OPEN_CHOICES,
  OPEN_ENV,
  openableTarget,
  openChoiceFromEnv,
  openerCommand,
  openInBrowser,
  type OpenChoice,
  type OpenContext,
  type Spawner,
} from "../src/engine/open.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const T0 = Date.parse("2030-01-01T00:00:00.000Z");

function entry(session: string, over: Partial<SessionStatus> = {}): SessionStatus {
  const at = new Date(T0).toISOString();
  return { session, role: "viewer", phase: "idle", tool: "scout_snapshot", url: "http://app.test/things", since: at, at, ...over };
}

// ---- StatusBoard ---------------------------------------------------------

test("each session keeps its own entry: a second writer does not replace the first", () => {
  const board = new StatusBoard(() => T0);
  board.update("admin", { role: "admin", phase: "running", tool: "scout_click", url: "http://app.test/a" });
  board.update("viewer", { role: "viewer", phase: "idle", tool: "scout_snapshot", url: "http://app.test/b" });
  const listed = board.list();
  assert.deepEqual(
    listed.map((s) => [s.session, s.phase, s.tool]),
    [
      ["admin", "running", "scout_click"],
      ["viewer", "idle", "scout_snapshot"],
    ],
  );
});

test("`since` marks when the current phase of the current tool began", () => {
  let now = T0;
  const board = new StatusBoard(() => now);
  const fields = { role: "admin", phase: "running" as const, tool: "scout_crawl", url: "" };
  const first = board.update("admin", fields);
  now += 30_000;
  const again = board.update("admin", fields);
  assert.equal(again.since, first.since, "re-writing the same running call must not restart its clock");
  assert.notEqual(again.at, first.at);

  now += 1_000;
  const idle = board.update("admin", { ...fields, phase: "idle" });
  assert.equal(idle.since, new Date(now).toISOString(), "a phase change starts a new clock");

  now += 1_000;
  const next = board.update("admin", { ...fields, tool: "scout_click" });
  assert.equal(next.since, new Date(now).toISOString(), "so does a different tool");
});

test("list is sorted by name, and a closed session leaves it", () => {
  const board = new StatusBoard(() => T0);
  for (const name of ["qa", "admin", "viewer"]) board.update(name, { role: name, phase: "idle", tool: "scout_attach", url: "" });
  assert.deepEqual(
    board.list().map((s) => s.session),
    ["admin", "qa", "viewer"],
  );
  board.remove("qa");
  assert.equal(board.has("qa"), false);
  board.clear();
  assert.deepEqual(board.list(), []);
});

test("a call that outlives every watchdog budget reads as stuck, an idle session never does", () => {
  const since = new Date(T0).toISOString();
  assert.equal(classify({ phase: "running", since }, T0 + 5_000), "running");
  assert.equal(classify({ phase: "running", since }, T0 + STUCK_AFTER_MS), "running");
  assert.equal(classify({ phase: "running", since }, T0 + STUCK_AFTER_MS + 1), "stuck");
  assert.equal(classify({ phase: "idle", since }, T0 + STUCK_AFTER_MS * 10), "idle");
});

test("durations read the way a person would say them", () => {
  assert.equal(formatDuration(-5), "0s");
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(252_000), "4m12s");
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(3_780_000), "1h03m");
});

test("the terminal line names the session, its state and where it is", () => {
  assert.equal(
    formatSessionLine(entry("admin", { role: "admin", phase: "running", tool: "scout_click" }), T0 + 4_000),
    "admin (admin) ⏳ scout_click for 4s — http://app.test/things",
  );
  assert.match(formatSessionLine(entry("admin", { phase: "running", tool: "scout_crawl" }), T0 + STUCK_AFTER_MS + 60_000), /⚠ STUCK scout_crawl for 3m00s/);
  assert.equal(formatSessionLine(entry("viewer", { url: "" }), T0 + 12_000), "viewer (viewer) · idle 12s after scout_snapshot");
});

// ---- watchTarget ---------------------------------------------------------

test("watch explains each reason it has nowhere to send the browser", () => {
  const token = "a".repeat(32);
  const problem = (input: Parameters<typeof watchTarget>[0]): string => {
    const out = watchTarget(input);
    assert.ok("problem" in out, "expected a problem");
    return out.problem;
  };
  assert.match(problem({ status: null, alive: false, token }), /has attached to this project yet/);
  assert.match(problem({ status: { pid: 4242, live: { port: 5000 } }, alive: false, token }), /pid 4242\) is not running/);
  assert.match(problem({ status: { pid: 1 }, alive: true, token }), /SCENESCOUT_LIVE=off/);
  assert.match(problem({ status: { pid: 1, live: { port: 5000 } }, alive: true, token: null }), /token file/);
});

test("watch builds the address itself: the host is never read from the project's files", () => {
  assert.deepEqual(watchTarget({ status: { pid: 1, live: { port: 5123 } }, alive: true, token: `${"b".repeat(32)}\n` }), {
    url: `http://127.0.0.1:5123/${"b".repeat(32)}/`,
  });
  // A repository can ship its own status.json and token file. Neither may steer the URL.
  for (const port of [0, 70000, 80.5, "8080" as unknown as number]) {
    assert.ok("problem" in watchTarget({ status: { pid: 1, live: { port } }, alive: true, token: "c".repeat(32) }), `port ${String(port)}`);
  }
  for (const token of ["short", "../../etc/passwd_padding_padding", "x".repeat(20) + "@evil.test/", "y".repeat(20) + "?next=1", "z".repeat(200)]) {
    assert.ok("problem" in watchTarget({ status: { pid: 1, live: { port: 5123 } }, alive: true, token }), token);
  }
});

// ---- LiveServer ----------------------------------------------------------

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(port: number, path: string, opts: { host?: string; method?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { Host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Open a stream and resolve once `frames` parts have arrived. The caller closes it. `progress.parts` counts the parts as
 * they arrive, for a test that has to act once a viewer is watching, before the stream resolves.
 */
function openStream(
  port: number,
  path: string,
  frames: number,
  progress: { parts: number } = { parts: 0 },
): Promise<{ status: number; type: string; seen: Buffer; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let seen = Buffer.alloc(0);
      const done = (): void => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), seen, close: () => req.destroy() });
      if (res.statusCode !== 200) {
        res.resume();
        res.on("end", done);
        return;
      }
      res.on("data", (c: Buffer) => {
        seen = Buffer.concat([seen, c]);
        // Count whole parts (a JPEG's end marker, then the part's closing CRLF), not headers:
        // a header can arrive before the picture it announces.
        progress.parts = seen.toString("latin1").split("\u00ff\u00d9\r\n").length - 1;
        if (progress.parts >= frames) done();
      });
    });
    req.on("error", (err) => {
      // Destroying our own request is how a viewer leaves; it is not a failure.
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

function fakeProvider(sessions: string[], feed: ActivityLine[] = []) {
  const calls = { screenshot: 0, startStream: 0, stop: 0, activity: [] as number[] };
  let push: ((jpeg: Buffer) => void) | null = null;
  const provider: LiveProvider = {
    snapshot: () => ({ pid: 4242, version: "9.9.9", at: new Date(T0).toISOString(), sessions: sessions.map((s) => entry(s)) }),
    activity: (session, limit) => {
      calls.activity.push(limit);
      return sessions.includes(session) ? feed.slice(-limit) : [];
    },
    report: () => null,
    replay: () => null,
    frame: async () => null,
    screenshot: async (session) => {
      calls.screenshot += 1;
      return sessions.includes(session) ? JPEG : null;
    },
    startStream: async (session, onFrame) => {
      if (session === "cannot-stream") return null;
      calls.startStream += 1;
      push = onFrame;
      return async () => {
        calls.stop += 1;
        push = null;
      };
    },
  };
  return { provider, calls, frame: (jpeg: Buffer) => push?.(jpeg) };
}

/** Poll until `cond` holds. The bound only decides how long a genuine hang takes to report: a passing wait returns at once. */
async function until(label: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A fixed window, only where the check is that something did NOT happen and the server gives no signal to wait on
 * instead. A slow machine can only make it miss a late event, never fail a check that should pass.
 */
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("the server listens on loopback only", async () => {
  const live = new LiveServer(fakeProvider(["admin"]).provider);
  try {
    await live.start();
    assert.equal(live.address?.host, "127.0.0.1", "0.0.0.0 would put a signed-in page on the network");
  } finally {
    await live.stop();
  }
});

test("a wrong token, a foreign Host and any method but GET are all refused", async () => {
  const { provider, calls } = fakeProvider(["admin"]);
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    assert.ok(token.length >= 32, "the token has to be unguessable");
    const other = new LiveServer(provider);
    try {
      assert.notEqual(token, (await other.start()).token, "and different for every server");
    } finally {
      await other.stop();
    }

    assert.equal((await request(port, "/")).status, 404);
    assert.equal((await request(port, `/${"x".repeat(token.length)}/api/status`)).status, 404, "a wrong token reads the same as a wrong path");
    assert.equal((await request(port, `/${token}x/api/status`)).status, 404);

    // DNS rebinding: a hostile page resolves its own name to 127.0.0.1. The browser then sends that name as Host.
    assert.equal((await request(port, `/${token}/api/status`, { host: `evil.test:${port}` })).status, 403);
    assert.equal((await request(port, `/${token}/api/status`, { host: `127.0.0.1:${port + 1}` })).status, 403);
    assert.equal((await request(port, `/${token}/api/status`, { host: `localhost:${port}` })).status, 200);

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      assert.equal((await request(port, `/${token}/shot/admin.jpg`, { method })).status, 405, `${method} must not reach a handler`);
    }
    assert.equal(calls.screenshot, 0, "a refused request never touches the browser");
  } finally {
    await live.stop();
  }
});

test("status carries every session with its state worked out on the server", async () => {
  const at = new Date(T0).toISOString();
  const provider: LiveProvider = {
    ...fakeProvider([]).provider,
    activity: () => [],
    snapshot: () => ({
      pid: 4242,
      version: "9.9.9",
      at,
      sessions: [entry("admin", { phase: "running", tool: "scout_crawl" }), entry("viewer")],
    }),
  };
  const live = new LiveServer(provider, () => T0 + STUCK_AFTER_MS + 5_000);
  try {
    const { port, token } = await live.start();
    const reply = await request(port, `/${token}/api/status`);
    assert.equal(reply.status, 200);
    assert.match(String(reply.headers["content-type"]), /application\/json/);
    assert.equal(reply.headers["cache-control"], "no-store");
    const body = JSON.parse(reply.body.toString()) as StatusResponse;
    assert.equal(body.pid, 4242);
    assert.deepEqual(
      body.sessions.map((s) => [s.session, s.state]),
      [
        ["admin", "stuck"],
        ["viewer", "idle"],
      ],
    );
  } finally {
    await live.stop();
  }
});

test("the page is served from a directory and locked down to itself", async () => {
  const live = new LiveServer(fakeProvider(["admin"]).provider);
  try {
    const { port, token } = await live.start();
    const bare = await request(port, `/${token}`);
    assert.equal(bare.status, 302, "its requests are relative, so the bare path has to redirect");
    assert.equal(bare.headers.location, `/${token}/`);

    const page = await request(port, `/${token}/`);
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    const csp = String(page.headers["content-security-policy"]);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src 'self'/);
    assert.equal(page.headers["referrer-policy"], "no-referrer", "the token is in the address, so it must not travel in a Referer");
    assert.equal(page.body.toString(), LIVE_PAGE);
  } finally {
    await live.stop();
  }
});

test("the page never builds markup from what the app under test supplies", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  // Session names, roles and URLs come from the tested app. textContent is the only safe sink.
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(LIVE_PAGE, /https?:\/\/(?!127\.0\.0\.1)/, "no external asset: the page has to work offline and under default-src 'none'");
});

test("a thumbnail is one capture however many pollers ask, until it goes stale", async () => {
  let now = T0;
  const { provider, calls } = fakeProvider(["admin"]);
  const live = new LiveServer(provider, () => now);
  try {
    const { port, token } = await live.start();
    const replies = await Promise.all([1, 2, 3, 4].map(() => request(port, `/${token}/shot/admin.jpg?ts=1`)));
    for (const reply of replies) {
      assert.equal(reply.status, 200);
      assert.equal(reply.headers["content-type"], "image/jpeg");
      assert.deepEqual(reply.body, JPEG);
    }
    assert.equal(calls.screenshot, 1, "twenty cards polling must not mean twenty captures a second");

    now += SHOT_MAX_AGE_MS - 1;
    await request(port, `/${token}/shot/admin.jpg`);
    assert.equal(calls.screenshot, 1);
    now += 2;
    await request(port, `/${token}/shot/admin.jpg`);
    assert.equal(calls.screenshot, 2, "a stale frame is replaced");

    assert.equal((await request(port, `/${token}/shot/nobody.jpg`)).status, 404, "an unknown session is not asked for a frame");
    assert.equal((await request(port, `/${token}/shot/admin.png`)).status, 404);
    assert.equal((await request(port, `/${token}/shot/%E0%A4%A.jpg`)).status, 404, "a name that does not decode is a wrong path, not a crash");
  } finally {
    await live.stop();
  }
});

test("a stream runs only while somebody watches: first viewer starts it, last one stops it", async () => {
  const { provider, calls, frame } = fakeProvider(["admin"]);
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    // A screencast emits on repaint. A page sitting still must still show a new viewer something.
    const first = await openStream(port, `/${token}/stream/admin.mjpg`, 1);
    assert.equal(first.status, 200);
    assert.match(first.type, /^multipart\/x-mixed-replace; boundary=/);
    assert.ok(first.seen.includes(JPEG), "the first part is the current picture, not a wait for the next repaint");
    assert.equal(calls.startStream, 1);

    const secondProgress = { parts: 0 };
    const secondOpen = openStream(port, `/${token}/stream/admin.mjpg`, 2, secondProgress);
    // A viewer is sent the current picture once it is watching: from then on, a pushed frame reaches it.
    await until("the second viewer to be sent the current picture", () => secondProgress.parts >= 1);
    const pushed = Buffer.from([0xff, 0xd8, 0xff, 9, 9, 9, 0xff, 0xd9]);
    frame(pushed);
    const second = await secondOpen;
    assert.ok(second.seen.includes(pushed), "a pushed frame reaches every viewer");
    assert.equal(calls.startStream, 1, "two viewers share one screencast");

    first.close();
    // Nothing tells the test when the server has seen the first viewer go, and the check is that nothing stops.
    await settle(200);
    assert.equal(calls.stop, 0, "one viewer leaving does not stop it for the other");
    second.close();
    await until("the screencast to stop", () => calls.stop === 1);

    const again = await openStream(port, `/${token}/stream/admin.mjpg`, 1);
    assert.equal(calls.startStream, 2, "and the next viewer starts a fresh one");
    again.close();
    await until("the second screencast to stop", () => calls.stop === 2);
  } finally {
    await live.stop();
  }
});

test("a session that cannot stream answers plainly instead of hanging the image", async () => {
  const live = new LiveServer(fakeProvider(["cannot-stream"]).provider);
  try {
    const { port, token } = await live.start();
    const reply = await openStream(port, `/${token}/stream/cannot-stream.mjpg`, 1);
    assert.equal(reply.status, 503);
  } finally {
    await live.stop();
  }
});

test("stopping the server ends every stream it started", async () => {
  const { provider, calls } = fakeProvider(["admin"]);
  const live = new LiveServer(provider);
  const { port, token } = await live.start();
  const viewer = await openStream(port, `/${token}/stream/admin.mjpg`, 1);
  await live.stop();
  assert.equal(calls.stop, 1, "a screencast left running would keep a DevTools session open on the page");
  viewer.close();
  assert.equal(live.address, null);
});

// ---- the activity feed ---------------------------------------------------

const line = (over: Partial<ActivityLine> = {}): ActivityLine => ({
  at: new Date(T0).toISOString(),
  action: "click",
  target: "Save",
  url: "http://app.test/things/1",
  ...over,
});

test("a status poll carries a short feed per session, and asks for no more than it shows", async () => {
  const history = Array.from({ length: 40 }, (_, i) => line({ action: `step-${i}` }));
  const { provider, calls } = fakeProvider(["admin"], history);
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    const body = JSON.parse((await request(port, `/${token}/api/status`)).body.toString()) as { sessions: Array<{ feed: ActivityLine[] }> };
    const feed = body.sessions[0]?.feed ?? [];
    assert.equal(feed.length, FEED_LINES, "a poll every second must not ship the whole log");
    assert.equal(feed.at(-1)?.action, "step-39", "the newest line is last: the feed reads top-to-bottom like a log");
    assert.deepEqual(calls.activity, [FEED_LINES]);
  } finally {
    await live.stop();
  }
});

test("the close-up asks for a longer feed, and only for a session that exists", async () => {
  const history = Array.from({ length: FEED_LINES_MAX + 40 }, (_, i) => line({ action: `step-${i}` }));
  const { provider, calls } = fakeProvider(["admin"], history);
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    const reply = await request(port, `/${token}/api/activity?session=admin`);
    assert.equal(reply.status, 200);
    const body = JSON.parse(reply.body.toString()) as { session: string; feed: ActivityLine[] };
    assert.equal(body.session, "admin");
    assert.equal(body.feed.length, FEED_LINES_MAX, "a long run's log is thousands of lines; the page gets a bounded slice");
    assert.equal(body.feed[body.feed.length - 1].action, `step-${FEED_LINES_MAX + 39}`, "the slice kept is the recent end of the log");
    assert.deepEqual(calls.activity, [FEED_LINES_MAX]);

    assert.equal((await request(port, `/${token}/api/activity?session=nobody`)).status, 404);
    assert.equal((await request(port, `/${token}/api/activity`)).status, 404, "no session named is not a request for every session");
  } finally {
    await live.stop();
  }
});

test("the feed renderer never builds markup, because a target is text from the tested app", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const renderer = script.slice(script.indexOf("function renderFeed"), script.indexOf("function paint("));
  assert.ok(renderer.length > 100, "renderFeed should be in the page");
  assert.doesNotMatch(renderer, /innerHTML|insertAdjacentHTML/);
  assert.match(renderer, /textContent/);
});

test("a log time is shown on the reader's clock, not sliced out of the UTC timestamp", () => {
  // `scenescout status` printed the UTC slice while the page showed local time: the same action, an hour apart.
  const tz = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";
  try {
    assert.equal(localClock("2030-01-01T00:00:00.000Z"), "14:00:00");
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
  assert.equal(localClock("not a time"), "");
});

test("feed times are shown on the viewer's clock, not sliced out of the UTC timestamp", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  // The log stores ISO-8601 UTC. Slicing characters 11-19 out of it showed a
  // feed an hour off the person's own watch, which reads as a stale feed.
  assert.doesNotMatch(script, /\.at\.slice\(11/);
  assert.match(script, /getHours\(\)/);
});

test("the close-up's always-dark feed sets its own text colours", () => {
  // The panel is dark in both themes; inheriting the light theme's
  // near-black text made every action name in it invisible.
  const css = LIVE_PAGE.slice(0, LIVE_PAGE.indexOf("</style>"));
  assert.match(css, /#focus \.feed \.a \{ color: #e6e9ee; \}/);
  assert.doesNotMatch(css, /#focus \{[^}]*background: rgba\(/, "a translucent backdrop lets the cards' text show through the close-up");
});

test("a card does not label a session anonymous", () => {
  // "anonymous" means no storage-state file was given. A session that signs in
  // through the app's own login is not anonymous, and the card cannot tell.
  assert.match(LIVE_PAGE, /s\.role === 'anonymous' \? '' : s\.role/);
});

test("the close-up puts the log beside the session's objective and what it is doing now", () => {
  // Log two thirds, brief one third. Both brief fields are the agent's own
  // words — the task from scout_attach, the objective from the active journey —
  // and each says plainly when it was not given, rather than showing nothing.
  const css = LIVE_PAGE.slice(0, LIVE_PAGE.indexOf("</style>"));
  assert.match(css, /#focus \.feed \{[^}]*flex: 2 1 0/);
  assert.match(css, /#focus \.brief \{ flex: 1 1 0/);
  assert.match(LIVE_PAGE, /data-testid="live-focus-task"/);
  assert.match(LIVE_PAGE, /data-testid="live-focus-objective"/);
  assert.match(LIVE_PAGE, /An agent sets it when it attaches the session/);
  assert.match(LIVE_PAGE, /Nothing stated yet/);
});

test("the status poll carries each session's objective and current task", async () => {
  const at = new Date(T0).toISOString();
  const provider: LiveProvider = {
    ...fakeProvider([]).provider,
    activity: () => [],
    snapshot: () => ({
      pid: 1,
      version: "t",
      at,
      sessions: [entry("admin", { objective: "Approve and reject orders as a manager", task: "Clear the approvals queue", taskSince: at })],
    }),
  };
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    const s = (JSON.parse((await request(port, `/${token}/api/status`)).body.toString()) as { sessions: SessionStatus[] }).sessions[0];
    assert.equal(s?.objective, "Approve and reject orders as a manager");
    assert.equal(s?.task, "Clear the approvals queue");
  } finally {
    await live.stop();
  }
});

// ---- the feed and the journey each action served ------------------------

const logged = (session: string, action: string, over: Partial<LoggedAction> = {}): LoggedAction => ({
  at: new Date(T0).toISOString(),
  action,
  url: "http://app.test/things?token=s3cret",
  session,
  ...over,
});

test("each feed line carries the goal of the journey it was part of, and only that", () => {
  const log = [
    logged("admin", "attach"),
    logged("qa", "journey:start", { target: "Somebody else's goal" }),
    logged("admin", "journey:start", { target: "Approve an order" }),
    logged("admin", "click", { target: "Approve" }),
    logged("qa", "click", { target: "Reject" }),
    logged("admin", "journey:end", { target: "Approve an order", result: "completed" }),
    logged("admin", "snapshot"),
    logged("admin", "journey:start", { target: "Reject the other one" }),
    logged("admin", "click", { target: "Reject" }),
  ];
  const feed = feedForSession(log, "admin", 60, (u) => u.replace("s3cret", "[redacted]"));
  assert.deepEqual(
    feed.map((l) => [l.action, l.task]),
    [
      ["attach", undefined],
      ["journey:start", "Approve an order"],
      ["click", "Approve an order"],
      ["journey:end", "Approve an order"],
      ["snapshot", undefined],
      ["journey:start", "Reject the other one"],
      ["click", "Reject the other one"],
    ],
    "the qa session's lines and goal never reach the admin feed; the end line still belongs to its journey",
  );
  assert.equal(feed[0]?.url, "http://app.test/things?token=[redacted]", "the url goes through the same redaction the log uses");
});

test("a window that opens in the middle of a journey still knows which journey", () => {
  const log = [logged("admin", "journey:start", { target: "Find the broken chart" }), ...Array.from({ length: 10 }, (_, i) => logged("admin", `step-${i}`))];
  const feed = feedForSession(log, "admin", 3);
  assert.deepEqual(
    feed.map((l) => [l.action, l.task]),
    [
      ["step-7", "Find the broken chart"],
      ["step-8", "Find the broken chart"],
      ["step-9", "Find the broken chart"],
    ],
  );
  const ended = [...log, logged("admin", "journey:end", { target: "Find the broken chart" }), logged("admin", "snapshot"), logged("admin", "click")];
  assert.deepEqual(
    feedForSession(ended, "admin", 2).map((l) => l.task),
    [undefined, undefined],
    "after the end marker the lines belong to no journey",
  );
});

test("the close-up groups the feed by task and shows a hovered group's task in the brief", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const renderer = script.slice(script.indexOf("function renderFeed"), script.indexOf("function paint("));
  assert.match(renderer, /line\.task/);
  assert.match(renderer, /'group'/);
  assert.match(renderer, /mouseenter/);
  assert.match(renderer, /mouseleave/);
  assert.match(LIVE_PAGE, /id="focus-task-head"/);
  assert.match(script, /Doing, for these actions/);
  assert.match(script, /Nothing was stated for these\./);
  const css = LIVE_PAGE.slice(0, LIVE_PAGE.indexOf("</style>"));
  assert.match(css, /\.feed \.g3 \{ background: rgba\(/, "four tints, so consecutive tasks never share one");
});

// ---- frames for every watched session over one connection ----------------

/** Open the events connection and resolve once `count` events named `wanted` have arrived. */
function openEvents(
  port: number,
  path: string,
  wanted: string,
  count: number,
  events: Array<{ event: string; data: string }> = [],
): Promise<{ status: number; type: string; events: Array<{ event: string; data: string }>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let text = "";
      const done = (): void => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), events, close: () => req.destroy() });
      if (res.statusCode !== 200) {
        res.resume();
        res.on("end", done);
        return;
      }
      res.on("data", (c: Buffer) => {
        text += c.toString("utf8");
        const parts = text.split("\n\n");
        text = parts.pop() ?? "";
        for (const part of parts) {
          const event = /^event: (.*)$/m.exec(part)?.[1];
          const data = /^data: (.*)$/m.exec(part)?.[1];
          if (event && data !== undefined) events.push({ event, data });
        }
        if (events.filter((e) => e.event === wanted).length >= count) done();
      });
    });
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

test("one events connection carries frames for several sessions, each tagged with its name", async () => {
  // A browser allows about six connections to one host. A stream per <img>
  // spent them all on six sessions and the status poll queued behind them, so
  // the page froze the moment "Stream all" was pressed on a six-agent run.
  const pushes = new Map<string, (jpeg: Buffer) => void>();
  const calls = { startStream: 0, stop: 0 };
  const provider: LiveProvider = {
    ...fakeProvider(["admin", "qa", "cannot-stream"]).provider,
    startStream: async (session, onFrame) => {
      if (session === "cannot-stream") return null;
      calls.startStream += 1;
      pushes.set(session, onFrame);
      return async () => {
        calls.stop += 1;
        pushes.delete(session);
      };
    },
  };
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    const seen: Array<{ event: string; data: string }> = [];
    const opened = openEvents(port, `/${token}/events?sessions=admin%2Cqa%2Ccannot-stream%2Cadmin`, "frame", 4, seen);
    const framesSeen = () => seen.filter((e) => e.event === "frame").map((e) => JSON.parse(e.data) as { session: string; jpeg: string });
    const sent = (session: string, jpeg: Buffer) => framesSeen().some((f) => f.session === session && Buffer.from(f.jpeg, "base64").equals(jpeg));
    // Each session is sent its current picture once the connection is watching it, in list order (a name given twice
    // counts once), and the session that cannot stream, last in that list, is named unavailable: once all of that has
    // come, a pushed frame reaches its session.
    await until(
      "every session named to be answered",
      () => framesSeen().some((f) => f.session === "admin") && framesSeen().some((f) => f.session === "qa") && seen.some((e) => e.event === "unavailable"),
    );
    const adminFrame = Buffer.from([0xff, 0xd8, 0xff, 1, 0xff, 0xd9]);
    const qaFrame = Buffer.from([0xff, 0xd8, 0xff, 2, 0xff, 0xd9]);
    pushes.get("admin")?.(adminFrame);
    pushes.get("qa")?.(qaFrame);
    await until("both pushed frames to arrive", () => sent("admin", adminFrame) && sent("qa", qaFrame));
    const conn = await opened;
    assert.equal(conn.status, 200);
    assert.match(conn.type, /^text\/event-stream/);
    assert.equal(calls.startStream, 2, "a session named twice starts one screencast");
    const frames = conn.events.filter((e) => e.event === "frame").map((e) => JSON.parse(e.data) as { session: string; jpeg: string });
    assert.ok(
      frames.some((f) => f.session === "admin" && Buffer.from(f.jpeg, "base64").equals(adminFrame)),
      "admin's pushed frame arrives under admin's name",
    );
    assert.ok(
      frames.some((f) => f.session === "qa" && Buffer.from(f.jpeg, "base64").equals(qaFrame)),
      "qa's under qa's",
    );
    assert.ok(
      frames.every((f) => Buffer.from(f.jpeg, "base64")[0] === 0xff),
      "and every frame is a JPEG, so the page can show it as data:image/jpeg",
    );
    assert.deepEqual(
      conn.events.filter((e) => e.event === "unavailable").map((e) => JSON.parse(e.data)),
      [{ session: "cannot-stream" }],
      "a session that cannot stream is named, and does not spoil the others",
    );
    conn.close();
    await until("both screencasts to stop", () => calls.stop === 2);

    assert.equal((await request(port, `/${token}/events?sessions=nobody`)).status, 404, "unknown sessions only is not a connection worth holding");
    assert.equal((await request(port, `/${token}/events`)).status, 404);
  } finally {
    await live.stop();
  }
});

test("the page takes its frames from the events connection, never a stream per image", async () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  assert.match(script, /new EventSource\('events\?sessions='/);
  assert.doesNotMatch(script, /\.mjpg/, "an <img> per stream is one connection per session");
  const live = new LiveServer(fakeProvider(["admin"]).provider);
  try {
    const { port, token } = await live.start();
    const csp = String((await request(port, `/${token}/`)).headers["content-security-policy"]);
    assert.match(csp, /img-src 'self' data:/, "a frame from the connection is shown as a data: URL");
  } finally {
    await live.stop();
  }
});

// ---- the report, read while the run is going --------------------------------

test("the report is served as the run stands, and says so when there is no run", async () => {
  let markdown: string | null = null;
  const provider: LiveProvider = {
    ...fakeProvider(["admin"]).provider,
    report: () => (markdown === null ? null : { markdown, at: new Date(T0).toISOString() }),
  };
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    assert.equal((await request(port, `/${token}/api/report`)).status, 404);
    markdown = "# SceneScout Report\n\n## Findings (1)";
    const reply = await request(port, `/${token}/api/report`);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["cache-control"], "no-store", "the document changes with every finding");
    assert.deepEqual(JSON.parse(reply.body.toString()), { markdown, at: new Date(T0).toISOString() });
  } finally {
    await live.stop();
  }
});

test("the page renders the report without building markup, since a finding's title is text from the tested app", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const renderer = script.slice(script.indexOf("function renderMarkdown"), script.indexOf("function renderFeed"));
  assert.ok(renderer.length > 200, "renderMarkdown should be in the page");
  assert.doesNotMatch(renderer, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(LIVE_PAGE, /data-testid="live-report-toggle"/);
  assert.match(LIVE_PAGE, /data-testid="live-report-doc"/);
  assert.match(script, /fetch\('api\/report'/);
});

test("the report panel shows a recorded picture through the frame route and drops any other picture line", () => {
  // The two regexes are written inside a template literal with doubled
  // backslashes; read them back from the page as the browser gets them.
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const shown = /\(m = (\/\^!\\\[.*?\$\/)\.exec\(line\)\) && m\[2\]\.indexOf\('\.\.'\) < 0/.exec(script);
  const dropped = /\} else if \((\/\^!\\\[.*?\$\/)\.test\(line\)\) \{/.exec(script);
  assert.ok(shown && dropped, "both picture branches are in the page");
  const show = new Function(`return ${shown[1]};`)() as RegExp;
  const drop = new Function(`return ${dropped[1]};`)() as RegExp;
  const m = show.exec("![What the page showed](recordings/s/0001-click.jpg)");
  assert.equal(m?.[2], "recordings/s/0001-click.jpg");
  assert.match(script, /pic\.src = 'record\/' \+ m\[2\];/, "through the frame route");
  for (const other of ["![x](findings/a.png)", "![x](https://evil.test/a.png)", "![x](recordings/a b.png)"]) {
    assert.equal(show.exec(other), null, other);
    assert.match(other, drop, `${other} is dropped, not printed as text`);
  }
  assert.ok(show.test("![x](recordings/../memory.json)") && script.includes("m[2].indexOf('..') < 0"), "a path with .. is refused after the match");
});

test("the page's script parses: a backslash or backtick lost to the template literal would break every viewer", () => {
  // The page is one TypeScript template literal. A regex written with single
  // backslashes reaches the browser without them, and a stray backtick ends
  // the page early; both compile fine and fail only when the page is opened.
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>") + "<script>".length, LIVE_PAGE.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));
});

// ---- what the reviews found ------------------------------------------------

test("stuck is judged against the running tool's own watchdog budget", () => {
  // scout_crawl runs under a ten-minute watchdog. A flat two-minute rule
  // turned a healthy crawl red and told the agent to re-attach mid-crawl.
  const since = new Date(T0).toISOString();
  assert.equal(classify({ phase: "running", since, budgetMs: 600_000 }, T0 + 180_000), "running");
  assert.equal(classify({ phase: "running", since, budgetMs: 600_000 }, T0 + 601_000), "stuck", "past its own budget the watchdog should have ended it");
  assert.equal(classify({ phase: "running", since }, T0 + STUCK_AFTER_MS + 1), "stuck", "an entry without a budget keeps the default");
});

test("watch tells a truncated status file, and a live view that could not start, apart from 'never attached'", () => {
  const truncated = watchTarget({ status: "unreadable", alive: false, token: null });
  assert.match("problem" in truncated ? truncated.problem : "", /truncated/);
  const failed = watchTarget({ status: { pid: 1, live: { error: "listen EACCES 127.0.0.1" } }, alive: true, token: "x".repeat(32) });
  assert.match("problem" in failed ? failed.problem : "", /could not open the live view: listen EACCES/);
});

test("a status file caught mid-write describes only the sessions that are whole", () => {
  // status.json is written by another process. An entry without `since`
  // printed "for NaNh" and could never be judged stuck.
  const whole = entry("admin");
  assert.deepEqual(wholeSessions([whole, { session: "half", phase: "running" }, { since: whole.since }, {}]), [whole]);
  assert.deepEqual(wholeSessions(undefined), []);
  assert.doesNotMatch(formatSessionLine(whole, T0 + 1000), /NaN/);
});

/** A provider with one push per session, so a test can tell which screencast is running. */
function streamingProvider(sessions: string[]) {
  const pushes = new Map<string, (jpeg: Buffer) => void>();
  const stops: string[] = [];
  /** Sessions a screencast was asked for, in order, counted before a held start waits. */
  const asked: string[] = [];
  let gate: (() => void) | null = null;
  const provider: LiveProvider = {
    ...fakeProvider(sessions).provider,
    startStream: async (session, onFrame) => {
      asked.push(session);
      if (gate) await new Promise<void>((r) => (gate = r));
      pushes.set(session, onFrame);
      return async () => {
        stops.push(session);
        pushes.delete(session);
      };
    },
  };
  return { provider, pushes, stops, asked, hold: () => (gate = () => {}), release: () => gate?.() };
}

test("dropping a session ends its MJPEG viewer, tells its events viewers, and stops its screencast alone", async () => {
  // scout_close removed the session from the board but never told the server:
  // the screencast kept running and the viewer kept a frozen frame under LIVE.
  const { provider, pushes, stops } = streamingProvider(["admin", "qa"]);
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    let mjpegEnded = false;
    const mjpeg = http.request({ host: "127.0.0.1", port, path: `/${token}/stream/admin.mjpg`, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.on("data", () => {});
      res.on("end", () => (mjpegEnded = true));
    });
    mjpeg.on("error", () => {});
    mjpeg.end();
    const events = openEvents(port, `/${token}/events?sessions=admin,qa`, "unavailable", 1);
    await until("both screencasts to start", () => pushes.size === 2);
    live.dropSession("admin");
    await until("the MJPEG viewer to be ended", () => mjpegEnded);
    const conn = await events;
    assert.deepEqual(
      conn.events.filter((e) => e.event === "unavailable").map((e) => JSON.parse(e.data)),
      [{ session: "admin" }],
    );
    assert.deepEqual(stops, ["admin"], "qa's screencast is untouched");
    conn.close();
    await until("qa's screencast to stop with its last viewer", () => stops.length === 2);
  } finally {
    await live.stop();
  }
});

test("a viewer that disconnects while its screencast is still starting leaves nothing running", async () => {
  const { provider, stops, asked, hold, release } = streamingProvider(["admin"]);
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    hold();
    const req = http.request({ host: "127.0.0.1", port, path: `/${token}/stream/admin.mjpg`, headers: { Host: `127.0.0.1:${port}` } });
    req.on("error", () => {});
    req.end();
    await until("the screencast to be asked for, and held starting", () => asked.length === 1);
    req.destroy();
    // No signal says when the server has seen the viewer go. Either order ends in one stop, so a slow machine only
    // tries the other order (gone after the start), never fails the check.
    await settle(200);
    release();
    await until("the screencast that nobody watches to stop", () => stops.length === 1);
  } finally {
    await live.stop();
  }
});

test("the feed's follow-the-tail check is measured before the node is emptied", () => {
  // Measured after, an empty node always reads as scrolled to its end, so
  // every refresh pulled a reader back to the bottom.
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const renderer = script.slice(script.indexOf("function renderFeed"), script.indexOf("function paint("));
  assert.ok(renderer.indexOf("var atTail") < renderer.indexOf("node.textContent = ''"), "the measurement must come first");
});

test("pointing at a feed group repaints the brief without refetching the feed", () => {
  // Every third repaint refetched the long feed, which replaced the very
  // group under the pointer.
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const show = script.slice(script.indexOf("function showTask"), script.indexOf("function paintBrief"));
  assert.match(show, /paintBrief\(\)/);
  assert.doesNotMatch(show, /paintFocus|loadFullFeed/);
});

test("a session that goes away while streaming loses its LIVE tag, and a connection the browser gave up on is reopened", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const unavailable = script.slice(script.indexOf("addEventListener('unavailable'"), script.indexOf("events.onerror"));
  assert.match(unavailable, /setLive\(card, false\)/);
  assert.match(script, /EventSource\.CLOSED\) eventsKey = ''/);
});

test("the report dialog says when the report could not be loaded", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  assert.match(script, /The report could not be loaded/);
});

test("overlapping status writes never leave a torn file, and the last one wins", async () => {
  // Two writeFile calls in one tick (attach writes once the port is open and
  // again for the session) left a short document with the tail of a longer
  // one after it: "Unexpected non-whitespace character after JSON".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-status-"));
  try {
    const bodies = Array.from({ length: 30 }, (_, i) => JSON.stringify({ n: i, pad: "x".repeat((i * 37) % 400) }, null, 2));
    await Promise.all(bodies.map((b) => writeStatusFile(dir, b)));
    const onDisk = fs.readFileSync(path.join(dir, "status.json"), "utf8");
    assert.equal(onDisk, bodies[bodies.length - 1]);
    // The shared file and this engine's own, and nothing else: a leaked .tmp
    // is what this guards against.
    assert.deepEqual(fs.readdirSync(dir).sort(), [statusFileName(process.pid), "status.json"].sort(), "no temp file is left behind");
    assert.equal(fs.readFileSync(path.join(dir, statusFileName(process.pid)), "utf8"), bodies[bodies.length - 1], "both land the same body");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scenescout status describes an engine, its sessions and where to watch, and copes with an older or torn file", () => {
  const at = new Date(T0 - 5000).toISOString();
  const live = { pid: 7, phase: "idle", tool: "scout_snapshot", at, detail: [entry("admin"), { session: "half" }], live: { port: 5555 } };
  const lines = formatStatus(live, true, T0);
  assert.equal(lines[0], "Engine pid 7 — ALIVE");
  assert.equal(lines[1], "· idle after: scout_snapshot (as of 5s ago)");
  assert.equal(lines[2], "Sessions (1):", "a torn entry is left out, not printed as NaN");
  assert.match(lines[3] ?? "", /^  admin \(viewer\)/);
  assert.equal(lines[4], "Live view: scenescout watch");
  assert.doesNotMatch(lines.join("\n"), /NaN/);

  assert.deepEqual(formatStatus({ ...live, live: { error: "listen EACCES" } }, true, T0).slice(-1), ["Live view unavailable: listen EACCES"]);
  assert.ok(!formatStatus(live, false, T0).some((l) => l.startsWith("Live view")), "a dead engine has no live view to open");

  // An engine from before the live view wrote one line for the whole project.
  const legacy = formatStatus(
    { pid: 8, phase: "running", tool: "scout_crawl", session: "qa", role: "qa", sessions: ["qa", "admin"], url: "http://app.test/x" },
    true,
    T0,
  );
  assert.deepEqual(legacy.slice(1), ["⏳ running: scout_crawl", "Session: qa (qa) · all sessions: qa, admin", "URL: http://app.test/x"]);
});

// ---- the report after the run ----------------------------------------------

test("the status poll carries the report's file, so the page can say whether it exists", async () => {
  const provider: LiveProvider = {
    ...fakeProvider(["admin"]).provider,
    snapshot: () => ({ pid: 1, version: "t", at: new Date(T0).toISOString(), sessions: [], report: { path: "/p/.scenescout/report.md", written: false } }),
  };
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    const body = JSON.parse((await request(port, `/${token}/api/status`)).body.toString()) as StatusResponse;
    assert.deepEqual(body.report, { path: "/p/.scenescout/report.md", written: false });
  } finally {
    await live.stop();
  }
});

test("the page shows the report when the run ends, and warns before the only copy is closed away", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  // A run that had sessions and has none is finished: its browsers are gone,
  // and until scout_report has written the file this page is the only copy.
  // A viewer who arrives after the last browser closed sees no session at all,
  // so a named report file counts as evidence the run happened.
  assert.match(script, /if \(snap\.sessions\.length > 0 \|\| snap\.report\) sawRun = true;/);
  assert.match(script, /finished = sawRun && snap\.sessions\.length === 0;/);
  assert.match(script, /if \(!reportShown\)/, "the report opens once when the run ends");
  assert.match(LIVE_PAGE, /data-testid="live-finished-state"/);
  assert.match(LIVE_PAGE, /data-testid="live-finished-where"/);

  const guard = script.slice(script.indexOf("window.addEventListener('beforeunload'"), script.indexOf("window.addEventListener('beforeunload'") + 300);
  assert.match(
    guard,
    /if \(!finished \|\| savedACopy \|\| \(reportFile && reportFile\.written\)\) return;/,
    "no warning while the run is live, or once the report is on disk or saved",
  );
  assert.match(guard, /e\.preventDefault\(\)/);

  // The file line is the honest one: saved where, or not saved at all.
  const where = script.slice(script.indexOf("function whereItIs"), script.indexOf("function saveACopy"));
  assert.match(where, /'saved at ' \+ reportFile\.path/);
  assert.match(where, /NOT saved/);
  // Saving is the viewer's own browser, not a request to the engine.
  const save = script.slice(script.indexOf("function saveACopy"), script.indexOf("function openReport"));
  assert.match(save, /new Blob\(\[reportMarkdown\]/);
  assert.match(save, /a\.download = /);
  assert.doesNotMatch(save, /fetch\(/);
});

test("a card says what its session is doing, and says so plainly when it has not said", () => {
  // The objective was only in the close-up, so the grid — the thing a watcher
  // scans — showed six sessions with no hint of what any of them was for.
  assert.match(LIVE_PAGE, /'live-card-task-' \+ name/);
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  assert.match(script, /card\.doing\.textContent = s\.task \|\| 'not said yet';/);
  assert.match(script, /card\.doing\.className = 'doing' \+ \(s\.task \? '' : ' unset'\);/);
  const css = LIVE_PAGE.slice(0, LIVE_PAGE.indexOf("</style>"));
  assert.match(css, /\.doing\.unset \{ color: var\(--stuck\); \}/, "a session that has not said reads as a problem, not as blank space");
});

test("the feed groups by the batch objective too, not only by journeys", () => {
  // The pastel groups in the close-up are built from each line's objective.
  // Only journeys wrote a marker, so a session that states objectives the
  // ordinary way — which is now every session — had an untinted feed saying
  // nothing about why any of it happened.
  const log = [
    logged("admin", "attach"),
    logged("admin", "task", { target: "Sign in as QA_Team and check where it lands" }),
    logged("admin", "click", { target: "Sign in" }),
    logged("admin", "task", { target: "Fill the deviation form to check submit works" }),
    logged("admin", "type", { target: "Title" }),
    logged("admin", "journey:start", { target: "Raise a deviation end to end" }),
    logged("admin", "click", { target: "Submit" }),
    logged("admin", "journey:end", { target: "Raise a deviation end to end", result: "completed" }),
    logged("admin", "snapshot"),
  ];
  assert.deepEqual(
    feedForSession(log, "admin", 60).map((l) => [l.action, l.task]),
    [
      ["attach", undefined],
      ["task", "Sign in as QA_Team and check where it lands"],
      ["click", "Sign in as QA_Team and check where it lands"],
      ["task", "Fill the deviation form to check submit works"],
      ["type", "Fill the deviation form to check submit works"],
      ["journey:start", "Raise a deviation end to end"],
      ["click", "Raise a deviation end to end"],
      ["journey:end", "Raise a deviation end to end"],
      // The journey is over; the batch objective is standing again.
      ["snapshot", "Fill the deviation form to check submit works"],
    ],
  );
});

test("a window that opens mid-batch still knows the objective, and a journey still outranks it", () => {
  const before = [logged("admin", "task", { target: "Walk the approvals queue" }), ...Array.from({ length: 10 }, (_, i) => logged("admin", `step-${i}`))];
  assert.deepEqual(
    feedForSession(before, "admin", 2).map((l) => l.task),
    ["Walk the approvals queue", "Walk the approvals queue"],
  );
  const inJourney = [
    logged("admin", "task", { target: "Walk the approvals queue" }),
    logged("admin", "journey:start", { target: "Approve one order" }),
    ...Array.from({ length: 10 }, (_, i) => logged("admin", `step-${i}`)),
  ];
  assert.deepEqual(
    feedForSession(inJourney, "admin", 2).map((l) => l.task),
    ["Approve one order", "Approve one order"],
    "the journey is what is running, so it is what the group says",
  );
});

test("one pastel tint per task, and a close-up with no frame says so", () => {
  // A change of task is a change of colour, so the block of actions a task
  // covers is legible at a glance and hovering it names the task.
  const css = LIVE_PAGE.slice(0, LIVE_PAGE.indexOf("</style>"));
  for (const tint of ["g0", "g1", "g2", "g3"]) {
    assert.match(css, new RegExp(`\\.feed \\.${tint} \\{ background: rgba\\([^)]+, \\.2[0-9]?\\);`), `${tint} reads as a highlight, not a wash`);
  }
  assert.match(css, /@media \(prefers-color-scheme: light\)[\s\S]*?\.feed \.g0 \{ background: rgba/, "the tints are lifted for a light card too");
  // The card already said when it had no frame; the close-up showed a broken image.
  assert.match(LIVE_PAGE, /#focus \.stage\.empty \.none \{ display: flex; \}/);
  assert.match(LIVE_PAGE, /No frame available\. The session's page may be closed/);
});

// ---- the recorded run: its own address, and the frames under each finding ----

/** The first bytes of a PNG, which is how the route tells a finding's picture from a frame. */
const PICTURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("a recorded run is a page at its own address, and its frames are served from there", async () => {
  const asked: string[] = [];
  const provider: LiveProvider = {
    ...fakeProvider(["clerk"]).provider,
    replay: () => "<!doctype html><title>Run</title><h1>clerk</h1>",
    frame: async (rel) => {
      asked.push(rel);
      return rel === "recordings/clerk/0007-click.jpg" ? JPEG : rel === "recordings/clerk/finding-a1b2.png" ? PICTURE : null;
    },
  };
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    const page = await request(port, `/${token}/run`);
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    // The document is served under the same policy as the board: it is one
    // file, and nothing in it may fetch anything from anywhere.
    assert.match(String(page.headers["content-security-policy"]), /default-src/);
    assert.match(page.body.toString(), /clerk/);

    const shot = await request(port, `/${token}/record/recordings/clerk/0007-click.jpg`);
    assert.equal(shot.status, 200);
    assert.equal(String(shot.headers["content-type"]), "image/jpeg");
    assert.deepEqual(shot.body, JPEG);
    // A finding's picture is a PNG, and is labelled as one; the frame beside it stays a JPEG.
    const picture = await request(port, `/${token}/record/recordings/clerk/finding-a1b2.png`);
    assert.equal(picture.status, 200);
    assert.equal(String(picture.headers["content-type"]), "image/png");
    assert.deepEqual(picture.body, PICTURE);

    // A viewer may ask for anything. The server hands the path to the provider
    // whole and builds no filesystem path of its own, so an escape is the
    // provider's to refuse — and it is refused, as a plain 404.
    const out = await request(port, `/${token}/record/..%2f..%2fetc%2fpasswd`);
    assert.equal(out.status, 404);
    assert.ok(asked.includes("../../etc/passwd"), `the provider decides: ${JSON.stringify(asked)}`);
  } finally {
    await live.stop();
  }
});

test("a run with no recording has no page and no frames, rather than a broken one", async () => {
  const live = new LiveServer(fakeProvider(["clerk"]).provider);
  try {
    const { port, token } = await live.start();
    assert.equal((await request(port, `/${token}/run`)).status, 404);
    assert.equal((await request(port, `/${token}/record/recordings/clerk/0001-click.jpg`)).status, 404);
  } finally {
    await live.stop();
  }
});

test("the report carries the frames each finding was found on, and the page hangs them under it", async () => {
  const evidence = [
    {
      id: "e3aad70ee8",
      frames: [{ at: new Date(T0).toISOString(), action: "click", detail: 'button "Create order"', frame: "recordings/clerk/0006-click.jpg" }],
    },
  ];
  const provider: LiveProvider = {
    ...fakeProvider(["clerk"]).provider,
    report: () => ({ markdown: "## Findings\n", at: new Date(T0).toISOString(), evidence }),
  };
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    const body = JSON.parse((await request(port, `/${token}/api/report`)).body.toString()) as { evidence: unknown };
    assert.deepEqual(body.evidence, evidence);
  } finally {
    await live.stop();
  }

  // The panel reads that payload: a finding's id line carries its frames, and
  // each one is fetched from the run's own frame route.
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  assert.match(script, /reportEvidence = d\.evidence \|\| \[\];/);
  const shots = script.slice(script.indexOf("function evidenceFor"), script.indexOf("function renderMarkdown"));
  assert.match(shots, /img\.src = 'record\/' \+ f\.frame;/);
  assert.match(shots, /data-testid', 'live-report-evidence-'/);
  // Nothing is shown for a finding with no frames and no picture: an unrecorded run with pictures off reads as it always did.
  assert.match(shots, /if \(!found\) return null;/);
  assert.match(shots, /if \(!found\.frames\.length\) return picture;/);
  // A finding's picture is shown first, from the same route, and opens on its own.
  assert.match(shots, /pic\.src = 'record\/' \+ found\.picture\.file;/);
  assert.match(shots, /data-testid', 'live-report-picture-' \+ id/);
  assert.match(shots, /data-testid', 'live-report-picture-open'/);
  assert.ok(script.includes("/^\\*\\*Id:\\*\\* `([^`]+)`/"), "the id line is what the frames hang from");
});

test("every element the script reaches for is in the page", () => {
  // A listener left behind on a control that was replaced threw on load and
  // took the whole script with it: no polling, no cards, no finished panel —
  // a blank page, with the failure visible only in the browser's console.
  const markup = LIVE_PAGE.slice(0, LIVE_PAGE.indexOf("<script>"));
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const present = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // Only the literal lookups; the one that takes a variable is checked by its caller's tests.
  const asked = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(asked.length > 10, "the scan found the lookups");
  assert.deepEqual(
    asked.filter((id) => !present.has(id)),
    [],
    "the script asks for an element the page has not got",
  );
});

test("the timeline is drawn from the close-up's long feed, and a re-render keeps it", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  // The status poll carries FEED_LINES; the close-up asks for FEED_LINES_MAX.
  // Re-rendering the timeline from whichever was nearest to hand shrank it to
  // six ticks the moment a step was picked.
  const draw = script.slice(script.indexOf("function renderTimeline"), script.indexOf("function showStep"));
  assert.match(draw, /timelineLines = lines \|\| timelineLines;/);
  const step = script.slice(script.indexOf("function showStep"), script.indexOf("function backToLive"));
  assert.doesNotMatch(step, /latest\[focused\]/, "a step is picked from the run the timeline already holds");
  assert.match(script, /renderTimeline\(d\.feed\);/, "the long feed is what fills it");
});

// ---- several engines on one project -----------------------------------------

test("each engine writes its own status file, so a second one does not erase the first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-many-"));
  const alive = new Set([111, 222]);
  const isAlive = (pid: number): boolean => alive.has(pid);
  const write = (pid: number, at: string): void =>
    fs.writeFileSync(path.join(dir, statusFileName(pid)), JSON.stringify({ pid, at, live: { port: 5000 + pid }, detail: [] }));

  write(111, "2026-09-20T20:00:00.000Z");
  write(222, "2026-09-20T20:05:00.000Z");
  const found = liveEngines(dir, isAlive);
  assert.deepEqual(
    found.map((e) => e.pid),
    [222, 111],
    "both engines, newest first — one per pid, not last-write-wins",
  );

  // An engine that has exited is not offered as something to watch.
  alive.delete(111);
  assert.deepEqual(
    liveEngines(dir, isAlive).map((e) => e.pid),
    [222],
  );

  // A file from an engine that never wrote a pid, and an unparseable one, are skipped rather than thrown on.
  fs.writeFileSync(path.join(dir, statusFileName(333)), "{ truncated");
  assert.deepEqual(
    liveEngines(dir, isAlive).map((e) => e.pid),
    [222],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a project written by an engine from before per-pid files is still readable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-legacy-"));
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ pid: 444, at: "2026-09-20T20:00:00.000Z", live: { port: 5444 } }));
  assert.deepEqual(
    liveEngines(dir, () => true).map((e) => e.pid),
    [444],
    "the shared file is the fallback when no per-pid file exists",
  );

  // Once a per-pid file is there, the shared one is ignored: it is a copy of
  // whichever engine wrote last and would double-count it.
  fs.writeFileSync(path.join(dir, statusFileName(444)), JSON.stringify({ pid: 444, at: "2026-09-20T20:01:00.000Z", live: { port: 5444 } }));
  assert.deepEqual(
    liveEngines(dir, () => true).map((e) => e.pid),
    [444],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writing status leaves both the shared file and this engine's own", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-write-"));
  await writeStatusFile(dir, JSON.stringify({ pid: process.pid, at: new Date(T0).toISOString() }));
  assert.ok(fs.existsSync(path.join(dir, "status.json")), "readers from before this still find what they expect");
  assert.ok(fs.existsSync(path.join(dir, statusFileName(process.pid))), "and watch finds this engine by pid");
  assert.match(liveTokenFileName(process.pid), new RegExp(`^live-token\\.${process.pid}$`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a live session states what it is doing before it has done anything", () => {
  // A card that reads "Nothing stated yet" is the first thing a watcher sees
  // when a run starts, which is when they most want to know what it is for.
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  assert.match(script, /setBrief\('focus-task', s && s\.task, 'Nothing stated yet\.'\)/, "the page still has a fallback…");
  const attach = fs.readFileSync(new URL("../src/engine/browser.ts", import.meta.url), "utf8");
  assert.match(attach, /this\.setTask\(opts\.task \?\? "Attaching and taking stock", opts\.task !== undefined\)/, "…but attach no longer leaves it unset");
  // And the placeholder must not satisfy the gate that makes an agent say what
  // it is doing, or every run would proceed under it.
  assert.match(attach, /this\.journey !== null \|\| \(this\.currentTask\?\.stated \?\? false\)/);
});

// ── the board at a glance ───────────────────────────────────────────────────
// Three things the status payload already carried and nobody could see: how
// long a session has been on its current task, how many of its recent steps
// went wrong, and which session is the one you are looking for. On a board of
// eleven cards those are the questions actually being asked.

test("a card says how long the session has been on this task, and how many recent steps went wrong", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const paint = script.slice(script.indexOf("function paintPace"), script.indexOf("function openFocus"));
  // taskSince reached only the close-up before this, and a bad result was only
  // ever a red word in a feed somebody had to read line by line.
  assert.match(paint, /on this for/);
  assert.match(paint, /taskSince/);
  assert.match(paint, /steps went wrong/);
  // The line disappears rather than sitting there empty on a session that has
  // stated no task and had no trouble.
  assert.match(paint, /card\.pace\.hidden = !on && bad === 0;/);
  // Only the trouble is red: reddening the whole line made "on this for 9s"
  // read as the complaint.
  assert.match(paint, /el\('span', 'bad',/);
});

test("regression: a hidden card is actually hidden", () => {
  // Every card rule sets `display`, which beats the browser's own
  // `[hidden] { display: none }`. Filtering therefore set the attribute,
  // showed "No session matches", and left every card on screen underneath it.
  // Found by rendering the page, which no string assertion here would have
  // caught — so the rule is asserted rather than the symptom.
  const style = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<style>"), LIVE_PAGE.indexOf("</style>"));
  assert.match(style, /\[hidden\] \{ display: none !important; \}/);
});

test("trouble is counted with the same rule the feed colours red", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const counter = script.slice(script.indexOf("function troubled"), script.indexOf("function paintPace"));
  // Two rules for "this step went wrong" would drift, and the card and the
  // feed beneath it would then disagree in front of the reader.
  assert.match(counter, /BAD_RESULT\.test/);
});

test("the filter hides cards without stopping the sessions behind them", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const match = script.slice(script.indexOf("function matches"), script.indexOf("function apply(snap)"));
  // Everything the card shows is searchable: the reader looks for "the one on
  // the orders register" as often as for a session by name.
  for (const field of ["s.session", "s.role", "s.objective", "s.task", "s.url", "s.tool"]) {
    assert.ok(match.includes(field), `${field} is not searchable`);
  }
  // Hidden, not unmounted and not unsubscribed: a filtered-out session is
  // still running, still streaming and still counted in the header.
  assert.match(match, /\.root\.hidden = !keep;/);
  assert.ok(!/setLive\(|events\.close\(/.test(match), "filtering must not touch streaming");
  // A filter that matches nothing says so, rather than showing a blank page
  // that reads as "every session has gone".
  assert.match(match, /No session matches/);
});

test("the timeline can be walked from the keyboard", () => {
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  const keys = script.slice(script.indexOf("function stepBy"), script.indexOf("if (e.key !== 'Escape') return;"));
  assert.match(keys, /ArrowLeft/);
  assert.match(keys, /ArrowRight/);
  assert.match(keys, /Home/);
  assert.match(keys, /End/);
  assert.match(keys, /backToLive\(\)/, "space returns to what the session is showing now");
  // Only in the close-up, and never while the reader is typing a filter —
  // an arrow key in a text box belongs to the text box.
  assert.match(keys, /if \(focused && !reportOpen && e\.target !== document\.getElementById\('filter'\)\)/);
  assert.match(keys, /timelineLines\.length === 0/, "a run with no timeline is not walked");
});

// ---- Opening the live view and the report (engine/open.ts) ----------------

test("open: the default opens both on a local desktop session and nothing in CI, over SSH or with no display; a setting wins", () => {
  const ctx = (over: Partial<OpenContext> = {}): OpenContext => ({ env: {}, platform: "darwin", ...over });
  const cases: Array<[string, OpenChoice | undefined, OpenContext, boolean, boolean]> = [
    ["macOS desktop", undefined, ctx(), true, true],
    ["Windows desktop", undefined, ctx({ platform: "win32" }), true, true],
    ["Linux with X", undefined, ctx({ platform: "linux", env: { DISPLAY: ":0" } }), true, true],
    ["Linux with Wayland", undefined, ctx({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }), true, true],
    ["Linux with no display", undefined, ctx({ platform: "linux" }), false, false],
    ["FreeBSD with no display", undefined, ctx({ platform: "freebsd" }), false, false],
    ["CI", undefined, ctx({ env: { CI: "true" } }), false, false],
    ["CI=1 on a Linux desktop", undefined, ctx({ platform: "linux", env: { CI: "1", DISPLAY: ":0" } }), false, false],
    ["CI=false is not CI", undefined, ctx({ env: { CI: "false" } }), true, true],
    ["CI=0 is not CI", undefined, ctx({ env: { CI: "0" } }), true, true],
    ["empty CI is not CI", undefined, ctx({ env: { CI: "" } }), true, true],
    ["GITHUB_ACTIONS=true is CI", undefined, ctx({ env: { GITHUB_ACTIONS: "true" } }), false, false],
    ["macOS over SSH", undefined, ctx({ env: { SSH_CONNECTION: "10.0.0.1 5000 10.0.0.2 22" } }), false, false],
    ["Windows over SSH", undefined, ctx({ platform: "win32", env: { SSH_TTY: "/dev/pts/0" } }), false, false],
    ["Linux desktop over SSH with X forwarding", undefined, ctx({ platform: "linux", env: { DISPLAY: "localhost:10.0", SSH_CONNECTION: "a" } }), false, false],
    ["set to live", "live", ctx(), true, false],
    ["set to report", "report", ctx(), false, true],
    ["set to both, in CI", "both", ctx({ env: { CI: "true" } }), true, true],
    ["set to none on a desktop", "none", ctx(), false, false],
  ];
  for (const [name, choice, c, live, report] of cases) {
    const d = decideOpen(choice, c);
    assert.deepEqual([d.live, d.report], [live, report], name);
    assert.ok(d.why.length > 0, `${name}: says why`);
  }
});

test("open: SCENESCOUT_OPEN is read, and a value outside the choices is refused", () => {
  assert.equal(openChoiceFromEnv({}), undefined);
  assert.equal(openChoiceFromEnv({ [OPEN_ENV]: "  " }), undefined);
  for (const c of OPEN_CHOICES) assert.equal(openChoiceFromEnv({ [OPEN_ENV]: c }), c);
  assert.throws(() => openChoiceFromEnv({ [OPEN_ENV]: "yes" }), /SCENESCOUT_OPEN must be one of live, report, both, none/);
});

test("open: only a loopback address or an absolute file path is opened", () => {
  const ok = [
    "http://127.0.0.1:4567/abc123/",
    "http://localhost:80/x",
    "http://[::1]:9000/t/",
    "/srv/project/.scenescout/report.html",
    "C:\\work\\project\\.scenescout\\report.html",
  ];
  const refused = [
    "https://127.0.0.1:4567/abc/",
    "http://example.com/abc/",
    "http://127.0.0.1.example.com/abc/",
    "http://user:pass@127.0.0.1:4567/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "relative/report.html",
    "-a Calculator",
    "/srv/report.html\nrm -rf /",
    "",
  ];
  for (const t of ok) assert.equal(openableTarget(t), true, t);
  for (const t of refused) assert.equal(openableTarget(t), false, t);
});

test("open: each platform's opener is run directly, with the target as one argument", () => {
  const url = "http://127.0.0.1:4567/tok/";
  assert.deepEqual(openerCommand("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(openerCommand("linux", url), { command: "xdg-open", args: [url] });
  assert.deepEqual(openerCommand("freebsd", url), { command: "xdg-open", args: [url] });
  assert.deepEqual(openerCommand("win32", url), { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
});

test("open: the opener is spawned without a shell, detached, and a refused target spawns nothing", () => {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  let errorListener: ((err: Error) => void) | undefined;
  let unrefs = 0;
  const spawn: Spawner = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      on: (_event, listener) => {
        errorListener = listener;
      },
      unref: () => {
        unrefs++;
      },
    };
  };
  const errors: string[] = [];
  const deps = { platform: "linux" as NodeJS.Platform, spawn, onError: (why: string) => errors.push(why) };

  assert.deepEqual(openInBrowser("/srv/project/.scenescout/report.html", deps), { ok: true });
  assert.deepEqual(calls, [
    { command: "xdg-open", args: ["/srv/project/.scenescout/report.html"], options: { shell: false, stdio: "ignore", detached: true } },
  ]);
  assert.equal(unrefs, 1);
  errorListener?.(new Error("spawn xdg-open ENOENT"));
  assert.deepEqual(errors, ["xdg-open could not start: spawn xdg-open ENOENT"]);

  const refused = openInBrowser("https://example.com/", deps);
  assert.equal(refused.ok, false);
  assert.equal(calls.length, 1, "a refused target never reaches the opener");

  const throwing: Spawner = () => {
    throw new Error("EPERM");
  };
  assert.deepEqual(openInBrowser("http://127.0.0.1:1/t/", { ...deps, spawn: throwing }), { ok: false, why: "xdg-open could not start: EPERM" });
});

// ---- the run-status pane (MCP Apps) -------------------------------------------

const PANE_NOW = Date.parse("2026-10-03T10:00:00.000Z");
const paneSession = (over: Partial<SessionStatus>): SessionStatus => ({
  session: "default",
  role: "admin",
  phase: "idle",
  tool: "scout_click",
  url: "http://localhost:3000/things",
  since: new Date(PANE_NOW - 5_000).toISOString(),
  at: new Date(PANE_NOW).toISOString(),
  ...over,
});
const paneInput = (over: Partial<PaneInput> = {}): PaneInput => ({
  nowMs: PANE_NOW,
  version: "9.9.9",
  live: { port: 4321, token: "tok_abcdefghijklmnop" },
  liveError: null,
  liveOff: false,
  sessions: [],
  findings: null,
  coverage: null,
  ...over,
});
const RUN_START = "2026-10-03T09:00:00.000Z";
const finding = (severity: "high" | "medium" | "low", over: Partial<PaneFinding> = {}): PaneFinding => ({
  severity,
  foundAt: "2026-10-03T09:30:00.000Z",
  ...over,
});

test("the pane counts open defects by severity, and keeps worth-a-look, resolved and earlier runs apart", () => {
  const cases: Array<{ name: string; findings: PaneFinding[]; want: PaneFindings }> = [
    { name: "none", findings: [], want: { open: 0, high: 0, medium: 0, low: 0, thisRun: 0, worthALook: 0, resolved: 0 } },
    {
      name: "one of each severity, this run",
      findings: [finding("high"), finding("medium"), finding("low")],
      want: { open: 3, high: 1, medium: 1, low: 1, thisRun: 3, worthALook: 0, resolved: 0 },
    },
    {
      name: "an earlier run's finding is open but not this run's",
      findings: [finding("high", { foundAt: "2026-10-02T09:00:00.000Z" })],
      want: { open: 1, high: 1, medium: 0, low: 0, thisRun: 0, worthALook: 0, resolved: 0 },
    },
    {
      name: "resolved is not open, whatever its severity",
      findings: [finding("high", { status: "resolved" })],
      want: { open: 0, high: 0, medium: 0, low: 0, thisRun: 0, worthALook: 0, resolved: 1 },
    },
    {
      name: "worth a look is never counted as a defect",
      findings: [finding("medium", { tier: "worth_a_look" }), finding("medium", { status: "open" })],
      want: { open: 1, high: 0, medium: 1, low: 0, thisRun: 1, worthALook: 1, resolved: 0 },
    },
  ];
  for (const c of cases) assert.deepEqual(countFindings(c.findings, RUN_START), c.want, c.name);
});

test("the pane's data carries each session's objective, task, state and the live view's address", () => {
  const data = paneData(
    paneInput({
      sessions: [
        paneSession({ session: "a", phase: "running", tool: "scout_crawl", objective: "Cover the settings area", task: "Open each tab", budgetMs: 600_000 }),
        paneSession({ session: "b", phase: "running", since: new Date(PANE_NOW - 200_000).toISOString() }),
        paneSession({ session: "c" }),
      ],
      findings: [finding("high")],
      runStart: RUN_START,
      coverage: { routesVisited: 3, routesTotal: 8, states: 5, elementsExercised: 12, elementsTotal: 40 },
    }),
  );
  assert.equal(data.liveUrl, "http://127.0.0.1:4321/tok_abcdefghijklmnop/");
  assert.equal(data.liveNote, undefined);
  assert.equal(data.at, new Date(PANE_NOW).toISOString());
  assert.deepEqual(
    data.sessions.map((s) => [s.session, s.state, s.forMs, s.objective, s.task]),
    [
      ["a", "running", 5_000, "Cover the settings area", "Open each tab"],
      ["b", "stuck", 200_000, undefined, undefined],
      ["c", "idle", 5_000, undefined, undefined],
    ],
  );
  assert.equal(data.findings?.high, 1);
  assert.deepEqual(data.coverage, { routesVisited: 3, routesTotal: 8, states: 5, elementsExercised: 12, elementsTotal: 40 });
});

test("the pane returns only what the live view shows: the board's fields, counts and coverage, and no other token", () => {
  const data = paneData(
    paneInput({
      sessions: [paneSession({ mode: "safe-write", browser: "chromium", headed: false, budgetMs: 30_000, taskSince: new Date(PANE_NOW).toISOString() })],
      findings: [finding("low")],
      runStart: RUN_START,
    }),
  );
  assert.deepEqual(Object.keys(data).sort(), ["at", "coverage", "findings", "liveUrl", "sessions", "version"]);
  assert.deepEqual(Object.keys(data.sessions[0]).sort(), ["forMs", "role", "session", "state", "tool", "url"]);
  // The token appears once, inside the loopback address the live view already hands out.
  const json = JSON.stringify(data);
  assert.equal(json.split("tok_abcdefghijklmnop").length - 1, 1);
});

test("without a live address the pane and its text say why", () => {
  const cases: Array<{ name: string; input: Partial<PaneInput>; note: RegExp }> = [
    { name: "before the first attach", input: { live: null }, note: /starts with the first scout_attach/ },
    { name: "SCENESCOUT_LIVE=off", input: { live: null, liveOff: true }, note: /SCENESCOUT_LIVE=off/ },
    { name: "the port would not open", input: { live: null, liveError: "EADDRINUSE" }, note: /could not start: EADDRINUSE/ },
  ];
  for (const c of cases) {
    const data = paneData(paneInput(c.input));
    assert.equal(data.liveUrl, null, c.name);
    assert.match(data.liveNote ?? "", c.note, c.name);
    assert.match(paneText(data).split("\n")[0], /^Live view: not available\./, c.name);
  }
});

test("the text fallback stands alone: the address first, then sessions, findings and coverage", () => {
  const text = paneText(
    paneData(
      paneInput({
        sessions: [paneSession({ session: "lane-1", phase: "running", tool: "scout_type", task: "Fill the new-thing form", objective: "Forms" })],
        findings: [finding("high"), finding("low", { tier: "worth_a_look" })],
        runStart: RUN_START,
        coverage: { routesVisited: 2, routesTotal: 4, states: 3, elementsExercised: 9, elementsTotal: 20 },
      }),
    ),
  );
  const lines = text.split("\n");
  // The attach result's `Live view:` form, so a client that finds the address there finds it here.
  assert.match(lines[0], /^Live view: http:\/\/127\.0\.0\.1:4321\/tok_abcdefghijklmnop\/ /);
  assert.ok(lines.includes("- lane-1 (admin): running scout_type for 5s on http://localhost:3000/things"), text);
  assert.ok(lines.includes("  task: Fill the new-thing form"), text);
  assert.ok(lines.includes("  objective: Forms"), text);
  assert.ok(lines.includes("Open findings: 1 (1 high, 0 medium, 0 low), 1 this run; 1 worth a look"), text);
  assert.ok(lines.includes("Coverage: routes 2/4 · 3 states · 9/20 elements exercised"), text);
  assert.match(paneText(paneData(paneInput())), /\nNo session is attached\.$/);
});

test("the pane's page: its script parses, it loads nothing from outside, and every control has a test id", () => {
  const page = statusPanePage("9.9.9");
  const script = page.slice(page.indexOf("<script>") + "<script>".length, page.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));
  assert.ok(script.includes(JSON.stringify(STATUS_POLL_TOOL)) && script.includes(String(STATUS_POLL_MS)), "the script polls the app-only tool");
  // The resource declares no outside origin, so nothing in it may need one.
  assert.doesNotMatch(page, /\b(?:src|href)=|@import|url\(|https?:\/\/(?!127\.0\.0\.1)/);
  for (const m of page.matchAll(/<(button|a|input|select|textarea)\b[^>]*>/g)) assert.match(m[0], /data-testid="status-pane-[a-z-]+"/, m[0]);
  // It answers only its parent window, and puts data on the page as text.
  assert.ok(script.includes("event.source !== window.parent"));
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.ok(STATUS_PANE_URI.startsWith("ui://") && MCP_APP_MIME === "text/html;profile=mcp-app");
});

// ---- The optional Claude Code mod's pane and lane model ---------------------
// The mod is a plugin of its own and cannot import the engine, so the names and
// the format it copies are held equal here, and its rules run against what the
// server really returns.

type El = { type: string; props: Record<string, unknown> };
const els = {
  Box: (props: Record<string, unknown>): El => ({ type: "Box", props }),
  Text: (props: Record<string, unknown>): El => ({ type: "Text", props }),
  Link: (props: Record<string, unknown>): El => ({ type: "Link", props }),
};
function walk(node: unknown, visit: (el: El) => void): void {
  if (!node || typeof node !== "object") return;
  const el = node as El;
  visit(el);
  for (const child of (el.props?.children as unknown[] | undefined) ?? []) walk(child, visit);
}
function drawnText(tree: unknown): string[] {
  const lines: string[] = [];
  walk(tree, (el) => {
    if (el.type === "Text") lines.push((el.props.children as unknown[]).filter((c) => typeof c === "string").join(""));
  });
  return lines;
}
function drawnTypes(tree: unknown): Set<string> {
  const types = new Set<string>();
  walk(tree, (el) => types.add(el.type));
  return types;
}
function serverResult(data: ReturnType<typeof paneData>) {
  return { content: [{ type: "text", text: paneText(data) }], structuredContent: { ...data }, isError: false };
}

test("the mod polls the server's own tools at the pane's rate and formats durations the same way", () => {
  assert.equal(mod.STATUS_POLL_TOOL, STATUS_POLL_TOOL);
  assert.equal(mod.STATUS_TOOL, STATUS_TOOL);
  assert.equal(mod.POLL_MS, STATUS_POLL_MS);
  for (const ms of [-5, 0, 999, 59_999, 60_000, 185_000, 3_599_999, 3_600_000, 7_380_000]) assert.equal(mod.formatDuration(ms), formatDuration(ms), String(ms));
  // Pane and command names: letters, digits, _ and -, at most 64 characters.
  for (const name of [mod.COMMAND, mod.PANE_ID]) assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
});

test("the mod tries the configured server first, then both default names, and the pair that answered last before all", () => {
  const cases: Array<{ name: string; configured: unknown; want: string[] }> = [
    { name: "nothing configured", configured: "", want: ["scenescout", "plugin:scenescout:scenescout"] },
    { name: "absent", configured: undefined, want: ["scenescout", "plugin:scenescout:scenescout"] },
    { name: "a custom name goes first", configured: "  my-scout ", want: ["my-scout", "scenescout", "plugin:scenescout:scenescout"] },
    { name: "a default named again is not tried twice", configured: "plugin:scenescout:scenescout", want: ["plugin:scenescout:scenescout", "scenescout"] },
    { name: "not text", configured: 42, want: ["scenescout", "plugin:scenescout:scenescout"] },
  ];
  for (const c of cases) assert.deepEqual(mod.serverCandidates(c.configured), c.want, c.name);

  const servers = mod.serverCandidates("");
  assert.deepEqual(mod.callPlan(servers, null), [
    ["scenescout", STATUS_POLL_TOOL],
    ["scenescout", STATUS_TOOL],
    ["plugin:scenescout:scenescout", STATUS_POLL_TOOL],
    ["plugin:scenescout:scenescout", STATUS_TOOL],
  ]);
  const plan = mod.callPlan(servers, ["plugin:scenescout:scenescout", STATUS_TOOL]);
  assert.deepEqual(plan[0], ["plugin:scenescout:scenescout", STATUS_TOOL]);
  assert.equal(plan.length, 4, "the pair that answered is moved, not added");
});

test("the mod reads the server's result: structured data, text alone, or the error", () => {
  const data = paneData(paneInput({ sessions: [paneSession({ session: "lane-1" })], findings: [finding("high")], runStart: RUN_START }));
  const structured = mod.readResult(serverResult(data), PANE_NOW);
  assert.equal(structured.kind, "data");
  assert.deepEqual(structured.data, { ...data });

  // A host that drops structuredContent (the tool declares no output schema) still leaves the text, whose first line carries the address.
  const textOnly = mod.readResult({ content: [{ type: "text", text: paneText(data) }], isError: false }, PANE_NOW);
  assert.equal(textOnly.kind, "text");
  assert.equal(textOnly.liveUrl, "http://127.0.0.1:4321/tok_abcdefghijklmnop/");

  const cases: Array<{ name: string; result: Record<string, unknown>; error: RegExp }> = [
    { name: "the server's own error", result: { content: [{ type: "text", text: "Error: no project" }], isError: true }, error: /no project/ },
    { name: "an error with no text", result: { content: [], isError: true }, error: /reported an error/ },
    { name: "nothing at all", result: { content: [], isError: false }, error: /nothing to show/ },
    { name: "a shape that is not the pane's", result: { content: [], structuredContent: { sessions: "x" }, isError: false }, error: /nothing to show/ },
  ];
  for (const c of cases) {
    const view = mod.readResult(c.result, PANE_NOW);
    assert.equal(view.kind, "error", c.name);
    assert.match(view.error ?? "", c.error, c.name);
  }
  const none = mod.unreachable(["scenescout scout_status_poll: not connected"], PANE_NOW);
  assert.match(none.error, /^No SceneScout server answered\. Tried scenescout scout_status_poll: not connected\. /);
  assert.match(none.error, /mcp_server/);
});

test("the pane's link is the live view on localhost, and anything else is not a link", () => {
  const cases: Array<{ url: unknown; want: string | null }> = [
    { url: "http://127.0.0.1:4321/tok_abcdefghijklmnop/", want: "http://localhost:4321/tok_abcdefghijklmnop/" },
    { url: "http://127.0.0.1:4321/", want: null },
    { url: "http://evil.test:4321/tok/", want: null },
    { url: "http://127.0.0.1:4321/tok/../x", want: null },
    { url: "https://127.0.0.1:4321/tok/", want: null },
    { url: null, want: null },
  ];
  for (const c of cases) assert.equal(mod.linkHref(c.url), c.want, String(c.url));
});

test("the pane draws sessions, findings by severity, coverage and the live view, with no image and no field", () => {
  const data = paneData(
    paneInput({
      sessions: [
        paneSession({ session: "lane-1", phase: "running", tool: "scout_type", task: "Fill the new-thing form", objective: "Forms" }),
        paneSession({ session: "lane-2", phase: "running", since: new Date(PANE_NOW - 200_000).toISOString() }),
      ],
      findings: [finding("high"), finding("medium"), finding("low", { tier: "worth_a_look" })],
      runStart: RUN_START,
      coverage: { routesVisited: 2, routesTotal: 4, states: 3, elementsExercised: 9, elementsTotal: 20 },
    }),
  );
  const tree = mod.renderPane(els, mod.readResult(serverResult(data), PANE_NOW));
  const text = drawnText(tree);
  const links: El[] = [];
  walk(tree, (el) => el.type === "Link" && links.push(el));
  assert.deepEqual(
    links.map((l) => l.props),
    [{ href: "http://localhost:4321/tok_abcdefghijklmnop/", label: "Open the live view" }],
  );
  assert.ok(text.includes("http://127.0.0.1:4321/tok_abcdefghijklmnop/"), "the address the server gave is shown to copy");
  assert.ok(text.includes("Sessions (2)"), text.join("\n"));
  assert.ok(text.includes("lane-1 (admin): running scout_type for 5s"), text.join("\n"));
  assert.ok(text.includes("  task: Fill the new-thing form") && text.includes("  objective: Forms"));
  assert.ok(
    text.some((l) => l.startsWith("lane-2") && l.includes("STUCK in")),
    "a stuck session says so",
  );
  assert.ok(text.includes("Open findings 2:") && text.includes("1 high") && text.includes("1 medium") && text.includes("0 low"));
  assert.ok(text.includes("1 worth a look"));
  assert.ok(text.includes("Coverage: routes 2/4 · 3 states · 9/20 elements exercised"));
  // Box, Text and Link draw in the terminal and the Code tab alike; Image is terminal-only, and the pane takes no input.
  assert.deepEqual([...drawnTypes(tree)].sort(), ["Box", "Link", "Text"]);
});

test("the pane says why there is nothing to show: loading, no server, no session, no live view", () => {
  const cases: Array<{ name: string; view: Parameters<typeof mod.renderPane>[1]; want: RegExp }> = [
    { name: "first poll pending", view: { kind: "loading" }, want: /Asking the SceneScout server/ },
    { name: "no server answered", view: mod.unreachable([], PANE_NOW), want: /No SceneScout server answered/ },
    { name: "no session yet", view: mod.readResult(serverResult(paneData(paneInput({ live: null }))), PANE_NOW), want: /No session is attached/ },
    { name: "live view off", view: mod.readResult(serverResult(paneData(paneInput({ live: null, liveOff: true }))), PANE_NOW), want: /SCENESCOUT_LIVE=off/ },
  ];
  // Text alone, with no address: the server's own reason is shown, not a generic one.
  cases.push({
    name: "text alone, live view off",
    view: mod.readResult({ content: [{ type: "text", text: paneText(paneData(paneInput({ live: null, liveOff: true }))) }] }, PANE_NOW),
    want: /^not available\. The live view is off: SCENESCOUT_LIVE=off/,
  });
  for (const c of cases) {
    const tree = mod.renderPane(els, c.view);
    assert.ok(
      drawnText(tree).some((l) => c.want.test(l)),
      `${c.name}: ${drawnText(tree).join(" | ")}`,
    );
    assert.ok(!drawnTypes(tree).has("Link"), `${c.name}: no link without an address`);
  }
  // Text alone: the address becomes the link, and the rest of the server's lines are drawn as they are.
  const data = paneData(paneInput({ sessions: [paneSession({ session: "lane-1" })] }));
  const tree = mod.renderPane(els, mod.readResult({ content: [{ type: "text", text: paneText(data) }] }, PANE_NOW));
  const text = drawnText(tree);
  assert.ok(text.includes("1 session:"), text.join("\n"));
  let href = "";
  walk(tree, (el) => {
    if (el.type === "Link") href = String(el.props.href);
  });
  assert.equal(href, "http://localhost:4321/tok_abcdefghijklmnop/");
  // Where nothing draws, the command prints the server's own text.
  assert.equal(mod.fallbackText(mod.readResult(serverResult(data), PANE_NOW)), paneText(data));
  assert.match(mod.fallbackText(mod.unreachable([], PANE_NOW)), /No SceneScout server answered/);
});

test("the lane model is set only when configured, only on a SceneScout lane, and never on a fork", () => {
  const settings: Array<{ value: unknown; want: string | null; error?: RegExp }> = [
    { value: "", want: null },
    { value: "   ", want: null },
    { value: undefined, want: null },
    { value: "sonnet", want: "sonnet" },
    { value: " claude-sonnet-4-5 ", want: "claude-sonnet-4-5" },
    { value: "claude-opus-4-1[1m]", want: "claude-opus-4-1[1m]" },
    { value: "sonnet; rm -rf", want: null, error: /is not a model alias or id/ },
    { value: 7, want: null, error: /not text/ },
  ];
  for (const c of settings) {
    const got = mod.laneModelSetting(c.value);
    assert.equal(got.model, c.want, String(c.value));
    if (c.error) assert.match(got.error ?? "", c.error, String(c.value));
    else assert.equal(got.error, undefined, String(c.value));
  }

  const lane = { prompt: 'Attach with scout_attach { session: "orders" } and report with scout_lane_report.', fork: false };
  const spawns: Array<{ name: string; spawn: Record<string, unknown>; configured: string | null; want: string | null }> = [
    { name: "nothing configured: the default does nothing", spawn: lane, configured: null, want: null },
    { name: "a lane gets the configured model", spawn: lane, configured: "sonnet", want: "sonnet" },
    { name: "the setting wins over the planner's choice", spawn: { ...lane, model: "opus" }, configured: "sonnet", want: "sonnet" },
    { name: "already on it: no rewrite", spawn: { ...lane, model: "sonnet" }, configured: "sonnet", want: null },
    { name: "a lane named only by its report", spawn: { prompt: "Hand back scout_lane_report's object.", fork: false }, configured: "haiku", want: "haiku" },
    { name: "a subagent that is not a lane", spawn: { prompt: "Search the code for the router.", fork: false }, configured: "sonnet", want: null },
    { name: "a fork inherits whatever is set", spawn: { ...lane, fork: true }, configured: "sonnet", want: null },
  ];
  for (const c of spawns) assert.equal(mod.spawnModel(c.spawn, c.configured), c.want, c.name);
});
