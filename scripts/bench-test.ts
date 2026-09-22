/**
 * Scoring a run against an answer key.
 *
 * The scorer is what every later change to the engine and the skill is judged
 * by, so the failure that matters here is a PLAUSIBLE WRONG number: a bad
 * change made to look good, or a good one made to look bad. Most of these
 * tests are contrastive pairs — two inputs that differ in the one fact that
 * flips the answer — because the scorer's hard cases are false positives that
 * name the same endpoint as a real defect, and findings two entries both claim.
 *
 *   npx tsx --test scripts/bench-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  calibrateAgainstKey,
  classify,
  formatScorecard,
  judgeDecision,
  keyHash,
  lintKey,
  parseKey,
  precisionBounds,
  sanitize,
  score,
  toArchive,
} from "../src/engine/bench.ts";
import type { RecordedDecision } from "../src/engine/calibration.ts";
import type { Finding } from "../src/engine/memory.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const entry = (id: string, match: string[], level = "minimal", severity = "high") => ({
  id,
  route: "/x",
  title: id,
  category: "other",
  severity,
  level,
  match,
});
const key = parseKey({
  app: "test",
  defects: [entry("list-500", ["status=broken", "broken.{0,20}(500|empty)"]), entry("dead-end", ["/dead"]), entry("fuzz-only", ["onerror"], "extensive")],
  alsoReal: [entry("extra", ["unplanted"], "minimal", "low")],
  nonDefects: [{ id: "stuck", title: "stuck filter", why: "it is not stuck", match: ["stuck.{0,40}broken"] }],
});

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

// ── reading the key ────────────────────────────────────────────────────────

test("a key with a mistyped level is refused, not read as one defect fewer", () => {
  // `"level": "Minimal"` used to drop the defect out of recall silently, and
  // the run scored as if the app had one defect fewer.
  const bad = { app: "t", defects: [{ ...entry("a", ["x"]), level: "Minimal" }] };
  assert.throws(() => parseKey(bad), /defects\.0\.level/);
  assert.throws(() => parseKey({ app: "t", defects: [{ ...entry("a", ["x"]), severity: "critical" }] }), /severity/);
});

test("a key with an invalid pattern or a repeated id is refused", () => {
  assert.throws(() => parseKey({ app: "t", defects: [entry("a", ["(unclosed"])] }), /regular expression/);
  assert.throws(() => parseKey({ app: "t", defects: [entry("a", ["x"]), entry("a", ["y"])] }), /twice/);
});

test("a scorecard names the key that produced it, and a changed key changes the name", () => {
  // Two runs scored against different keys are not comparable; the hash is
  // how a reader can tell.
  const before = keyHash(key);
  const after = keyHash(parseKey({ ...key, defects: [...key.defects, entry("new", ["new"])] }));
  assert.equal(before, keyHash(key), "stable");
  assert.notEqual(before, after);
  assert.equal(score(key, [], [], "minimal").key, before);
});

// ── classification ─────────────────────────────────────────────────────────

test("a false positive naming the same endpoint as a real defect is classified as the false positive", () => {
  assert.equal(classify("filter stuck after the broken 500", key)?.kind, "nonDefect");
  const real = classify("GET /api/list?status=broken 500, empty table", key);
  assert.equal(real?.kind === "defect" && real.entry.id, "list-500");
});

test("text two entries both claim is ambiguous, and scored as neither", () => {
  // First-match-wins credited a finding about two defects to one of them and
  // counted the other as missed, with nothing on the scorecard to say so.
  const both = classify("status=broken and also /dead", key);
  assert.equal(both?.kind, "ambiguous");
  const card = score(key, [finding("status=broken and also /dead")], [], "minimal");
  assert.equal(card.ambiguous.length, 1);
  assert.equal(card.correct, 0);
  assert.equal(card.falsePositives.length, 0);
  assert.deepEqual(card.found, [], "an ambiguous finding credits no defect");
});

test("matching is case-insensitive and anything unmatched is unknown, not wrong", () => {
  assert.equal(classify("STATUS=BROKEN", key)?.kind, "defect");
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

test("an unsure verdict, an unnamed thing and an ambiguous one are never scored", () => {
  assert.equal(judgeDecision(decision({ verdict: "unsure", evidence: "/dead" }), key), null);
  assert.equal(judgeDecision(decision({ observation: "unrelated" }), key), null);
  assert.equal(judgeDecision(decision({ evidence: "status=broken /dead" }), key), null);
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

test("a defect a lane judged but never filed is named — and one it filed is not", () => {
  // The run-0 miss this exists for: a lane put a defect in its report at
  // 0.75 and never called scout_finding, so it was not in the report at all.
  const unfiled = score(key, [], [decision({ evidence: "GET /dead 200", observation: "dead end" })], "minimal");
  assert.deepEqual(unfiled.judgedNotFiled, ["dead-end"]);
  assert.deepEqual(unfiled.missed.sort(), ["dead-end", "list-500"], "judged is not found: it never reached the report");
  const filed = score(key, [finding("GET /dead 200")], [decision({ evidence: "GET /dead 200", observation: "dead end" })], "minimal");
  assert.deepEqual(filed.judgedNotFiled, [], "a defect that was filed is not a follow-through gap");
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

test("precision is shown with bounds, so unlabelled false claims cannot hide", () => {
  // The labelled ratio cannot move when a change adds five false claims nobody
  // has labelled yet. The bounds can.
  const card = score(key, [finding("status=broken 500"), finding("mystery one"), finding("mystery two"), finding("mystery three")], [], "minimal");
  const p = precisionBounds(card);
  assert.equal(p.labelled, "1/1 (100%)");
  assert.equal(p.low, "25%", "every open finding counted as wrong");
  assert.equal(p.high, "100%", "every open finding counted as right");
  assert.match(formatScorecard(card), /3 of 4 unlabelled, so between 25% and 100% of all findings/);
});

// ── calibration against the key ────────────────────────────────────────────

test("calibration is measured on verdicts the key can judge, and names every reason one was not scored", () => {
  const right = Array.from({ length: 9 }, () => decision({ evidence: "/dead", confidence: 0.9 }));
  const wrong = decision({ evidence: null, observation: "stuck after broken", confidence: 0.9 });
  const skipped = [
    decision({ observation: "unrelated" }),
    decision({ evidence: "status=broken /dead" }),
    decision({ evidence: "/dead", confidence: 7 }),
    decision({ evidence: "/dead", verdict: "unsure" }),
  ];
  const k = calibrateAgainstKey([...right, wrong, ...skipped], key);
  assert.equal(k?.judged, 10);
  assert.equal(k?.correct, 9);
  assert.deepEqual([k?.notInKey, k?.ambiguous, k?.badConfidence, k?.unsure], [1, 1, 1, 1], "each reason counted separately");
  assert.ok((k?.ece ?? 1) < 1e-9, "nine right of ten at 0.9 is perfectly calibrated");
});

test("nothing the key could judge reads as nothing, never as a perfect score", () => {
  // "0/0 verdicts right, expected calibration error 0.00" read as perfect.
  const out = formatScorecard(score(key, [], [decision({ observation: "unrelated" })], "minimal"));
  assert.match(out, /nothing the key could judge/);
  assert.ok(!/error 0\.00/.test(out), out);
});

test("the scorecard leads with recall and precision, and names its key", () => {
  const out = formatScorecard(score(key, [finding("status=broken 500")], [], "minimal"));
  const lines = out.split("\n");
  assert.match(lines[0], new RegExp(`key ${keyHash(key)}`));
  assert.match(lines[2], /^Recall\s+1\/2/);
  assert.match(lines[3], /^Precision\s+1\/1/);
});

// ── archiving a run ────────────────────────────────────────────────────────

test("an archive keeps what scoring reads and nothing that names a person or a machine", () => {
  const f = finding("POST /api/x 500 at /Users/u/project/src/app.ts:12", { title: "Crash in /home/u/app" });
  const d = decision({ observation: "saw /private/tmp/run-3/x", evidence: "C:\\Users\\u\\app\\x.js" });
  const a = toArchive("run-9", "2026-09-23", "note", [f], [d]);
  const text = JSON.stringify(a);
  assert.ok(!/\/Users\/|\/home\/|\/private\/tmp|C:\\\\Users/.test(text), text);
  assert.equal(sanitize("see /Users/a/b/c.ts:4 and /tmp/x"), "see <path> and <path>");
  assert.deepEqual(Object.keys(a.findings[0]).sort(), ["category", "evidence", "severity", "title"], "only what scoring reads");
  // And an archive scores exactly as the memory it came from.
  assert.deepEqual(score(key, a.findings, a.decisions, "minimal").found, score(key, [f], [d], "minimal").found);
});

// ── the demo app's own key ─────────────────────────────────────────────────

const demoKey = parseKey(JSON.parse(fs.readFileSync(path.join(root, "demo-app", "answer-key.json"), "utf8")));

test("the demo key agrees with every one of its own examples and counter-examples", () => {
  // The key tests itself: every entry's title and examples must classify to
  // it, and no counter-example may. This is what stops widening one pattern
  // from quietly stealing another entry's findings — five of the first key's
  // fourteen defects failed to match their own titles.
  assert.deepEqual(lintKey(demoKey), []);
});

test("no known non-defect claims any real defect's title", () => {
  // Non-defects win a single match, so one written too broadly turns a real
  // defect into a false positive — which is how a run that found the planted
  // delete bug would have been scored as having reported the write policy.
  for (const d of [...demoKey.defects, ...demoKey.alsoReal]) {
    const got = classify(d.title, demoKey);
    assert.notEqual(got?.kind, "nonDefect", `${d.id}'s title is claimed by a non-defect`);
  }
});

test("the demo key names routes the app serves", () => {
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
