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
  type RecordedDecision,
  unfiledDefects,
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

test("evidence naming no failing endpoint is unjoinable, NOT a lane getting it wrong", () => {
  // The literal-text fallback was the worst thing here: "500 on GET /api/r0"
  // is ordinary English, and whichever agent wrote the finding chose the word
  // order. It produced a key matching nothing, and a lane that was right about
  // a bug that WAS filed published an expected calibration error of 0.90.
  const c = calibrate([decision({ evidence: "widget dashboard-count shows 0" })], [finding("widget dashboard-count shows 0")]);
  assert.equal(c?.checkable, 0, "nothing can be looked up for it");
  assert.equal(c?.unjoinable, 1);
  assert.equal(c?.filed, 0);
  assert.deepEqual([...joinKeys("widget dashboard-count shows 0")], [], "no key at all");
  assert.deepEqual([...joinKeys("500 on GET /api/r0")], [], "a status before its endpoint names no failure");
});

test("spacing and case in a signature do not break the join", () => {
  // The join speaks the store's own signature, which normalises the path and
  // lower-cases it, so the two sides agree on what one bug is.
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
  const said = formatCalibration(c).join("\n");
  assert.ok(!said.includes("Expected calibration error"), "no figure");
  // But the ABSENCE is explained. A run with seven decisions and a run with
  // none looked identical when the section simply vanished, and the reader
  // concluded the feature was broken.
  assert.match(said, /Not enough to say yet/);
  assert.match(said, /8 are needed/);

  const enough = run(0.9, MIN_FOR_A_VERDICT, 0);
  assert.ok(formatCalibration(calibrate(enough.decisions, enough.findings)).length > 0);
});

test("the section says what the number is not, before any percentage", () => {
  // "ECE 0.24" above a table of percentages reads as a verdict on the app.
  // It is a verdict on the lanes, against this run's own bar.
  const { decisions, findings } = run(0.9, 8, 2);
  const out = formatCalibration(calibrate(decisions, findings)).join("\n");
  assert.match(out, /not whether the app is broken/);
  assert.ok(out.indexOf("not whether the app is broken") < out.indexOf("|"), "the caveat comes before any table");
  assert.match(out, /Expected calibration error/);
  // The table's rows carry the whole point; a header alone says nothing.
  assert.match(out, /\| 0\.8–1\.0 \| 10 \| 0\.90 \| 80% \|/, out);
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
  assert.match(out, /2 of the findings those decisions matched/);
  const one = formatCalibration(
    calibrate(
      decisions,
      findings.map((f, i) => (i === 1 ? { ...f, verdict: undefined, verifiedAt: undefined } : f)),
    ),
  ).join("\n");
  assert.match(one, /1 of the findings those decisions matched has /, "it reads as English for a single finding");
  assert.match(out, /evidence about the app, unlike the table above/);
});

test("a run with nothing re-tested says nothing about re-testing", () => {
  const { decisions, findings } = run(0.9, 9, 1);
  const out = formatCalibration(calibrate(decisions, findings)).join("\n");
  assert.ok(!out.includes("scout_verify"), out);
});

// ── what the review's mutations showed was unpinned ─────────────────────────

test("a decision about an endpoint that ANSWERED does not join to a failure on it", () => {
  // The store counts only a failing signature as a bug's identity: a bare
  // "POST /api/orders" names the endpoint, not what went wrong, and a double
  // submit and an accepted negative quantity both name it. Joining on it too
  // credited a lane for an unrelated finding on the same endpoint.
  const c = calibrate([decision({ evidence: "POST /api/orders" })], [finding("POST /api/orders 500")]);
  assert.equal(c?.filed, 0);
  assert.deepEqual([...joinKeys("GET /api/x 200")], [], "an endpoint that answered is not a bug signature");
});

test("the re-test line counts findings, not the decisions that matched them", () => {
  // Ten decisions about one endpoint match ONE finding. Counting per decision
  // said "10 of the filed findings have since been re-tested" when there was
  // one of them.
  const decisions = Array.from({ length: 10 }, (_, i) => decision({ evidence: `GET /api/things/${i} 500` }));
  const one = { ...finding("GET /api/things/1 500"), verdict: "present" as const, verifiedAt: "2026-09-22T11:00:00.000Z" };
  const c = calibrate(decisions, [one]);
  assert.equal(c?.filed, 10, "every decision is a prediction, and each was right");
  assert.deepEqual(c?.verified, { present: 1, gone: 0, changed: 0 }, "but there is one finding");
});

test("a confidence that is not a number lands in the lowest bucket, not the highest", () => {
  // Falling through the comparisons put NaN in 0.8–1.0 and rendered "mean
  // stated confidence of NaN" beside it: a confidence nobody stated, reported
  // as near-certainty. The schema refuses it; stored history is read without one.
  assert.equal(bucketOf(Number.NaN), 0);
  assert.equal(bucketOf(Number.POSITIVE_INFINITY), 0);
  assert.equal(bucketOf(-1), 0);
  assert.equal(bucketOf(99), 4);
});

test("the mean stated confidence is a mean", () => {
  // Reporting the SUM would print "mean stated confidence of 9.00".
  const { decisions, findings } = run(0.9, 9, 1);
  assert.ok(Math.abs((calibrate(decisions, findings)?.stated ?? 0) - 0.9) < 1e-9);
});

test("the advice under the table matches the error above it", () => {
  // These three bands ARE the section's advice; nothing else pins them.
  const good = formatCalibration(calibrate(...(Object.values(run(0.9, 9, 1)) as [never, never]))).join("\n");
  assert.match(good, /track what happened closely/);
  const bad = formatCalibration(calibrate(...(Object.values(run(0.9, 1, 9)) as [never, never]))).join("\n");
  assert.match(bad, /rather than a rate/);
});

test("eight is the threshold, as a number and not as whatever the constant says", () => {
  const seven = run(0.9, 7, 0);
  const eight = run(0.9, 8, 0);
  assert.ok(!formatCalibration(calibrate(seven.decisions, seven.findings)).join("\n").includes("Expected calibration"), "seven publishes no figure");
  assert.match(formatCalibration(calibrate(eight.decisions, eight.findings)).join("\n"), /Expected calibration error/, "eight does");
  assert.equal(MIN_FOR_A_VERDICT, 8);
});

test("a confidence the file should not have held is excluded, not averaged in", () => {
  // The schema guards the wire, not the file. One stored 2 among nine 0.9s
  // published "mean stated confidence of 1.02" and moved the error across an
  // advice band; a string published NaN.
  const { decisions, findings } = run(0.9, 9, 1);
  const bad = decision({ confidence: 2 });
  const worse = decision({ confidence: "0.9" as unknown as number });
  const c = calibrate([...decisions, bad, worse], findings);
  assert.equal(c?.checkable, 10, "the two unusable ones are not scored");
  assert.equal(c?.unjoinable, 2);
  assert.ok(Math.abs((c?.stated ?? 0) - 0.9) < 1e-9, String(c?.stated));
  assert.ok(Number.isFinite(c?.ece), String(c?.ece));
  assert.match(formatCalibration(c).join("\n"), /2 further decision\(s\)/);
});

test("a judged defect with no finding behind it is named when the report is folded, and a filed one is not", () => {
  const findings = [finding("GET /api/things/3 500"), finding("save-notes covered by sticky footer at 1280x800")];
  const unfiled = unfiledDefects(
    [
      // Filed under another id of the same endpoint: the store merges these, so this is filed.
      decision({ observation: "things-500", evidence: "GET /api/things/9 500" }),
      // No failure signature, but the same evidence text the finding carries.
      decision({ observation: "sticky", evidence: "save-notes covered by sticky footer" }),
      // Judged, never filed: the case this exists for.
      decision({ observation: "label-missing", evidence: "input[name=email] has no label" }),
      decision({ observation: "no-evidence", evidence: null }),
      // Not defects: nothing to file.
      decision({ observation: "fine", verdict: "not_a_defect", evidence: "GET /api/other 500" }),
      decision({ observation: "maybe", verdict: "unsure", evidence: "GET /api/other 500" }),
    ],
    findings,
  );
  assert.deepEqual(unfiled, ["label-missing — input[name=email] has no label", "no-evidence"]);
});

test("a decision naming a failing endpoint is filed only by a finding on that endpoint, never by text overlap", () => {
  // The finding's evidence is inside the decision's, but it names no failure: not the same bug by the store's rule.
  const findings = [finding("GET /api/items")];
  const d = decision({ observation: "toast-lies", evidence: "toast says saved but GET /api/items returned 500" });
  assert.deepEqual(unfiledDefects([d], findings), ["toast-lies — toast says saved but GET /api/items returned 500"]);
  assert.deepEqual(unfiledDefects([d], [finding("GET /api/items 500")]), [], "the same failing signature is filed");
});

test("a short signature does not count as filed just because it appears inside another finding", () => {
  // "404" is inside half a run's findings; it says nothing about which one covers this.
  assert.deepEqual(unfiledDefects([decision({ observation: "x", evidence: "404" })], [finding("GET /img/chart.png 404")]), ["x — 404"]);
  assert.deepEqual(unfiledDefects([decision({ observation: "x", evidence: "404" })], [finding("404")]), [], "the same text exactly is filed");
});
