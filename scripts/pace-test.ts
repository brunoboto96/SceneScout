/**
 * How a run's pace is measured, and the stale-session warning that comes from
 * it. The numbers behind these tests are from a real four-session validation
 * run: median gaps under a second, idle share near 85%, and one session that
 * performed a single action and then held a browser for the rest of the hour.
 *
 *   npx tsx --test scripts/pace-test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPace, IDLE_GAP_MS, measurePace, sayDuration, STALE_SESSION_MS, isActing } from "../src/engine/pace.ts";
import type { ActionLogEntry } from "../src/engine/memory.ts";

const T0 = Date.parse("2026-09-20T20:00:00.000Z");
const at = (secs: number): string => new Date(T0 + secs * 1000).toISOString();
const step = (secs: number, session: string, over: Partial<ActionLogEntry> = {}): ActionLogEntry => ({
  at: at(secs),
  action: "click",
  url: "http://app.test/x",
  session,
  ...over,
});

test("idle is the gap the agent spent thinking, not time the engine worked", () => {
  // Four quick actions, then a two-minute pause, then one more.
  const log = [step(0, "admin"), step(1, "admin"), step(2, "admin"), step(3, "admin"), step(123, "admin")];
  const pace = measurePace(log, T0 + 123_000);
  const admin = pace.sessions[0];
  assert.equal(admin.actions, 5);
  assert.equal(admin.medianGapMs, 1000, "the typical step costs a second");
  assert.equal(admin.maxGapMs, 120_000);
  // 120s of the 123s span was one gap over the threshold.
  assert.ok(admin.idleShare > 0.95 && admin.idleShare <= 1, String(admin.idleShare));
  assert.equal(pace.actions, 5);
});

test("a session that acted once and then held its browser is named", () => {
  const log = [step(0, "admin"), step(1, "admin"), step(0, "auditor")];
  // The clock is set so auditor is past the threshold and admin sits exactly
  // on it: the boundary is exclusive, so only the one genuinely over is named.
  const open = ["admin", "auditor"];
  const pace = measurePace(log, T0 + STALE_SESSION_MS + 1000, open);
  assert.deepEqual(pace.quiet, ["auditor"]);
  assert.deepEqual(measurePace(log, T0 + STALE_SESSION_MS + 2000, open).quiet.sort(), ["admin", "auditor"], "a second later, both are");

  const busy = measurePace(log, T0 + 2000);
  assert.deepEqual(busy.quiet, [], "…and neither is, a moment after acting");
});

test("each session is measured on its own actions, not the interleaved log", () => {
  const log = [step(0, "admin"), step(10, "qa"), step(20, "admin"), step(30, "qa"), step(40, "qa")];
  const pace = measurePace(log, T0 + 40_000);
  const byName = Object.fromEntries(pace.sessions.map((s) => [s.session, s]));
  assert.equal(byName.admin.actions, 2);
  assert.equal(byName.qa.actions, 3);
  assert.equal(byName.admin.medianGapMs, 20_000, "admin's own gap, not the 10s to the next qa action");
  assert.equal(pace.spanMs, 40_000, "the run spans the first action to the last, whoever took them");
});

test("frames are counted so an unrecorded run is visible as one", () => {
  const log = [step(0, "qa", { frame: "recordings/qa/0001-click.jpg" }), step(1, "qa"), step(2, "qa", { frame: "recordings/qa/0002-click.jpg" })];
  assert.equal(measurePace(log, T0).sessions[0].framed, 2);
  assert.equal(measurePace([step(0, "qa"), step(1, "qa")], T0).sessions[0].framed, 0);
});

test("an empty or unparseable log measures nothing rather than throwing", () => {
  assert.deepEqual(measurePace([], T0), {
    sessions: [],
    spanMs: 0,
    actions: 0,
    quiet: [],
    waiting: { workingMs: 0, workingIdleMs: 0, leadInMs: 0, afterFinishMs: 0, afterFoldMs: null },
  });
  const bad = measurePace([{ at: "not a date", action: "click", url: "" }], T0);
  assert.deepEqual(bad.sessions, [], "a row with no usable time is not a session");
});

test("the report says what idle means, and warns about a held browser", () => {
  const log = [step(0, "admin"), step(1, "admin"), step(0, "auditor")];
  const lines = formatPace(measurePace(log, T0 + STALE_SESSION_MS + 1000, ["admin", "auditor"])).join("\n");
  assert.match(lines, /How the run was paced/);
  assert.match(lines, /the agent thinking at length\. That is how closely the sessions kept working/, "the number is about the agent, and says so");
  assert.match(lines, /Held a browser with nothing to do/);
  assert.match(lines, /auditor/);
  // A run where everything is busy gets the table and no warning.
  const quiet = formatPace(measurePace(log, T0 + 2000, ["admin", "auditor"])).join("\n");
  assert.ok(!quiet.includes("Held a browser"));
  assert.deepEqual(formatPace(measurePace([], T0)), [], "no run, no section");
});

test("durations read the way a person says them", () => {
  assert.equal(sayDuration(0), "0s");
  assert.equal(sayDuration(45_000), "45s");
  assert.equal(sayDuration(252_000), "4m12s");
  assert.equal(sayDuration(3_780_000), "1h03m");
  assert.equal(IDLE_GAP_MS, 30_000);
});

test("stated tasks and attaches are not actions: they take no time", () => {
  // A real run logged 325 entries of which 107 were stated tasks, inflating
  // every session's action count by about a third and dragging the median gap
  // toward zero.
  const log = [
    step(0, "qa", { action: "attach" }),
    step(0, "qa", { action: "task", target: "Filing an order" }),
    step(0, "qa", { action: "click" }),
    step(10, "qa", { action: "task", target: "Checking the register" }),
    step(20, "qa", { action: "click" }),
    step(20, "qa", { action: "created-resource", target: "/api/orders id=1" }),
  ];
  const pace = measurePace(log, T0 + 20_000);
  assert.equal(pace.actions, 2, "two clicks, not six entries");
  assert.equal(pace.sessions[0].actions, 2);
  assert.equal(pace.sessions[0].medianGapMs, 20_000, "the gap between the clicks, not between a click and a marker");
  assert.equal(isActing("click"), true);
  assert.equal(isActing("task"), false);
  assert.equal(isActing("close"), false);
  assert.equal(isActing("lane-report"), false);
  assert.equal(isActing("journey:start"), false);
});

test("only a session still attached can be holding a browser", () => {
  const log = [step(0, "lane-a"), step(0, "lane-b")];
  const later = T0 + STALE_SESSION_MS + 60_000;

  // Both are long quiet, but only one is still open. Warning about a lane that
  // finished and closed told the reader to close something already gone — for
  // six of eleven sessions in the first run that printed this report.
  assert.deepEqual(measurePace(log, later, ["lane-a"]).quiet, ["lane-a"]);
  assert.deepEqual(measurePace(log, later, []).quiet, [], "a run whose lanes have all closed warns about nothing");
  assert.deepEqual(measurePace(log, later, ["lane-a", "lane-b"]).quiet.sort(), ["lane-a", "lane-b"]);

  // And the warning line follows the same rule.
  assert.ok(
    !formatPace(measurePace(log, later, []))
      .join("\n")
      .includes("Held a browser"),
  );
  assert.match(formatPace(measurePace(log, later, ["lane-b"])).join("\n"), /Held a browser with nothing to do.*lane-b/);
});

test("time after a lane finished is kept apart from its working time", () => {
  // A lane that waited 20s after attaching, acted for 10s, then sat for two
  // minutes waiting to be folded before it was closed.
  const log = [step(0, "orders", { action: "attach" }), step(20, "orders"), step(30, "orders"), step(150, "orders", { action: "close" })];
  const orders = measurePace(log, T0 + 999_000).sessions[0];
  assert.equal(orders.actions, 2, "attach and close are not actions");
  assert.equal(orders.spanMs, 10_000, "working time is first action to last");
  assert.equal(orders.leadInMs, 20_000);
  assert.equal(orders.afterFinishMs, 120_000);
  assert.equal(orders.afterFoldMs, null, "no fold was recorded");
  assert.match(formatPace(measurePace(log, T0 + 999_000)).join("\n"), /\| orders \| 2 \| 10s \| .* \| 0% \| 2m00s \| 0 \|/);
});

test("a fold marker splits the time after finishing at the moment the browser stopped being needed", () => {
  const log = [
    step(0, "orders", { action: "attach" }),
    step(5, "orders"),
    step(65, "orders"),
    step(95, "orders", { action: "lane-report" }), // 30s writing the report
    step(245, "orders", { action: "close" }), // 150s waiting to be closed
  ];
  const pace = measurePace(log, T0 + 999_000);
  const orders = pace.sessions[0];
  assert.equal(orders.actions, 2, "the fold marker is not an action");
  assert.equal(orders.afterFinishMs, 180_000);
  assert.equal(orders.afterFoldMs, 150_000);
  assert.match(formatPace(pace).join("\n"), /3m00s \(2m30s after fold\)/);
});

test("the run's summary separates the lanes' efficiency from waiting to be collected", () => {
  // Eight quick lanes that all finish early and wait for the slowest: the
  // case a single "held idle" figure scored as the idlest run.
  const log = [];
  for (let i = 0; i < 8; i += 1) {
    const lane = `lane-${i}`;
    log.push(
      step(0, lane, { action: "attach" }),
      step(1, lane),
      step(61, lane),
      step(62, lane, { action: "lane-report" }),
      step(600, lane, { action: "close" }),
    );
  }
  const pace = measurePace(log, T0 + 999_000);
  assert.equal(pace.waiting.workingMs, 8 * 60_000);
  assert.equal(pace.waiting.workingIdleMs, 8 * 60_000, "each lane's one 60s gap is over the threshold");
  assert.equal(pace.waiting.afterFinishMs, 8 * 539_000);
  assert.equal(pace.waiting.afterFoldMs, 8 * 538_000);
  const text = formatPace(pace).join("\n");
  assert.match(text, /\*\*While working\*\*.*100% was spent in gaps/);
  assert.match(text, /\*\*After finishing\*\*, sessions held their browsers for a further 1h11m, 1h11m of it after their report was already folded/);

  const tight = measurePace([step(0, "a", { action: "attach" }), step(1, "a"), step(3, "a"), step(4, "a", { action: "close" })], T0 + 999_000);
  assert.match(formatPace(tight).join("\n"), /0% was spent in gaps/);
  assert.equal(tight.waiting.afterFoldMs, null, "a run with no fold says nothing about folds");
  assert.doesNotMatch(formatPace(tight).join("\n"), /after their report/);
});

test("a session that attached and never acted is in the table, all of it lead-in", () => {
  // The case the old table could not show: a re-attached browser nobody used.
  const log = [step(0, "admin"), step(5, "admin"), step(10, "inventory", { action: "attach" }), step(130, "inventory", { action: "close" })];
  const byName = Object.fromEntries(measurePace(log, T0 + 999_000).sessions.map((s) => [s.session, s]));
  assert.equal(byName.inventory?.actions, 0);
  assert.equal(byName.inventory?.leadInMs, 120_000);
  assert.equal(byName.admin.leadInMs + byName.admin.afterFinishMs, 0, "no attach recorded, nothing to measure from");
});

test("a session still attached is waiting up to now; a closed one with no close marker is not guessed at", () => {
  const log = [step(0, "qa", { action: "attach" }), step(10, "qa")];
  const open = measurePace(log, T0 + 70_000, ["qa"]).sessions[0];
  assert.deepEqual([open.leadInMs, open.afterFinishMs], [10_000, 60_000], "10s before, 60s since");
  // Written before close was logged: when it closed is unknown, so only the leading gap counts.
  const closed = measurePace(log, T0 + 70_000, []).sessions[0];
  assert.deepEqual([closed.leadInMs, closed.afterFinishMs], [10_000, 0]);
  // Re-attached: each attach is measured on its own.
  const twice = [...log, step(20, "qa", { action: "close" }), step(100, "qa", { action: "attach" }), step(103, "qa"), step(104, "qa", { action: "close" })];
  const both = measurePace(twice, T0 + 999_000).sessions[0];
  assert.deepEqual([both.leadInMs, both.afterFinishMs], [10_000 + 3_000, 10_000 + 1_000]);
});

test("the edges do not depend on the order the log arrives in", () => {
  const inOrder = [step(0, "qa", { action: "attach" }), step(10, "qa"), step(20, "qa"), step(100, "qa", { action: "close" })];
  const shuffled = [inOrder[2], inOrder[0], inOrder[3], inOrder[1]];
  const a = measurePace(shuffled, T0 + 999_000).sessions[0];
  const b = measurePace(inOrder, T0 + 999_000).sessions[0];
  assert.deepEqual([a.leadInMs, a.afterFinishMs], [b.leadInMs, b.afterFinishMs]);
  assert.deepEqual([b.leadInMs, b.afterFinishMs], [10_000, 80_000]);
});

test("a lane that acts again after its report was folded has no after-fold split", () => {
  // Filing a defect the fold said was unfiled means acting after the fold. The
  // browser WAS still needed, so none of the trailing time is "after fold".
  const log = [
    step(0, "orders", { action: "attach" }),
    step(5, "orders"),
    step(60, "orders", { action: "lane-report" }),
    step(70, "orders"),
    step(200, "orders", { action: "close" }),
  ];
  const orders = measurePace(log, T0 + 999_000).sessions[0];
  assert.equal(orders.afterFinishMs, 130_000, "from the LAST action, the one after the fold");
  assert.equal(orders.afterFoldMs, null);
});
