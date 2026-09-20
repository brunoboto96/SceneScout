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
} from "../src/engine/live.ts";
import { LIVE_PAGE } from "../src/engine/live-page.ts";

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

/** Open a stream and resolve once `frames` parts have arrived. The caller closes it. */
function openStream(port: number, path: string, frames: number): Promise<{ status: number; type: string; seen: Buffer; close: () => void }> {
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
        if (seen.toString("latin1").split("\u00ff\u00d9\r\n").length - 1 >= frames) done();
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

async function until(label: string, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

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

    const secondOpen = openStream(port, `/${token}/stream/admin.mjpg`, 2);
    await until("the second viewer to join", () => calls.startStream === 1 && calls.screenshot >= 1);
    await new Promise((r) => setTimeout(r, 50));
    const pushed = Buffer.from([0xff, 0xd8, 0xff, 9, 9, 9, 0xff, 0xd9]);
    frame(pushed);
    const second = await secondOpen;
    assert.ok(second.seen.includes(pushed), "a pushed frame reaches every viewer");
    assert.equal(calls.startStream, 1, "two viewers share one screencast");

    first.close();
    await new Promise((r) => setTimeout(r, 50));
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
): Promise<{ status: number; type: string; events: Array<{ event: string; data: string }>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let text = "";
      const events: Array<{ event: string; data: string }> = [];
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
    const opened = openEvents(port, `/${token}/events?sessions=admin%2Cqa%2Ccannot-stream%2Cadmin`, "frame", 4);
    await until("both screencasts to start", () => pushes.size === 2);
    await new Promise((r) => setTimeout(r, 50));
    const adminFrame = Buffer.from([0xff, 0xd8, 0xff, 1, 0xff, 0xd9]);
    const qaFrame = Buffer.from([0xff, 0xd8, 0xff, 2, 0xff, 0xd9]);
    pushes.get("admin")?.(adminFrame);
    pushes.get("qa")?.(qaFrame);
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
  let gate: (() => void) | null = null;
  const provider: LiveProvider = {
    ...fakeProvider(sessions).provider,
    startStream: async (session, onFrame) => {
      if (gate) await new Promise<void>((r) => (gate = r));
      pushes.set(session, onFrame);
      return async () => {
        stops.push(session);
        pushes.delete(session);
      };
    },
  };
  return { provider, pushes, stops, hold: () => (gate = () => {}), release: () => gate?.() };
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
  const { provider, stops, hold, release } = streamingProvider(["admin"]);
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    hold();
    const req = http.request({ host: "127.0.0.1", port, path: `/${token}/stream/admin.mjpg`, headers: { Host: `127.0.0.1:${port}` } });
    req.on("error", () => {});
    req.end();
    await new Promise((r) => setTimeout(r, 50));
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
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
    assert.deepEqual(fs.readdirSync(dir), ["status.json"], "no temp file is left behind");
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

test("a recorded run is a page at its own address, and its frames are served from there", async () => {
  const asked: string[] = [];
  const provider: LiveProvider = {
    ...fakeProvider(["clerk"]).provider,
    replay: () => "<!doctype html><title>Run</title><h1>clerk</h1>",
    frame: async (rel) => {
      asked.push(rel);
      return rel === "recordings/clerk/0007-click.jpg" ? JPEG : null;
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
  // Nothing is shown for a finding with no frames: an unrecorded run reads as it always did.
  assert.match(shots, /if \(!found \|\| !found\.frames\.length\) return null;/);
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
