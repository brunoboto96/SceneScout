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
  LIVE_TOKEN_FILE,
  statusFileName,
  writeLiveToken,
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
import { CARES, CHECK_AREAS, THOROUGHNESSES, checkGuidedChoices, confirmationReason, guidedPlan, isLocalAddress } from "../src/engine/guided.ts";
import {
  ACTION_LABEL,
  ACTION_PROMPT,
  AREA_LABEL,
  CARE_EXPLAIN,
  CARE_LABEL,
  CARE_PREVIEW,
  CONFIRM_ANSWER,
  CONFIRM_COMING,
  CONFIRM_PREVIEW_HEADING,
  CONFIRM_SAYS,
  DESTRUCTIVE_NOT_OFFERED,
  ERROR_HEADING,
  ERROR_KINDS,
  HELD_BACK,
  NEEDS_YOU_SENTENCE,
  SCREEN_HEADING,
  PHASE_NOW,
  SAFETY_EXPLAINER,
  SIGN_IN_AGAIN,
  SIGN_IN_HEALTH,
  THOROUGHNESS_LABEL,
} from "../src/engine/guided-words.ts";
import { CARD_IMPACTS, cardActions as engineCardActions, cardText, errorAction, guidedProgress, nextActions } from "../src/engine/progress.ts";
import { plainCard } from "../src/engine/plain.ts";
import { AREA_FIELDS, FORM_CHOICES } from "../src/intake.ts";
import type { Finding } from "../src/engine/memory.ts";
import * as mod from "../mods/scenescout-mod/hooks/pane.js";
import * as guided from "../mods/scenescout-mod/hooks/guided.js";
import { register as registerMod } from "../mods/scenescout-mod/hooks/register.js";
import {
  COULD_NOT_OPEN,
  decideOpen,
  OPEN_CHOICES,
  OPEN_ENV,
  openableTarget,
  openChoiceFromEnv,
  openerCommand,
  openInBrowser,
  openOrSay,
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
  assert.match(script, /pic\.src = reportFramePrefix \+ m\[2\];/, "through the frame route, under the report's project");
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

test("a session dropped while its screencast is still starting has the screencast stopped once it starts", async () => {
  // A viewer that leaves is only seen after the start, so this is the one path where the start itself must stop it.
  const { provider, stops, asked, hold, release } = streamingProvider(["admin"]);
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    hold();
    const reply = request(port, `/${token}/stream/admin.mjpg`);
    await until("the screencast to be asked for, and held starting", () => asked.length === 1);
    live.dropSession("admin");
    release();
    assert.equal((await reply).status, 503, "the viewer that was waiting is told the session cannot stream");
    await until("the screencast nobody can watch to stop", () => stops.length >= 1);
    await settle(100);
    assert.deepEqual(stops, ["admin"], "stopped once, not again");
  } finally {
    await live.stop();
  }
});

test("a screencast whose stop fails is still forgotten, and the next viewer starts a fresh one", async () => {
  const { provider, calls } = fakeProvider(["admin"]);
  const failing: LiveProvider = {
    ...provider,
    startStream: async (session, onFrame, onEnd) => {
      const stop = await provider.startStream(session, onFrame, onEnd);
      return async () => {
        await stop?.();
        throw new Error("the page closed first");
      };
    },
  };
  const live = new LiveServer(failing);
  try {
    const { port, token } = await live.start();
    const first = await openStream(port, `/${token}/stream/admin.mjpg`, 1);
    first.close();
    await until("the screencast to be stopped", () => calls.stop === 1);
    const again = await openStream(port, `/${token}/stream/admin.mjpg`, 1);
    assert.equal(calls.startStream, 2);
    again.close();
    await until("the second stop", () => calls.stop === 2);
  } finally {
    await live.stop();
  }
});

test("a thumbnail that cannot be captured answers 503, and the next poll tries again", async () => {
  const { provider, calls } = fakeProvider(["admin"]);
  let fail = true;
  const flaky: LiveProvider = {
    ...provider,
    screenshot: async (session) => {
      if (fail) {
        calls.screenshot += 1;
        throw new Error("the page navigated mid-capture");
      }
      return provider.screenshot(session);
    },
  };
  const live = new LiveServer(flaky);
  try {
    const { port, token } = await live.start();
    assert.equal((await request(port, `/${token}/shot/admin.jpg`)).status, 503);
    fail = false;
    const ok = await request(port, `/${token}/shot/admin.jpg`);
    assert.equal(ok.status, 200, "a failed capture is not cached");
    assert.deepEqual(ok.body, JPEG);
    assert.equal(calls.screenshot, 2);
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

test("the live view's token files are written owner-only, whatever was at their names before", { skip: process.platform === "win32" }, async () => {
  // The token is the live view's only credential. `mode` on a write applies
  // only when the file is created, and a write follows a link: a leftover
  // token file other accounts could read kept its bits, and a link shipped at
  // the shared name sent the token into whatever file it pointed at.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-token-"));
  try {
    const victim = path.join(dir, "elsewhere.txt");
    fs.writeFileSync(victim, "not the engine's");
    fs.writeFileSync(path.join(dir, liveTokenFileName(4242)), "old", { mode: 0o644 });
    fs.chmodSync(path.join(dir, liveTokenFileName(4242)), 0o644);
    fs.symlinkSync(victim, path.join(dir, LIVE_TOKEN_FILE));

    await writeLiveToken(dir, 4242, "t".repeat(32));

    for (const name of [liveTokenFileName(4242), LIVE_TOKEN_FILE]) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      assert.ok(stat.isFile(), `${name} is a file of its own, not a link`);
      assert.equal(stat.mode & 0o777, 0o600, `${name} can be read by its owner only`);
      assert.equal(fs.readFileSync(file, "utf8"), "t".repeat(32));
    }
    assert.equal(fs.readFileSync(victim, "utf8"), "not the engine's", "the file a link pointed at is untouched");
    assert.deepEqual(fs.readdirSync(dir).sort(), ["elsewhere.txt", LIVE_TOKEN_FILE, liveTokenFileName(4242)].sort(), "no temporary file is left behind");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a shared token file left readable by others is replaced by an owner-only one", { skip: process.platform === "win32" }, async () => {
  // The per-pid name was chmod-ed after its write; the shared name never was, so a leftover one kept its bits.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-token-"));
  try {
    fs.writeFileSync(path.join(dir, LIVE_TOKEN_FILE), "old", { mode: 0o644 });
    fs.chmodSync(path.join(dir, LIVE_TOKEN_FILE), 0o644);
    await writeLiveToken(dir, 4242, "t".repeat(32));
    const stat = fs.lstatSync(path.join(dir, LIVE_TOKEN_FILE));
    assert.equal(stat.mode & 0o777, 0o600, "the shared token file can be read by its owner only");
    assert.equal(fs.readFileSync(path.join(dir, LIVE_TOKEN_FILE), "utf8"), "t".repeat(32));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "status files are written owner-only, replacing a link left at their names instead of writing through it",
  { skip: process.platform === "win32" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-status-"));
    try {
      const victim = path.join(dir, "elsewhere.txt");
      fs.writeFileSync(victim, "not the engine's");
      fs.symlinkSync(victim, path.join(dir, "status.json"));
      fs.symlinkSync(victim, path.join(dir, statusFileName(process.pid)));
      await writeStatusFile(dir, '{"pid":1}');
      for (const name of ["status.json", statusFileName(process.pid)]) {
        const stat = fs.lstatSync(path.join(dir, name));
        assert.ok(stat.isFile(), `${name} is a file of its own, not a link`);
        assert.equal(stat.mode & 0o777, 0o600, `${name} can be read by its owner only`);
        assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), '{"pid":1}');
      }
      assert.equal(fs.readFileSync(victim, "utf8"), "not the engine's", "the file a link pointed at is untouched");
      assert.deepEqual(fs.readdirSync(dir).sort(), ["elsewhere.txt", "status.json", statusFileName(process.pid)].sort(), "no temporary file is left behind");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("a token write that fails leaves no file holding the token behind", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-token-"));
  try {
    // A folder at the shared name: the rename onto it fails after the temporary file was written.
    fs.mkdirSync(path.join(dir, LIVE_TOKEN_FILE, "inside"), { recursive: true });
    await assert.rejects(writeLiveToken(dir, 4242, "t".repeat(32)));
    const left = fs.readdirSync(dir).filter((name) => name !== LIVE_TOKEN_FILE && name !== liveTokenFileName(4242));
    assert.deepEqual(left, [], "no temporary file is left behind");
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
    report: () => ({ markdown: "## Findings\n", at: new Date(T0).toISOString(), evidence, framePrefix: "record/p-0123456789ab/" }),
  };
  const live = new LiveServer(provider);
  try {
    const { port, token } = await live.start();
    const body = JSON.parse((await request(port, `/${token}/api/report`)).body.toString()) as { evidence: unknown; framePrefix: unknown };
    assert.deepEqual(body.evidence, evidence);
    assert.equal(body.framePrefix, "record/p-0123456789ab/", "the report names the project its pictures belong to");
  } finally {
    await live.stop();
  }

  // The panel reads that payload: a finding's id line carries its frames, and
  // each one is fetched from the run's own frame route.
  const script = LIVE_PAGE.slice(LIVE_PAGE.indexOf("<script>"));
  assert.match(script, /reportEvidence = d\.evidence \|\| \[\];/);
  assert.match(script, /reportFramePrefix = d\.framePrefix \|\| 'record\/';/, "an unkeyed report still reads from record/");
  const shots = script.slice(script.indexOf("function evidenceFor"), script.indexOf("function renderMarkdown"));
  assert.match(shots, /img\.src = reportFramePrefix \+ f\.frame;/);
  assert.match(shots, /data-testid', 'live-report-evidence-'/);
  // Nothing is shown for a finding with no frames and no picture: an unrecorded run with pictures off reads as it always did.
  assert.match(shots, /if \(!found\) return null;/);
  assert.match(shots, /if \(!found\.frames\.length\) return picture;/);
  // A finding's picture is shown first, from the same route, and opens on its own.
  assert.match(shots, /pic\.src = reportFramePrefix \+ found\.picture\.file;/);
  assert.match(shots, /link\.href = reportFramePrefix \+ found\.picture\.file;/, "the picture opens from the report's project too");
  assert.doesNotMatch(shots, /'record\/' \+/, "no report picture is addressed outside the report's project");
  // A change of project re-renders the panel, so no picture keeps the old project's address.
  assert.match(script, /var key = d\.markdown \+ '\\u0000' \+ JSON\.stringify\(reportEvidence\) \+ '\\u0000' \+ reportFramePrefix;/);
  // The live feed's own frames belong to the session their path names, not to the report's project.
  assert.match(script, /getElementById\('focus-img'\)\.src = 'record\/' \+ line\.frame;/);
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

test("open from the CLI: 'Could not open a browser' is said only when the opener could not start", () => {
  const url = "http://127.0.0.1:4567/tok/";
  const started =
    (onError?: (fire: (err: Error) => void) => void): Spawner =>
    () => ({
      on: (_event, listener) => onError?.(listener),
      unref: () => undefined,
    });
  const desktop = { DISPLAY: ":0" };
  const refuse: Spawner = () => {
    throw new Error("nothing is spawned when nobody would see the window");
  };
  const cases: Array<{ name: string; target: string; spawn: Spawner; said: string[]; env?: Record<string, string> }> = [
    // An opener that started and has not exited (xdg-open still running, say) is a success: nothing waits on it.
    { name: "started", target: url, spawn: started(), said: [] },
    {
      name: "not installed",
      target: url,
      spawn: started((fire) => fire(new Error("spawn xdg-open ENOENT"))),
      said: [`${COULD_NOT_OPEN} (xdg-open could not start: spawn xdg-open ENOENT)`],
    },
    {
      name: "spawn throws",
      target: url,
      spawn: () => {
        throw new Error("EPERM");
      },
      said: [`${COULD_NOT_OPEN} (xdg-open could not start: EPERM)`],
    },
    {
      name: "refused target",
      target: "https://example.com/",
      spawn: started(),
      said: [`${COULD_NOT_OPEN} (only the live view's loopback address or an absolute file path is opened)`],
    },
    // Nobody would see a window, so nothing is spawned and the reason is said rather than an opener failing silently.
    {
      name: "over SSH",
      target: url,
      env: { ...desktop, SSH_CONNECTION: "192.0.2.1 22 192.0.2.2 22" },
      spawn: refuse,
      said: [`${COULD_NOT_OPEN} (no display to show a window on)`],
    },
    { name: "no display server", target: url, env: {}, spawn: refuse, said: [`${COULD_NOT_OPEN} (no display to show a window on)`] },
    { name: "CI", target: url, env: { ...desktop, CI: "true" }, spawn: refuse, said: [`${COULD_NOT_OPEN} (a CI run)`] },
  ];
  for (const c of cases) {
    const said: string[] = [];
    openOrSay(c.target, { env: c.env ?? desktop, platform: "linux", spawn: c.spawn, say: (line) => said.push(line) });
    assert.deepEqual(said, c.said, c.name);
  }
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

/** A guided check's progress as the server builds it for the pane: one plan, one session on the forms area, one finding. */
function guidedPaneData() {
  const built = guidedPlan({ address: "https://staging.example.com", areas: ["forms", "broken-pages"], care: "look-only" }, "gp-0123456789");
  assert.ok(built.ok);
  const finding: Finding = {
    id: "0a1b2c3d4e",
    severity: "high",
    category: "false_success",
    title: "Saving a thing says it worked when it did not",
    detail: "The page shows Saved.",
    url: "https://staging.example.com/things/new",
    state: "/things/new#abc",
    repro: [],
    foundAt: new Date(PANE_NOW - 60_000).toISOString(),
    runs: 1,
  };
  const guided = guidedProgress({
    nowMs: PANE_NOW,
    plan: built.plan,
    run: { startedMs: PANE_NOW - 6 * 60_000, lastActiveMs: PANE_NOW, story: ["Opening /"], areasStarted: ["forms"], reported: false },
    sessions: [
      {
        session: "default",
        state: "running",
        tool: "scout_type",
        url: "https://staging.example.com/things/new",
        since: new Date(PANE_NOW - 5_000).toISOString(),
        area: "forms",
      },
    ],
    coverage: { routesVisited: 4, routesTotal: 9, elementsExercised: 12 },
    findings: [finding],
  });
  return paneData(paneInput({ sessions: [paneSession({ phase: "running", tool: "scout_type" })], findings: [finding], runStart: RUN_START, guided }));
}

test("the pane's data carries a guided check's progress, and none at all when no plan was built", () => {
  const data = guidedPaneData();
  const g = data.guided!;
  assert.equal(g.title, "Checking staging.example.com");
  assert.equal(g.now, "Typing into a field on /things/new");
  assert.deepEqual(
    g.areas.map((a) => [a.area, a.state]),
    [
      ["forms", "in-progress"],
      ["broken-pages", "waiting"],
    ],
  );
  assert.deepEqual(g.problems, { blocksUsers: 1, annoying: 0, cosmetic: 0, worthALook: 0 });
  assert.equal(g.latest[0].id, "0a1b2c3d4e");
  assert.ok(g.saved?.basis.startsWith("4 pages and 12 controls"), "the figure travels with its basis");
  assert.deepEqual(g.time, { usedMs: 6 * 60_000, budgetMs: 20 * 60_000 });
  // The text a client with no pane gets carries the same, the figure with its basis.
  const text = paneText(data);
  assert.ok(text.includes("Checking staging.example.com (6m of 20m). Now: Typing into a field on /things/new"), text);
  assert.ok(text.includes("  [..] Forms - "), text);
  assert.ok(text.includes("  Problems so far: 1 block users, 0 annoying, 0 cosmetic. Pages: 4 of 9."), text);
  assert.ok(text.includes(`  ${g.saved!.sentence}`), text);
  // The data is plain JSON the pane can read, with no other token than the live view's.
  assert.equal(JSON.stringify(data).split("tok_abcdefghijklmnop").length - 1, 1);
  // No guided plan: no field, so a run without one returns exactly what it did before.
  assert.ok(!("guided" in paneData(paneInput())));
  // The mod's pane still draws the data with a guided check in it.
  assert.ok(drawnText(mod.renderPane(els, mod.readResult(serverResult(data), PANE_NOW))).length > 0);
});

test("the pane's page draws a guided check: its section, cards and buttons are built as text, and buttons call only three tools", () => {
  const page = statusPanePage("9.9.9");
  const script = page.slice(page.indexOf("<script>") + "<script>".length, page.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));
  assert.match(page, /<section id="guided"[^>]*data-testid="status-pane-guided"[^>]*hidden>/);
  assert.ok(script.includes('var DIRECT_TOOLS = ["scout_cards", "scout_feedback", "scout_guided_confirm"];'));
  // A prompt button goes to the host as a message only where it says it takes one, else the words are shown.
  assert.ok(script.includes("hostCapabilities.message") && script.includes('request("ui/message"'));
  // Every button the script makes has a test id.
  const made = script.split('document.createElement("button")').length - 1;
  assert.equal(made, 1, "one place makes buttons");
  assert.ok(/b\.setAttribute\("data-testid", prefix \+ slug\(action\.label\)\)/.test(script));
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
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

// ---- The mod's guided panel ---------------------------------------------------
// Every rule of the panel lives in mods/scenescout-mod/hooks/guided.js. Its words
// are copies of the engine's, held equal here; every state is drawn from
// fixtures on every surface's element table, and every button is pressed to
// see what it asks for. `claude plugin test mods/scenescout-mod` mounts the
// same panel in Claude Code's own test kit.

type Surface = "terminal" | "desktop" | "vscode" | "mobile";
/** Each surface's element table, as the mods API declares it: a tree naming an element its surface lacks fails whole. */
const SURFACE_ELEMENTS: Record<Surface, string[]> = {
  terminal: ["Box", "Text", "Button", "Input", "Select", "Link", "Code", "Markdown", "Client", "Raster", "Image"],
  desktop: ["Box", "Text", "Button", "Input", "Select", "Svg", "Link", "Code", "Markdown", "Client"],
  vscode: ["Box", "Text", "Button", "Input", "Select", "Svg", "Link", "Code", "Markdown"],
  mobile: ["Box", "Text", "Button", "Svg", "Link", "Code", "Markdown"],
};
const SURFACES = Object.keys(SURFACE_ELEMENTS) as Surface[];
function elsFor(surface: Surface): Record<string, (props: Record<string, unknown>) => El> {
  return Object.fromEntries(SURFACE_ELEMENTS[surface].map((name) => [name, (props: Record<string, unknown>): El => ({ type: name, props })]));
}
/** Every element of a tree, with no hole in any children list. */
function elementsOf(tree: unknown): El[] {
  const out: El[] = [];
  walk(tree, (el) => {
    out.push(el);
    for (const c of (el.props?.children as unknown[] | undefined) ?? []) assert.ok(c !== null && c !== undefined, `${el.type} has an empty child`);
  });
  return out;
}
/** What a tree shows a person: Text, Button labels and Markdown. */
function shown(tree: unknown): string {
  return elementsOf(tree)
    .map((el) =>
      el.type === "Text"
        ? (el.props.children as unknown[]).join("")
        : el.type === "Button"
          ? String(el.props.label)
          : el.type === "Markdown"
            ? String(el.props.text)
            : "",
    )
    .filter(Boolean)
    .join("\n");
}
/** The checks a surface makes before it draws: the element is in its table, a Text holds strings, a Button and an Input have their keys. */
function assertDrawable(tree: unknown, surface: Surface, label: string): void {
  for (const el of elementsOf(tree)) {
    assert.ok(SURFACE_ELEMENTS[surface].includes(el.type), `${label} on ${surface}: ${el.type} is not drawn there`);
    if (el.type === "Text")
      for (const c of el.props.children as unknown[]) assert.equal(typeof c, "string", `${label} on ${surface}: a Text child is not text`);
    if (el.type === "Button") {
      assert.match(String(el.props.key), /^(guided-[a-z0-9-]+)$/, `${label}: a Button's key is its test id`);
      assert.ok(String(el.props.label).length > 0 && typeof el.props.onPress === "function", `${label}: ${String(el.props.key)}`);
    }
    if (el.type === "Input") assert.match(String(el.props.key), /^guided-[a-z0-9-]+$/);
    if (el.type === "Svg") assert.ok(String(el.props.source).length <= guided.SVG_SOURCE_MAX && String(el.props.alt).length > 0);
  }
  const keys = elementsOf(tree)
    .filter((el) => el.type === "Button")
    .map((el) => String(el.props.key));
  assert.equal(new Set(keys).size, keys.length, `${label} on ${surface}: two buttons share a key: ${keys.join(", ")}`);
}
type Acted = { type: string; payload?: Record<string, unknown> };
/** Draw a step and record what each press asks for. */
function drawGuided(
  surface: Surface,
  w: ReturnType<typeof guided.initialWizard>,
  status: { kind: string; data?: unknown; error?: string },
  picture: unknown = null,
) {
  const acts: Acted[] = [];
  const els = elsFor(surface);
  const runPane = status.kind === "data" ? mod.renderPane(els as never, status as never) : null;
  const tree = guided.renderGuided(els as never, w, { surface, status, picture: picture as never, runPane }, (type, payload) => acts.push({ type, payload }));
  const press = (key: string, value?: string) => {
    const el = elementsOf(tree).find((e) => e.props.key === key);
    assert.ok(el, `no element keyed ${key}: ${shown(tree)}`);
    if (el.type === "Input") (el.props.onSubmit as (v: string) => void)(value ?? "");
    else (el.props.onPress as () => void)();
    return acts[acts.length - 1];
  };
  return { tree, acts, press, text: shown(tree), types: new Set(elementsOf(tree).map((e) => e.type)) };
}

const GUIDED_PLAN_ID = "gp-0123456789";
const STATUS_IDLE = mod.readResult(serverResult(paneData(paneInput())), PANE_NOW);
const STATUS_RUNNING = mod.readResult(serverResult(guidedPaneData()), PANE_NOW);
function statusWith(over: Record<string, unknown>) {
  const data = guidedPaneData();
  return mod.readResult(serverResult({ ...data, guided: { ...data.guided!, ...over } } as never), PANE_NOW);
}
const STATUS_DOWN = mod.unreachable(["scenescout scout_status_poll: not connected"], PANE_NOW);
function cardFixture(id: string, over: Partial<Finding> = {}) {
  return plainCard({
    id,
    severity: "high",
    category: "false_success",
    title: "Saving a thing says it worked when it did not",
    detail: "The page shows Saved.",
    url: "https://staging.example.com/things/new",
    state: "/things/new#abc",
    repro: [],
    foundAt: new Date(PANE_NOW - 60_000).toISOString(),
    runs: 2,
    ...over,
  });
}
function wizard(over: Partial<ReturnType<typeof guided.initialWizard>> = {}) {
  return { ...guided.initialWizard(), ...over };
}
function planFor(choices: Record<string, unknown>) {
  const built = guidedPlan(choices, GUIDED_PLAN_ID);
  assert.ok(built.ok, JSON.stringify(built));
  return JSON.parse(JSON.stringify(built.plan)) as Record<string, any>;
}

test("the panel's words are the engine's, word for word", () => {
  assert.deepEqual(guided.CARES, [...CARES]);
  assert.deepEqual(guided.THOROUGHNESSES, [...THOROUGHNESSES]);
  assert.deepEqual(
    guided.PANEL_AREAS,
    CHECK_AREAS.filter((a) => a !== "tickets"),
  );
  assert.deepEqual(guided.CARE_LABEL, CARE_LABEL);
  assert.deepEqual(guided.CARE_EXPLAIN, CARE_EXPLAIN);
  assert.deepEqual(guided.CARE_PREVIEW, CARE_PREVIEW);
  assert.equal(guided.DESTRUCTIVE_NOT_OFFERED, DESTRUCTIVE_NOT_OFFERED);
  assert.deepEqual(guided.AREA_LABEL, AREA_LABEL);
  assert.deepEqual(guided.HELD_BACK, HELD_BACK);
  assert.deepEqual(guided.THOROUGHNESS_LABEL, THOROUGHNESS_LABEL);
  assert.deepEqual(guided.CONFIRM_COMING, CONFIRM_COMING);
  assert.deepEqual(guided.CONFIRM_ANSWER, CONFIRM_ANSWER);
  assert.equal(guided.CONFIRM_PREVIEW_HEADING, CONFIRM_PREVIEW_HEADING);
  assert.deepEqual(guided.SAFETY_EXPLAINER, [...SAFETY_EXPLAINER]);
  assert.equal(guided.SERVER_ERROR_SENTENCE, NEEDS_YOU_SENTENCE["server-error"]("x"));
  assert.deepEqual(guided.SCREEN_HEADING, SCREEN_HEADING);
  assert.deepEqual(guided.ERROR_HEADING, ERROR_HEADING);
  assert.deepEqual(Object.keys(guided.ERROR_HEADING), [...ERROR_KINDS]);
  assert.equal(guided.STARTING_SENTENCE, PHASE_NOW.starting);
  assert.deepEqual(guided.ACTION_LABEL, ACTION_LABEL);
  for (const k of ["stop", "recheck", "plainReport", "fileTickets"] as const) assert.equal(guided.ACTION_PROMPT[k], ACTION_PROMPT[k]);
  assert.equal(guided.ACTION_PROMPT.explain("a1b2c3d4e5"), ACTION_PROMPT.explain("a1b2c3d4e5"));
  assert.equal(guided.ACTION_PROMPT.again("a1b2c3d4e5"), ACTION_PROMPT.again("a1b2c3d4e5"));
  assert.deepEqual(guided.cardActions("a1b2c3d4e5"), engineCardActions("a1b2c3d4e5"));
  assert.deepEqual(guided.SIGN_IN_LABEL, Object.fromEntries(FORM_CHOICES.signIn.map((c) => [c.const, c.title])));
  assert.deepEqual(guided.AREA_DEFAULT, Object.fromEntries(AREA_FIELDS.map((f) => [f.area, f.default])));
  assert.deepEqual(Object.keys(guided.IMPACT_MARK).sort(), [...CARD_IMPACTS].sort());
  // The tools a button reaches are the server's own, and the same three the MCP App pane allows.
  const guideSource = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "tools", "guide.ts"), "utf8");
  assert.ok(
    guideSource.includes(`export const GUIDED_PLAN_TOOL = "${guided.PLAN_TOOL}"`) &&
      guideSource.includes(`export const GUIDED_CONFIRM_TOOL = "${guided.CONFIRM_TOOL}"`),
  );
  assert.ok(statusPanePage("9.9.9").includes(`var DIRECT_TOOLS = ${JSON.stringify(guided.DIRECT_TOOLS).replace(/,/g, ", ")};`));
  assert.equal(guided.GUIDED_COMMAND, "scenescout-guided");
});

test("the panel judges an address and a care level as the engine does", () => {
  const addresses = [
    "http://localhost:3000",
    "http://127.0.0.1/x",
    "http://[::1]:8080/",
    "https://staging.example.com",
    "http://localhost.example.com",
    "not a url",
    "",
  ];
  for (const a of addresses) assert.equal(guided.isLocalAddress(a), isLocalAddress(a), a);
  for (const care of CARES)
    for (const address of addresses) assert.equal(guided.confirmReason(care, address), confirmationReason({ care, address }), `${care} ${address}`);
});

test("the draft becomes choices the server accepts, or one sentence saying what is missing", () => {
  const d = guided.defaultDraft();
  assert.deepEqual(d, { address: "", areas: ["sign-in", "forms", "broken-pages"], journey: "", signIn: "none", care: "look-only", thoroughness: "normal" });
  const refused: Array<[string, Partial<typeof d>, RegExp]> = [
    ["no address", {}, /Type the address/],
    ["no scheme", { address: "staging.example.com" }, /starting with http/],
    ["nothing ticked", { address: "https://staging.example.com", areas: [] }, /at least one/],
    ["a journey with no sentence", { address: "https://staging.example.com", areas: ["journey"], journey: "  " }, /Describe the journey/],
  ];
  for (const [name, over, want] of refused) {
    const got = guided.choicesFromDraft({ ...d, ...over });
    assert.ok(!got.ok && want.test(got.error), name);
  }
  // Every accepted draft is accepted by the engine too, and the journey travels only with its area.
  const accepted: Array<Partial<typeof d>> = [
    { address: " https://staging.example.com " },
    {
      address: "http://localhost:3000",
      areas: ["journey", "phone"],
      journey: "Buy the cheapest item",
      care: "may-create-test-data",
      thoroughness: "thorough",
      signIn: "sso",
    },
    { address: "https://staging.example.com", areas: ["forms"], journey: "left over from before", care: "may-submit-forms" },
  ];
  for (const over of accepted) {
    const got = guided.choicesFromDraft({ ...d, ...over });
    assert.ok(got.ok, JSON.stringify(over));
    assert.ok(checkGuidedChoices(got.choices).ok, JSON.stringify(got.choices));
    assert.equal("journey" in got.choices, (got.choices.areas as string[]).includes("journey"));
  }
  assert.deepEqual(
    (guided.choicesFromDraft({ ...d, address: "http://localhost:3000", areas: ["phone", "sign-in"] }) as unknown as { choices: { areas: string[] } }).choices
      .areas,
    ["sign-in", "phone"],
    "areas in the panel's order",
  );
});

test("the wizard's own presses: steps, toggles and choices, and nothing unknown gets in", () => {
  const w = guided.initialWizard();
  assert.equal(guided.reduce(w, { type: "go", step: "configuring" }).step, "configuring");
  assert.equal(guided.reduce(w, { type: "go", step: "nowhere" }), w, "an unknown step changes nothing");
  assert.deepEqual(guided.reduce(w, { type: "toggleArea", area: "forms" }).draft.areas, ["sign-in", "broken-pages"]);
  assert.deepEqual(guided.reduce(w, { type: "toggleArea", area: "phone" }).draft.areas, ["sign-in", "forms", "broken-pages", "phone"]);
  assert.equal(guided.reduce(w, { type: "toggleArea", area: "tickets" }), w, "tickets are not offered in the panel");
  assert.equal(guided.reduce(w, { type: "care", value: "destructive" }), w, "a care level that deletes cannot be chosen");
  assert.equal(guided.reduce(w, { type: "care", value: "may-create-test-data" }).draft.care, "may-create-test-data");
  assert.equal(guided.reduce(w, { type: "thoroughness", value: "thorough" }).draft.thoroughness, "thorough");
  assert.equal(guided.reduce(w, { type: "signIn", value: "hunter2" }), w);
  assert.equal(guided.reduce(w, { type: "address", value: "x".repeat(5000) }).draft.address.length, 2048);
  const opened = guided.reduce(w, { type: "openCard", id: "0a1b2c3d4e" });
  assert.deepEqual([opened.step, opened.cardId], ["card", "0a1b2c3d4e"]);
  const reset = guided.reduce({ ...w, step: "results", planId: "gp-x", draft: { ...w.draft, care: "may-create-test-data" } }, { type: "newCheck" });
  assert.deepEqual([reset.step, reset.planId, reset.draft.care], ["configuring", null, "look-only"], "a new check starts from Look only");
  // A value an older version wrote, or none, reads back as a wizard that draws.
  assert.deepEqual(guided.wizardOf(undefined), guided.initialWizard());
  const odd = guided.wizardOf({ step: "gone", draft: { care: "destructive", areas: ["tickets", "forms"] }, notice: { tone: "loud", text: "x" } });
  assert.deepEqual([odd.step, odd.draft.care, odd.draft.areas, odd.notice], ["welcome", "look-only", ["forms"], null]);
});

test("a plan that needs the person's confirmation waits on the preview; one that needs none starts Claude", () => {
  const configuring = wizard({ step: "configuring" });
  const asks = guided.afterPlan(configuring, {
    content: [{ type: "text", text: "plan" }],
    structuredContent: planFor({ address: "https://staging.example.com", areas: ["forms"], care: "may-create-test-data" }),
  });
  assert.equal(asks.wizard.step, "confirm");
  assert.equal(asks.send, undefined, "nothing reaches Claude before the person answers");
  const local = guided.afterPlan(configuring, { structuredContent: planFor({ address: "http://localhost:3000", areas: ["forms"], care: "may-submit-forms" }) });
  assert.equal(local.wizard.step, "running");
  assert.equal(local.send, `Run the SceneScout guided plan ${GUIDED_PLAN_ID}: call scout_guided_plan {planId: "${GUIDED_PLAN_ID}"} and follow it.`);
  assert.equal(local.wizard.lastChoices?.address, "http://localhost:3000", "kept for Run again");
  const refused = guided.afterPlan(configuring, { isError: true, content: [{ type: "text", text: "Error: the address must start with http:// or https://" }] });
  assert.deepEqual([refused.wizard.step, refused.wizard.notice], ["configuring", { tone: "error", text: "The address must start with http:// or https://" }]);
  assert.equal(refused.send, undefined);
});

test("only the person's yes in the server's form starts a check that writes", () => {
  const plan = planFor({ address: "https://staging.example.com", areas: ["forms"], care: "may-create-test-data" });
  const w = wizard({ step: "confirm", planId: GUIDED_PLAN_ID, plan, busy: "confirm" });
  const answer = (outcome: string, accepted: boolean) => ({
    content: [{ type: "text", text: "..." }],
    structuredContent: { planId: GUIDED_PLAN_ID, accepted, outcome, tellPerson: CONFIRM_SAYS[outcome as keyof typeof CONFIRM_SAYS], mode: "safe-write" },
  });
  const yes = guided.afterConfirm(w, answer("accepted", true));
  assert.equal(yes.wizard.step, "running");
  assert.ok(yes.send?.includes(GUIDED_PLAN_ID));
  for (const outcome of ["went-back", "wrong-code", "declined", "cancelled", "unsupported"]) {
    const no = guided.afterConfirm(w, answer(outcome, false));
    assert.equal(no.send, undefined, outcome);
    assert.deepEqual([no.wizard.step, no.wizard.notice?.text], ["confirm", CONFIRM_SAYS[outcome as keyof typeof CONFIRM_SAYS]], outcome);
  }
  // A form the panel's own call could not show goes to Claude, whose call shows the same form; Claude starts only on an accepted plan.
  const failed = guided.afterConfirm(w, answer("failed", false));
  assert.match(failed.send ?? "", /call scout_guided_confirm \{planId: "gp-0123456789"\}\. Only if it says the plan is accepted/);
  const broke = guided.afterConfirm(w, { isError: true, content: [{ type: "text", text: "Error: this server holds no guided plan with that id" }] });
  assert.equal(broke.send, undefined);
});

test("every panel state draws on every surface: fields where the surface has them, buttons alone on mobile", () => {
  const cards = [cardFixture("0a1b2c3d4e"), cardFixture("1b2c3d4e5f", { severity: "low", title: "A label is cut off" })];
  const remotePlan = planFor({ address: "https://staging.example.com", areas: ["forms"], care: "may-submit-forms" });
  const states: Array<{ name: string; w: ReturnType<typeof wizard>; status: any; want: RegExp; picture?: unknown }> = [
    { name: "welcome", w: wizard(), status: STATUS_IDLE, want: /Find what is broken/ },
    {
      name: "welcome, a check going",
      w: wizard({ lastChoices: { address: "https://staging.example.com", care: "look-only" } }),
      status: STATUS_RUNNING,
      want: /A check is going/,
    },
    {
      name: "configuring",
      w: wizard({
        step: "configuring",
        draft: { ...guided.defaultDraft(), areas: ["forms", "journey"], care: "may-submit-forms", address: "https://x.example.com" },
      }),
      status: STATUS_IDLE,
      want: /How careful/,
    },
    {
      name: "confirm, creating data",
      w: wizard({
        step: "confirm",
        planId: GUIDED_PLAN_ID,
        plan: planFor({ address: "https://staging.example.com", areas: ["forms"], care: "may-create-test-data" }),
      }),
      status: STATUS_IDLE,
      want: /type the code/,
    },
    {
      name: "confirm, waiting for the form",
      w: wizard({ step: "confirm", planId: GUIDED_PLAN_ID, plan: remotePlan, busy: "confirm" }),
      status: STATUS_IDLE,
      want: /A form has opened/,
    },
    {
      name: "confirm, turned down",
      w: wizard({ step: "confirm", planId: GUIDED_PLAN_ID, plan: remotePlan, notice: { tone: "error", text: CONFIRM_SAYS.declined } }),
      status: STATUS_IDLE,
      want: /Run it as "Look only"/,
    },
    { name: "running, before the first poll", w: wizard({ step: "running", planId: "gp-9999999999" }), status: STATUS_IDLE, want: /Getting ready to start/ },
    { name: "running", w: wizard({ step: "running", planId: GUIDED_PLAN_ID }), status: STATUS_RUNNING, want: /Checking staging\.example\.com · 6m of 20m/ },
    {
      name: "running, it needs the person",
      w: wizard({ step: "running", planId: GUIDED_PLAN_ID }),
      status: statusWith({
        phase: "needs-you",
        needsYou: {
          kind: "stuck",
          sentence: "A step is taking much longer than it should.",
          actions: [{ kind: "prompt", label: "Stop", text: ACTION_PROMPT.stop }],
        },
      }),
      want: /I need you/,
    },
    {
      name: "finished",
      w: wizard({ step: "running", planId: GUIDED_PLAN_ID, lastChoices: { address: "https://staging.example.com" } }),
      status: statusWith({ phase: "done", next: nextActions("done") }),
      want: /Run again/,
    },
    { name: "results", w: wizard({ step: "results", cards, cardsTotal: 2 }), status: STATUS_IDLE, want: /Results · 2 problems/ },
    { name: "results, none", w: wizard({ step: "results", cards: [], cardsTotal: 0 }), status: STATUS_IDLE, want: /No problems to show/ },
    {
      name: "card",
      w: wizard({ step: "card", cards, cardId: "0a1b2c3d4e", pictureFiles: { "0a1b2c3d4e": "/home/u/site/.scenescout/shots/a b.png" } }),
      status: STATUS_RUNNING,
      want: /What was expected/,
      picture: { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', width: 10, height: 10 },
    },
    { name: "card not loaded", w: wizard({ step: "card", cardId: "ffffffffff" }), status: STATUS_IDLE, want: /No problem with id ffffffffff/ },
    { name: "safety", w: wizard({ step: "safety" }), status: STATUS_DOWN, want: /never asks for your password/ },
    { name: "server down", w: wizard({ step: "welcome" }), status: STATUS_DOWN, want: /could not reach the SceneScout server/ },
  ];
  for (const s of states)
    for (const surface of SURFACES) {
      const drawn = drawGuided(surface, s.w, s.status, s.picture);
      assertDrawable(drawn.tree, surface, s.name);
      assert.match(
        drawn.text,
        surface === "mobile" && s.name === "configuring" ? /type the address in the message box/ : s.want,
        `${s.name} on ${surface}: ${drawn.text}`,
      );
      if (surface === "mobile") assert.ok(!drawn.types.has("Input") && !drawn.types.has("Select"), `${s.name}: mobile draws no field`);
    }
  // The configuring step types into fields where it can, and sends mobile to the message box.
  assert.ok(drawGuided("desktop", states[2].w, STATUS_IDLE).types.has("Input"));
  assert.match(drawGuided("mobile", states[2].w, STATUS_IDLE).text, /type the address in the message box/);
  // The picture probe is drawn only where Svg is, and the links are there either way.
  const card = states.find((s) => s.name === "card")!;
  for (const surface of SURFACES) {
    const drawn = drawGuided(surface, card.w, card.status, card.picture);
    assert.equal(drawn.types.has("Svg"), surface !== "terminal", surface);
    assert.ok(drawn.text.includes("[See picture](file:///home/u/site/.scenescout/shots/a%20b.png)"), drawn.text);
    assert.ok(drawn.text.includes("[See it in the live view](http://localhost:4321/tok_abcdefghijklmnop/)"), drawn.text);
  }
  // A running check shows what the run pane shows, too.
  assert.match(drawGuided("terminal", states[7].w, STATUS_RUNNING).text, /Open findings/);
});

test("each button asks for what it says: the server, Claude, or another step", () => {
  const cards = [cardFixture("0a1b2c3d4e")];
  const welcome = drawGuided("desktop", wizard(), STATUS_RUNNING);
  assert.deepEqual(welcome.press("guided-welcome-check"), { type: "newCheck", payload: undefined });
  assert.deepEqual(welcome.press("guided-welcome-safety"), { type: "go", payload: { step: "safety" } });
  assert.deepEqual(welcome.press("guided-welcome-follow"), { type: "follow", payload: { planId: GUIDED_PLAN_ID } });
  assert.deepEqual(drawGuided("mobile", wizard(), STATUS_IDLE).press("guided-welcome-check"), { type: "mobileCheck", payload: undefined });

  const config = drawGuided("terminal", wizard({ step: "configuring" }), STATUS_IDLE);
  assert.deepEqual(config.press("guided-config-address", "https://staging.example.com"), {
    type: "address",
    payload: { value: "https://staging.example.com" },
  });
  assert.deepEqual(config.press("guided-config-area-phone"), { type: "toggleArea", payload: { area: "phone" } });
  assert.deepEqual(config.press("guided-config-care-may-create-test-data"), { type: "care", payload: { value: "may-create-test-data" } });
  assert.deepEqual(config.press("guided-config-start"), { type: "build", payload: undefined });
  assert.ok(
    !config.text.includes("destructive") && !/delete data/.test(config.text.split(DESTRUCTIVE_NOT_OFFERED).join("")),
    "no care level that deletes is offered",
  );

  const plan = planFor({ address: "https://staging.example.com", areas: ["forms"], care: "may-create-test-data" });
  const confirm = drawGuided("desktop", wizard({ step: "confirm", planId: GUIDED_PLAN_ID, plan }), STATUS_IDLE);
  assert.deepEqual(confirm.press("guided-confirm-yes"), { type: "confirm", payload: undefined });
  assert.deepEqual(confirm.press("guided-confirm-back"), { type: "go", payload: { step: "configuring" } });
  const yes = elementsOf(confirm.tree).find((e) => e.props.key === "guided-confirm-yes")!;
  assert.equal(yes.props.label, CONFIRM_ANSWER.testCopy);
  const back = elementsOf(confirm.tree).find((e) => e.props.key === "guided-confirm-back")!;
  assert.equal(back.props.autoFocus, true, "Go back holds the focus, so Enter alone accepts nothing");
  for (const line of CARE_PREVIEW["may-create-test-data"]) assert.ok(confirm.text.includes(line));
  // Waiting on the form, there is no second yes to press.
  assert.ok(
    !elementsOf(drawGuided("desktop", wizard({ step: "confirm", planId: GUIDED_PLAN_ID, plan, busy: "confirm" }), STATUS_IDLE).tree).some(
      (e) => e.props.key === "guided-confirm-yes",
    ),
  );

  const running = drawGuided("desktop", wizard({ step: "running", planId: GUIDED_PLAN_ID }), STATUS_RUNNING);
  assert.deepEqual(running.press("guided-running-see-all-problems"), { type: "cards", payload: undefined });
  assert.deepEqual(running.press("guided-running-stop"), { type: "send", payload: { text: ACTION_PROMPT.stop } });
  assert.deepEqual(running.press("guided-running-card-0a1b2c3d4e"), { type: "openCard", payload: { id: "0a1b2c3d4e", surface: "desktop" } });

  const card = drawGuided("vscode", wizard({ step: "card", cards, cardId: "0a1b2c3d4e" }), STATUS_IDLE);
  assert.deepEqual(card.press("guided-card-not-a-bug"), { type: "feedback", payload: { id: "0a1b2c3d4e", verdict: "not-a-bug" } });
  assert.deepEqual(card.press("guided-card-explain-more"), { type: "send", payload: { text: ACTION_PROMPT.explain("0a1b2c3d4e") } });
  assert.deepEqual(card.press("guided-card-check-again"), { type: "send", payload: { text: ACTION_PROMPT.again("0a1b2c3d4e") } });
  assert.deepEqual(card.press("guided-card-back"), { type: "go", payload: { step: "results" } });
  // A card the person already marked not a bug offers no second Not a bug.
  const marked = [{ ...cards[0], feedback: { verdict: "not-a-bug", at: "2026-10-03T10:00:00.000Z" } }];
  assert.ok(
    !elementsOf(drawGuided("vscode", wizard({ step: "card", cards: marked, cardId: "0a1b2c3d4e" }), STATUS_IDLE).tree).some(
      (e) => e.props.key === "guided-card-not-a-bug",
    ),
  );

  const results = drawGuided("mobile", wizard({ step: "results", cards, cardsTotal: 1, lastChoices: { address: "https://staging.example.com" } }), STATUS_IDLE);
  assert.deepEqual(results.press("guided-results-recheck"), { type: "send", payload: { text: ACTION_PROMPT.recheck } });
  assert.deepEqual(results.press("guided-results-again"), { type: "runAgain", payload: undefined });
  assert.ok(!elementsOf(results.tree).some((e) => e.props.key === "guided-results-new"), "mobile cannot type a new address");
  // Filing tickets is a turn for Claude, which previews them; the server's own form, listing them, is where the person says yes.
  assert.deepEqual(results.press("guided-results-file-tickets"), { type: "send", payload: { text: ACTION_PROMPT.fileTickets } });
  assert.match(ACTION_PROMPT.fileTickets, /scout_ticket_preview.*scout_ticket_file/);
  assert.equal(elementsOf(results.tree).find((e) => e.props.key === "guided-results-file-tickets")?.props.label, ACTION_LABEL.fileTickets);
  const none = drawGuided("desktop", wizard({ step: "results", cards: [], cardsTotal: 0 }), STATUS_IDLE);
  assert.ok(!elementsOf(none.tree).some((e) => e.props.key === "guided-results-file-tickets"), "nothing to file, no button");
  assert.deepEqual(drawGuided("terminal", wizard(), STATUS_DOWN).press("guided-error-retry"), { type: "retry", payload: undefined });
});

test("an error screen is one sentence and one button, under its own heading; a request of the person keeps its own", () => {
  const plan = planFor({ address: "https://staging.example.com", areas: ["forms"], signIn: "password" });
  const screen = (kind: (typeof ERROR_KINDS)[number] | "stuck") => {
    const actions =
      kind === "stuck"
        ? [{ kind: "prompt", label: ACTION_LABEL.stop, text: ACTION_PROMPT.stop }]
        : kind === "server-error"
          ? []
          : [errorAction(kind, plan as never)];
    return statusWith({
      phase: kind === "stopped-by-cap" ? "stopped" : "needs-you",
      needsYou: { kind, sentence: kind === "stuck" ? "A step is stuck." : NEEDS_YOU_SENTENCE[kind]("staging.example.com"), actions },
      next: actions,
    });
  };
  const cases: Array<[(typeof ERROR_KINDS)[number], string, string, Acted]> = [
    ["address-unreachable", SCREEN_HEADING.wentWrong, "guided-needs-try-again", { type: "send", payload: { text: ACTION_PROMPT.retry(GUIDED_PLAN_ID) } }],
    ["browser-download-failed", SCREEN_HEADING.wentWrong, "guided-needs-try-again", { type: "send", payload: { text: ACTION_PROMPT.retry(GUIDED_PLAN_ID) } }],
    [
      "sign-in-expired",
      SCREEN_HEADING.needYou,
      "guided-needs-sign-in-again",
      { type: "send", payload: { text: ACTION_PROMPT.signInAgain(GUIDED_PLAN_ID, "https://staging.example.com", "user") } },
    ],
    ["stopped-by-cap", SCREEN_HEADING.wentWrong, "guided-needs-see-all-problems", { type: "cards", payload: undefined }],
  ];
  for (const [kind, heading, key, pressed] of cases)
    for (const surface of SURFACES) {
      const drawn = drawGuided(surface, wizard({ step: "running", planId: GUIDED_PLAN_ID }), screen(kind));
      assertDrawable(drawn.tree, surface, kind);
      const lines = drawn.text.split("\n");
      const at = lines.indexOf(heading);
      assert.ok(
        at >= 0 && lines[at + 1] === NEEDS_YOU_SENTENCE[kind]("staging.example.com"),
        `${kind} on ${surface}: the heading, then the sentence:\n${drawn.text}`,
      );
      const own = elementsOf(drawn.tree).filter((e) => e.type === "Button" && String(e.props.key).startsWith("guided-needs-"));
      assert.deepEqual(
        own.map((e) => e.props.key),
        [key],
        `${kind}: one button`,
      );
      assert.deepEqual(drawn.press(key), pressed);
      assert.equal(guided.needsYouHeading(kind), heading);
    }
  // A request that is not a failure keeps "I need you", in the panel and where nothing draws.
  const stuck = drawGuided("desktop", wizard({ step: "running", planId: GUIDED_PLAN_ID }), screen("stuck"));
  assert.ok(stuck.text.includes(`${SCREEN_HEADING.needYou}\nA step is stuck.`), stuck.text);
  assert.ok(!stuck.text.includes(SCREEN_HEADING.wentWrong));
  assert.match(
    guided.guidedText(wizard({ planId: GUIDED_PLAN_ID }), screen("address-unreachable")),
    /^Something went wrong: I could not open staging\.example\.com/m,
  );
  // The server not answering: its sentence and one button, Try again, with a link to the fix.
  const down = drawGuided("desktop", wizard(), STATUS_DOWN);
  const lines = down.text.split("\n");
  assert.equal(lines[lines.indexOf(SCREEN_HEADING.wentWrong) + 1], guided.SERVER_ERROR_SENTENCE);
  assert.deepEqual(
    elementsOf(down.tree)
      .filter((e) => e.type === "Button" && String(e.props.key).startsWith("guided-error-"))
      .map((e) => e.props.key),
    ["guided-error-retry"],
  );
});

test("the safety explainer opens from the welcome and from a check being set up, and goes back to where it was opened", () => {
  const draft = { ...guided.defaultDraft(), address: "https://staging.example.com", areas: ["forms"], care: "may-submit-forms" as const };
  const setting = wizard({ step: "configuring", draft });
  const config = drawGuided("desktop", setting, STATUS_IDLE);
  assert.deepEqual(config.press("guided-config-safety"), { type: "go", payload: { step: "safety" } });
  const opened = guided.reduce(setting, { type: "go", step: "safety" });
  assert.equal(opened.step, "safety");
  const explainer = drawGuided("desktop", opened, STATUS_IDLE);
  for (const s of SAFETY_EXPLAINER) assert.ok(explainer.text.includes(s), s);
  const back = explainer.press("guided-safety-back");
  assert.deepEqual(back, { type: "go", payload: { step: "configuring" } }, "back to the check being set up");
  assert.deepEqual(guided.reduce(opened, back.payload as never).draft, draft, "with its choices kept");
  // From the welcome, back goes to the welcome.
  const fromWelcome = guided.reduce(wizard(), { type: "go", step: "safety" });
  assert.deepEqual(drawGuided("terminal", fromWelcome, STATUS_IDLE).press("guided-safety-back"), { type: "go", payload: { step: "welcome" } });
  // Where it goes back to survives a reload of the mod, and nothing else gets in.
  assert.equal(guided.wizardOf(JSON.parse(JSON.stringify(opened))).returnTo, "configuring");
  assert.equal(guided.wizardOf({ ...opened, returnTo: "nowhere" }).returnTo, null);
  assert.equal(guided.wizardOf({ ...opened, returnTo: "safety" }).returnTo, null);
});

test("an engine action becomes a server call only for the three tools a button may call", () => {
  const cases: Array<[unknown, unknown]> = [
    [
      { kind: "direct", label: "x", tool: "scout_feedback", args: { id: "a", verdict: "not-a-bug" } },
      { kind: "call", tool: "scout_feedback", args: { id: "a", verdict: "not-a-bug" } },
    ],
    [
      { kind: "direct", label: "x", tool: "scout_guided_confirm", args: { planId: "gp-1" } },
      { kind: "call", tool: "scout_guided_confirm", args: { planId: "gp-1" } },
    ],
    [{ kind: "direct", label: "x", tool: "scout_attach", args: { mode: "safe-write" } }, null],
    [{ kind: "direct", label: "x", tool: "scout_feedback" }, null],
    [
      { kind: "prompt", label: "x", text: "Stop." },
      { kind: "send", text: "Stop." },
    ],
    [{ kind: "prompt", label: "x", text: "" }, null],
    ["scout_cards", null],
  ];
  for (const [action, want] of cases) assert.deepEqual(guided.actionEffect(action), want, JSON.stringify(action));
  assert.equal(guided.sendRoute(false), "submit");
  assert.equal(guided.sendRoute(true), "append", "a press mid-turn goes into the running turn");
});

test("a lane's turn ending leaves Claude's own turn running, so Stop goes into it rather than waiting for it to end", async () => {
  // register.js wired to a stand-in for Claude Code's `$`: its hooks, its state, and what it sends Claude.
  type Hook = ($: unknown, e: any, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
  const hooks = new Map<string, Hook[]>();
  const on = (event: string, ...rest: unknown[]) => {
    const hook = rest[rest.length - 1] as Hook;
    hooks.set(event, [...(hooks.get(event) ?? []), hook]);
    return { catch: () => undefined };
  };
  const state = new Map<string, { value: unknown; version: number }>();
  const appended: unknown[] = [];
  const submitted: string[] = [];
  const $ = {
    state: {
      get: async (ref: { key: string }) => state.get(ref.key) ?? { value: undefined, version: 0 },
      set: async (ref: { key: string }, value: unknown) => {
        state.set(ref.key, { value, version: (state.get(ref.key)?.version ?? 0) + 1 });
        return { isSet: true };
      },
    },
    session: { append: async (row: unknown) => (appended.push(row), { uuid: "row" }) },
    prompt: { submit: async (p: { text: string }) => (submitted.push(p.text), {}) },
    ui: { toast: () => undefined, resolve: () => elsFor("desktop") },
  };
  registerMod(on as never, {});
  const raise = async (event: string, e: unknown) => {
    for (const hook of hooks.get(event) ?? []) await hook($, e, async (x) => x);
  };
  await raise("turn.start", { text: "check my site", turnId: "main" });
  // A lane subagent finishes while Claude's own turn goes on: it raises turn.complete with its agentId, and no turn.start.
  await raise("turn.complete", { answer: "lane report", turnId: "lane", agentId: "lane-1", reason: "answer", isAborted: false, durationMs: 1 });
  state.set("status", { value: STATUS_RUNNING, version: 1 });
  state.set("wizard", { value: wizard({ step: "running", planId: GUIDED_PLAN_ID }), version: 1 });
  const [render] = hooks.get("ui.render")!;
  const tree = await render($, { requestId: mod.PANE_ID, surface: "desktop" }, async (x) => x);
  const stop = elementsOf(tree).find((e) => e.props.key === "guided-running-stop")!;
  (stop.props.onPress as () => void)();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(submitted, [], "Stop did not wait for the turn to end");
  assert.equal(appended.length, 1);
  // Claude's own turn ending is the end.
  await raise("turn.complete", { answer: "done", turnId: "main", reason: "answer", isAborted: false, durationMs: 1 });
  (stop.props.onPress as () => void)();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(submitted, [ACTION_PROMPT.stop]);
  assert.equal(guided.endsMainTurn({ agentId: "lane-1" }), false);
  assert.equal(guided.endsMainTurn({ turnId: "main" }), true);
});

test("the first-run tour: three panels, Next, Back, Skip and Done, on every surface", () => {
  assert.equal(guided.TOUR.length, 3);
  for (const surface of SURFACES)
    for (let page = 0; page < guided.TOUR.length; page++) {
      const drawn = drawGuided(surface, wizard({ step: "tour", tourPage: page }), STATUS_IDLE);
      assertDrawable(drawn.tree, surface, `tour ${page}`);
      assert.ok(drawn.text.includes(guided.TOUR[page].title) && drawn.text.includes(guided.TOUR[page].body));
      assert.ok(drawn.text.includes(`${page + 1} of 3`));
      const last = page === guided.TOUR.length - 1;
      if (last) assert.deepEqual(drawn.press("guided-tour-done"), { type: "tourDone", payload: undefined });
      else {
        assert.deepEqual(drawn.press("guided-tour-next"), { type: "tourNext", payload: undefined });
        assert.deepEqual(
          drawn.press("guided-tour-skip"),
          { type: "tourDone", payload: undefined },
          "skippable from any panel but the last, where Done ends it",
        );
      }
      if (page > 0) assert.deepEqual(drawn.press("guided-tour-back"), { type: "tourBack", payload: undefined });
      else assert.ok(!elementsOf(drawn.tree).some((e) => e.props.key === "guided-tour-back"));
    }
  // The welcome offers it again.
  assert.deepEqual(drawGuided("desktop", wizard(), STATUS_IDLE).press("guided-welcome-tour"), { type: "tour", payload: undefined });
  // The pages turn within bounds, and a tour that is not showing is not turned.
  let w = guided.reduce(wizard({ step: "results" }), { type: "tour" });
  assert.deepEqual([w.step, w.tourPage], ["tour", 0]);
  w = guided.reduce(guided.reduce(guided.reduce(w, { type: "tourNext" }), { type: "tourNext" }), { type: "tourNext" });
  assert.equal(w.tourPage, 2);
  assert.equal(guided.reduce(w, { type: "tourBack" }).tourPage, 1);
  assert.equal(guided.reduce(w, { type: "tourDone" }).step, "welcome");
  assert.equal(guided.reduce(wizard({ step: "running" }), { type: "tourNext" }).tourPage, 0);
  assert.equal(guided.reduce(wizard({ step: "running" }), { type: "tourDone" }).step, "running");
  assert.equal(guided.wizardOf({ step: "tour", tourPage: 99 }).tourPage, 2);
  assert.equal(guided.wizardOf({ step: "tour", tourPage: -3 }).tourPage, 0);
  // The tour's words say what a care level does as the engine does: Look only holds back what would save something.
  assert.ok(guided.TOUR[1].body.includes(CARE_LABEL["look-only"]) && !/nothing is sent|saves nothing/i.test(guided.TOUR[1].body));
});

test("the tour starts on a first open of the welcome only, and once done or skipped it is remembered", async () => {
  // Who sees the tour, as a contrastive pair on each fact that decides it.
  assert.equal(guided.startsTour(undefined, wizard(), STATUS_IDLE), true, "never seen, on the welcome");
  assert.equal(guided.startsTour(true, wizard(), STATUS_IDLE), false, "seen");
  assert.equal(
    guided.startsTour(undefined, wizard({ step: "running", planId: GUIDED_PLAN_ID }), STATUS_IDLE),
    false,
    "a check being followed is not interrupted",
  );
  assert.equal(guided.startsTour(new Error("no store"), wizard(), STATUS_IDLE), false, "a store that cannot be read counts as seen");
  assert.equal(guided.startsTour(undefined, wizard(), STATUS_RUNNING), false, "a check going on, which the welcome shows, is not covered");
  // register.js against a stand-in `$` with a store.
  type Hook = ($: unknown, e: any, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
  const hooks = new Map<string, Hook[]>();
  const on = (event: string, ...rest: unknown[]) => {
    hooks.set(event, [...(hooks.get(event) ?? []), rest[rest.length - 1] as Hook]);
    return { catch: () => undefined };
  };
  const state = new Map<string, { value: unknown; version: number }>();
  const store = new Map<string, unknown>();
  const $ = {
    state: {
      get: async (ref: { key: string }) => state.get(ref.key) ?? { value: undefined, version: 0 },
      set: async (ref: { key: string }, value: unknown) => {
        state.set(ref.key, { value, version: (state.get(ref.key)?.version ?? 0) + 1 });
        return { isSet: true };
      },
    },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) },
    mcp: { call: async () => serverResult(paneData(paneInput())) },
    clock: { now: async () => PANE_NOW },
    session: { surfaces: async () => ["desktop"] },
    ui: { open: async () => undefined, toast: () => undefined, log: () => undefined, resolve: () => elsFor("desktop") },
  };
  registerMod(on as never, {});
  const open = async () => {
    for (const hook of hooks.get("command.run") ?? []) await hook($, { command: "scenescout-guided" }, async (x) => x);
  };
  const step = () => (state.get("wizard")?.value as { step: string } | undefined)?.step;
  await open();
  assert.equal(step(), "tour", "a first open shows the tour");
  const [render] = hooks.get("ui.render")!;
  const press = async (key: string) => {
    const tree = await render($, { requestId: mod.PANE_ID, surface: "desktop" }, async (x) => x);
    (elementsOf(tree).find((e) => e.props.key === key)!.props.onPress as () => void)();
    await new Promise((r) => setTimeout(r, 20));
  };
  await press("guided-tour-skip");
  assert.equal(step(), "welcome");
  assert.equal(store.get(guided.TOUR_SEEN_KEY), true, "skipping is remembered");
  await open();
  assert.equal(step(), "welcome", "and the next open goes straight to the welcome");
  // Asked for again from the welcome, it shows whatever the store says.
  await press("guided-welcome-tour");
  assert.equal(step(), "tour");
});

test("before a check with a sign-in starts, the panel says whether the saved sign-in lasts it; only one that does offers Sign in again", () => {
  const planWith = (state: "lasts" | "runs-out") => {
    const p = planFor({ address: "https://staging.example.com", areas: ["forms"], signIn: "password", care: "may-submit-forms" });
    p.signInHealth = {
      state,
      sentence: SIGN_IN_HEALTH[state]("staging.example.com"),
      signInAgain: {
        label: SIGN_IN_AGAIN.label,
        prompt: SIGN_IN_AGAIN.prompt("https://staging.example.com", "user"),
        command: "scenescout login https://staging.example.com --role user",
      },
    };
    return p;
  };
  for (const surface of SURFACES) {
    const lasts = drawGuided(surface, wizard({ step: "running", planId: "gp-9999999999", plan: planWith("lasts") }), STATUS_IDLE);
    assertDrawable(lasts.tree, surface, "health, lasts");
    assert.ok(lasts.text.includes(SIGN_IN_HEALTH.lasts("staging.example.com")));
    assert.ok(lasts.text.includes(SIGN_IN_AGAIN.command("scenescout login https://staging.example.com --role user")), lasts.text);
    assert.deepEqual(lasts.press("guided-signin-again"), { type: "send", payload: { text: SIGN_IN_AGAIN.prompt("https://staging.example.com", "user") } });
    const runsOut = drawGuided(surface, wizard({ step: "running", planId: "gp-9999999999", plan: planWith("runs-out") }), STATUS_IDLE);
    assert.ok(runsOut.text.includes(SIGN_IN_HEALTH["runs-out"]("staging.example.com")));
    assert.ok(!elementsOf(runsOut.tree).some((e) => e.props.key === "guided-signin-again"), "the check signs in first anyway");
  }
  // The confirmation's preview says it too, before anything starts.
  const confirm = drawGuided("desktop", wizard({ step: "confirm", planId: GUIDED_PLAN_ID, plan: planWith("lasts") }), STATUS_IDLE);
  assert.ok(confirm.text.includes(SIGN_IN_HEALTH.lasts("staging.example.com")));
  // Once the check is under way, it is no longer shown.
  const under = drawGuided("desktop", wizard({ step: "running", planId: GUIDED_PLAN_ID, plan: planWith("lasts") }), STATUS_RUNNING);
  assert.ok(!under.text.includes(SIGN_IN_HEALTH.lasts("staging.example.com")));
  assert.equal(SIGN_IN_AGAIN.label, ACTION_LABEL.signInAgain);
  assert.equal(guided.SIGN_IN_AGAIN_COMMAND("x"), SIGN_IN_AGAIN.command("x"));
});

test("Claude's own attach that writes, and filing tickets, ask the person first; looking only never does", () => {
  const attach = (mode: string, planId?: string) => ({
    tool: "mcp__scenescout__scout_attach",
    url: "https://staging.example.com",
    mode,
    ...(planId ? { planId } : {}),
  });
  const cases: Array<[string, Record<string, unknown>, string[], boolean]> = [
    ["observe", attach("observe"), [], false],
    ["no mode given: the server attaches in read-only", attach(""), [], true],
    ["read-only", attach("read-only"), [], true],
    ["safe-write", attach("safe-write"), [], true],
    ["destructive", attach("destructive"), [], true],
    ["a plan the person confirmed in the panel", attach("safe-write", "gp-1"), ["gp-1"], false],
    ["another plan", attach("safe-write", "gp-2"), ["gp-1"], true],
    ["the plugin's own server name", { ...attach("read-only"), tool: "mcp__plugin_scenescout_scenescout__scout_attach" }, [], true],
    ["a tool merely named like it", { ...attach("read-only"), tool: "scout_attach" }, [], false],
    ["filing tickets", { tool: "mcp__scenescout__scout_ticket_file", previewId: "p" }, [], true],
    ["anything else", { tool: "Bash", command: "ls" }, [], false],
  ];
  for (const [name, call, confirmed, asks] of cases) {
    const g = guided.guardFor(call, confirmed);
    assert.equal(g !== null, asks, name);
    if (g) {
      assert.match(g.question, /\?$/, name);
      assert.notEqual(g.allow, g.refuse);
      assert.match(g.deny, /Do not retry/, name);
    }
  }
  assert.match(guided.guardFor(attach("safe-write"), [])!.question, /"safe-write" mode \(May create test data\)/);
});

test("the results screen makes the team report with no turn for Claude, then offers the page and its folder", () => {
  const page = "/home/u/site/.scenescout/team-report.html";
  const folder = "/home/u/site/.scenescout/team-report";
  // The tool the button calls is the server's own.
  const resultsSource = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "tools", "results.ts"), "utf8");
  assert.ok(resultsSource.includes(`"${guided.TEAM_REPORT_TOOL}",`), "the button names the tool the server registers");
  assert.ok(!guided.DIRECT_TOOLS.includes(guided.TEAM_REPORT_TOOL), "an engine action cannot reach it: only the results screen's own button does");

  const results = drawGuided("desktop", wizard({ step: "results", cards: [cardFixture("0a1b2c3d4e")], cardsTotal: 1 }), STATUS_IDLE);
  assert.deepEqual(results.press("guided-results-team-report"), { type: "teamReport", payload: undefined });
  const label = elementsOf(results.tree).find((e) => e.props.key === "guided-results-team-report")!;
  assert.equal(label.props.label, ACTION_LABEL.teamReport);
  assert.ok(!results.text.includes(guided.PANEL_WORDS.openReport), "no link before a report is made");

  const writing = drawGuided("desktop", wizard({ step: "results", cards: [], busy: "team-report" }), STATUS_IDLE);
  assert.ok(writing.text.includes(guided.PANEL_WORDS.writingTeamReport));

  const made = drawGuided("desktop", wizard({ step: "results", cards: [], teamReport: { path: page, folder } }), STATUS_IDLE);
  assert.ok(made.text.includes(`[${guided.PANEL_WORDS.openReport}](file:///home/u/site/.scenescout/team-report.html)`), made.text);
  assert.ok(made.text.includes(`[${guided.PANEL_WORDS.showFolder}](file:///home/u/site/.scenescout/team-report)`), made.text);

  const answer = (structuredContent: Record<string, unknown>, isError = false) => ({
    isError,
    content: [{ type: "text", text: isError ? "Error: No project is open yet" : `Team report written: ${String(structuredContent.path)}\nmore` }],
    structuredContent,
  });
  assert.deepEqual(guided.readTeamReport(answer({ path: page, folder })), { ok: true, path: page, folder, said: `Team report written: ${page}` });
  assert.deepEqual(guided.readTeamReport(answer({ path: "C:\\site\\.scenescout\\team-report.html", folder: "C:\\site\\.scenescout\\team-report" })).ok, true);
  assert.deepEqual(guided.readTeamReport(answer({}, true)), { ok: false, error: "No project is open yet" });
  // Anything but the page named team-report.html inside a .scenescout/ folder, and its own folder, is never offered as a link.
  for (const [p, f] of [
    ["/home/u/Downloads/run-me.command", folder],
    ["/home/u/site/.scenescout/team-report.html", "/home/u/Downloads"],
    ["site/.scenescout/team-report.html", "site/.scenescout/team-report"],
    ["/home/u/site/team-report.html", "/home/u/site/team-report"],
  ])
    assert.equal(guided.readTeamReport(answer({ path: p, folder: f })).ok, false, `${p} | ${f}`);
  // A value an older version or a bad write left in the state is dropped.
  assert.equal(guided.wizardOf({ teamReport: { path: "relative.html", folder: "x" } }).teamReport, null);
  assert.deepEqual(guided.wizardOf({ teamReport: { path: page, folder } }).teamReport, { path: page, folder });
});

test("the team report button cannot be pressed twice while the report is written, and reading the problems still says so", () => {
  const writing = drawGuided("desktop", wizard({ step: "results", cards: [], busy: "team-report" }), STATUS_IDLE);
  assert.ok(!elementsOf(writing.tree).some((e) => e.props.key === "guided-results-team-report"), "no second press while the first is being written");
  const idle = drawGuided("desktop", wizard({ step: "results", cards: [] }), STATUS_IDLE);
  assert.ok(elementsOf(idle.tree).some((e) => e.props.key === "guided-results-team-report"));
  // While the problems are being read, the screen says that, not that there are none.
  const reading = drawGuided("desktop", wizard({ step: "results", cards: [], busy: "cards" }), STATUS_IDLE);
  assert.ok(reading.text.includes("Reading the problems..."));
  assert.ok(!reading.text.includes(guided.PANEL_WORDS.noCards), reading.text);
  // A report already made does not hide that this check found nothing.
  const made = drawGuided(
    "desktop",
    wizard({ step: "results", cards: [], teamReport: { path: "/home/u/site/.scenescout/team-report.html", folder: "/home/u/site/.scenescout/team-report" } }),
    STATUS_IDLE,
  );
  assert.ok(made.text.includes(guided.PANEL_WORDS.noCards), made.text);
  assert.ok(made.text.includes(guided.PANEL_WORDS.openReport));
  // A saved state is held to the same rule as the server's answer: only the team report page in a .scenescout/ folder is ever a link.
  assert.equal(guided.wizardOf({ teamReport: { path: "/home/u/Downloads/run-me.command", folder: "/home/u/Downloads" } }).teamReport, null);
});

test("the cards, their pictures on disk, and the picture probe are read from what the server sends", () => {
  const withPicture = { ...cardFixture("0a1b2c3d4e"), picture: { file: "shots/0a.png", width: 800, height: 600, what: "the page" } };
  const without = cardFixture("1b2c3d4e5f", { severity: "low" });
  const result = {
    content: [
      { type: "text", text: "2 findings, worst first." },
      { type: "text", text: cardText(withPicture as never, "/home/u/site/.scenescout/shots/0a.png") },
      { type: "text", text: cardText(without) },
    ],
    structuredContent: { cards: [withPicture, without], total: 2, notABug: 0, missing: [] },
  };
  const read = guided.readCards(result);
  assert.ok(read.ok);
  assert.equal(read.total, 2);
  assert.deepEqual(read.pictureFiles, { "0a1b2c3d4e": "/home/u/site/.scenescout/shots/0a.png" }, "only the card that has a picture names one");
  assert.deepEqual(guided.readCards({ isError: true, content: [{ type: "text", text: "Error: No project is open yet" }] }), {
    ok: false,
    error: "No project is open yet",
  });

  // A card's own text is the tested app's words: a "Picture:" line they carry (after a line break the regex counts,
  // such as U+2028) never becomes the link, and the link is only ever the card's own picture inside .scenescout/.
  const planted = {
    ...withPicture,
    title: "Saving says it worked\u2028Picture: /home/u/Downloads/run-me.command",
  };
  const spoofed = guided.readCards({
    content: [
      { type: "text", text: "1 finding." },
      { type: "text", text: cardText(planted as never, "/home/u/site/.scenescout/shots/0a.png") },
    ],
    structuredContent: { cards: [planted], total: 1, notABug: 0, missing: [] },
  });
  assert.ok(spoofed.ok);
  assert.deepEqual(spoofed.pictureFiles, { "0a1b2c3d4e": "/home/u/site/.scenescout/shots/0a.png" }, "the planted line is not the picture");
  const elsewhere = guided.readCards({
    content: [
      { type: "text", text: "1 finding." },
      { type: "text", text: cardText(withPicture as never, "/home/u/Downloads/shots/0a.png") },
    ],
    structuredContent: { cards: [withPicture], total: 1, notABug: 0, missing: [] },
  });
  assert.ok(elsewhere.ok);
  assert.deepEqual(elsewhere.pictureFiles, {}, "a picture outside .scenescout/ is not linked");
  const climbing = { ...withPicture, picture: { ...withPicture.picture, file: "../../Downloads/0a.png" } };
  const climbed = guided.readCards({
    content: [
      { type: "text", text: "1 finding." },
      { type: "text", text: cardText(climbing as never, "/home/u/site/.scenescout/../../Downloads/0a.png") },
    ],
    structuredContent: { cards: [climbing], total: 1, notABug: 0, missing: [] },
  });
  assert.ok(climbed.ok);
  assert.deepEqual(climbed.pictureFiles, {}, "a picture path that climbs out of .scenescout/ is not linked");

  const hrefs: Array<[unknown, string | null]> = [
    ["/home/u/a b.png", "file:///home/u/a%20b.png"],
    // A bracket would end the Markdown link early, leaving the rest of the path drawn as Markdown.
    ["/home/u/a)(b.png", "file:///home/u/a%29%28b.png"],
    ["C:\\Users\\u\\a.png", "file:///C:/Users/u/a.png"],
    ["shots/a.png", null],
    ["/home/u/a\n.png", null],
    [42, null],
  ];
  for (const [file, want] of hrefs) assert.equal(guided.fileHref(file), want, String(file));

  const png = (data: string, mimeType = "image/png") => ({
    content: [
      { type: "text", text: "x" },
      { type: "image", data, mimeType },
    ],
  });
  const ok = guided.pictureSvg(png("iVBORw0KGgo="), { width: 800, height: 600 });
  assert.ok("svg" in ok && ok.width === guided.PICTURE_WIDTH && ok.height === 240, JSON.stringify(ok));
  assert.ok("svg" in ok && ok.svg.includes('href="data:image/png;base64,iVBORw0KGgo="'));
  const refused: Array<[unknown, RegExp]> = [
    [{ content: [{ type: "text", text: "no picture" }] }, /no picture/],
    [png("iVBORw0KGgo=", "image/jpeg"), /not a PNG/],
    [png('x"/><script>'), /not a PNG/],
    [png("A".repeat(guided.SVG_SOURCE_MAX)), /too large/],
  ];
  for (const [r, why] of refused) {
    const got = guided.pictureSvg(r, { width: 10, height: 10 });
    assert.ok("why" in got && why.test(got.why), JSON.stringify(got));
  }
});

test("where nothing draws, /scenescout-guided says where the check is and what to say next, and offers only Look only", () => {
  const idle = guided.guidedText(guided.initialWizard(), STATUS_IDLE);
  assert.match(idle, /check my site with SceneScout/);
  assert.match(idle, /can start only in "Look only"/);
  const running = guided.guidedText(wizard({ planId: GUIDED_PLAN_ID }), STATUS_RUNNING);
  assert.match(running, /^Checking staging\.example\.com \(6m of 20m\)\. Now: /);
  assert.match(running, /Problems so far: 1 block users · 0 annoying · 0 cosmetic/);
  assert.match(running, /id 0a1b2c3d4e/);
  assert.match(guided.guidedText(guided.initialWizard(), STATUS_DOWN), /could not reach the SceneScout server/);
  // A check of another plan is not passed off as the panel's.
  assert.equal(guided.guidedOf(STATUS_RUNNING, "gp-9999999999"), null);
  assert.equal(guided.guidedOf(STATUS_RUNNING, null)?.planId, GUIDED_PLAN_ID);
});
