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
import path from "node:path";
import { needsTask, normalizeTask, taskRefusal, TASK_MAX } from "../src/engine/task.ts";
import test from "node:test";
import { CallWork, SessionQueue, watchdogCap, withWatchdog } from "../src/engine/dispatch.ts";
import { revealedLines } from "../src/engine/hover.ts";
import { explainLaunchFailure, isMissingBrowser, readyBrowser, type BrowserReadyDeps } from "../src/engine/launch.ts";
import { browserPresence, type InstallTarget } from "../src/browsers.ts";
import { orphanPids } from "../src/engine/reaper.ts";
import { boundedTeardown } from "../src/engine/teardown.ts";
import { descendants, extraHandles } from "./smoke/leaks.ts";
import fs from "node:fs";
import { parseShard, pickShard, withoutShard } from "./smoke/shards.ts";
import { shards as smokeShards } from "./smoke/suites.ts";

/** Stands in for work that takes a while, or yields to the timer queue. No assertion depends on how long one takes. */
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

test("calls on DIFFERENT sessions overlap", async () => {
  // The trace is the proof: a job that awaits anything lets the other
  // session's job start first, and a queue that serialized the two would put
  // "a:end" second. How long the pair takes is not measured, since a loaded
  // machine can stretch any wall-clock bound.
  const q = new SessionQueue();
  const trace: string[] = [];
  const job = (name: string) => async () => {
    trace.push(`${name}:start`);
    await tick(20);
    trace.push(`${name}:end`);
  };
  await Promise.all([q.run("admin", job("a")), q.run("qa", job("b"))]);
  assert.deepEqual(trace.slice(0, 2), ["a:start", "b:start"], "both started before either finished");
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
    let rejectLate!: (err: Error) => void;
    const late = new Promise<string>((_, reject) => (rejectLate = reject));
    const out = await withWatchdog("scout_navigate", late, 10, () => "timed-out");
    assert.equal(out, "timed-out");
    rejectLate(new Error("late failure"));
    // Node reports an unhandled rejection once the microtasks after it have run, before the next macrotask.
    await new Promise((r) => setImmediate(r));
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

/**
 * Stand-ins for a page, context and browser whose close takes `ms`, never
 * finishes (Infinity), or finishes when the test says ("held"), recording what
 * was closed.
 */
function standIns(ms: { context: number | "held"; browser: number }) {
  const closed: string[] = [];
  const waiting: Array<{ name: string; done: () => void }> = [];
  const record = (name: string): void => {
    closed.push(name);
    for (const w of waiting.filter((w) => w.name === name)) w.done();
  };
  let finishContext = (): void => {};
  const closer = (name: string, delay: number | "held") => ({
    close: () => {
      if (delay === Infinity) return new Promise<void>(() => {});
      if (delay === "held") return new Promise<void>((r) => (finishContext = r)).then(() => record(name));
      return tick(delay).then(() => record(name));
    },
  });
  const page = closer("page", 0);
  const context = { ...closer("context", ms.context), pages: () => [page] };
  /** Resolves once `name` has closed: the condition a test waits on, rather than a guess at how long closing takes. */
  const whenClosed = (name: string): Promise<void> =>
    closed.includes(name) ? Promise.resolve() : new Promise<void>((done) => void waiting.push({ name, done }));
  return { closed, context, browser: closer("browser", ms.browser), whenClosed, finishContext: () => finishContext() };
}

/** Whether `p` settles within `ms`. The bound is far past anything a passing test takes: it turns a hang into a failure that says what hung. */
async function settlesWithin(p: Promise<unknown>, ms = 5000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([p.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
  clearTimeout(timer);
  return settled;
}

test("a teardown that outlasts its cap still closes the browser after the caller has moved on", async () => {
  // The caller returns at the cap and clears its own fields; the browser must not depend on them.
  const { closed, context, browser, whenClosed, finishContext } = standIns({ context: "held", browser: 0 });
  // The context cannot finish closing until it is let go below, so a teardown that waited for it would never return.
  assert.ok(await settlesWithin(boundedTeardown(context, browser, 20)), "returns at the cap, not when teardown ends");
  finishContext();
  assert.ok(await settlesWithin(whenClosed("browser")), `the browser is closed (closed: ${closed.join(", ")})`);
});

test("a context that never closes does not keep the browser running", async () => {
  const { closed, context, browser, whenClosed } = standIns({ context: Infinity, browser: 0 });
  await boundedTeardown(context, browser, 20);
  assert.ok(await settlesWithin(whenClosed("browser")), `the browser is closed (closed: ${closed.join(", ")})`);
  assert.deepEqual(closed, ["page", "browser"]);
});

test("a teardown within its cap closes in order, once each", async () => {
  const { closed, context, browser } = standIns({ context: 0, browser: 0 });
  await boundedTeardown(context, browser, 1000);
  assert.deepEqual(closed, ["page", "context", "browser"]);
  await boundedTeardown(null, null, 10);
});

test("the smoke leak check sees everything under this process, and nothing else", () => {
  // A browser a suite never closed is still node's child, so the orphan reaper
  // above skips it by design, and its helpers hang under IT, not under node.
  const ps = [
    `  500     1 node smoke.ts`, // this process
    `  501   500 /cache/ms-playwright/chromium/chrome --headless`, // a browser left open
    `  502   501 /cache/ms-playwright/chromium/chrome --type=renderer`, // its helper, a grandchild
    `  503   500 ps -A -o pid=,ppid=,command=`, // the listing itself
    `  504   500 /bin/ps -A -o pid=,ppid=,command=`, // the listing, by full path
    `  505     1 /cache/ms-playwright/chromium/chrome --headless`, // somebody else's browser
    `  506   777 node other.js`, // an unrelated process
    `  507   500 node dist/cli.js check`, // a CLI child still running is a leftover too
    `  508   500 /repo/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.28.2 --ping`, // tsx's transformer, not the suite's
    `  509   501 /repo/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.28.2 --ping`, // ...but only as node's own child
    `garbage`,
  ].join("\n");
  assert.deepEqual(
    descendants(ps, 500).map((p) => p.pid),
    [501, 502, 507, 509],
  );
  assert.deepEqual(descendants(ps, 999), []);
  assert.deepEqual(descendants("", 500), []);
});

test("the smoke open-handle check counts by type, so one more of a kind already open still counts", () => {
  assert.deepEqual(extraHandles(["TTYWrap", "TTYWrap"], ["TTYWrap", "TTYWrap"]), []);
  // A browser left open shows as a child process and the pipes to it, next to stdio pipes that were there all along.
  assert.deepEqual(extraHandles(["PipeWrap", "PipeWrap"], ["PipeWrap", "PipeWrap", "ProcessWrap", "PipeWrap"]), ["ProcessWrap", "PipeWrap"]);
  assert.deepEqual(extraHandles(["TTYWrap"], ["Timeout", "TCPServerWrap", "TTYWrap"]), ["Timeout", "TCPServerWrap"]);
  // Closing something that was open at the start is not a leak.
  assert.deepEqual(extraHandles(["TTYWrap", "Timeout"], ["TTYWrap"]), []);
});

test("a smoke shard runs its own suites, and every suite belongs to exactly one shard", () => {
  const shards = [["a", "b"], ["c"], ["d", "e"]];
  assert.deepEqual(pickShard(shards, undefined), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(pickShard(shards, parseShard(["--shard", "1/3"])), ["a", "b"]);
  assert.deepEqual(pickShard(shards, parseShard(["--shard", "3/3"])), ["d", "e"]);
  // The shards a workflow runs, taken together, are the whole suite.
  assert.deepEqual(
    [1, 2, 3].flatMap((k) => pickShard(shards, { index: k, count: 3 })),
    pickShard(shards, undefined),
  );
});

test("every browser suite is in exactly one shard, and the suites that share state share one, in order", () => {
  const dir = path.join(import.meta.dirname, "smoke");
  // A suite is a module under scripts/smoke/ that exports its title and run; the rest are helpers.
  const suiteFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && /^export const title = /m.test(fs.readFileSync(path.join(dir, f), "utf8")));
  const titles = smokeShards.flat().map((s) => s.title);
  assert.equal(new Set(titles).size, titles.length, "a suite is listed twice");
  assert.equal(titles.length, suiteFiles.length, `${suiteFiles.length} suite files, ${titles.length} suites in the shards`);
  const shardOf = (title: string) => smokeShards.findIndex((shard) => shard.some((s) => s.title === title));
  const order = (title: string) => smokeShards[shardOf(title)].findIndex((s) => s.title === title);
  // "cross-run memory, safe-write, uploads" checks that a second run sees the coverage "read-only exploration" recorded.
  assert.equal(shardOf("read-only exploration"), shardOf("cross-run memory, safe-write, uploads"));
  assert.ok(order("read-only exploration") < order("cross-run memory, safe-write, uploads"));
});

test("a smoke shard count that is not the runner's fails rather than skipping suites", () => {
  // A workflow running two shards of three would never run the third.
  assert.throws(() => pickShard([["a"], ["b"], ["c"]], { index: 1, count: 2 }), /has 3 shards, so the workflow must run 3/);
  assert.throws(() => pickShard([["a"], ["b"]], { index: 1, count: 3 }), /has 2 shards/);
});

test("the smoke runner reads --shard k/n and leaves the title filter alone", () => {
  assert.equal(parseShard([]), undefined);
  assert.equal(parseShard(["auth"]), undefined);
  assert.deepEqual(parseShard(["--shard", "2/3"]), { index: 2, count: 3 });
  assert.deepEqual(parseShard(["auth", "--shard", "1/2"]), { index: 1, count: 2 });
  for (const bad of ["", "2", "0/3", "4/3", "2/0", "a/b", "2/3x"]) {
    assert.throws(() => parseShard(["--shard", bad]), /--shard/, `--shard ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseShard(["--shard"]), /takes k\/n/);
  assert.deepEqual(withoutShard(["--shard", "2/3", "auth"]), ["auth"]);
  assert.deepEqual(withoutShard(["auth", "--shard", "2/3"]), ["auth"]);
  assert.deepEqual(withoutShard(["auth"]), ["auth"]);
});

test("a close waits for a session's running calls, and only that session's", async () => {
  const work = new CallWork();
  let finishSlow!: () => void;
  const slow = new Promise<void>((r) => (finishSlow = r));
  work.track("admin", slow);
  work.track("clerk", new Promise(() => {})); // another session's call, never finishing
  assert.equal(work.count("admin"), 1);
  setTimeout(finishSlow, 20);
  assert.equal(await work.settle("admin", 5000), 0, "the wait ends when the call does, not at its bound");
  assert.equal(work.count("admin"), 0);
  assert.equal(work.count("clerk"), 1, "settling one session leaves the other's calls alone");
});

test("a call that fails counts as finished, and a wait for nothing returns at once", async () => {
  const work = new CallWork();
  const failing = Promise.reject(new Error("page closed"));
  failing.catch(() => {}); // its caller handles the rejection; the tracker must not need to
  work.track("s", failing);
  assert.equal(await work.settle("s", 5000), 0);
  assert.equal(await work.settle("nobody", 5000), 0);
});

test("a close stops waiting at its bound and says how many calls were still running", async () => {
  const work = new CallWork();
  work.track("a", new Promise(() => {}));
  work.track("b", new Promise(() => {}));
  work.track("b", new Promise(() => {}));
  const started = Date.now();
  assert.equal(await work.settle("b", 50), 2);
  assert.equal(await work.settleAll(50), 3);
  assert.ok(Date.now() - started < 2000, "the bound held");
});

test("SCENESCOUT_WATCHDOG_MS caps the watchdog only when it is a whole number of at least 100 ms", () => {
  assert.equal(watchdogCap(undefined), undefined);
  assert.equal(watchdogCap(""), undefined);
  assert.equal(watchdogCap("  "), undefined);
  assert.equal(watchdogCap("1000"), 1000);
  assert.equal(watchdogCap("100"), 100);
  for (const bad of ["99", "0", "-5", "1.5", "1s", "abc"]) assert.throws(() => watchdogCap(bad), /SCENESCOUT_WATCHDOG_MS must be a whole number/, bad);
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

/** readyBrowser's dependencies with the download faked: `on` is which builds are on disk, and a good download adds its targets. */
function fakeBrowsers(env: NodeJS.ProcessEnv, on: InstallTarget[], download: { ok: boolean; detail?: string; lands?: boolean } = { ok: true }) {
  const disk = new Set<string>();
  const exe = { chromium: "/c/chromium-1200/chrome", firefox: "/c/firefox-1500/firefox", webkit: "/c/webkit-2200/pw_run.sh" };
  const put = (t: InstallTarget): void => {
    // Joined the way browserPresence joins it, so the marker matches on Windows too.
    if (t === "chromium" || t === "chromium-headless-shell") disk.add(path.join("/c/chromium_headless_shell-1200", "INSTALLATION_COMPLETE"));
    if (t === "chromium") disk.add(exe.chromium);
    if (t === "firefox" || t === "webkit") disk.add(exe[t]);
  };
  for (const t of on) put(t);
  const downloads: InstallTarget[][] = [];
  const said: string[] = [];
  let clock = 0;
  const deps: BrowserReadyDeps = {
    env,
    present: async () => browserPresence(exe, (p) => disk.has(p)),
    download: async (targets) => {
      downloads.push(targets);
      clock += 42_000;
      if (download.ok && download.lands !== false) for (const t of targets) put(t);
      return { ok: download.ok, detail: download.detail };
    },
    say: (line) => said.push(line),
    now: () => clock,
  };
  return { deps, downloads, said };
}

test("the first attach downloads the one build it needs, says so while it does, then carries on", async () => {
  const f = fakeBrowsers({}, []);
  const note = await readyBrowser({ engine: "chromium", headed: false }, f.deps);
  assert.deepEqual(f.downloads, [["chromium-headless-shell"]], "only the build a headless Chromium launch needs");
  assert.match(f.said[0], /^Getting the test browser ready — a one-time download of about 200 MB/);
  assert.equal(note, "The test browser is ready (chromium-headless-shell, downloaded once in 42 s; later tests start straight away).");
  // The next attach finds it and says nothing.
  assert.equal(await readyBrowser({ engine: "chromium", headed: false }, f.deps), null);
  assert.equal(f.downloads.length, 1);

  // A headed run needs the full browser; a firefox attach needs firefox, whatever else is there.
  const headed = fakeBrowsers({}, ["chromium-headless-shell"]);
  await readyBrowser({ engine: "chromium", headed: true }, headed.deps);
  assert.deepEqual(headed.downloads, [["chromium"]]);
  const ff = fakeBrowsers({}, ["chromium"]);
  await readyBrowser({ engine: "firefox", headed: false }, ff.deps);
  assert.deepEqual(ff.downloads, [["firefox"]]);
});

test("a build already on disk is never downloaded again, whatever the setting", async () => {
  for (const env of [{}, { CI: "true" }, { SCENESCOUT_BROWSER_DOWNLOAD: "off" }]) {
    const f = fakeBrowsers(env, ["chromium"]);
    assert.equal(await readyBrowser({ engine: "chromium", headed: true }, f.deps), null);
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.said, []);
  }
});

test("CI and the off setting download nothing and name the command to run by hand", async () => {
  const ci = fakeBrowsers({ CI: "true" }, []);
  await assert.rejects(readyBrowser({ engine: "chromium", headed: false }, ci.deps), (err: Error) => {
    assert.match(err.message, /In CI SceneScout downloads a browser only when asked/);
    assert.match(err.message, /SCENESCOUT_BROWSER_DOWNLOAD=on/);
    assert.match(err.message, /npx -y scenescout install --browser-only --browsers chromium-headless-shell/);
    return true;
  });
  assert.deepEqual(ci.downloads, []);

  const off = fakeBrowsers({ SCENESCOUT_BROWSER_DOWNLOAD: "off" }, []);
  await assert.rejects(
    readyBrowser({ engine: "webkit", headed: false }, off.deps),
    /SCENESCOUT_BROWSER_DOWNLOAD=off keeps SceneScout from downloading it.*--browsers webkit/s,
  );
  assert.deepEqual(off.downloads, []);

  // CI that asks for it gets the download.
  const asked = fakeBrowsers({ CI: "true", SCENESCOUT_BROWSER_DOWNLOAD: "on" }, []);
  await readyBrowser({ engine: "chromium", headed: false }, asked.deps);
  assert.equal(asked.downloads.length, 1);
});

test("a failed download says why and what to run by hand", async () => {
  const failed = fakeBrowsers({}, [], { ok: false, detail: "getaddrinfo ENOTFOUND cdn.example.com" });
  await assert.rejects(readyBrowser({ engine: "chromium", headed: false }, failed.deps), (err: Error) => {
    assert.match(err.message, /^The test browser could not be downloaded \(getaddrinfo ENOTFOUND cdn.example.com\)\. Check the network or proxy/);
    assert.match(err.message, /npx -y scenescout install --browser-only --browsers chromium-headless-shell/);
    return true;
  });
  // The installer reporting success is not the build being there.
  const missing = fakeBrowsers({}, [], { ok: true, lands: false });
  await assert.rejects(
    readyBrowser({ engine: "firefox", headed: false }, missing.deps),
    /download finished, but the firefox build is still not where Playwright looks.*--browsers firefox/s,
  );
});
