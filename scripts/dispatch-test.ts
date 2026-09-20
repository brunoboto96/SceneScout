/**
 * Unit tests for the tool-call dispatch layer.
 *
 * This is the mechanism behind the multi-role promise — same session
 * serializes, different sessions run in parallel — and it shipped with NO
 * direct coverage: it lived inside mcp-server.ts, where reaching it meant
 * driving a real browser over stdio, so `npm test` never touched it. Two calls
 * overlapping on one browser's ref table, or a watchdog timer that never
 * cleared, would both have shipped green.
 *
 *   npx tsx --test scripts/dispatch-test.ts
 */
import assert from "node:assert/strict";
import { needsTask, normalizeTask, taskRefusal, TASK_MAX } from "../src/engine/task.ts";
import test from "node:test";
import { SessionQueue, withWatchdog } from "../src/engine/dispatch.ts";
import { revealedLines } from "../src/engine/hover.ts";
import { explainLaunchFailure, isMissingBrowser } from "../src/engine/launch.ts";
import { orphanPids } from "../src/engine/reaper.ts";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// SessionQueue — the concurrency contract
// ---------------------------------------------------------------------------

test("two calls on the SAME session never interleave", async () => {
  const q = new SessionQueue();
  const trace: string[] = [];
  const job = (name: string) => async () => {
    trace.push(`${name}:start`);
    await tick(20);
    trace.push(`${name}:end`);
  };
  await Promise.all([q.run("admin", job("a")), q.run("admin", job("b"))]);
  // The failure this pins: "a:start, b:start, a:end, b:end" — overlapping work
  // on one browser, which corrupts its ref table.
  assert.deepEqual(trace, ["a:start", "a:end", "b:start", "b:end"]);
});

test("calls on DIFFERENT sessions overlap in wall-clock", async () => {
  const q = new SessionQueue();
  const trace: string[] = [];
  const job = (name: string) => async () => {
    trace.push(`${name}:start`);
    await tick(30);
    trace.push(`${name}:end`);
  };
  const started = Date.now();
  await Promise.all([q.run("admin", job("a")), q.run("qa", job("b"))]);
  const elapsed = Date.now() - started;
  assert.deepEqual(trace.slice(0, 2), ["a:start", "b:start"], "both started before either finished");
  assert.ok(elapsed < 55, `two 30ms jobs on different sessions should not take ~60ms (took ${elapsed}ms)`);
});

test("a REJECTED call does not wedge its session's queue", async () => {
  const q = new SessionQueue();
  await assert.rejects(
    q.run("admin", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  // Without the (fn, fn) two-armed then, the chain stays rejected and every
  // later call on that session inherits the failure forever.
  assert.equal(await q.run("admin", async () => "ok"), "ok");
});

test("a rejection is delivered to its own caller, not to the next one", async () => {
  const q = new SessionQueue();
  const failing = q.run("admin", async () => {
    throw new Error("first");
  });
  const following = q.run("admin", async () => "second");
  await assert.rejects(failing, /first/);
  assert.equal(await following, "second", "the next call gets its own result");
});

test("the queue preserves submission order", async () => {
  const q = new SessionQueue();
  const done: number[] = [];
  await Promise.all(
    [40, 5, 20].map((ms, i) =>
      q.run("s", async () => {
        await tick(ms);
        done.push(i);
      }),
    ),
  );
  assert.deepEqual(done, [0, 1, 2], "a fast job queued second must not finish first");
});

test("forget() drops a closed session's chain", async () => {
  const q = new SessionQueue();
  await q.run("gone", async () => "x");
  assert.equal(q.size, 1);
  q.forget("gone");
  assert.equal(q.size, 0);
});

test("forget() during an IN-FLIGHT call does not let the next call interleave", async () => {
  // scout_close runs on its own control chain, so it really can land mid-call.
  // Dropping the chain there would let the next call start immediately and
  // overlap with the one still running — the exact corruption this class
  // exists to prevent, reintroduced as "cleanup".
  const q = new SessionQueue();
  const trace: string[] = [];
  const job = (name: string) => async () => {
    trace.push(`${name}:start`);
    await tick(20);
    trace.push(`${name}:end`);
  };
  const first = q.run("s", job("a"));
  q.forget("s"); // arrives while "a" is still running
  const second = q.run("s", job("b"));
  await Promise.all([first, second]);
  assert.deepEqual(trace, ["a:start", "a:end", "b:start", "b:end"], "serialization must survive a mid-call forget");
});

test("a key forgotten while busy is dropped once it drains", async () => {
  const q = new SessionQueue();
  const running = q.run("s", async () => {
    await tick(10);
  });
  q.forget("s");
  assert.equal(q.size, 1, "still tracked while in flight");
  await running;
  await tick(5);
  assert.equal(q.size, 0, "and released afterwards");
});

test("clear() forgets every key", async () => {
  const q = new SessionQueue();
  await Promise.all([q.run("a", async () => 1), q.run("b", async () => 2)]);
  assert.equal(q.size, 2);
  q.clear();
  assert.equal(q.size, 0);
});

// ---------------------------------------------------------------------------
// withWatchdog — a wedged call must answer, not hang
// ---------------------------------------------------------------------------

test("a slow call resolves with the timeout value instead of hanging", async () => {
  const never = new Promise<string>(() => {});
  const out = await withWatchdog("scout_click", never, 20, (label, ms) => `timeout:${label}:${ms}`);
  assert.equal(out, "timeout:scout_click:20");
});

test("a call that beats the watchdog returns its own result", async () => {
  const out = await withWatchdog("scout_click", Promise.resolve("real"), 50, () => "timeout");
  assert.equal(out, "real");
});

test("the timer is cleared when the call settles first", async () => {
  // A leaked timer holds the event loop open and accumulates one per tool call
  // for the life of a long-running daemon. If it were not cleared, this test
  // would keep the process alive past its own end.
  const before = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0;
  await withWatchdog("x", Promise.resolve(1), 60_000, () => -1);
  await tick(5);
  const after = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0;
  assert.ok(after <= before, `a settled call must not leave its 60s timer live (${before} → ${after})`);
});

test("a rejection ARRIVING AFTER the timeout does not become an unhandled rejection", async () => {
  let unhandled: unknown = null;
  const onUnhandled = (err: unknown): void => {
    unhandled = err;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const late = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late failure")), 30));
    const out = await withWatchdog("scout_navigate", late, 10, () => "timed-out");
    assert.equal(out, "timed-out");
    await tick(60); // let the late rejection land
    assert.equal(unhandled, null, "the losing side of the race must be caught, or Node crashes the process");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a call that rejects before the timeout still rejects to its caller", async () => {
  await assert.rejects(
    withWatchdog("scout_click", Promise.reject(new Error("real failure")), 1000, () => "timeout"),
    /real failure/,
  );
});

test("the orphan reaper only ever selects browsers this tool launched and abandoned", () => {
  // The cost of a wrong answer is SIGKILLing somebody else's browser, so every
  // one of the three conditions has a row that fails on it alone.
  const cache = "/home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome";
  const ps = [
    `  101     1 ${cache} --enable-features=scenescout-session --headless`, // ours, orphaned
    `  102     1 ${cache} --enable-features=scenecraft-session --headless`, // ours under the previous name, orphaned
    `  103  4242 ${cache} --enable-features=scenescout-session --headless`, // ours, but its parent is alive
    `  104     1 ${cache} --headless`, // an orphaned Playwright browser that is NOT ours
    `  105     1 /usr/bin/chromium --enable-features=scenescout-session`, // marker, but not a Playwright-cache browser
    `  106     1 /home/u/.cache/ms-playwright/ffmpeg-1011/ffmpeg --enable-features=scenescout-session`, // cache, marker, not a browser
    `garbage line`,
    ``,
  ].join("\n");
  assert.deepEqual(orphanPids(ps), [101, 102]);
  assert.deepEqual(orphanPids(""), []);
});

test("a browser that was never downloaded gets one instruction, not a stack of text", () => {
  // Playwright's real wording, abbreviated. This is the most likely first-run
  // failure for anyone who installed from npm and skipped the setup step.
  const playwright = [
    "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome",
    "╔═════════════════════════════════════════════════════╗",
    "║ Looks like Playwright was just installed or updated. ║",
    "║ Please run the following command to download new browsers: ║",
    "║     npx playwright install                           ║",
  ].join("\n");
  assert.equal(isMissingBrowser(playwright), true);
  const advice = explainLaunchFailure(playwright, 0);
  assert.match(advice, /npx -y scenescout install --browser-only/);
  assert.doesNotMatch(advice, /╔|ms-playwright/, "the box and the cache path are noise to the reader");

  // The instruction names the build that launch needed, not always Chromium.
  assert.match(advice, /--browsers chromium-headless-shell/);
  assert.match(explainLaunchFailure(playwright, 0, { engine: "firefox", headed: false }), /The firefox build has not been downloaded.*--browsers firefox/s);
  // Someone who installed only the headless shell and asks for a window did run install; say what is different.
  const headed = explainLaunchFailure(playwright, 0, { engine: "chromium", headed: true });
  assert.match(headed, /headed run needs the full Chromium browser.*--browsers chromium\n/s);

  // Any other failure keeps its reason, on one line, and says what was cleaned up.
  const other = explainLaunchFailure("browser launch timed out after 30s\n    at attempt (browser.js:1)", 2);
  assert.equal(isMissingBrowser("browser launch timed out after 30s"), false);
  assert.match(other, /launch failed twice \(browser launch timed out after 30s\) — 2 orphaned browser/);
  assert.doesNotMatch(other, /at attempt/);
});

test("hover reports text that appeared, not text that only moved to a new line", () => {
  // A tooltip with no tooltip markup is found by diffing the page text.
  assert.deepEqual(revealedLines("Status\n2 warnings", "Status\n2 warnings\nMissing connector between nodes"), ["Missing connector between nodes"]);
  // The previous hover's tooltip closing re-flows the text next to it. In one
  // browser the badges then sit on a line of their own; every word was already
  // showing, so nothing was revealed.
  assert.deepEqual(revealedLines("1 error 3 notices 2 warnings Missing connector between nodes\nNext", "1 error  3 notices  2 warnings\nNext"), []);
  // A short tooltip whose word already appears inside a longer line is still a reveal:
  // it is on the page once more than it was.
  assert.deepEqual(revealedLines("Delete account permanently\nSave", "Delete account permanently\nSave\nDelete"), ["Delete"]);
  // Spacing differences between the two readings are not new text either.
  assert.deepEqual(revealedLines("Total:   12", "Total: 12"), []);
  // The list is capped, and each line is trimmed to a readable length.
  assert.equal(revealedLines("", Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n")).length, 5);
  assert.equal(revealedLines("", "x".repeat(900))[0].length, 300);
});

// ---- the objective every acting tool needs ---------------------------------

test("a tool that changes the app needs a task; reading the page does not", () => {
  // The live view can only show what the agent states. Left optional it was
  // usually blank, so a watcher saw a session clicking through their app with
  // nothing to say why.
  for (const acting of ["scout_navigate", "scout_back", "scout_click", "scout_type", "scout_select", "scout_press", "scout_upload", "scout_run_plan"]) {
    assert.equal(needsTask(acting), true, acting);
  }
  // Orienting is what an agent does before it can say what it is about to do.
  for (const reading of [
    "scout_snapshot",
    "scout_hover",
    "scout_scroll",
    "scout_coverage",
    "scout_design_audit",
    "scout_screenshot",
    "scout_crawl",
    "scout_journey",
    "scout_finding",
    "scout_note",
    "scout_report",
  ]) {
    assert.equal(needsTask(reading), false, reading);
  }
});

test("a task is one bounded line, and an empty one clears it", () => {
  assert.equal(normalizeTask("  Sign in as QA_Team\n  and check where it lands  "), "Sign in as QA_Team and check where it lands");
  // Longer than the bound is cut at a word, and says it was cut.
  const passed = "Filtering the documents register by status, then checking that the URL keeps the filter after a reload and through a shared link";
  const long = normalizeTask(passed);
  assert.ok(long.length <= TASK_MAX, String(long.length));
  assert.ok(long.endsWith("…"), long);
  const body = long.slice(0, -1);
  assert.ok(passed.startsWith(body), "what is kept is a prefix of what was passed");
  assert.equal(passed[body.length], " ", "cut at a word boundary, not mid-word");
  assert.equal(normalizeTask("x".repeat(400)).length, TASK_MAX, "a single long token is still cut to the bound");
  assert.equal(normalizeTask("   "), "");
  assert.equal(normalizeTask(undefined), "");
});

test("the refusal names the parameter, the shape of a good task, and how long it lasts", () => {
  // An agent that reads this once should not need it a second time.
  const refusal = taskRefusal("scout_click");
  assert.match(refusal, /^scout_click needs a task/);
  assert.match(refusal, /task:"…"/);
  assert.match(refusal, /stays set until you pass a different one/);
  assert.match(refusal, /scout_journey/);
});
