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
  decodedEntitiesNote,
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

test("lane: unfenced text around the object is refused, and the reason says which", () => {
  refused("Here is my report:\n" + laneReport(), /no text before/);
  refused(laneReport() + "\nHope this helps.", /no text after/);
  refused("", /no text before/, "empty reply");
  refused("{not json", /not valid JSON/);
});

test("lane: prose around ONE fenced object is dropped unread, and the parse says so", () => {
  // Six of eight lanes in one measured run replied like this.
  const bare = parseLaneReport(laneReport());
  for (const wrapped of [
    "Done. Here is my report:\n\n```json\n" + laneReport() + "\n```",
    "```json\n" + laneReport() + "\n```\nDone.",
    "Summary: 3 defects.\n```\n" + laneReport() + "\n```\nLet me know if you need more.",
  ]) {
    const r = parseLaneReport(wrapped);
    assert.ok(r.ok, wrapped.slice(0, 30));
    assert.equal(r.aroundIgnored, true);
    assert.deepEqual(r.report, bare.ok && bare.report);
  }
  assert.equal(bare.ok && bare.aroundIgnored, false, "a bare object has nothing around it");
  const fencedOnly = parseLaneReport("```json\n" + laneReport() + "\n```");
  assert.equal(fencedOnly.ok && fencedOnly.aroundIgnored, false, "nor does a lone fenced one");

  // The contrast: two objects, or a fence holding something else, is still a guess.
  refused("```json\n" + laneReport() + "\n```\nand the corrected one:\n```json\n" + laneReport() + "\n```", /2 fenced JSON blocks/);
  refused("Notes:\n```\nnot an object\n```\n", /no text before/);
  // Windows line endings, fenced alone or wrapped.
  for (const crlf of ["```json\r\n" + laneReport() + "\r\n```", "Report:\r\n```json\r\n" + laneReport() + "\r\n```\r\nDone."]) {
    const r = parseLaneReport(crlf);
    assert.ok(r.ok, JSON.stringify(crlf.slice(0, 20)));
  }
  // A fenced block that is not valid is refused on its content, not skipped.
  refused('Here:\n```json\n{"lane": \n```', /not valid JSON/);
});

// A planner relaying a lane's reply often HTML-escapes it. The escaped text
// then fails to match findings and answer-key patterns, and once pushed a
// route past its cap so the whole report was refused.
test("lane: HTML character references a relay added are decoded in every string field", () => {
  const arrow = parseLaneReport(laneReport({}, { evidence: "testid=a -&gt; /orders.html" }));
  assert.ok(arrow.ok, arrow.ok ? "" : arrow.reason);
  assert.equal(arrow.report.decisions[0].evidence, "testid=a -> /orders.html");
  assert.equal(arrow.entitiesDecoded, 1);
  assert.match(decodedEntitiesNote(arrow.entitiesDecoded), /1 HTML character reference .*decoded/);

  // Every string field, every named and numeric form.
  const markup = parseLaneReport(
    laneReport(
      { lane: "orders&#39;", routes: ["/things/&lt;n&gt;?a=1&amp;b=2"], status: "partial", blocked_by: "&quot;Save&quot; is &#x2014; disabled&#8230;" },
      { observation: "it&apos;s-escaped", evidence: "&lt;img src=x onerror&gt;" },
    ),
  );
  assert.ok(markup.ok, markup.ok ? "" : markup.reason);
  assert.equal(markup.report.lane, "orders'");
  assert.deepEqual(markup.report.routes, ["/things/<n>?a=1&b=2"]);
  assert.equal(markup.report.blocked_by, '"Save" is — disabled…');
  assert.equal(markup.report.decisions[0].observation, "it's-escaped");
  assert.equal(markup.report.decisions[0].evidence, "<img src=x onerror>");
  assert.equal(markup.entitiesDecoded, 11);
  assert.match(decodedEntitiesNote(11), /11 HTML character references .*decoded/);

  // Fenced with prose around it: both notes apply.
  const wrapped = parseLaneReport("Report:\n```json\n" + laneReport({}, { evidence: "a -&gt; b" }) + "\n```");
  assert.ok(wrapped.ok && wrapped.aroundIgnored && wrapped.entitiesDecoded === 1);
});

test("lane: a length cap applies to the decoded text, so a route escaped past it is accepted", () => {
  const route = "/things/<n>" + "r".repeat(LANE_ROUTE_MAX - "/things/<n>".length);
  assert.equal(route.length, LANE_ROUTE_MAX);
  const escapedRoute = route.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  assert.ok(escapedRoute.length > LANE_ROUTE_MAX);
  const capped = parseLaneReport(laneReport({ routes: [escapedRoute] }));
  assert.ok(capped.ok, capped.ok ? "" : capped.reason);
  assert.deepEqual(capped.report.routes, [route]);
  refused(laneReport({ routes: [escapedRoute + "r"] }), /at routes\.0$/, "one past the cap once decoded");
});

test("lane: references are decoded once only, and anything else that looks like one is left alone", () => {
  // An escaped entity comes back as that entity, not as the character.
  const once = parseLaneReport(laneReport({}, { evidence: "&amp;lt;b&amp;gt; shown as text" }));
  assert.ok(once.ok);
  assert.equal(once.report.decisions[0].evidence, "&lt;b&gt; shown as text");
  // Not one of the references decoded, or not a valid one, so left alone.
  const loose = parseLaneReport(laneReport({}, { evidence: "a & b &nbsp; &#xZZ; &#0; &#1114112; &unknown;" }));
  assert.ok(loose.ok);
  assert.equal(loose.report.decisions[0].evidence, "a & b &nbsp; &#xZZ; &#0; &#1114112; &unknown;");
  assert.equal(loose.entitiesDecoded, 0);
});

test("lane: the contrast, a reply with no references is unchanged and the fold carries no decode note", () => {
  const text = laneReport({}, { evidence: "testid=a -> /orders.html" });
  const plain = parseLaneReport(text);
  assert.ok(plain.ok);
  assert.equal(plain.entitiesDecoded, 0);
  assert.deepEqual(plain.report, JSON.parse(text));
  assert.equal(decodedEntitiesNote(plain.entitiesDecoded), "");
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
  assert.ok(text.includes('"orders"'), "the lane is told its own name");
  assert.ok(laneReportInstruction('a"b').includes('"a\\"b"'), "the lane name is escaped into the instruction");
});

test("lane: every lane in a wave is given the same rubric, so it is one cacheable prefix", () => {
  // The lane name used to sit in the second sentence, so two lanes' prompts
  // diverged after about a line and shared no prefix. Every lane in a fan-out
  // gets this text, so keeping it byte-identical until the last sentence is
  // the difference between one cached prefix and N uncached ones.
  const a = laneReportInstruction("orders");
  const b = laneReportInstruction("stock");
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;

  // Everything up to the sentence that states the name is identical; the two
  // then diverge inside the name itself, which is as late as it can be.
  const tail = a.lastIndexOf("Your lane name is");
  assert.ok(shared >= tail, `diverged at ${shared}, before the name sentence at ${tail}`);
  assert.equal(a.slice(0, tail), b.slice(0, tail), "the rubric is byte-identical for both lanes");
  assert.ok(shared > 0.9 * Math.min(a.length, b.length), `only ${shared} of ${a.length} characters are shared`);
  // And the name is the LAST thing said, not merely late.
  assert.ok(a.trimEnd().endsWith('put exactly that in "lane".'), a.slice(-80));
});

test("a reply that was not relay-escaped keeps its references: a literal < means nothing was escaped on the way", () => {
  const reply = JSON.stringify({
    lane: "orders",
    status: "complete",
    decisions: [
      { observation: "name-double-escaped", verdict: "defect", severity: "low", category: "visual", confidence: 0.9, evidence: "<td> shows Tom &amp; Jerry" },
    ],
    routes: ["/orders"],
    blocked_by: null,
  });
  const parsed = parseLaneReport(reply);
  assert.ok(parsed.ok);
  assert.equal(parsed.report.decisions[0].evidence, "<td> shows Tom &amp; Jerry");
  assert.equal(parsed.entitiesDecoded, 0);
  assert.equal(decodedEntitiesNote(parsed.entitiesDecoded), "");
});
