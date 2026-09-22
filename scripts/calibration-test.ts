/**
 * Whether a lane's stated confidence matches what happened.
 *
 * The rules here decide what a published number claims, so most of these tests
 * are about what is NOT counted and what is NOT said. A calibration figure is
 * the kind of number a reader quotes back months later; printing one computed
 * over four decisions, or over decisions that had no checkable outcome, is
 * worse than printing nothing.
 *
 *   npx tsx --test scripts/calibration-test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bucketLabel,
  bucketOf,
  calibrate,
  formatCalibration,
  joinKeys,
  MIN_FOR_A_VERDICT,
  signatureKey,
  type RecordedDecision,
} from "../src/engine/calibration.ts";
import type { Finding } from "../src/engine/memory.ts";

let n = 0;
const decision = (over: Partial<RecordedDecision> = {}): RecordedDecision => ({
  lane: "orders",
  observation: `obs-${(n += 1)}`,
  verdict: "defect",
  severity: "medium",
  category: "data-inconsistency",
  confidence: 0.9,
  evidence: `GET /api/r${n} 500`,
  at: "2026-09-22T10:00:00.000Z",
  ...over,
});

const finding = (evidence: string, over: Partial<Finding> = {}): Finding => ({
  id: `f${evidence.length}${Math.random().toString(36).slice(2, 6)}`,
  severity: "medium",
  category: "data-inconsistency",
  title: "t",
  detail: "d",
  evidence,
  url: "http://app.test/things",
  state: "things#1",
  repro: [],
  foundAt: "2026-09-22T10:00:00.000Z",
  runs: 1,
  ...over,
});

/** A run of `hit` decisions that were filed and `miss` that were not, all at one confidence. */
function run(confidence: number, hit: number, miss: number): { decisions: RecordedDecision[]; findings: Finding[] } {
  const decisions: RecordedDecision[] = [];
  const findings: Finding[] = [];
  for (let i = 0; i < hit; i += 1) {
    const d = decision({ confidence });
    decisions.push(d);
    findings.push(finding(d.evidence as string));
  }
  for (let i = 0; i < miss; i += 1) decisions.push(decision({ confidence }));
  return { decisions, findings };
}

// ── what counts ─────────────────────────────────────────────────────────────

test("only a defect carrying a signature has a checkable outcome", () => {
  // An "unsure" asks the planner to look closer; it is not a claim that can be
  // right or wrong. A decision with no signature cannot be joined to anything,
  // so counting it would measure willingness to attach evidence, not judgement.
  const decisions = [
    decision({ verdict: "unsure", severity: null, category: null }),
    decision({ verdict: "not_a_defect", severity: null, category: null }),
    decision({ verdict: "defect", evidence: null }),
  ];
  assert.equal(calibrate(decisions, []), null);
});

test("a run that used no lanes produces nothing at all", () => {
  assert.equal(calibrate([], []), null);
  assert.deepEqual(formatCalibration(null), []);
});

test("a decision is filed when a finding carries the same signature", () => {
  const { decisions, findings } = run(0.9, 3, 1);
  const c = calibrate(decisions, findings);
  assert.equal(c?.checkable, 4);
  assert.equal(c?.filed, 3);
});

test("decisions about one endpoint all count as filed when the store merged them into one finding", () => {
  // Findings MERGE: /api/things/3 and /api/things/7 normalise to the same
  // /api/things/:id, so five lane decisions about that endpoint produce ONE
  // finding. Joining on the literal string reported 1 filed and 4 dropped —
  // the lanes understated fivefold, and the number read as a verdict on them
  // rather than a bug in the join. Found by rendering a report, not by a test.
  const decisions = [3, 7, 11, 19, 23].map((i) => decision({ evidence: `GET /api/things/${i} 500` }));
  const c = calibrate(decisions, [finding("GET /api/things/3 500")]);
  assert.equal(c?.checkable, 5);
  assert.equal(c?.filed, 5, "the store considers these one bug, and it was filed");
});

test("two different endpoints are not merged by the join", () => {
  const decisions = [decision({ evidence: "GET /api/things/3 500" }), decision({ evidence: "GET /api/orders/3 500" })];
  const c = calibrate(decisions, [finding("GET /api/things/3 500")]);
  assert.equal(c?.filed, 1);
});

test("evidence that names no endpoint still joins on its own text", () => {
  // Not every finding is an HTTP failure; a widget reading zero is evidence too.
  const c = calibrate([decision({ evidence: "widget dashboard-count shows 0" })], [finding("widget  dashboard-count shows 0")]);
  assert.equal(c?.filed, 1);
  const miss = calibrate([decision({ evidence: "widget dashboard-count shows 0" })], [finding("widget other-count shows 0")]);
  assert.equal(miss?.filed, 0);
});

test("spacing in a signature does not break the join, but case does not change", () => {
  assert.equal(signatureKey("  GET   /api/things 500 "), "GET /api/things 500");
  assert.equal(signatureKey("GET /API/Things 500"), "GET /API/Things 500", "a path is case-sensitive");
  const d = decision({ evidence: "GET  /api/things 500" });
  const c = calibrate([d], [finding("GET /api/things 500")]);
  assert.equal(c?.filed, 1);
  assert.deepEqual([...joinKeys("GET /api/things/9 500")], ["GET /api/things/:id 500"], "the join speaks the store's own signature");
});

// ── the number itself ───────────────────────────────────────────────────────

test("a lane that is right exactly as often as it says has no calibration error", () => {
  // Ten decisions at 0.9 of which nine were filed: the statement and the
  // outcome agree, which is what a calibrated confidence means.
  const { decisions, findings } = run(0.9, 9, 1);
  const c = calibrate(decisions, findings);
  assert.ok((c?.ece ?? 1) < 1e-9, `expected no error, got ${c?.ece}`);
  assert.equal(c?.buckets.length, 1);
  assert.equal(c?.buckets[0].decisions, 10);
  assert.equal(c?.buckets[0].filed, 0.9);
});

test("a lane that is confidently wrong is measured as such", () => {
  // Ten at 0.9, two filed: the number it stated is 0.7 away from the truth.
  const { decisions, findings } = run(0.9, 2, 8);
  const c = calibrate(decisions, findings);
  assert.ok(Math.abs((c?.ece ?? 0) - 0.7) < 1e-9, String(c?.ece));
});

test("error is weighted by how many decisions sit in each bucket", () => {
  // Nine well-calibrated at 0.9 plus one badly wrong at 0.3 must not read as
  // half-wrong: a bucket of one carries a tenth of the weight.
  const good = run(0.9, 9, 1);
  const bad = { decisions: [decision({ confidence: 0.3 })], findings: [] as Finding[] };
  const c = calibrate([...good.decisions, ...bad.decisions], [...good.findings, ...bad.findings]);
  assert.equal(c?.buckets.length, 2);
  assert.ok(Math.abs((c?.ece ?? 0) - 0.3 / 11) < 1e-9, String(c?.ece));
});

test("confidences land in the bucket they read as", () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(0.2), 0);
  assert.equal(bucketOf(0.21), 1);
  assert.equal(bucketOf(1), 4);
  // Out-of-range values are clamped rather than thrown: the schema already
  // refuses them, and a report must not crash on stored history either way.
  assert.equal(bucketOf(-1), 0);
  assert.equal(bucketOf(99), 4);
  assert.equal(bucketLabel(0), "0.0–0.2");
  assert.equal(bucketLabel(4), "0.8–1.0");
});

// ── what the report says ────────────────────────────────────────────────────

test("too few decisions print nothing rather than a number that swings on one", () => {
  const few = run(0.9, MIN_FOR_A_VERDICT - 2, 1);
  const c = calibrate(few.decisions, few.findings);
  assert.ok(c, "it is still computed");
  assert.deepEqual(formatCalibration(c), [], "…but not published");

  const enough = run(0.9, MIN_FOR_A_VERDICT, 0);
  assert.ok(formatCalibration(calibrate(enough.decisions, enough.findings)).length > 0);
});

test("the section says what the number is not, before any percentage", () => {
  // "ECE 0.24" above a table of percentages reads as a verdict on the app.
  // It is a verdict on the lanes, against this run's own bar.
  const { decisions, findings } = run(0.9, 8, 2);
  const out = formatCalibration(calibrate(decisions, findings)).join("\n");
  assert.match(out, /not whether the app is broken/);
  assert.ok(out.indexOf("not whether the app is broken") < out.indexOf("| Stated confidence |"), "the caveat comes before the table");
  assert.match(out, /Expected calibration error/);
});

test("re-tested findings are reported separately, because those ARE about the app", () => {
  const { decisions, findings } = run(0.9, 9, 1);
  findings[0] = { ...findings[0], verdict: "present", verifiedAt: "2026-09-22T11:00:00.000Z" };
  findings[1] = { ...findings[1], verdict: "gone", verifiedAt: "2026-09-22T11:00:00.000Z" };
  // A verdict with no date is not a confirmation, and must not be counted.
  findings[2] = { ...findings[2], verdict: "changed" };
  const c = calibrate(decisions, findings);
  assert.deepEqual(c?.verified, { present: 1, gone: 1, changed: 0 });
  const out = formatCalibration(c).join("\n");
  assert.match(out, /2 of the filed findings have since been re-tested/);
  const one = formatCalibration(
    calibrate(
      decisions,
      findings.map((f, i) => (i === 1 ? { ...f, verdict: undefined, verifiedAt: undefined } : f)),
    ),
  ).join("\n");
  assert.match(one, /1 of the filed findings has since been re-tested/, "it reads as English for a single finding");
  assert.match(out, /evidence about the app, unlike the table above/);
});

test("a run with nothing re-tested says nothing about re-testing", () => {
  const { decisions, findings } = run(0.9, 9, 1);
  const out = formatCalibration(calibrate(decisions, findings)).join("\n");
  assert.ok(!out.includes("re-tested"), out);
});
