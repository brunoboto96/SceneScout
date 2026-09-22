/**
 * Scoring a run against an answer key.
 *
 * The scorer is what every later change to the engine and the skill will be
 * judged by, so it has to be right in the same way the product is: a wrong
 * number here would make a bad change look good. Most of these tests are
 * contrastive pairs — two phrasings that differ in the one fact that flips
 * the classification — because the scorer's hard cases are false positives
 * that mention the same endpoint as a real defect.
 *
 *   npx tsx --test scripts/bench-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { calibrateAgainstKey, classify, formatScorecard, judgeDecision, score, type AnswerKey } from "../src/engine/bench.ts";
import type { RecordedDecision } from "../src/engine/calibration.ts";
import type { Finding } from "../src/engine/memory.ts";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

const key: AnswerKey = {
  app: "test",
  defects: [
    {
      id: "list-500",
      route: "/list",
      title: "list 500 shown as empty",
      category: "data-inconsistency",
      severity: "high",
      level: "minimal",
      match: ["status=broken", "broken.{0,20}(500|empty)"],
    },
    { id: "dead-end", route: "/dead", title: "no way back", category: "dead-end", severity: "high", level: "minimal", match: ["/dead"] },
    { id: "fuzz-only", route: "/form", title: "markup rendered", category: "security", severity: "high", level: "extensive", match: ["onerror"] },
  ],
  alsoReal: [{ id: "extra", route: "/x", title: "real but unplanted", category: "ux-polish", severity: "low", level: "minimal", match: ["unplanted"] }],
  nonDefects: [{ id: "stuck", title: "stuck filter", why: "it is not stuck", match: ["stuck.{0,40}broken"] }],
};

let seq = 0;
const finding = (evidence: string, over: Partial<Finding> = {}): Finding => ({
  id: `f${(seq += 1)}`,
  severity: "high",
  category: "data-inconsistency",
  title: evidence,
  detail: "d",
  evidence,
  url: "http://app.test/",
  state: "s#1",
  repro: [],
  foundAt: "2026-09-23T10:00:00.000Z",
  runs: 1,
  ...over,
});
const decision = (over: Partial<RecordedDecision> = {}): RecordedDecision => ({
  lane: "a",
  observation: `o${(seq += 1)}`,
  verdict: "defect",
  severity: "high",
  category: "data-inconsistency",
  confidence: 0.9,
  evidence: null,
  at: "2026-09-23T10:00:00.000Z",
  ...over,
});

// ── classification ─────────────────────────────────────────────────────────

test("a false positive naming the same endpoint as a real defect is classified as the false positive", () => {
  // The contrastive pair the ordering exists for: both mention the broken
  // filter; only one is a real defect. Trying defects first credited the false
  // claim with the real bug.
  assert.equal(classify("filter stuck after the broken 500", key)?.entry.id, "stuck");
  assert.equal(classify("GET /api/list?status=broken 500, empty table", key)?.entry.id, "list-500");
});

test("matching is case-insensitive and anything unmatched is unknown, not wrong", () => {
  assert.equal(classify("STATUS=BROKEN", key)?.entry.id, "list-500");
  assert.equal(classify("something the key never heard of", key), null);
});

// ── judging a lane's verdict ───────────────────────────────────────────────

test("a verdict is right when it agrees with the key and wrong when it does not", () => {
  const onDefect = { evidence: "GET /dead 200", observation: "dead end" };
  const onFalse = { evidence: null, observation: "filter stuck after broken load" };
  assert.equal(judgeDecision(decision({ ...onDefect, verdict: "defect" }), key), true);
  assert.equal(judgeDecision(decision({ ...onDefect, verdict: "not_a_defect" }), key), false);
  assert.equal(judgeDecision(decision({ ...onFalse, verdict: "defect" }), key), false);
  assert.equal(judgeDecision(decision({ ...onFalse, verdict: "not_a_defect" }), key), true);
});

test("an unsure verdict and a decision the key does not name are never scored", () => {
  assert.equal(judgeDecision(decision({ verdict: "unsure", observation: "dead end", evidence: "/dead" }), key), null);
  assert.equal(judgeDecision(decision({ observation: "unrelated" }), key), null);
});

// ── the scorecard ──────────────────────────────────────────────────────────

test("recall counts only the defects expected at the run's level", () => {
  const card = score(key, [finding("GET /api/list?status=broken 500"), finding("GET /dead 200")], [], "medium");
  assert.equal(card.expected, 2, "the fuzzing-only defect is not expected at medium");
  assert.deepEqual(card.found.sort(), ["dead-end", "list-500"]);
  assert.deepEqual(card.missed, []);
  assert.equal(score(key, [], [], "extensive").expected, 3);
});

test("finding a defect above the run's level is credited, not counted as expected", () => {
  const card = score(key, [finding("<img src=x onerror=1> rendered")], [], "medium");
  assert.deepEqual(card.beyondLevel, ["fuzz-only"]);
  assert.equal(card.expected, 2);
});

test("a real but unplanted finding raises precision without touching recall", () => {
  const card = score(key, [finding("unplanted problem")], [], "minimal");
  assert.equal(card.correct, 1);
  assert.equal(card.found.length, 0);
});

test("a defect a lane judged but never filed is named", () => {
  // The run-0 miss this exists for: a lane put a defect in its report at
  // 0.75 and never called scout_finding, so it was not in the report at all.
  const card = score(key, [], [decision({ evidence: "GET /dead 200", observation: "dead end" })], "minimal");
  assert.deepEqual(card.judgedNotFiled, ["dead-end"]);
  assert.deepEqual(card.missed.sort(), ["dead-end", "list-500"], "judged is not found: it never reached the report");

  // And the other half of the pair: judged AND filed is not a follow-through gap.
  const filed = score(key, [finding("GET /dead 200")], [decision({ evidence: "GET /dead 200", observation: "dead end" })], "minimal");
  assert.deepEqual(filed.judgedNotFiled, [], "a defect that was filed is not named as unfiled");
});

test("false positives, unknowns and duplicates are each counted", () => {
  const card = score(
    key,
    [finding("filter stuck after broken 500"), finding("status=broken 500"), finding("broken 500 empty table"), finding("never heard of it")],
    [],
    "minimal",
  );
  assert.equal(card.falsePositives.length, 1);
  assert.equal(card.unknown.length, 1);
  assert.equal(card.duplicates, 1, "two findings for one defect is one duplicate");
});

test("severity is compared using the most severe finding for each defect", () => {
  const card = score(key, [finding("status=broken 500", { severity: "low" }), finding("GET /dead 200", { severity: "high" })], [], "minimal");
  assert.equal(card.severity.agree, 1);
  assert.equal(card.severity.lower, 1);
  assert.deepEqual(
    card.severity.detail.find((d) => d.id === "list-500"),
    { id: "list-500", filed: "low", key: "high" },
  );
});

// ── calibration against the key ────────────────────────────────────────────

test("calibration is measured on verdicts the key can judge, and says how many it could not", () => {
  const right = Array.from({ length: 9 }, () => decision({ evidence: "/dead", confidence: 0.9 }));
  const wrong = decision({ evidence: null, observation: "stuck after broken", confidence: 0.9 });
  const unjudged = decision({ observation: "unrelated", confidence: 0.9 });
  const k = calibrateAgainstKey([...right, wrong, unjudged], key);
  assert.equal(k?.judged, 10);
  assert.equal(k?.correct, 9);
  assert.equal(k?.unjudged, 1);
  assert.ok((k?.ece ?? 1) < 1e-9, "nine right of ten at 0.9 is perfectly calibrated");
});

test("an unusable confidence is disclosed as unjudged, never averaged in", () => {
  const k = calibrateAgainstKey([decision({ evidence: "/dead", confidence: 2 }), decision({ evidence: "/dead", confidence: Number.NaN })], key);
  assert.equal(k?.judged, 0);
  assert.equal(k?.unjudged, 2);
});

test("the scorecard leads with recall and precision, and says when findings are unlabelled", () => {
  const out = formatScorecard(score(key, [finding("status=broken 500"), finding("mystery")], [], "minimal"));
  const [, , recall, precision] = out.split("\n");
  assert.match(recall, /^Recall\s+1\/2/);
  assert.match(precision, /^Precision\s+1\/1 .* 1 more are unlabelled/);
});

// ── the demo app's own key ─────────────────────────────────────────────────

const demoKey = JSON.parse(fs.readFileSync(path.join(root, "demo-app", "answer-key.json"), "utf8")) as AnswerKey;

test("the demo key compiles, has unique ids, and names routes the app serves", () => {
  const ids = [...demoKey.defects, ...demoKey.alsoReal, ...demoKey.nonDefects].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const e of [...demoKey.defects, ...demoKey.alsoReal, ...demoKey.nonDefects])
    for (const m of e.match) assert.doesNotThrow(() => new RegExp(m, "i"), `${e.id}: ${m}`);
  for (const d of [...demoKey.defects, ...demoKey.alsoReal]) {
    const file = d.route === "/" ? "index.html" : d.route.replace(/^\//, "");
    assert.ok(fs.existsSync(path.join(root, "demo-app", "public", file)), `${d.id}: ${d.route} is not a page the demo serves`);
  }
});

test("the demo key has one planted defect for every row of the README's seeded table", () => {
  // Two lists of the same thing drift. The README is what a person reads; the
  // key is what a run is scored against. They must agree on the count.
  const readme = fs.readFileSync(path.join(root, "demo-app", "README.md"), "utf8");
  const table = readme.slice(readme.indexOf("## What is seeded"));
  const rows = table.split("\n").filter((l) => /^\| [^-|][^|]*\|/.test(l) && !l.startsWith("| Where"));
  const defects = rows.filter((r) => !/Not a defect/i.test(r));
  assert.equal(defects.length, demoKey.defects.length, `README seeds ${defects.length}, the key lists ${demoKey.defects.length}`);
});

test("the demo key classifies phrasings real runs have used", () => {
  // Wording from actual runs, pinned so a change to the key cannot quietly
  // reclassify them. The contrastive pairs are the point: each false positive
  // sits next to the real defect it resembles.
  const cases: Array<[string, string | null]> = [
    ["GET /api/orders?status=archived 500, page shows empty list, no error", "orders-archived-refused-empty"],
    ["select Archived(500) then Rejected repeats GET /api/orders?status=archived 500, same state hash", "filter-stuck-after-failure"],
    ["click×2 new-order-submit → POST /api/orders fired twice → orders 1044 and 1045", "new-order-double-submit"],
    ["2x click signin-role-auditor -> POST /api/signin fired twice", "sign-in-double-click"],
    ["All orders link overlaps bulk-import badge 84%", "dashboard-badge-covers-button"],
    ["bulk-import badge has no hover affordance", null],
    ["testid=new-order-msg role=status unnamed at load", "empty-live-region-unnamed"],
    ["demo-app/public/orders-new.html: input[name=email] has no label", "new-order-email-no-label"],
    ["delete-workspace blocked by tester safe-write policy", "write-policy-block"],
    ["GET /api/inventory?sort=qty returns order [10,120,250,3,64,9]", "inventory-sort-as-text"],
    ["POST /api/orders/1042/approve 200 OK while signed in as clerk", "approve-endpoint-accepts-clerk"],
    ["click settings-save fires 0 network requests; settings-name reverts after reload", "settings-save-claims-saved"],
  ];
  for (const [text, expected] of cases) assert.equal(classify(text, demoKey)?.entry.id ?? null, expected, text);
});
