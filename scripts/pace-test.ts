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
  assert.deepEqual(measurePace([], T0), { sessions: [], spanMs: 0, actions: 0, quiet: [] });
  const bad = measurePace([{ at: "not a date", action: "click", url: "" }], T0);
  assert.deepEqual(bad.sessions, [], "a row with no usable time is not a session");
});

test("the report says what idle means, and warns about a held browser", () => {
  const log = [step(0, "admin"), step(1, "admin"), step(0, "auditor")];
  const lines = formatPace(measurePace(log, T0 + STALE_SESSION_MS + 1000, ["admin", "auditor"])).join("\n");
  assert.match(lines, /How the run was paced/);
  assert.match(lines, /waiting for the agent, not time the engine spent working/, "the number is about the agent, and says so");
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
