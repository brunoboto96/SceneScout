/**
 * Unit tests for the LANE REPORT — what a parallel agent hands back to the
 * planner, checked by a schema on arrival.
 *
 * The rule under test is that the instruction a lane is given and the parser
 * its reply meets cannot disagree: every closed-set value and every cap the
 * parser enforces is in the instruction text, because a limit the lane is not
 * told refuses good replies (three of the first ten real replies were lost
 * that way), and every cap the instruction states is actually enforced.
 *
 *   npx tsx --test scripts/lane-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LANE_BLOCKED_BY_MAX,
  LANE_CATEGORIES,
  LANE_EVIDENCE_MAX,
  LANE_MAX_ITEMS,
  LANE_NAME_MAX,
  LANE_OBSERVATION_MAX,
  LANE_ROUTE_MAX,
  LANE_SEVERITIES,
  LANE_STATUSES,
  LANE_VERDICTS,
  laneReportInstruction,
  parseLaneReport,
  summarizeLaneReport,
} from "../src/engine/lane.ts";
import { FINDING_CATEGORIES } from "../src/engine/memory.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observation: "o03",
    verdict: "defect",
    severity: "high",
    category: "http-error",
    confidence: 0.95,
    evidence: "GET /api/orders?status=archived 500",
    ...overrides,
  };
}

function laneReport(overrides: Record<string, unknown> = {}, decisionOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    lane: "orders",
    status: "complete",
    decisions: [decision(decisionOverrides)],
    routes: ["/orders.html"],
    blocked_by: null,
    ...overrides,
  });
}

function refused(text: string, reason: RegExp, label = text.slice(0, 80)): void {
  const r = parseLaneReport(text);
  assert.ok(!r.ok, `should refuse: ${label}`);
  assert.match(r.reason, reason, label);
}

test("lane: a well-formed reply parses, bare or fenced, with or without a newline before the closing fence", () => {
  const bare = parseLaneReport(laneReport());
  assert.ok(bare.ok, "bare JSON");
  for (const fenced of ["```json\n" + laneReport() + "\n```", "```\n" + laneReport() + "\n```", "```JSON\n" + laneReport() + "```"]) {
    const r = parseLaneReport(fenced);
    assert.ok(r.ok, fenced.slice(0, 12));
    assert.deepEqual(r.report, bare.report);
  }
});

test("lane: text before or after the object is refused, and the reason says which", () => {
  refused("Here is my report:\n" + laneReport(), /no text before/);
  refused(laneReport() + "\nHope this helps.", /no text after/);
  refused("```json\n" + laneReport() + "\n```\nDone.", /closing ```/);
  refused("", /no text before/, "empty reply");
  refused("{not json", /not valid JSON/);
});

test("lane: every value comes from a closed set, and the reason names the field", () => {
  refused(laneReport({}, { category: "bug" }), /at decisions\.0\.category$/);
  refused(laneReport({}, { severity: "critical" }), /at decisions\.0\.severity$/);
  refused(laneReport({}, { verdict: "maybe" }), /at decisions\.0\.verdict$/);
  refused(laneReport({}, { confidence: 1.2 }), /at decisions\.0\.confidence$/);
  refused(laneReport({}, { confidence: -0.1 }), /at decisions\.0\.confidence$/);
  refused(laneReport({}, { confidence: "high" }), /at decisions\.0\.confidence$/);
  refused(laneReport({}, { note: "an extra key" }), /Unrecognized key.*at decisions\.0$/);
  refused(laneReport({ notes: "an extra top-level key" }), /Unrecognized key/);
  refused(laneReport({ status: "done" }), /at status$/);
  refused(laneReport({ routes: [""] }), /at routes\.0$/);
});

test("lane: every cap the parser enforces refuses at cap+1 and accepts at the cap", () => {
  const caps: Array<[string, number, (n: number) => string, RegExp]> = [
    ["observation", LANE_OBSERVATION_MAX, (n) => laneReport({}, { observation: "o".repeat(n) }), /at decisions\.0\.observation$/],
    ["evidence", LANE_EVIDENCE_MAX, (n) => laneReport({}, { evidence: "e".repeat(n) }), /at decisions\.0\.evidence$/],
    ["blocked_by", LANE_BLOCKED_BY_MAX, (n) => laneReport({ status: "blocked", blocked_by: "b".repeat(n) }), /at blocked_by$/],
    ["lane", LANE_NAME_MAX, (n) => laneReport({ lane: "l".repeat(n) }), /at lane$/],
    ["route", LANE_ROUTE_MAX, (n) => laneReport({ routes: ["/" + "r".repeat(n - 1)] }), /at routes\.0$/],
  ];
  for (const [name, max, build, at] of caps) {
    assert.ok(parseLaneReport(build(max)).ok, `${name} at ${max} fits`);
    refused(build(max + 1), at, `${name} at ${max + 1}`);
  }
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => decision({ observation: `o${i}`, verdict: "not_a_defect", severity: null, category: null, evidence: null }));
  assert.ok(parseLaneReport(laneReport({ decisions: many(LANE_MAX_ITEMS) })).ok);
  refused(laneReport({ decisions: many(LANE_MAX_ITEMS + 1) }), /at decisions$/, "too many decisions");
  refused(laneReport({ routes: Array.from({ length: LANE_MAX_ITEMS + 1 }, (_, i) => `/r${i}`) }), /at routes$/, "too many routes");
  // The regression the caps were sized from: a descriptive self-assigned id and a real signature both fit.
  assert.ok(parseLaneReport(laneReport({}, { observation: "order-detail-save-notes-covered-by-stickybar" })).ok);
});

test("lane: a defect without a severity or a category is not a decision yet; a non-defect may carry either", () => {
  refused(laneReport({}, { severity: null }), /severity and a category/);
  refused(laneReport({}, { category: null }), /severity and a category/);
  assert.ok(parseLaneReport(laneReport({}, { verdict: "not_a_defect", severity: null, category: null, evidence: null })).ok);
  assert.ok(
    parseLaneReport(laneReport({}, { verdict: "unsure", severity: "low", category: "ux-polish", confidence: 0.5 })).ok,
    "an unsure with a tentative category tells the planner where to look",
  );
});

test("lane: blocked_by follows the status", () => {
  refused(laneReport({ status: "blocked" }), /must say what blocked it at blocked_by$/);
  refused(laneReport({ status: "complete", blocked_by: "sign-in returns 503" }), /complete lane cannot also have been blocked/);
  assert.ok(parseLaneReport(laneReport({ status: "blocked", blocked_by: "sign-in returns 503" })).ok);
  assert.ok(
    parseLaneReport(laneReport({ status: "partial", blocked_by: "write policy refused the manager sign-in" })).ok,
    "a partial lane may say what cut it short",
  );
});

test("lane: an observation judged twice is refused", () => {
  refused(laneReport({ decisions: [decision(), decision({ severity: "low" })] }), /judged twice at decisions\.1\.observation$/);
});

test("lane: a report naming another lane is refused when the planner says which lane it asked", () => {
  assert.ok(parseLaneReport(laneReport(), "orders").ok);
  const r = parseLaneReport(laneReport(), "reports");
  assert.ok(!r.ok && /names lane "orders".*asked of lane "reports"/.test(r.reason));
});

test("lane: the fold counts what the planner decides on", () => {
  const one = parseLaneReport(laneReport());
  assert.ok(one.ok);
  assert.equal(summarizeLaneReport(one.report), "orders: complete, 1 judged, 1 defects (1 high), 0 unsure, mean confidence 0.95, 1 routes");
  const mixed = parseLaneReport(
    laneReport({
      status: "blocked",
      blocked_by: "sign-in 503",
      decisions: [
        decision({ observation: "a", confidence: 1 }),
        decision({ observation: "b", severity: "low", confidence: 0.5 }),
        decision({ observation: "c", verdict: "unsure", severity: null, category: null, confidence: 0.4 }),
        decision({ observation: "d", verdict: "not_a_defect", severity: "high", category: null, confidence: 0.9, evidence: null }),
      ],
    }),
  );
  assert.ok(mixed.ok, mixed.ok ? "" : mixed.reason);
  // "high" is counted among defects only: d is a not_a_defect that happens to carry a severity.
  assert.equal(
    summarizeLaneReport(mixed.report),
    "orders: blocked, 4 judged, 2 defects (1 high), 1 unsure, mean confidence 0.70, 1 routes, blocked by sign-in 503",
  );
  const empty = parseLaneReport(laneReport({ decisions: [], routes: [] }));
  assert.ok(empty.ok);
  assert.equal(summarizeLaneReport(empty.report), "orders: complete, 0 judged, 0 defects (0 high), 0 unsure, mean confidence 0.00, 0 routes");
});

test("lane: the categories are the ones scout_finding accepts, and the skill lists every one", () => {
  assert.deepEqual([...LANE_CATEGORIES], [...FINDING_CATEGORIES]);
  const skill = fs.readFileSync(path.join(ROOT, "skills", "scenescout", "SKILL.md"), "utf8");
  const line = skill.split("\n").find((l) => l.includes("`scout_finding` takes `severity`, `category`"));
  assert.ok(line, "the skill's scout_finding bullet is where the categories are listed");
  for (const c of FINDING_CATEGORIES) assert.ok(line.includes(`\`${c}\``), `the skill's category list is missing ${c}`);
});

test("lane: the instruction the planner sends names every value and every cap the parser enforces", () => {
  const text = laneReportInstruction("orders");
  for (const v of [...LANE_CATEGORIES, ...LANE_SEVERITIES, ...LANE_VERDICTS, ...LANE_STATUSES]) {
    assert.ok(text.includes(`"${v}"`), `instruction is missing "${v}"`);
  }
  for (const [name, cap] of [
    ["observation", LANE_OBSERVATION_MAX],
    ["evidence", LANE_EVIDENCE_MAX],
    ["blocked_by", LANE_BLOCKED_BY_MAX],
    ["lane name", LANE_NAME_MAX],
    ["route", LANE_ROUTE_MAX],
  ] as const) {
    assert.ok(text.includes(`${cap} characters`), `the ${name} cap (${cap}) is stated, not discovered by refusal`);
  }
  assert.ok(text.includes(`${LANE_MAX_ITEMS} decisions`));
  assert.ok(text.includes('required when the status is "blocked"'), "the blocked rule is stated like the defect rule is");
  assert.ok(text.includes('"lane":"orders"'));
  assert.ok(laneReportInstruction('a"b').includes('"lane":"a\\"b"'), "the lane name is escaped into the example");
});
