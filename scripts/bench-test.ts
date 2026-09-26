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
  calibrateAgainstKey,
  checkKeyForArchive,
  chooseApp,
  classify,
  DEFAULT_APP,
  formatScorecard,
  groupByApp,
  judgeDecision,
  keyHash,
  lintKey,
  parseKey,
  isScopeDismissal,
  precisionBounds,
  runDate,
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
  assert.equal(judgeDecision(dismissals[0], key), null);
  // The same wording on a defect verdict is a claim, and is scored.
  const claimed = decision({ verdict: "defect", evidence: "/dead", observation: "belongs to the landing page" });
  assert.equal(isScopeDismissal(claimed), false);
  assert.equal(judgeDecision(claimed, key), true);
  // A not-a-defect verdict with a reason about the thing itself is scored.
  assert.equal(judgeDecision(decision({ verdict: "not_a_defect", evidence: "/dead", observation: "works as designed" }), key), false);
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

// ── the held-out app, and scoring each run with its own app's key ──────────

const holdoutKey = parseKey(JSON.parse(fs.readFileSync(path.join(root, "holdout-app", "answer-key.json"), "utf8")));

test("the held-out key agrees with every one of its own examples and counter-examples", () => {
  assert.deepEqual(lintKey(holdoutKey), []);
  for (const d of [...holdoutKey.defects, ...holdoutKey.alsoReal]) {
    assert.notEqual(classify(d.title, holdoutKey)?.kind, "nonDefect", `${d.id}'s title is claimed by a non-defect`);
  }
});

test("the held-out key plants twelve to fourteen defects at every level, on routes the app serves", () => {
  assert.ok(holdoutKey.defects.length >= 12 && holdoutKey.defects.length <= 14, String(holdoutKey.defects.length));
  for (const level of ["minimal", "medium", "extensive"])
    assert.ok(
      holdoutKey.defects.some((d) => d.level === level),
      level,
    );
  for (const d of [...holdoutKey.defects, ...holdoutKey.alsoReal]) {
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
  const groups = groupByApp([a("run-2", "2026-09-22"), a("holdout-1", "2026-09-27", "holdout"), a("run-1", "2026-09-21", "demo"), a("run-0", "2026-09-21")]);
  assert.deepEqual([...groups.keys()], ["demo", "holdout"]);
  assert.deepEqual(
    groups.get("demo")!.map((x) => x.run),
    ["run-0", "run-1", "run-2"],
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
