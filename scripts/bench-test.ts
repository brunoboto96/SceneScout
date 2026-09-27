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
import { spawnSync } from "node:child_process";
import os from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appOfKey,
  archiveApp,
  byRunOrder,
  calibrateAgainstKey,
  checkKeyForArchive,
  chooseApp,
  classify,
  DEFAULT_APP,
  decisionText,
  formatScorecard,
  groupByApp,
  judgeDecision,
  keyHash,
  lintKey,
  parseKey,
  isOwnershipRemark,
  isScopeDismissal,
  laneRoutePaths,
  precisionBounds,
  runDate,
  sanitize,
  score,
  toArchive,
} from "../src/engine/bench.ts";
import type { RecordedDecision } from "../src/engine/calibration.ts";
import { HttpModelClient } from "../src/ci-run.ts";
import { NO_USAGE, redactKeys } from "../src/engine/ci.ts";
import {
  buildPairs,
  decideDuplicate,
  formatPairScore,
  JUDGE_TOOL,
  parseJudgement,
  ruleJudgement,
  samplePairs,
  scorePairs,
  type Ask,
  type Judgement,
  type LabelledPair,
  type PairFinding,
} from "../src/engine/dedup.ts";
import { OpenAIConversation, type ModelTurn } from "../src/engine/provider.ts";
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
  nonDefects: [
    { id: "stuck", title: "stuck filter", why: "it is not stuck", match: ["stuck.{0,40}broken"], overrides: ["list-500"] },
    { id: "copy", title: "honest copy", why: "the copy is fine", match: ["coming soon"] },
  ],
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

test("a non-defect wins only over the defects it says it narrows", () => {
  // "copy" names no defect it narrows. Letting it win everywhere turned a
  // rewording of a real dead end into a false positive with a confident
  // explanation beside it; now the overlap is visible and scored as neither.
  const overlap = classify("page says coming soon and is a /dead end", key);
  assert.equal(overlap?.kind, "ambiguous");
  assert.deepEqual(overlap?.kind === "ambiguous" && overlap.ids, ["copy", "dead-end"]);
  assert.equal(classify("page says coming soon", key)?.kind, "nonDefect");
  // "stuck" does narrow list-500, so there it wins.
  assert.equal(classify("stuck after broken 500", key)?.kind, "nonDefect");
  // But not over a defect it does not narrow.
  assert.equal(classify("stuck after broken, and /dead", key)?.kind, "ambiguous");
});

test("a non-defect that overrides a defect the key does not have is refused", () => {
  assert.throws(
    () => parseKey({ app: "t", defects: [entry("a", ["a"])], nonDefects: [{ id: "n", title: "n", why: "w", match: ["n"], overrides: ["b"] }] }),
    /overrides "b"/,
  );
});

test("a non-defect's own title must classify to it", () => {
  const k = parseKey({
    app: "t",
    defects: [entry("a", ["^a$"])],
    nonDefects: [{ id: "n", title: "a harmless thing", why: "w", match: ["nothing like the title"] }],
  });
  assert.deepEqual(lintKey(k), ['n: "a harmless thing" classified as nothing']);
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

// ── contextual entries ─────────────────────────────────────────────────────

// An observation that is a defect only under a convention the run cannot see,
// such as a spacing scale the project may or may not declare.
const ctxKey = parseKey({
  ...key,
  contextual: [
    { id: "grid", route: "/x", title: "padding off grid", category: "ux-polish", reason: "only where a spacing scale is declared", match: ["off.grid"] },
  ],
});

test("a contextual entry is validated like the others", () => {
  const ctx = { id: "c", route: "/x", title: "c", category: "ux", reason: "r", match: ["c"] };
  assert.throws(() => parseKey({ app: "t", defects: [entry("a", ["a"])], contextual: [{ ...ctx, match: ["(unclosed"] }] }), /contextual\.0\.match/);
  assert.throws(() => parseKey({ app: "t", defects: [entry("a", ["a"])], contextual: [{ ...ctx, reason: "" }] }), /contextual\.0\.reason/);
  assert.throws(
    () => parseKey({ app: "t", defects: [entry("a", ["a"])], contextual: [{ ...ctx, severity: "low" }] }),
    /contextual\.0/,
    "a severity it is never scored on",
  );
  assert.throws(() => parseKey({ app: "t", defects: [entry("a", ["a"])], contextual: [{ ...ctx, id: "a" }] }), /twice/);
  // A non-defect narrows a real defect; a contextual entry is not one.
  assert.throws(
    () =>
      parseKey({ app: "t", defects: [entry("a", ["a"])], contextual: [ctx], nonDefects: [{ id: "n", title: "n", why: "w", match: ["n"], overrides: ["c"] }] }),
    /overrides "c"/,
  );
  assert.notEqual(keyHash(ctxKey), keyHash(key), "the list is part of the key's hash");
});

test("a contextual entry wins over nothing: overlapping any other entry is ambiguous", () => {
  const alone = classify("padding off grid", ctxKey);
  assert.equal(alone?.kind === "contextual" && alone.entry.id, "grid");
  assert.equal(classify("padding off grid on the /dead page", ctxKey)?.kind, "ambiguous", "with a real defect");
  assert.equal(classify("coming soon, padding off grid", ctxKey)?.kind, "ambiguous", "with a non-defect");
});

test("a finding matching a contextual entry is set aside: neither correct, wrong nor unlabelled", () => {
  const card = score(ctxKey, [finding("status=broken 500"), finding("padding off grid"), finding("mystery")], [], "minimal");
  assert.equal(card.correct, 1);
  assert.equal(card.falsePositives.length, 0);
  assert.equal(card.unknown.length, 1);
  assert.deepEqual(card.contextual, [{ id: "grid", title: "padding off grid" }]);
  const p = precisionBounds(card);
  assert.equal(p.labelled, "1/1 (100%)");
  assert.deepEqual([p.low, p.high], ["50%", "100%"], "bounds are over the two findings not set aside, not all three");
  const out = formatScorecard(card);
  assert.match(out, /Set aside\s+1 of 3 finding\(s\)/);
  assert.match(out, /1 of 2 unlabelled/);
  // The same finding scored against the key without the list is unlabelled.
  assert.equal(score(key, [finding("padding off grid")], [], "minimal").unknown.length, 1);
});

test("a finding the run filed as worth a look is in neither recall nor precision, and is counted and printed", () => {
  const look = (evidence: string) => finding(evidence, { tier: "worth_a_look", convention: "a 4px spacing scale" });
  // On a planted defect, a known non-defect and nothing the key names: none of them moves a count.
  const card = score(key, [finding("status=broken 500"), look("/dead page"), look("coming soon"), look("mystery")], [], "minimal");
  assert.deepEqual(card.found, ["list-500"], "a worth-a-look on a planted defect is no recall credit");
  assert.deepEqual(card.missed, ["dead-end"]);
  assert.equal(card.correct, 1);
  assert.equal(card.falsePositives.length, 0, "nor a false positive on a non-defect");
  assert.equal(card.unknown.length, 0, "nor unlabelled");
  assert.equal(card.worthALook.length, 3);
  assert.deepEqual(precisionBounds(card), { labelled: "1/1 (100%)", low: "100%", high: "100%" });
  const out = formatScorecard(card);
  assert.match(out, /Set aside\s+3 of 4 finding\(s\) the run filed as worth a look/);
  assert.match(out, /Filed as worth a look \(3\):\n {2}\/dead page — a defect only if the project uses a 4px spacing scale/);
  // The archive keeps the tier, so a re-score sets the same findings aside.
  const archived = toArchive("run-w", "2026-09-27", "n", [look("/dead page")], [], "demo");
  assert.deepEqual(archived.findings[0], {
    title: "/dead page",
    severity: "high",
    category: "data-inconsistency",
    evidence: "/dead page",
    tier: "worth_a_look",
    convention: "a 4px spacing scale",
  });
  assert.equal(score(key, archived.findings, [], "minimal").worthALook.length, 1);
});

test("a verdict on a contextual entry is not scored either way, and is counted under its own reason", () => {
  const onCtx = [decision({ verdict: "defect", evidence: "padding off grid" }), decision({ verdict: "not_a_defect", evidence: "padding off grid" })];
  for (const d of onCtx) assert.equal(judgeDecision(d, ctxKey), null, d.verdict);
  const k = calibrateAgainstKey([...onCtx, decision({ evidence: "/dead" })], ctxKey);
  assert.deepEqual([k?.judged, k?.contextual, k?.notInKey], [1, 2, 0]);
  assert.match(
    formatScorecard(score(ctxKey, [], [...onCtx, decision({ evidence: "/dead" })], "minimal")),
    /2 about things that are defects only under a convention/,
  );
  // Without the list, the not-a-defect verdict is unscored as unknown, not as contextual.
  assert.equal(calibrateAgainstKey(onCtx, key)?.contextual, 0);
});

test("the key's self-test covers contextual entries", () => {
  const k = parseKey({
    app: "t",
    defects: [entry("a", ["^a$"])],
    contextual: [{ id: "c", route: "/x", title: "a convention", category: "ux", reason: "r", match: ["convention"], counterExamples: ["a convention too"] }],
  });
  assert.deepEqual(lintKey(k), ['c: counter-example "a convention too" classified TO it']);
  const titleMiss = parseKey({ ...k, contextual: [{ ...k.contextual[0], match: ["nothing like it"], counterExamples: [] }] });
  assert.deepEqual(lintKey(titleMiss), ['c: "a convention" classified as nothing']);
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
    // On a planted defect, and still not scored: the lane said it depends on a convention, which the key cannot mark right or wrong.
    decision({ evidence: "/dead", verdict: "worth_a_look", convention: "a 4px spacing scale" }),
  ];
  const k = calibrateAgainstKey([...right, wrong, ...skipped], key);
  assert.equal(k?.judged, 10);
  assert.equal(k?.correct, 9);
  assert.deepEqual([k?.notInKey, k?.ambiguous, k?.badConfidence, k?.unsure, k?.worthALook], [1, 1, 1, 1, 1], "each reason counted separately");
  assert.equal(judgeDecision(decision({ evidence: "/dead", verdict: "worth_a_look", convention: "a 4px spacing scale" }), key), null);
  assert.ok((k?.ece ?? 1) < 1e-9, "nine right of ten at 0.9 is perfectly calibrated");
  // Nine right at 0.9 contribute 0.01 each, the one wrong 0.81: mean 0.09.
  assert.ok(Math.abs((k?.brier ?? 0) - 0.09) < 1e-9, String(k?.brier));
});

test("Brier ranks right-and-too-quiet above wrong-and-well-calibrated, where ECE does not", () => {
  // Run 1's shape: every verdict right, each stated at 0.7. ECE 0.3, Brier 0.09.
  const quiet = calibrateAgainstKey(
    Array.from({ length: 10 }, () => decision({ evidence: "/dead", confidence: 0.7 })),
    key,
  )!;
  // Half right, each stated at 0.5: ECE 0, Brier 0.25 — honest, and no better than a coin.
  const coin = calibrateAgainstKey(
    Array.from({ length: 10 }, (_, i) => decision({ evidence: "/dead", verdict: i % 2 ? "defect" : "not_a_defect", confidence: 0.5 })),
    key,
  )!;
  assert.ok(quiet.ece > coin.ece, "ECE prefers the coin");
  assert.ok(quiet.brier < coin.brier, "Brier prefers the lanes that were right");
});

test("a lane dismissing something as another lane's is not scored as a verdict on it", () => {
  // "Not a defect — belongs to the dashboard" is about who owns it. Scored as
  // a wrong verdict, five such notes reversed the direction of a comparison.
  const dismissals = [
    decision({ verdict: "not_a_defect", evidence: "/dead", observation: "belongs to the landing page, out of lane scope" }),
    decision({ verdict: "not_a_defect", evidence: "/dead — fired from the home page, not my routes", observation: "x" }),
  ];
  for (const d of dismissals) assert.equal(isScopeDismissal(d), true, d.evidence ?? "");
  // Wordings lanes use for "not mine", and verdicts about the thing itself that only share a word with them.
  for (const text of [
    "handled by the dashboard lane",
    "outside my routes; the dashboard lane owns it",
    "not part of my assigned routes",
    "chart-404-belongs-to-home",
  ]) {
    assert.equal(isScopeDismissal(decision({ verdict: "not_a_defect", observation: text })), true, text);
  }
  for (const text of [
    "badge belongs to the header design; overlap is intentional",
    "Empty state belongs to the design system",
    "Export is out of scope for v1",
  ]) {
    assert.equal(isScopeDismissal(decision({ verdict: "not_a_defect", observation: text })), false, text);
  }
  const k = calibrateAgainstKey(dismissals, key);
  assert.deepEqual([k?.judged, k?.outOfScope], [0, 2]);
  assert.equal(k?.contextual, 0);
  assert.equal(judgeDecision(dismissals[0], key), null);
  // The same wording on a defect verdict is a claim, and is scored.
  const claimed = decision({ verdict: "defect", evidence: "/dead", observation: "belongs to the landing page" });
  assert.equal(isScopeDismissal(claimed), false);
  assert.equal(judgeDecision(claimed, key), true);
  // A not-a-defect verdict with a reason about the thing itself is scored.
  assert.equal(judgeDecision(decision({ verdict: "not_a_defect", evidence: "/dead", observation: "works as designed" }), key), false);
});

test("a not-a-defect about the lane's own page is scored, however it words where the thing came from", () => {
  // The pattern cannot know which routes a lane owns, so wording that places
  // a thing "from the X load" or "absent on a direct load" is as likely to be
  // the owning lane's verdict on its own page as a dismissal. Widening the
  // pattern to take these would drop wrong verdicts from calibration.
  for (const text of [
    "empty table from the archived load is expected",
    "GET /img/chart.png 404 from the home load; image is optional",
    "absent on a direct /orders-new.html load, so fine",
    "Hint present on direct /orders-new.html load; renders as designed",
    "Spinner from initial load clears within a second",
    "Error text comes from the form's own validation, not from the server",
  ]) {
    const d = decision({ verdict: "not_a_defect", observation: text });
    assert.equal(isScopeDismissal(d), false, text);
  }
});

// ── whose page it is, by the lanes' routes ─────────────────────────────────

test("a route from a lane report names every page in it", () => {
  // Lanes write routes as free text. Every page named counts, a note's
  // included: a page left out would set a verdict about it aside, while a
  // page taken in only keeps a verdict scored.
  const cases: Array<[string, string[]]> = [
    ["/order.html?id=1042 (from /orders.html link)", ["/order.html", "/orders.html"]],
    ["/audit.html (as clerk and as auditor)", ["/audit.html"]],
    ["Orders (/orders.html)", ["/orders.html"]],
    ["orders.html", ["/orders.html"]],
    ["127.0.0.1:4173/orders.html", ["/orders.html"]],
    ["localhost:3000/things/42/edit", ["/things/:id/edit"]],
    ["http://127.0.0.1:4173", ["/"]],
    ["http://127.0.0.1:4173/orders.html", ["/orders.html"]],
    ["/inventory.html: sort and filters", ["/inventory.html"]],
    ["/", ["/"]],
    ["/index.html", ["/"]],
    ["/settings/", ["/settings"]],
    ["/#/things?tab=open", ["/things"]],
    ["/reports.html, /reports-scheduled.html", ["/reports.html", "/reports-scheduled.html"]],
    ["/reports.html and /reports-scheduled.html", ["/reports.html", "/reports-scheduled.html"]],
    ["/a.html + /b.html | /c.html\n/d.html", ["/a.html", "/b.html", "/c.html", "/d.html"]],
    ["/orders.html → /order.html?id=3", ["/orders.html", "/order.html"]],
    ["/orders.html -> /order.html", ["/orders.html", "/order.html"]],
    ["dashboard", []],
    ["the orders area", []],
    ["(none)", []],
  ];
  for (const [raw, want] of cases) assert.deepEqual(laneRoutePaths(raw), want, raw);
});

const routeKey = parseKey({
  app: "routes",
  defects: [
    { ...entry("chart-404", ["chart\\.png 404"]), route: "/" },
    { ...entry("sort-as-text", ["sorts? .{0,20}as text"]), route: "/stock.html" },
    { ...entry("nav-overlap", ["nav .{0,20}overlaps"]), route: "/", everyPage: true },
    { ...entry("delete-lies", ["delete .{0,30}reports success"]), route: "/settings.html", alsoOn: ["/thing.html"] },
  ],
  nonDefects: [{ id: "policy", title: "write policy", why: "the tester refused it", match: ["refused by the write policy"] }],
});
const stockLane = { stock: ["/stock.html?sort=qty (from the nav)"] };

test("a not-a-defect on a defect outside the lane's routes is an ownership remark, and the same words on its own route are a verdict", () => {
  // Run 11's orders and stock lanes dismissed the dashboard's broken image
  // in words the wording rule does not read ("raised on / before
  // navigating"), so right remarks about another lane's page scored as wrong
  // verdicts. Knowing the lane's routes decides it by where the thing is.
  const remark = decision({ lane: "stock", verdict: "not_a_defect", evidence: "GET /img/chart.png 404", observation: "raised on / before navigating" });
  assert.equal(isScopeDismissal(remark), false, "the wording rule misses it");
  assert.equal(judgeDecision(remark, routeKey), false, "and without routes it is scored as a wrong verdict");
  assert.equal(isOwnershipRemark(remark, routeKey, stockLane), true);
  assert.equal(judgeDecision(remark, routeKey, stockLane), null);
  // The same text from a lane that covered "/" is its own wrong verdict.
  const home = { stock: [...stockLane.stock, "/ (landing)"] };
  assert.equal(isOwnershipRemark(remark, routeKey, home), false);
  assert.equal(judgeDecision(remark, routeKey, home), false);

  // And the reverse: "not my lane" wording on a defect on the lane's own route
  // is a verdict. The wording rule drops it; the route rule scores it.
  const own = decision({ lane: "stock", verdict: "not_a_defect", evidence: "quantity sorts as text", observation: "handled by the dashboard lane" });
  assert.equal(isScopeDismissal(own), true);
  assert.equal(judgeDecision(own, routeKey), null);
  assert.equal(judgeDecision(own, routeKey, stockLane), false);

  const k = calibrateAgainstKey([remark, own], routeKey, stockLane)!;
  assert.deepEqual([k.judged, k.correct, k.outOfScope, k.ownership], [1, 0, 1, "routes"]);
  // Each verdict the route rule set aside is listed, so a run can be audited.
  assert.deepEqual(k.setAsideByRoute, [{ lane: "stock", id: "chart-404", confidence: 0.9 }]);
  const card = formatScorecard(score(routeKey, [], [remark, own], "minimal", stockLane));
  assert.match(card, /1 dismissed as another lane's \(by the lanes' routes\)/);
  assert.match(card, /Set aside as another lane's, by the lanes' routes \(1\):\n\s+stock on chart-404, stated 0\.90/);
  // By wording nothing is listed: there is no entry to name.
  assert.deepEqual(calibrateAgainstKey([own], routeKey)?.setAsideByRoute, []);
});

test("a defect in chrome every page carries is every lane's, and one on several pages is owned from any of them", () => {
  // A lane that owns any page cannot call the shared nav "not mine": the nav
  // is on its page too.
  const chrome = decision({ lane: "stock", verdict: "not_a_defect", evidence: "nav links overlaps the logo", observation: "not my page" });
  assert.equal(isOwnershipRemark(chrome, routeKey, stockLane), false);
  assert.equal(judgeDecision(chrome, routeKey, stockLane), false);
  // By wording it would have been dropped.
  assert.equal(judgeDecision(chrome, routeKey), null);

  const del = decision({ lane: "thing", verdict: "not_a_defect", evidence: "Delete order reports success", observation: "settings lane owns it" });
  assert.equal(judgeDecision(del, routeKey, { thing: ["/thing.html?id=7"] }), false, "shown on the lane's own page");
  assert.equal(judgeDecision(del, routeKey, { thing: ["/other.html"] }), null, "on none of the lane's pages");
});

test("a lane's worth-a-look is counted as that, whatever its routes say", () => {
  // Both skip reasons apply to one run: a worth-a-look is not a claim, and the
  // route rule only reads not-a-defect verdicts.
  const look = decision({ lane: "stock", verdict: "worth_a_look", evidence: "GET /img/chart.png 404", observation: "not my page" });
  assert.equal(judgeDecision(look, routeKey, stockLane), null);
  const k = calibrateAgainstKey([look], routeKey, stockLane)!;
  assert.deepEqual([k.worthALook, k.outOfScope, k.setAsideByRoute.length], [1, 0, 0]);
});

test("a not-a-defect the key calls right, or cannot place, is never taken for an ownership remark", () => {
  // Only a real defect has a page someone owns. A lane right that something
  // is not a defect is scored right, whichever page it is on.
  const right = decision({ lane: "stock", verdict: "not_a_defect", evidence: "refused by the write policy", observation: "not my page" });
  assert.equal(isOwnershipRemark(right, routeKey, stockLane), false);
  assert.equal(judgeDecision(right, routeKey, stockLane), true);
  const unknown = decision({ lane: "stock", verdict: "not_a_defect", observation: "something the key does not name, not my page" });
  const k = calibrateAgainstKey([unknown], routeKey, stockLane)!;
  assert.deepEqual([k.outOfScope, k.notInKey], [0, 1]);
  // A defect verdict is a claim wherever it is.
  const claim = decision({ lane: "stock", verdict: "defect", evidence: "GET /img/chart.png 404" });
  assert.equal(judgeDecision(claim, routeKey, stockLane), true);
});

test("a lane whose routes are not known is read by wording, as every archive before routes were kept is", () => {
  const remark = (lane: string) =>
    decision({ lane, verdict: "not_a_defect", evidence: "GET /img/chart.png 404", observation: "belongs to the dashboard lane" });
  // No routes at all: the wording rule, unchanged.
  assert.equal(judgeDecision(remark("stock"), routeKey), null);
  assert.equal(calibrateAgainstKey([remark("stock")], routeKey)?.ownership, "wording");
  // Routes for other lanes only, or routes that name no path: this lane by wording.
  assert.equal(isOwnershipRemark(remark("orders"), routeKey, stockLane), true);
  assert.equal(isOwnershipRemark(remark("vague"), routeKey, { vague: ["dashboard", "(everything)"] }), true);
  // One route that names no page makes the lane unknown: it may be the page the verdict is about.
  assert.equal(isOwnershipRemark(remark("partly"), routeKey, { partly: ["/stock.html", "the dashboard area"] }), true, "wording decides");
  const unreadable = decision({ lane: "partly", verdict: "not_a_defect", evidence: "GET /img/chart.png 404", observation: "raised on / before navigating" });
  assert.equal(judgeDecision(unreadable, routeKey, { partly: ["/stock.html", "the dashboard area"] }), false, "and a remark it misses stays scored");
  const plain = decision({ lane: "orders", verdict: "not_a_defect", evidence: "GET /img/chart.png 404", observation: "raised on / before navigating" });
  assert.equal(isOwnershipRemark(plain, routeKey, stockLane), false);
  assert.equal(calibrateAgainstKey([remark("stock"), remark("orders")], routeKey, stockLane)?.ownership, "mixed");
  assert.match(formatScorecard(score(routeKey, [], [remark("stock")], "minimal")), /1 dismissed as another lane's \(by wording: no lane routes archived\)/);
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
  const a = toArchive("run-9", "2026-09-23", "note", [f], [d], "demo");
  const text = JSON.stringify(a);
  assert.ok(!/\/Users\/|\/home\/|\/private\/tmp|C:\\\\Users/.test(text), text);
  assert.equal(sanitize("see /Users/a/b/c.ts:4 and /tmp/x"), "see <path> and <path>");
  assert.deepEqual(Object.keys(a.findings[0]).sort(), ["category", "evidence", "severity", "title"], "only what scoring reads");
  // And an archive scores exactly as the memory it came from.
  assert.deepEqual(score(key, a.findings, a.decisions, "minimal").found, score(key, [f], [d], "minimal").found);
  assert.equal("laneRoutes" in a, false, "no routes recorded, none archived");
});

test("no query string or fragment from a lane's route reaches an archive", () => {
  // A lane copies routes from the address bar, and an address can carry a token.
  const secret = "abc123def456ghi";
  const a = toArchive("run-12", "2026-09-27", "note", [], [], "demo", {
    auth: [
      `/cb?access_token=${secret}`,
      `/cb#access_token=${secret}`,
      `/files/x.pdf?X-Amz-Signature=${secret}&X-Amz-Date=1`,
      `/login?code=${secret} (after redirect)`,
      `/s session_id=${secret}`,
    ],
  });
  const text = JSON.stringify(a);
  assert.ok(!text.includes(secret), text);
  assert.ok(!/access_token|X-Amz|code=|session_id/.test(text), text);
  assert.deepEqual(a.laneRoutes?.auth.map(laneRoutePaths), [["/cb"], ["/cb"], ["/files/x.pdf"], ["/login"], ["/s"]]);
  // A hash route keeps its path.
  assert.deepEqual(toArchive("r", "2026-09-27", "n", [], [], "demo", { spa: ["/#/things?token=x"] }).laneRoutes, { spa: ["/#/things"] });
});

test("a key entry names each of its pages once, and one on every page names no others", () => {
  const base = { ...entry("e", ["x"]), route: "/a" };
  assert.throws(() => parseKey({ app: "t", defects: [{ ...base, alsoOn: ["/b"], everyPage: true }] }), /both alsoOn and everyPage/);
  assert.throws(() => parseKey({ app: "t", defects: [{ ...base, alsoOn: ["/a"] }] }), /names the page "\/a" twice/);
  assert.throws(() => parseKey({ app: "t", defects: [{ ...base, alsoOn: ["/b", "/b"] }] }), /twice/);
  assert.equal(parseKey({ app: "t", defects: [{ ...base, alsoOn: ["/b"] }] }).defects[0].alsoOn?.[0], "/b");
});

test("an archive keeps each lane's routes, so ownership is re-scored by them", () => {
  const d = decision({ lane: "stock", verdict: "not_a_defect", evidence: "GET /img/chart.png 404", observation: "raised on / before navigating" });
  const a = toArchive("run-12", "2026-09-27", "note", [], [d], "demo", { stock: ["/stock.html, notes in /Users/u/notes.md"] });
  assert.deepEqual(a.laneRoutes, { stock: ["/stock.html, notes in <path>"] });
  const archived = JSON.parse(JSON.stringify(a)) as typeof a;
  assert.deepEqual(
    score(routeKey, archived.findings, archived.decisions, "minimal", archived.laneRoutes).calibration,
    score(routeKey, [], [d], "minimal", { stock: ["/stock.html"] }).calibration,
  );
  assert.equal(score(routeKey, archived.findings, archived.decisions, "minimal", archived.laneRoutes).calibration?.outOfScope, 1);
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
  // A non-defect wins over the defects it narrows, so one written too broadly
  // turns a real defect into a false positive — which is how a run that found
  // the planted delete bug would have been scored as having reported the
  // write policy.
  for (const d of [...demoKey.defects, ...demoKey.alsoReal]) {
    const got = classify(d.title, demoKey);
    assert.notEqual(got?.kind, "nonDefect", `${d.id}'s title is claimed by a non-defect`);
    assert.notEqual(got?.kind, "contextual", `${d.id}'s title is set aside as contextual`);
  }
});

test("a run is dated by its last decision, and never later than it", () => {
  const ds = [decision({ at: "2026-09-22T19:47:40.773Z" }), decision({ at: "2026-09-22T19:48:17.463Z" })];
  assert.equal(runDate(ds), "2026-09-22");
  assert.equal(runDate(ds, "2026-09-21"), "2026-09-21", "archived from notes a day late is allowed to say when it ran");
  // Run 1 was once dated the day after it ran, and --all sorts by date.
  assert.throws(() => runDate(ds, "2026-09-23"), /cannot be dated 2026-09-23/);
  assert.throws(() => runDate([]), /give it a date/);
  assert.equal(runDate([], "2026-09-20"), "2026-09-20");
  assert.throws(() => runDate(ds, "22/09/2026"), /YYYY-MM-DD/);
});

test("the demo key sets aside what depends on a convention, and says which", () => {
  // Lanes dismissed these as not defects and were scored wrong for it: the
  // demo declares no spacing scale, nav links are recognisable by position, and
  // a data-testid is a test-automation convention no user meets.
  for (const id of ["spacing-off-grid", "nav-links-unstyled", "stickybar-link-missing-testid"]) {
    const e = demoKey.contextual.find((c) => c.id === id);
    assert.ok(e && e.reason.length > 20, `${id} is contextual, with a reason`);
    assert.equal(judgeDecision(decision({ verdict: "not_a_defect", evidence: e.examples[0] ?? e.title }), demoKey), null, id);
  }
  // A page hiding approve controls from a clerk is not the endpoint accepting one.
  const hidden = decision({
    verdict: "not_a_defect",
    observation: "approvals-hides-actions-for-clerk",
    evidence: "testid=approvals-who clerk notice, no approve/reject controls",
  });
  assert.equal(classify(decisionText(hidden), demoKey), null);
});

test("archived runs are listed by date, then by name with numbers compared as numbers", () => {
  const runs = [
    { run: "run-10", date: "2026-09-26" },
    { run: "run-2", date: "2026-09-22" },
    { run: "run-9", date: "2026-09-26" },
    { run: "run-1", date: "2026-09-22" },
  ];
  assert.deepEqual(
    [...runs].sort(byRunOrder).map((r) => r.run),
    ["run-1", "run-2", "run-9", "run-10"],
  );
});

test("the demo key names routes the app serves", () => {
  for (const d of [...demoKey.defects, ...demoKey.alsoReal, ...demoKey.contextual]) {
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

// ── the held-out app, and scoring each run with its own app's key ──────────

const holdoutKey = parseKey(JSON.parse(fs.readFileSync(path.join(root, "holdout-app", "answer-key.json"), "utf8")));

test("every entry in both keys names the page it is on", () => {
  // Ownership is decided by an entry's pages, so each must read as exactly
  // one path, and an entry on every page must say so rather than name "/".
  for (const k of [demoKey, holdoutKey]) {
    for (const e of [...k.defects, ...k.alsoReal, ...k.contextual]) {
      for (const r of [e.route, ...(e.alsoOn ?? [])]) assert.deepEqual(laneRoutePaths(r), [r], `${k.app} ${e.id} ${r}`);
    }
    const nav = k.contextual.find((e) => e.id === "nav-links-unstyled");
    assert.equal(nav?.everyPage, true, `${k.app}: the nav is on every page`);
  }
  // An endpoint defect any lane can reach with a direct request is every lane's.
  for (const [k, id] of [
    [demoKey, "approve-endpoint-accepts-clerk"],
    [demoKey, "orders-api-accepts-invalid-input"],
    [holdoutKey, "member-record-any-id"],
  ] as const) {
    assert.equal([...k.defects, ...k.alsoReal].find((e) => e.id === id)?.everyPage, true, id);
  }
});

test("the held-out key agrees with every one of its own examples and counter-examples", () => {
  assert.deepEqual(lintKey(holdoutKey), []);
  for (const d of [...holdoutKey.defects, ...holdoutKey.alsoReal]) {
    assert.notEqual(classify(d.title, holdoutKey)?.kind, "nonDefect", `${d.id}'s title is claimed by a non-defect`);
    assert.notEqual(classify(d.title, holdoutKey)?.kind, "contextual", `${d.id}'s title is set aside as contextual`);
  }
});

test("the held-out key plants twelve to fourteen defects at every level, on routes the app serves", () => {
  assert.ok(holdoutKey.defects.length >= 12 && holdoutKey.defects.length <= 14, String(holdoutKey.defects.length));
  for (const level of ["minimal", "medium", "extensive"])
    assert.ok(
      holdoutKey.defects.some((d) => d.level === level),
      level,
    );
  for (const d of [...holdoutKey.defects, ...holdoutKey.alsoReal, ...holdoutKey.contextual]) {
    const file = d.route === "/" ? "index.html" : d.route.replace(/^\//, "");
    assert.ok(fs.existsSync(path.join(root, "holdout-app", "public", file)), `${d.id}: ${d.route} is not a page the held-out app serves`);
  }
  // Its own key, not a copy of the demo's: no id is shared.
  const demoIds = new Set([...demoKey.defects, ...demoKey.alsoReal, ...demoKey.nonDefects].map((e) => e.id));
  assert.deepEqual(
    holdoutKey.defects.map((d) => d.id).filter((id) => demoIds.has(id)),
    [],
  );
});

test("the held-out key has one planted defect for every row of its README's spoilers table", () => {
  const readme = fs.readFileSync(path.join(root, "holdout-app", "README.md"), "utf8");
  const table = readme.slice(readme.indexOf("## What is planted"));
  const rows = table.split("\n").filter((l) => /^\| [^-|][^|]*\|/.test(l) && !l.startsWith("| Where"));
  const defects = rows.filter((r) => !/Not a defect/i.test(r));
  assert.equal(defects.length, holdoutKey.defects.length, `README plants ${defects.length}, the key lists ${holdoutKey.defects.length}`);
  // The warning comes before the answers, not after them.
  assert.ok(readme.indexOf("stop reading here") < readme.indexOf("## What is planted"));
});

test("an archive records the app it was made against, and one from before there were two apps is the demo's", () => {
  assert.equal(toArchive("h-1", "2026-09-26", "n", [], [], "holdout").app, "holdout");
  assert.equal(archiveApp({ app: "holdout" }), "holdout");
  assert.equal(archiveApp({}), DEFAULT_APP);
  assert.equal(DEFAULT_APP, "demo");
  // Every archive committed so far names a known app or predates the second one.
  for (const f of fs.readdirSync(path.join(root, "bench", "runs")).filter((x) => x.endsWith(".json"))) {
    const a = JSON.parse(fs.readFileSync(path.join(root, "bench", "runs", f), "utf8")) as { app?: string };
    assert.ok(a.app === undefined || a.app === "demo" || a.app === "holdout", `${f}: app ${a.app}`);
  }
});

test("the app a run is scored as: what was asked, else what the archive says, else the demo — never two that disagree", () => {
  const known = ["demo", "holdout"];
  assert.equal(chooseApp({ known }), "demo");
  assert.equal(chooseApp({ requested: "holdout", known }), "holdout");
  assert.equal(chooseApp({ archived: "holdout", known }), "holdout");
  assert.equal(chooseApp({ requested: "holdout", archived: "holdout", known }), "holdout");
  assert.throws(() => chooseApp({ requested: "demo", archived: "holdout", known }), /archived for the holdout app/);
  assert.throws(() => chooseApp({ requested: "harbour", known }), /--app "harbour" is not a benchmark app/);
  assert.throws(() => chooseApp({ archived: "other", known }), /archive's app "other"/);
});

test("a key file is known by the app it names, and one of another benchmark app's is refused for an archive", () => {
  const keys = { demo: demoKey, holdout: holdoutKey };
  assert.equal(appOfKey(holdoutKey, keys), "holdout");
  assert.equal(appOfKey({ app: "a draft key" }, keys), undefined);
  assert.throws(() => checkKeyForArchive(holdoutKey, {}, keys), /archived for the demo app, and that key is the holdout app's/);
  assert.throws(() => checkKeyForArchive(demoKey, { app: "holdout" }, keys), /archived for the holdout app/);
  assert.doesNotThrow(() => checkKeyForArchive(holdoutKey, { app: "holdout" }, keys));
  assert.doesNotThrow(() => checkKeyForArchive({ app: "a draft key" }, {}, keys), "a draft key belongs to no app, so it may score anything");
});

test("--all groups archives by app, so each is scored against its own key", () => {
  const a = (run: string, date: string, app?: string) => ({ ...(app ? { app } : {}), run, date, note: "", findings: [], decisions: [] });
  const groups = groupByApp([
    a("run-10", "2026-09-22"),
    a("run-2", "2026-09-22"),
    a("holdout-1", "2026-09-27", "holdout"),
    a("run-1", "2026-09-21", "demo"),
    a("run-0", "2026-09-21"),
  ]);
  assert.deepEqual([...groups.keys()], ["demo", "holdout"]);
  assert.deepEqual(
    groups.get("demo")!.map((x) => x.run),
    ["run-0", "run-1", "run-2", "run-10"],
    "within an app, runs keep the numeric order --all lists them in",
  );
  assert.deepEqual(
    groups.get("holdout")!.map((x) => x.run),
    ["holdout-1"],
  );
});

test("a held-out run scored against the demo's key is a plausible wrong number, which is why the key follows the app", () => {
  const findings = holdoutKey.defects.map((d) => finding(d.examples[0] ?? d.title, { severity: d.severity }));
  const right = score(holdoutKey, findings, [], "extensive");
  assert.equal(right.found.length, holdoutKey.defects.length);
  const wrong = score(demoKey, findings, [], "extensive");
  assert.ok(wrong.found.length < 3, `the demo key credits ${wrong.found.join(", ")}`);
  assert.equal(wrong.expected, demoKey.defects.length);
});

test("npm run bench scores an archive with its own app's key, and refuses another app's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-app-"));
  try {
    const findings = holdoutKey.defects.slice(0, 3).map((d) => ({ title: d.title, severity: d.severity }));
    const holdout = path.join(dir, "holdout-9.json");
    fs.writeFileSync(holdout, JSON.stringify({ app: "holdout", run: "holdout-9", date: "2026-09-26", note: "n", findings, decisions: [] }));
    const legacy = path.join(dir, "run-legacy.json");
    fs.writeFileSync(legacy, JSON.stringify({ run: "run-legacy", date: "2026-09-26", note: "n", findings: [], decisions: [] }));
    const bench = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts", "bench.ts"), ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });

    const scored = bench(holdout);
    assert.equal(scored.status, 0, scored.stderr);
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(scored.stdout.split("\n")[0], new RegExp(`${escape(holdoutKey.app)}.*key ${keyHash(holdoutKey)}`));
    assert.match(scored.stdout, new RegExp(`Recall\\s+3/${holdoutKey.defects.filter((d) => d.level !== "extensive").length}`));

    const refused = bench(holdout, "--app", "demo");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /archived for the holdout app/);

    const old = bench(legacy);
    assert.equal(old.status, 0, old.stderr);
    assert.match(old.stdout.split("\n")[0], new RegExp(`${escape(demoKey.app)}.*key ${keyHash(demoKey)}`));

    // --key naming the other app's key file is the same mistake by another route.
    const byFile = bench("--key", path.join(root, "holdout-app", "answer-key.json"), legacy);
    assert.notEqual(byFile.status, 0);
    assert.match(byFile.stderr, /archived for the demo app, and that key is the holdout app's/);
    assert.equal(bench("--key", path.join(root, "demo-app", "answer-key.json"), legacy).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── finding dedup as a measured decision ────────────────────────────────────

const pageKey = parseKey({
  app: "pairs",
  defects: [
    { ...entry("export-500", ["POST /api/export 500", "export.{0,20}fails"]), route: "/reports" },
    { ...entry("export-double", ["double.?submit"]), route: "/reports" },
    { ...entry("chart-404", ["chart\\.png 404"]), route: "/" },
    { ...entry("stale-total", ["stale total"]), route: "/list", alsoOn: ["/reports"] },
  ],
  nonDefects: [{ id: "slow", title: "slow export", why: "within budget", match: ["export is slow"] }],
});
const arch = (run: string, findings: Array<{ title: string; evidence?: string; category?: string }>, app = "pairs") => ({
  app,
  run,
  date: "2026-09-27",
  note: "",
  decisions: [],
  findings: findings.map((f) => ({ severity: "high" as const, category: "http-error", ...f })),
});

test("dedup pairs: one key entry is a same pair and two entries on one page a different pair; other pages are not paired", () => {
  const set = buildPairs(
    [
      arch("r1", [
        { title: "Export fails with a server error", evidence: "POST /api/export 500" },
        { title: "Chart image missing", evidence: "GET /img/chart.png 404" },
      ]),
      arch("r2", [
        { title: "Export button breaks: POST /api/export 500 on click", evidence: "testid=export click" },
        { title: "Export sends a double submit", evidence: "POST /api/export x2" },
      ]),
    ],
    { pairs: pageKey },
  );
  const describe = (p: LabelledPair) => `${p.a.keyId}~${p.b.keyId}@${p.route}:${p.same ? "same" : "different"}`;
  assert.deepEqual(set.pairs.map(describe).sort(), [
    "export-500~export-500@/reports:same",
    "export-500~export-double@/reports:different",
    "export-500~export-double@/reports:different",
  ]);
  assert.equal(set.findings, 4);
});

test("dedup pairs: alsoOn pages pair, and what cannot be labelled is counted, not paired", () => {
  const set = buildPairs(
    [
      arch("r1", [
        { title: "Export fails", evidence: "POST /api/export 500" },
        { title: "stale total after an edit" },
        { title: "Nothing the key knows" },
        { title: "export fails and a double submit too" },
        { title: "the export is slow" },
      ]),
      arch("r2", [{ title: "Export fails", evidence: "POST /api/export 500" }]),
      arch("r3", [{ title: "Export fails", evidence: "POST /api/export 500" }], "no-such-app"),
    ],
    { pairs: pageKey },
  );
  assert.deepEqual(
    set.pairs.map((p) => `${p.a.keyId}~${p.b.keyId}@${p.route}`),
    ["export-500~stale-total@/reports"],
    "stale-total names /reports in alsoOn; the repeat of identical text in r2 is not a second finding",
  );
  assert.deepEqual(
    { identicalText: set.identicalText, unmatched: set.unmatched, ambiguous: set.ambiguous, nonDefect: set.nonDefect, withoutKey: set.archivesWithoutKey },
    { identicalText: 1, unmatched: 1, ambiguous: 1, nonDefect: 1, withoutKey: 1 },
  );
});

test("dedup pairs: the sample is capped, the same whatever order the pairs arrive in, and a bad cap is refused", () => {
  const ps: LabelledPair[] = Array.from({ length: 30 }, (_, i) => ({
    app: "pairs",
    route: "/",
    a: { title: `a${i}`, category: "visual", keyId: "x", run: "r1" },
    b: { title: `b${i}`, category: "visual", keyId: "x", run: "r2" },
    same: true,
  }));
  const one = samplePairs(ps, 10);
  assert.equal(one.length, 10);
  assert.deepEqual(samplePairs([...ps].reverse(), 10), one);
  assert.equal(samplePairs(ps, 100).length, 30);
  assert.throws(() => samplePairs(ps, 0), /positive whole number/);
});

const pf = (title: string, evidence: string | undefined, category = "http-error"): PairFinding => ({ title, evidence, category, keyId: "k", run: "r" });

test("dedup rule: the benchmark scores the store's own rule — shared failing request merges, differing requests do not", () => {
  // The contrastive pair: one fact differs, the endpoint the evidence names.
  const merged = ruleJudgement({
    route: "/r",
    a: pf("Export fails", "POST /api/export 500"),
    b: pf("Export is broken for everyone", "POST /api/export 500 on click"),
  });
  const kept = ruleJudgement({
    route: "/r",
    a: pf("Export fails", "POST /api/export 500"),
    b: pf("Export is broken for everyone", "POST /api/import 500 on click"),
  });
  assert.deepEqual(merged, { verdict: "same", pSame: 1 });
  assert.deepEqual(kept, { verdict: "different", pSame: 0 });
});

test("dedup scoring: accuracy, Brier and equal-count ECE, with unsure and failed judgements left out and counted", () => {
  const labels = [true, true, true, true, false, false, false, false, true, false];
  const js: Array<Judgement | null> = [
    { verdict: "same", pSame: 0.9 },
    { verdict: "same", pSame: 0.9 },
    { verdict: "same", pSame: 0.8 },
    { verdict: "different", pSame: 0.2 },
    { verdict: "different", pSame: 0.1 },
    { verdict: "different", pSame: 0.1 },
    { verdict: "same", pSame: 0.6 },
    { verdict: "different", pSame: 0.3 },
    { verdict: "unsure", pSame: 0.5 },
    null,
  ];
  const s = scorePairs(labels, js, 2);
  assert.equal(s.judged, 8);
  assert.equal(s.unsure, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.correct, 6);
  assert.equal(s.accuracy, 0.75);
  // (0.01+0.01+0.04+0.64+0.01+0.01+0.36+0.09)/8
  assert.ok(Math.abs(s.brier! - 1.17 / 8) < 1e-9);
  assert.equal(s.brierRef, 0.25);
  // Sorted p: .1 .1 .2 .3 | .6 .8 .9 .9 — actual 1/4 and 3/4.
  assert.deepEqual(
    s.buckets.map((b) => b.n),
    [4, 4],
  );
  assert.ok(Math.abs(s.buckets[0].stated - 0.175) < 1e-9 && s.buckets[0].actual === 0.25);
  assert.ok(Math.abs(s.ece! - (0.5 * 0.075 + 0.5 * 0.05)) < 1e-9);
});

test("dedup scoring: tied probabilities share a bucket, so a yes/no rule has two, and too few pairs publish no number", () => {
  const labels = [true, false, false, false, false, false, true, true, true, false];
  const rule: Judgement[] = labels.map((_, i) => (i < 6 ? { verdict: "different", pSame: 0 } : { verdict: "same", pSame: 1 }));
  const s = scorePairs(labels, rule, 5);
  assert.deepEqual(
    s.buckets.map((b) => [b.n, b.stated, b.actual]),
    [
      [6, 0, 1 / 6],
      [4, 1, 0.75],
    ],
  );
  // A 0/1 decider's Brier is its error rate.
  assert.equal(s.brier, 0.2);
  const few = scorePairs(labels.slice(0, 7), rule.slice(0, 7));
  assert.equal(few.accuracy, null);
  assert.equal(few.brier, null);
  assert.match(formatPairScore("rule", few), /fewer than 8 judged, no figures/);
  assert.throws(() => scorePairs([true], []), /1 labels but 0 judgements/);
});

const turn = (input: unknown, name = JUDGE_TOOL.name): ModelTurn => ({
  text: "",
  calls: [{ id: "c1", name, input }],
  usage: { input: 10, cachedInput: 0, cacheWrite: 0, output: 5 },
});

test("dedup judge: only a coherent judge_pair call is read; anything else is an error, never a guess", () => {
  assert.deepEqual(parseJudgement(turn({ verdict: "same", p_same: 0.8 })), { ok: true, judgement: { verdict: "same", pSame: 0.8 } });
  assert.deepEqual(parseJudgement(turn({ verdict: "unsure", p_same: 0.5 })), { ok: true, judgement: { verdict: "unsure", pSame: 0.5 } });
  for (const [bad, why] of [
    [turn({ verdict: "same", p_same: 0.3 }), /contradicts/],
    [turn({ verdict: "different", p_same: 0.7 }), /contradicts/],
    [turn({ verdict: "same", p_same: 1.2 }), /not a probability/],
    [turn({ verdict: "same", p_same: "0.9" }), /not a probability/],
    [turn({ verdict: "maybe", p_same: 0.5 }), /not same, different or unsure/],
    [turn({ verdict: "same", p_same: 0.9 }, "other_tool"), /did not call judge_pair/],
    [{ text: "They look the same.", calls: [], usage: NO_USAGE, note: "the model declined to continue" }, /declined/],
  ] as const)
    assert.match((parseJudgement(bad) as { error: string }).error, why);
});

test("dedup judge: off by default the rule decides; a failing or unsure judge falls back to the rule and says so", async () => {
  const pair = { route: "/r", a: pf("Export fails", "POST /api/export 500"), b: pf("Export broken", "POST /api/export 500") };
  assert.deepEqual(await decideDuplicate(pair), { duplicate: true, by: "rule" });
  const differs = await decideDuplicate(pair, async () => turn({ verdict: "different", p_same: 0.1 }));
  assert.deepEqual(differs, { duplicate: false, by: "model", judgement: { verdict: "different", pSame: 0.1 } });
  const thrown = await decideDuplicate(pair, async () => {
    throw new Error("HTTP 529: overloaded");
  });
  assert.equal(thrown.by, "rule");
  assert.equal(thrown.duplicate, true);
  assert.match(thrown.note!, /model judge failed \(HTTP 529: overloaded\); the current rule decided/);
  const malformed = await decideDuplicate(pair, async () => turn({ verdict: "same", p_same: 0.2 }));
  assert.equal(malformed.by, "rule");
  assert.match(malformed.note!, /contradicts/);
  const unsure = await decideDuplicate(pair, async () => turn({ verdict: "unsure", p_same: 0.5 }));
  assert.equal(unsure.by, "rule");
  assert.match(unsure.note!, /unsure; the current rule decided/);
});

test("dedup judge: through the real OpenAI adapter, a structured reply is read and a refused key falls back without printing it", async () => {
  const KEY = "sk-judge-test-0123456789abcdef";
  const pair = { route: "/r", a: pf("Export fails", "POST /api/export 500"), b: pf("Export broken", "POST /api/export 500") };
  const sent: unknown[] = [];
  const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const ok = async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return reply(200, {
      status: "completed",
      output: [{ type: "function_call", call_id: "call_1", name: "judge_pair", arguments: JSON.stringify({ verdict: "different", p_same: 0.2 }) }],
      usage: { input_tokens: 120, output_tokens: 9 },
    });
  };
  const ask =
    (f: typeof fetch): Ask =>
    (system, tools, kickoff) =>
      new HttpModelClient(new OpenAIConversation({ baseUrl: "http://model.test/v1", model: "m", effort: "none", system, tools }, kickoff), KEY, {
        fetch: f,
        sleep: async () => {},
      }).next(60_000);
  const d = await decideDuplicate(pair, ask(ok as typeof fetch));
  assert.deepEqual(d, { duplicate: false, by: "model", judgement: { verdict: "different", pSame: 0.2 } });
  const body = sent[0] as { reasoning: { effort: string }; tools: Array<{ name: string }>; input: Array<{ content: string }> };
  assert.equal(body.reasoning.effort, "none");
  assert.deepEqual(
    body.tools.map((t) => t.name),
    ["judge_pair"],
  );
  assert.match(body.input[0].content, /Finding A: .*POST \/api\/export 500/);
  const refused = (async () => reply(401, { error: { message: `Incorrect API key provided: ${KEY}` } })) as typeof fetch;
  const fell = await decideDuplicate(pair, ask(refused));
  assert.equal(fell.by, "rule");
  assert.match(fell.note!, /model judge failed \(HTTP 401/);
  // The API's error text can quote the key, and the note carries it as given:
  // whoever prints a note must redact it first, as dedup-bench does.
  assert.ok(fell.note!.includes(KEY));
  assert.ok(!redactKeys(fell.note!, [KEY]).includes(KEY));
});
