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
import test from "node:test";
import { SessionQueue, withWatchdog } from "../dist/engine/dispatch.js";

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
  await assert.rejects(q.run("admin", async () => { throw new Error("boom"); }), /boom/);
  // Without the (fn, fn) two-armed then, the chain stays rejected and every
  // later call on that session inherits the failure forever.
  assert.equal(await q.run("admin", async () => "ok"), "ok");
});

test("a rejection is delivered to its own caller, not to the next one", async () => {
  const q = new SessionQueue();
  const failing = q.run("admin", async () => { throw new Error("first"); });
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
  // ft_close runs on its own control chain, so it really can land mid-call.
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
  const out = await withWatchdog("ft_click", never, 20, (label, ms) => `timeout:${label}:${ms}`);
  assert.equal(out, "timeout:ft_click:20");
});

test("a call that beats the watchdog returns its own result", async () => {
  const out = await withWatchdog("ft_click", Promise.resolve("real"), 50, () => "timeout");
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
    const out = await withWatchdog("ft_navigate", late, 10, () => "timed-out");
    assert.equal(out, "timed-out");
    await tick(60); // let the late rejection land
    assert.equal(unhandled, null, "the losing side of the race must be caught, or Node crashes the process");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a call that rejects before the timeout still rejects to its caller", async () => {
  await assert.rejects(
    withWatchdog("ft_click", Promise.reject(new Error("real failure")), 1000, () => "timeout"),
    /real failure/,
  );
});
