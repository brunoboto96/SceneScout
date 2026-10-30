/**
 * Unit tests for the template-driven test report of a recorded check
 * (`scenescout check --record --template <file.json>`): the template's schema
 * and its errors, the flow metadata it reads (id, requirements, expected), the
 * deterministic page (a golden file), deviations, the evidence manifest and
 * escaping. The browser half is in scripts/smoke/check.ts.
 *
 * Also the team report (scout_team_report, src/engine/team-report.ts): which
 * problems it lists and how, the page against scripts/golden/team-report.html,
 * escaping, the manifest's hashes, and that nothing is written outside the
 * project's .scenescout/ folder.
 *
 *   npx tsx --test scripts/report-test.ts
 *   UPDATE_GOLDEN=1 npx tsx --test scripts/report-test.ts   # rewrite the golden file after an intended change
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readText } from "./checkout.ts";
import { REPORT_GENERATOR_META, testReportOf } from "../action/check-action.mjs";
import { clearReplayOutput, prepareTemplateReport, writeTemplateReport } from "../src/check-run.ts";
import { DEFAULT_SETTINGS, parseCheckArgs, toSummaryJson, type CheckResult } from "../src/engine/check.ts";
import { journeyOf, redactReplay, type CheckReplay } from "../src/engine/check-replay.ts";
import {
  buildTemplateReport,
  deviationsOf,
  evidenceFiles,
  evidenceIndex,
  isGeneratedReport,
  MISSING,
  parseReportTemplate,
  recordedReportFile,
  REPORT_GENERATOR,
  reportFileOf,
  templateRecordError,
  type EvidenceEntry,
  type ReportTemplate,
} from "../src/engine/check-report.ts";
import { parseFlow, type Flow, type FlowOutcome } from "../src/engine/flow.ts";
import {
  RECAP_ADDRESS_MAX,
  RECAP_FILE,
  recapAddress,
  recapDuration,
  recapFigures,
  recapLines,
  recapSvg,
  writeRecap,
  type RecapFigures,
} from "../src/engine/recap.ts";
import { assertSavedPagePolicy, pagePolicy } from "./saved-page-csp.ts";
import type { Finding } from "../src/engine/memory.ts";
import { MODE_CARE_LABEL, TEAM_REPORT_WORDS } from "../src/engine/guided-words.ts";
import {
  TEAM_EVIDENCE_DIR,
  TEAM_MANIFEST_FILE,
  TEAM_REPORT_FILE,
  TEAM_REPORT_GENERATOR,
  teamReportData,
  teamReportHtml,
  teamReportMarkdown,
  teamReportText,
  writeTeamReport,
  type TeamEvidenceEntry,
  type TeamReportSource,
} from "../src/engine/team-report.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = path.join(ROOT, "examples", "report-template.json");
const GOLDEN = path.join(ROOT, "scripts", "golden", "check-report.html");

function flowOf(json: object, file: string): Flow {
  const parsed = parseFlow(JSON.stringify(json), file);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.flow;
}

/** A flow with traceability: an id, the requirements it covers, and an expected result on its actions. */
const traced = flowOf(
  {
    name: "place an order",
    id: "TC-01",
    requirements: ["REQ-012", "REQ-013"],
    steps: [
      { action: "navigate", target: "/shop", expected: "The catalogue lists the products" },
      { action: "click", target: 'role=button[name="Add to basket"]', expected: "The basket shows one item" },
      { action: "expect-text", text: "1 item" },
      { action: "click", target: "testid=checkout" },
      { action: "expect-url", pattern: "/order/\\d+$", expected: "The order confirmation opens" },
    ],
  },
  "01-order.json",
);

/** A flow with none: its test ID, requirements and the expected result of its actions are missing. */
const plain = flowOf(
  {
    name: "cancel an order",
    steps: [
      { action: "navigate", target: "/orders" },
      { action: "click", target: "text=Cancel" },
      { action: "expect-text", text: "Order cancelled" },
      { action: "expect-element", target: "testid=undo", state: "visible" },
    ],
  },
  "02-cancel.json",
);

const FAILED_AT_3: FlowOutcome = {
  status: "failed",
  step: 3,
  did: 'expect text "Order cancelled"',
  reason: 'no visible text "Order cancelled" within 5s',
  path: "/orders",
};

function replayOf(): CheckReplay {
  return redactReplay({
    startedAt: "2026-03-04T05:06:07.000Z",
    roles: [
      {
        role: "anonymous",
        own: true,
        visits: [],
        journeys: [
          {
            ...journeyOf(
              traced,
              { status: "passed" },
              [1, 2, 3, 4, 5].map((n) => ({ frame: `replay-frames/check/000${n}-step.jpg` })),
            ),
            video: "replay-videos/journey-01-01-order.webm",
          },
        ],
      },
      {
        role: "reviewer",
        own: false,
        visits: [],
        journeys: [
          journeyOf(
            plain,
            FAILED_AT_3,
            [1, 2, 3].map((n) => ({ frame: `replay-frames/role-reviewer/000${n}-step.jpg` })),
          ),
        ],
      },
    ],
    framesLeftOut: 0,
  });
}

function resultOf(replay: CheckReplay = replayOf()): CheckResult {
  return {
    url: "http://127.0.0.1:3000/",
    generatedAt: "2026-03-04T05:08:09.000Z",
    mode: "read-only",
    failOn: "high",
    routes: [],
    issues: [
      {
        rule: "flow-step-failed",
        severity: "high",
        routes: ["/orders"],
        evidence: 'flow "cancel an order" (02-cancel.json) step 3 of 4',
        fingerprint: "flow-step-failed-cancel-an-order",
      },
    ],
    worthALook: [],
    unvisited: [],
    ignored: [],
    ignoredPaths: [],
    flows: [],
    retest: null,
    settings: { ...DEFAULT_SETTINGS },
    skippedFlows: [],
    replay,
  };
}

const META = { version: "9.9.9", commit: "0123456789abcdef0123456789abcdef01234567" };

/** Fixed hashes, so the golden file depends on nothing on disk. */
function fixedEvidence(result: CheckResult): EvidenceEntry[] {
  return evidenceFiles(result).map((p, i) =>
    i === evidenceFiles(result).length - 1 ? { path: p, bytes: null, sha256: null } : { path: p, bytes: 100 + i, sha256: String(i % 10).repeat(64) },
  );
}

function exampleTemplate(): ReportTemplate {
  const parsed = parseReportTemplate(fs.readFileSync(EXAMPLE, "utf8"), "report-template.json");
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.template;
}

function template(over: object): ReportTemplate {
  const parsed = parseReportTemplate(
    JSON.stringify({
      title: "Report",
      sections: [{ type: "tests", columns: ["testId", "requirements", "step", "expected", "actual", "result", "evidence"] }],
      ...over,
    }),
    "t.json",
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.template;
}

/** Strips tags, repeating until nothing changes (the form the incomplete multi-character sanitisation check recognises). */
function stripTags(text: string): string {
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== previous);
  return text;
}

/** The text of each cell of the rows of the first table in the section, tags stripped. */
function rowsOf(html: string, section: string): string[][] {
  const body = html.split(`data-section="${section}"`)[1]?.split("</section>")[0] ?? "";
  return [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/g)].map((c) => stripTags(c[1])));
}

test("golden: the same run, template and evidence always render the same page", () => {
  const html = buildTemplateReport(resultOf(), exampleTemplate(), fixedEvidence(resultOf()), META);
  assert.equal(buildTemplateReport(resultOf(), exampleTemplate(), fixedEvidence(resultOf()), META), html, "two renders are identical");
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, html);
  }
  assert.equal(
    html,
    // As LF: a Windows checkout may store the golden file with CRLF; the page itself always writes LF.
    readText(GOLDEN),
    "the page matches scripts/golden/check-report.html (UPDATE_GOLDEN=1 rewrites it after an intended change)",
  );
});

test("the page's own policy runs no script and loads its frames only from its own origin", () => {
  const html = buildTemplateReport(resultOf(), exampleTemplate(), fixedEvidence(resultOf()), META);
  assert.ok(html.includes("<img "), "the page under test shows a frame");
  assertSavedPagePolicy(html, "the test report");
  assert.deepEqual(pagePolicy(html).get("script-src"), ["'none'"]);
});

test("the example template is valid and lays out every section in its order, with its document ID and fields filled", () => {
  const html = buildTemplateReport(resultOf(), exampleTemplate(), fixedEvidence(resultOf()), META);
  assert.equal(reportFileOf(exampleTemplate()), "test-report.html");
  assert.deepEqual(
    [...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]),
    ["text", "summary", "tests", "deviations", "manifest", "signoff"],
  );
  assert.match(html, /<th scope="row">Document ID<\/th><td>ATR-20260304-050607<\/td>/);
  assert.match(html, /<td>SceneScout 9\.9\.9<\/td>/);
  assert.match(html, /<td>0123456789ab<\/td>/);
  assert.match(html, /<th scope="col" data-column="evidence">Screenshot<\/th>/, "a column's heading comes from the template");
  assert.ok(isGeneratedReport(html));
  assert.ok(!/<script|\son[a-z]+=/i.test(html), "no scripts or event handlers");
  assert.ok(!/(src|href)="https?:/.test(html), "nothing loaded from the network");
});

test("a failed assertion is a fail, and becomes a deviation with its step, expected and actual result", () => {
  const html = buildTemplateReport(
    resultOf(),
    template({ sections: [{ type: "summary" }, { type: "tests", columns: ["step", "result"] }, { type: "deviations" }] }),
    [],
    META,
  );
  const tests = rowsOf(html, "tests");
  assert.deepEqual(
    tests.filter((r) => r.length === 2),
    [
      ["Step", "Result"],
      ["1. navigate /shop", "Pass"],
      ["2. click role=button[name=&quot;Add to basket&quot;]", "Pass"],
      ["3. expect text &quot;1 item&quot;", "Pass"],
      ["4. click testid=checkout", "Pass"],
      ["5. expect the URL to match //order/\\d+$/", "Pass"],
      ["1. navigate /orders", "Pass"],
      ["2. click text=Cancel", "Pass"],
      ["3. expect text &quot;Order cancelled&quot;", "Fail"],
      ["4. expect testid=undo to be visible", "Not run"],
    ],
  );
  assert.deepEqual(rowsOf(html, "deviations"), [
    ["#", "Test ID", "Test", "Step", "Expected result", "Actual result", "Result"],
    [
      "1",
      MISSING,
      "cancel an order",
      "3. expect text &quot;Order cancelled&quot;",
      "expect text &quot;Order cancelled&quot;",
      "no visible text &quot;Order cancelled&quot; within 5s on /orders",
      "Fail",
    ],
  ]);
  assert.match(html, /data-testid="report-verdict">Fail</, "the overall result is a fail");
  assert.deepEqual(
    deviationsOf(resultOf()).map((d) => [d.test, d.step, d.result]),
    [["cancel an order", 3, "failed"]],
  );
  const passing = resultOf({ ...replayOf(), roles: [replayOf().roles[0]] });
  const green = buildTemplateReport({ ...passing, issues: [] }, template({ sections: [{ type: "summary" }, { type: "deviations" }] }), [], META);
  assert.match(green, /data-testid="report-verdict">Pass</);
  assert.match(green, /data-testid="report-no-deviations">No deviations\.</);
  // --fail-on never: the gate lets the broken flow through, but the report never calls a failed test a pass.
  const ungated = buildTemplateReport({ ...resultOf(), failOn: "never" }, template({ sections: [{ type: "summary" }] }), [], META);
  assert.match(ungated, /data-testid="report-verdict">Fail</, "a failed test fails the report whatever the gate says");
  assert.ok(!html.includes("\r") && !green.includes("\r"), "the page writes LF only, so its bytes are the same on every platform");
});

test("the expected result is the step's own, else an expect-* step's assertion; an action with none shows —", () => {
  const steps = replayOf().roles[0].journeys[0].steps;
  assert.deepEqual(
    steps.map((s) => s.expected),
    ["The catalogue lists the products", "The basket shows one item", 'expect text "1 item"', undefined, "The order confirmation opens"],
  );
  const html = buildTemplateReport(resultOf(), template({ sections: [{ type: "tests", columns: ["step", "expected", "actual"] }] }), [], META);
  const rows = rowsOf(html, "tests").filter((r) => r.length === 3);
  assert.deepEqual(rows[4], ["4. click testid=checkout", MISSING, "As expected"]);
  assert.deepEqual(rows[9], ["4. expect testid=undo to be visible", "expect testid=undo to be visible", MISSING], "a step that never ran has no actual result");
});

test("a flow without traceability metadata still renders, with — for its test ID and requirements", () => {
  const html = buildTemplateReport(resultOf(), template({}), [], META);
  const body = html.split('<tbody id="test-2"')[1].split("</tbody>")[0];
  const first = rowsOf(`<section data-section="x">${body}</section>`, "x")[1];
  assert.deepEqual(first.slice(0, 2), [MISSING, MISSING]);
  assert.match(body, /<b>—<\/b> cancel an order/);
  const traced = html.split('<tbody id="test-1"')[1].split("</tbody>")[0];
  assert.match(traced, /<td rowspan="5" class="span">TC-01<\/td><td rowspan="5" class="span">REQ-012, REQ-013<\/td>/);
});

test("flows: id, requirements and a step's expected are accepted, and checked like every other field", () => {
  assert.equal(traced.id, "TC-01");
  assert.deepEqual(traced.requirements, ["REQ-012", "REQ-013"]);
  assert.equal(plain.id, undefined);
  const nav = { action: "navigate", target: "/" };
  const bad = (json: object) => {
    const r = parseFlow(JSON.stringify(json), "f.json");
    return r.ok ? "ok" : r.error;
  };
  assert.equal(bad({ id: "", steps: [nav] }), "f.json: id is the test's identifier");
  assert.equal(bad({ requirements: "REQ-1", steps: [nav] }), "f.json: requirements Invalid input: expected array, received string");
  assert.equal(bad({ steps: [{ ...nav, expected: " " }] }), "f.json: steps[0].expected is the result the step should bring about, in words");
  assert.equal(bad({ steps: [{ ...nav, expectd: "typo" }] }), 'f.json: steps[0] unknown field(s) "expectd"');
  assert.equal(bad({ steps: [nav], extra: 1 }), 'f.json: (the whole file) unknown field(s) "extra"');
});

test("the manifest lists the SHA-256 of every evidence file as it is on disk, and a missing one as not found", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "report-manifest-"));
  try {
    const result = resultOf();
    const files = evidenceFiles(result);
    assert.equal(files[0], "check.json");
    assert.equal(files[1], "replay.html");
    assert.equal(files.length, 2 + 8 + 1, "check.json, the replay page, eight frames and one video");
    const missing = "replay-frames/role-reviewer/0003-step.jpg";
    for (const [i, rel] of files.entries()) {
      if (rel === missing) continue;
      fs.mkdirSync(path.join(out, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(out, rel), `evidence ${i} ${rel}`);
    }
    const written = writeTemplateReport(out, result, template({ file: "evidence.html", sections: [{ type: "manifest" }] }), META);
    assert.equal(written, "evidence.html");
    const html = fs.readFileSync(path.join(out, written), "utf8");
    const listed = rowsOf(html, "manifest").filter((r) => r.length === 3 && r[0] !== "File");
    assert.deepEqual(
      listed.map((r) => r[0]),
      files,
    );
    for (const [file, bytes, sha] of listed) {
      if (file === missing) {
        assert.deepEqual([bytes, sha], ["not found", "not found"]);
        continue;
      }
      const data = fs.readFileSync(path.join(out, file));
      assert.equal(sha, createHash("sha256").update(data).digest("hex"), `${file}'s hash matches the file`);
      assert.equal(Number(bytes), data.length);
    }
    const facts = rowsOf(html, "manifest").filter((r) => r.length === 2);
    assert.deepEqual(facts, [
      ["SceneScout version", "9.9.9"],
      ["Target", "http://127.0.0.1:3000/"],
      ["Started", "2026-03-04 05:06:07 UTC"],
      ["Ended", "2026-03-04 05:08:09 UTC"],
    ]);
    assert.deepEqual(evidenceIndex(out, ["nope.jpg"]), [{ path: "nope.jpg", bytes: null, sha256: null }]);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("an invalid template is refused with the file, the field and what is wrong", () => {
  const err = (json: unknown) => {
    const r = parseReportTemplate(typeof json === "string" ? json : JSON.stringify(json), "t.json");
    return r.ok ? "ok" : r.error;
  };
  const sections = [{ type: "summary" }];
  assert.match(err("{ not json"), /^t\.json: not valid JSON/);
  assert.equal(err({ sections }), "t.json: title is required");
  assert.equal(err({ title: "R", sections: [] }), "t.json: sections needs at least one section");
  assert.equal(err({ title: "R", sections, colour: "red" }), 't.json: (the whole file) unknown field(s) "colour"');
  assert.equal(
    err({ title: "R", sections: [{ type: "appendix" }] }),
    "t.json: sections[0].type must be one of summary, tests, deviations, manifest, signoff, text",
  );
  assert.equal(
    err({ title: "R", sections: [{ type: "tests", columns: ["testId", "severity"] }] }),
    `t.json: sections[0].columns[1] must be one of testId, requirements, step, expected, actual, result, evidence, or { "key": one of those, "heading": "…" }`,
  );
  assert.equal(
    err({ title: "R", sections: [{ type: "tests", columns: ["step", { key: "step", heading: "S" }] }] }),
    "t.json: sections[0].columns names a column twice",
  );
  assert.equal(err({ title: "R", sections: [{ type: "tests", columns: [] }] }), "t.json: sections[0].columns needs at least one column");
  assert.equal(err({ title: "R", sections: [{ type: "summary", rows: 2 }] }), 't.json: sections[0] unknown field(s) "rows"');
  assert.equal(
    err({ title: "R", sections: [{ type: "summary" }, { type: "summary" }] }),
    't.json: sections[1].type "summary" appears more than once: each section but text appears at most once',
  );
  assert.equal(err({ title: "R", sections: [{ type: "signoff", roles: [] }] }), "t.json: sections[0].roles needs at least one role");
  assert.equal(
    err({ title: "R", sections: [{ type: "signoff", roles: [5] }] }),
    't.json: sections[0].roles[0] must be the role that signs, e.g. "Reviewer", or { "role": "…", "meaning": "…" }',
  );
  assert.equal(
    err({ title: "R", sections: [{ type: "signoff", roles: [{ role: "QA", sign: true }] }] }),
    't.json: sections[0].roles[0] unknown field(s) "sign"',
  );
  assert.equal(err({ title: "R", sections: [{ type: "text", paragraphs: [] }] }), "t.json: sections[0].paragraphs needs at least one paragraph");
  assert.equal(
    err({ title: "R", documentId: "TR-{build}", sections }),
    "t.json: documentId uses {build}, which is not a token: use {date}, {time}, {run}, {version}, {commit}",
  );
  assert.equal(
    err({ title: "R-{constructor}", sections }),
    "t.json: title uses {constructor}, which is not a token: use {date}, {time}, {run}, {version}, {commit}",
  );
  assert.equal(
    err({ title: "R", fields: [{ label: "x", value: "{toString}" }], sections }),
    "t.json: fields[0].value uses {toString}, which is not a token: use {date}, {time}, {run}, {version}, {commit}",
  );
  assert.equal(err({ title: "R", labels: { pass: "OK", passed: "OK" }, sections }), 't.json: labels unknown field(s) "passed"');
  assert.equal(err({ title: "R", file: "../escape.html", sections }), "t.json: file must be a plain file name ending .html, e.g. test-report.html");
  assert.equal(err({ title: "R", file: "replay.html", sections }), "t.json: file must not be replay.html, which the replay page is written to");
  assert.equal(
    err({ title: "R", file: "Replay.html", sections }),
    "t.json: file must not be replay.html, which the replay page is written to",
    "the same file on a case-insensitive disk",
  );
  for (const file of ["CON.html", "nul.html", "Com1.html", "LPT9.html"])
    assert.equal(err({ title: "R", file, sections }), "t.json: file must not be a name Windows reserves for a device, such as CON.html or NUL.html", file);
  for (const file of ["report.HTML", "a\\b.html", "C:x.html", ".hidden.html", "x.html."])
    assert.equal(err({ title: "R", file, sections }), "t.json: file must be a plain file name ending .html, e.g. test-report.html", file);
  assert.equal(err({ title: "R", file: "console.html", sections }), "ok", "only the device names themselves are reserved");
  assert.equal(err({ title: "R", sections }), "ok");
});

test("template text and app text are escaped everywhere they appear", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const t = template({
    title: `T ${evil}`,
    subtitle: evil,
    documentId: `D-${evil.replace(/[{}]/g, "")}`,
    fields: [{ label: evil, value: evil }],
    labels: { pass: evil, testId: evil, role: evil },
    sections: [
      { type: "text", heading: evil, paragraphs: [evil] },
      { type: "summary", heading: evil },
      { type: "tests", heading: evil, columns: ["testId", { key: "step", heading: evil }, "result"] },
      { type: "deviations", paragraphs: [evil] },
      { type: "signoff", roles: [evil, { role: evil, meaning: evil }] },
    ],
  });
  const app = flowOf(
    {
      name: `flow ${evil}`,
      id: evil,
      requirements: [evil],
      steps: [
        { action: "navigate", target: "/a" },
        { action: "expect-text", text: evil, expected: evil },
      ],
    },
    "x.json",
  );
  const replay: CheckReplay = {
    startedAt: "2026-03-04T05:06:07.000Z",
    roles: [{ role: evil, own: false, visits: [], journeys: [journeyOf(app, { status: "failed", step: 2, did: "x", reason: evil, path: "/a" })] }],
    framesLeftOut: 0,
  };
  const html = buildTemplateReport(resultOf(replay), t, [{ path: `replay-frames/${evil}`, bytes: 1, sha256: "a".repeat(64) }], META);
  assert.ok(!html.includes("<img src=x"), "no markup from the template or the app reaches the page as markup");
  assert.ok(!html.includes('onerror="'), "no attribute breaks out");
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
});

test("--template: parsed to an absolute path, refused empty and with --record off; it needs a recorded check", () => {
  const parsed = parseCheckArgs(["http://127.0.0.1:3000", "--record", "--template", "tpl/report.json"], "/work");
  assert.ok(parsed.ok);
  assert.equal(parsed.ok && parsed.options.template, "/work/tpl/report.json");
  assert.deepEqual(parseCheckArgs(["http://127.0.0.1:3000", "--template="], "/work"), {
    ok: false,
    error: "--template needs the path of a report template (JSON)",
  });
  assert.deepEqual(parseCheckArgs(["http://127.0.0.1:3000", "--record", "off", "--template", "t.json"], "/work"), {
    ok: false,
    error: "--template renders the report from a recorded check's frames, so it cannot be used with --record off",
  });
  assert.equal(templateRecordError({}), null);
  assert.equal(templateRecordError({ template: "/t.json", record: true }), null);
  assert.equal(
    templateRecordError({ template: "/t.json", record: false }),
    "--template renders the report from a recorded check's frames: add --record (or set SCENESCOUT_RECORD=on)",
  );
  assert.throws(() => prepareTemplateReport({ template: "/t.json", record: false }, "/out"), /add --record/);
});

test("--template: a bad template or a report the project keeps stops the check before it starts; an earlier run's report is cleared", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-prepare-"));
  try {
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    const tpl = path.join(dir, "t.json");
    fs.writeFileSync(tpl, JSON.stringify({ title: "R", sections: [{ type: "summary" }] }));
    assert.equal(prepareTemplateReport({ template: tpl, record: true }, out)?.title, "R");
    assert.equal(prepareTemplateReport({ record: true }, out), null);
    assert.throws(() => prepareTemplateReport({ template: path.join(dir, "missing.json"), record: true }, out), /--template: cannot read/);
    fs.writeFileSync(tpl, JSON.stringify({ title: "R", sections: [{ type: "summary" }], extra: true }));
    assert.throws(() => prepareTemplateReport({ template: tpl, record: true }, out), /--template: .*t\.json: \(the whole file\) unknown field\(s\) "extra"/);
    fs.writeFileSync(tpl, JSON.stringify({ title: "R", sections: [{ type: "summary" }] }));
    // The project's own report.html: never overwritten, never removed.
    fs.writeFileSync(path.join(out, "report.html"), "<!doctype html><title>Ours</title>");
    assert.throws(() => prepareTemplateReport({ template: tpl, record: true }, out), /is not a report SceneScout wrote, so a check will not overwrite it/);
    clearReplayOutput(out);
    assert.equal(fs.readFileSync(path.join(out, "report.html"), "utf8"), "<!doctype html><title>Ours</title>");
    // One a check wrote at the name this run's template names: replaced, and cleared before the check.
    const ours = buildTemplateReport(resultOf(), template({}), [], META);
    fs.writeFileSync(path.join(out, "report.html"), ours);
    assert.ok(prepareTemplateReport({ template: tpl, record: true }, out));
    clearReplayOutput(out, "report.html");
    assert.equal(fs.existsSync(path.join(out, "report.html")), false);
    // The one the earlier run's check.json records, under the name that run's template gave it: cleared too.
    fs.writeFileSync(path.join(out, "check.json"), JSON.stringify(toSummaryJson({ ...resultOf(), testReport: "earlier.html" }, "9.9.9")));
    fs.writeFileSync(path.join(out, "earlier.html"), ours);
    // A marked copy a reviewer renamed (or kept under any other name) is theirs: it survives every clean-up.
    fs.writeFileSync(path.join(out, "TR-20260101-signed.html"), ours);
    clearReplayOutput(out, "report.html");
    assert.deepEqual(fs.readdirSync(out).sort(), ["TR-20260101-signed.html", "check.json"]);
    clearReplayOutput(out);
    assert.ok(fs.existsSync(path.join(out, "TR-20260101-signed.html")), "a renamed report survives a check with no template");
    // A check.json naming anything but a plain report file beside it names nothing to remove.
    for (const bad of ["../escape.html", "replay.html", "REPLAY.html", "check.json", "/abs.html", "C:\\x.html", "sub/x.html", "CON.html", 5])
      assert.equal(recordedReportFile({ testReport: bad }), null, String(bad));
    assert.equal(recordedReportFile({ testReport: "earlier.html" }), "earlier.html");
    assert.equal(recordedReportFile(null), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("action: the template input is forwarded, the report is the one check.json records, while it carries the mark, and it is kept in the artifact", () => {
  assert.equal(REPORT_GENERATOR_META, `<meta name="generator" content="${REPORT_GENERATOR}">`);
  const files: Record<string, string> = {
    "test-report.html": `<html>${REPORT_GENERATOR_META}</html>`,
    "renamed.html": `<html>${REPORT_GENERATOR_META}</html>`,
    "replay.html": `<html>${REPORT_GENERATOR_META}</html>`,
    "ours.html": "<html></html>",
  };
  const read = (f: string) => {
    const text = files[path.basename(f)];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  };
  assert.equal(testReportOf({ testReport: "test-report.html" }, "/o", read), path.join("/o", "test-report.html"));
  assert.equal(testReportOf({ testReport: "ours.html" }, "/o", read), "", "a file without the mark is the project's own");
  assert.equal(testReportOf({ testReport: "gone.html" }, "/o", read), "");
  assert.equal(testReportOf({ testReport: "replay.html" }, "/o", read), "");
  assert.equal(testReportOf({ testReport: "../test-report.html" }, "/o", read), "", "never a path outside the folder");
  assert.equal(testReportOf({}, "/o", read), "", "no testReport, no report: a renamed marked copy is never taken");
  assert.equal(testReportOf(null, "/o", read), "");
  // The action reads the same names as the CLI's recordedReportFile: each name is taken by both or by neither.
  const marked = () => REPORT_GENERATOR_META;
  for (const name of [
    "test-report.html",
    "a..html",
    "replay.html",
    "Replay.html",
    "../x.html",
    "/abs.html",
    "C:\\x.html",
    "x\\y.html",
    "CON.html",
    "nul.html",
    "lpt1.html",
    "PRN.x.html",
    "x.HTML",
    ".x.html",
  ])
    assert.equal(testReportOf({ testReport: name }, "/o", marked) !== "", recordedReportFile({ testReport: name }) !== null, name);
  const action = parseYaml(fs.readFileSync(path.join(ROOT, "action.yml"), "utf8"));
  assert.ok(action.inputs.template, "the action has a template input");
  assert.match(action.outputs["test-report"].value, /steps\.run\.outputs\.test-report/);
  const upload = (action.runs.steps as Array<{ name: string; with?: { path?: string } }>).find((s) => s.name === "Keep the results")!;
  assert.match(upload.with!.path!, /steps\.run\.outputs\.test-report \}\}/);
});

// ── the team report ─────────────────────────────────────────────────────────

const TEAM_GOLDEN = path.join(ROOT, "scripts", "golden", "team-report.html");
const CHECK_START = "2026-10-16T09:00:00.000Z";

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    severity: "high",
    category: "false_success",
    title: "Saving an order says it worked when the server refused it",
    detail: "The page showed Order saved, and the server answered 422.",
    url: "https://staging.example.com/orders/new",
    state: "/orders/new#form",
    repro: ["navigate /orders/new @ https://staging.example.com/orders/new", 'click button "Save" @ https://staging.example.com/orders/new'],
    foundAt: "2026-10-16T09:10:00.000Z",
    runs: 1,
    ...over,
  };
}

/** A check with one of everything the report sorts: problems of each impact, one marked not a bug, a worth-a-look, an earlier one and a fixed one. */
function teamSource(over: Partial<TeamReportSource> = {}): TeamReportSource {
  return {
    findings: [
      finding("c3c3c3c3c3", {
        severity: "low",
        category: "visual",
        title: "The footer overlaps the last row",
        url: "https://staging.example.com/orders",
        state: "/orders#list",
        repro: [],
      }),
      finding("a1a1a1a1a1", {
        picture: "recordings/main/finding-a1a1a1a1a1.png",
        pictureShot: { width: 640, height: 400, frame: "element", label: "Save", at: "2026-10-16T09:10:00.000Z" },
        seenOn: ["/orders/edit"],
      } as Partial<Finding>),
      finding("b2b2b2b2b2", {
        severity: "medium",
        category: "a11y",
        title: "The date field has no label",
        detail: "A screen reader announces it as edit text.",
      }),
      finding("d4d4d4d4d4", {
        severity: "medium",
        title: "The banner flickers",
        feedback: { verdict: "not-a-bug", reason: "It is an animation", at: "2026-10-16T09:20:00.000Z" },
      } as Partial<Finding>),
      finding("e5e5e5e5e5", { severity: "low", tier: "worth_a_look", title: "A link has no test id" }),
      finding("f6f6f6f6f6", { title: "Found by an earlier check", foundAt: "2026-10-01T09:00:00.000Z" }),
      finding("0a0a0a0a0a", { title: "Fixed already", status: "resolved" }),
    ],
    sessionStart: CHECK_START,
    violations: [{ kind: "http_error" }, { kind: "http_error" }],
    routes: { visited: 7, total: 9 },
    gaps: ["2 known route(s) never visited: /admin, /reports", "single-role run (user) — permission boundaries and role capability gaps are untested"],
    mode: "observe",
    address: "https://staging.example.com",
    guided: { areas: ["forms", "broken-pages"], thoroughness: "normal" },
    version: "9.9.9",
    generatedAt: "2026-10-16T10:00:00.000Z",
    ...over,
  };
}

/** Fixed evidence, so the golden page depends on nothing on disk. */
const TEAM_EVIDENCE: TeamEvidenceEntry[] = [
  { file: "team-report/report.md", bytes: 2048, sha256: "1".repeat(64) },
  { file: "team-report/recordings/main/finding-a1a1a1a1a1.png", bytes: 5120, sha256: "2".repeat(64) },
];

test("team report: this check's problems worst first, not-a-bug apart, the rest counted, and the cover from the guided choices", () => {
  const data = teamReportData(teamSource());
  assert.deepEqual(
    data.cards.map((c) => c.id),
    ["a1a1a1a1a1", "b2b2b2b2b2", "c3c3c3c3c3"],
    "open defects this check found, worst first; no worth-a-look, earlier, fixed or not-a-bug one",
  );
  assert.deepEqual(
    data.notABug.map((c) => c.id),
    ["d4d4d4d4d4"],
    "a problem marked not a bug is listed apart, never dropped",
  );
  const summary = data.summary.join("\n");
  assert.match(summary, /^This run found 3 problems: 1 blocks users, 1 is annoying and 1 is cosmetic\. It went to 7 of the 9 pages/);
  assert.match(summary, /1 problem found by earlier runs was not checked again/);
  assert.match(summary, /1 observation is a problem only if your project follows a particular convention/);
  assert.match(summary, /The check left 2 things untested\./);
  assert.ok(!summary.includes("/admin"), "the not-checked list is its own section, not repeated in the summary");
  assert.equal(data.checked, "Forms, Broken pages and links");
  assert.equal(data.care, "Look only");
  assert.equal(data.thoroughness, "Normal");

  // Not a guided check: the cover says how much of the site it reached, and that nobody chose how thorough.
  const plain = teamReportData(teamSource({ guided: undefined, mode: "safe-write" }));
  assert.equal(plain.checked, "7 of the 9 pages it knew about");
  assert.equal(plain.thoroughness, TEAM_REPORT_WORDS.notGiven);
  assert.equal(plain.care, "May create test data");
  assert.equal(teamReportData(teamSource({ guided: undefined, routes: undefined })).checked, TEAM_REPORT_WORDS.everything);
  assert.deepEqual(MODE_CARE_LABEL, {
    observe: "Look only",
    "read-only": "May submit forms",
    "safe-write": "May create test data",
    destructive: "May delete data (a developer's choice)",
  });

  // Nothing found: the page says so, and still carries its not-checked list and sign-off.
  const empty = teamReportData(teamSource({ findings: [] }));
  const html = teamReportHtml(empty, []);
  assert.ok(html.includes(TEAM_REPORT_WORDS.noProblems) && html.includes(TEAM_REPORT_WORDS.noEvidence));
  assert.ok(html.includes("/admin, /reports") && html.includes(TEAM_REPORT_WORDS.signoff));
});

test("golden: the same check and evidence always render the same team report", () => {
  const html = teamReportHtml(teamReportData(teamSource()), TEAM_EVIDENCE);
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(TEAM_GOLDEN), { recursive: true });
    fs.writeFileSync(TEAM_GOLDEN, html);
  }
  assert.equal(html, readText(TEAM_GOLDEN), "the team report changed: if that was intended, run UPDATE_GOLDEN=1 npm run report-test and review the diff");
  // The parts the design asks for, in order: cover, summary, cards, not a bug, not checked, sign-off, evidence.
  const order = ["cover", "summary", "problems", "not-a-bug", "not-checked", "signoff", "evidence"].map((s) => html.indexOf(`data-section="${s}"`));
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    `sections out of order: ${order.join(",")}`,
  );
  assert.equal((html.match(/<tr class="signature">/g) ?? []).length, TEAM_REPORT_WORDS.signRoles.length, "a blank line for each who signs");
  assert.equal((html.match(/<td class="blank"><\/td>/g) ?? []).length, TEAM_REPORT_WORDS.signRoles.length * 3, "name, signature and date are left blank");
  assert.ok(html.includes('src="team-report/recordings/main/finding-a1a1a1a1a1.png"'), "the picture is the evidence folder's copy");
  assertSavedPagePolicy(html, "team report");
});

test("team report: every word the app supplied is escaped, and the page runs nothing", () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const data = teamReportData(
    teamSource({
      address: `https://staging.example.com/?q=${hostile}`,
      gaps: [`a route ${hostile} never visited`],
      findings: [
        finding("a1a1a1a1a1", {
          title: `Title ${hostile}`,
          detail: `Detail ${hostile}`,
          url: `https://staging.example.com/${hostile}`,
          evidence: `POST /api/${hostile} 500`,
          repro: [`click button "${hostile}" @ https://staging.example.com/x`],
          seenOn: [`/also/${hostile}`],
        }),
        finding("d4d4d4d4d4", { title: `Not a bug ${hostile}`, feedback: { verdict: "not-a-bug", reason: hostile, at: CHECK_START } } as Partial<Finding>),
      ],
    }),
  );
  const html = teamReportHtml(data, [{ file: `team-report/${hostile}`, bytes: null, sha256: null }]);
  assert.ok(!/<script>alert|<img src=x|onerror="/i.test(html), "no markup from the app survives as markup");
  assert.ok(html.includes("&lt;script&gt;alert(2)&lt;/script&gt;"), "it is shown as text");
  assertSavedPagePolicy(html, "hostile team report");
  assert.deepEqual(pagePolicy(html).get("script-src"), ["'none'"]);
  // In the Markdown, a pipe in the address cannot end the cover's cell early.
  const md = teamReportMarkdown(teamReportData(teamSource({ address: "https://a.example/|b" })), new Set());
  assert.ok(md.includes("| Site | https://a.example/\\|b |"), md.split("\n").slice(0, 6).join("\n"));
});

test("team report: a backslash in a cover cell is escaped, so a backslash then pipe stays one cell and the text round-trips", () => {
  const cells = (row: string): string[] => {
    const out: string[] = [];
    let cur = "";
    for (let i = 1; i < row.length; i++) {
      const ch = row[i];
      if (ch === "\\" && i + 1 < row.length) cur += row[++i];
      else if (ch === "|") (out.push(cur.trim()), (cur = ""));
      else cur += ch;
    }
    return out;
  };
  for (const address of ["https://a.example/a\\|b", "https://a.example/ends\\"]) {
    const md = teamReportMarkdown(teamReportData(teamSource({ address })), new Set());
    const row = md.split("\n").find((l) => l.startsWith("| Site |"));
    assert.ok(row, "the cover has a Site row");
    assert.deepEqual(cells(row), ["Site", address], row);
  }
});

/** Every file under `root`, with its bytes' hash, skipping `skip` (a folder name relative to root). */
function treeOf(root: string, skip: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (rel === skip) continue;
      if (e.isDirectory()) walk(full);
      else out.set(rel, e.isSymbolicLink() ? `link:${fs.readlinkSync(full)}` : createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

const sha = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("team report: written inside .scenescout/ only, with a manifest whose hashes are the files on disk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-report-"));
  try {
    const project = path.join(root, "project");
    const dir = path.join(project, ".scenescout");
    fs.mkdirSync(path.join(dir, "recordings", "main"), { recursive: true });
    fs.writeFileSync(path.join(project, "index.html"), "<p>the app</p>");
    fs.writeFileSync(path.join(dir, "recordings", "main", "finding-a1a1a1a1a1.png"), Buffer.from("picture bytes"));
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "not the project's");
    const before = treeOf(root, path.join("project", ".scenescout"));

    // One picture is there, one card names a picture that is not.
    const src = teamSource();
    src.findings = [...src.findings, finding("9b9b9b9b9b", { severity: "low", picture: "recordings/main/finding-9b9b9b9b9b.png" } as Partial<Finding>)];
    const report = writeTeamReport(dir, teamReportData(src));
    assert.deepEqual(treeOf(root, path.join("project", ".scenescout")), before, "nothing outside .scenescout/ was written or changed");
    assert.equal(report.file, ".scenescout/team-report.html");
    assert.equal(report.evidenceDir, ".scenescout/team-report");
    assert.equal(report.path, path.join(dir, TEAM_REPORT_FILE));
    assert.equal(report.problems, 4);
    assert.equal(report.pictures, 1);
    assert.equal(report.missingPictures, 1);
    assert.match(teamReportText(report), /1 picture was not found and is listed as not found/);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, TEAM_EVIDENCE_DIR, TEAM_MANIFEST_FILE), "utf8"));
    assert.equal(manifest.generator, TEAM_REPORT_GENERATOR);
    assert.equal(manifest.version, "9.9.9");
    assert.equal(manifest.startedAt, CHECK_START);
    assert.equal(manifest.generatedAt, "2026-10-16T10:00:00.000Z");
    assert.deepEqual(
      manifest.files.map((f: TeamEvidenceEntry) => f.file),
      [TEAM_REPORT_FILE, "team-report/report.md", "team-report/recordings/main/finding-a1a1a1a1a1.png", "team-report/recordings/main/finding-9b9b9b9b9b.png"],
    );
    for (const f of manifest.files as TeamEvidenceEntry[]) {
      if (f.sha256 === null) {
        assert.equal(f.file, "team-report/recordings/main/finding-9b9b9b9b9b.png", "only the missing picture has no hash");
        assert.ok(!fs.existsSync(path.join(dir, f.file)));
        continue;
      }
      assert.equal(sha(path.join(dir, ...f.file.split("/"))), f.sha256, `${f.file}'s hash is the file on disk`);
      assert.equal(fs.statSync(path.join(dir, ...f.file.split("/"))).size, f.bytes);
    }
    // The tool's own list: every file it wrote, the manifest included, relative to the project.
    assert.deepEqual(
      report.manifest.map((m) => m.file),
      [
        ".scenescout/team-report.html",
        ".scenescout/team-report/report.md",
        ".scenescout/team-report/recordings/main/finding-a1a1a1a1a1.png",
        ".scenescout/team-report/manifest.json",
      ],
    );
    for (const m of report.manifest) assert.equal(sha(path.join(project, ...m.file.split("/"))), m.sha256);
    // The page lists the evidence's hashes, and shows only the picture that is there.
    const html = fs.readFileSync(report.path, "utf8");
    assert.ok(html.includes(sha(path.join(dir, "team-report", "report.md"))));
    assert.ok(html.includes('src="team-report/recordings/main/finding-a1a1a1a1a1.png"'));
    assert.ok(!html.includes('src="team-report/recordings/main/finding-9b9b9b9b9b.png"') && html.includes(TEAM_REPORT_WORDS.pictureMissing));
    const md = fs.readFileSync(path.join(dir, "team-report", "report.md"), "utf8");
    assert.ok(md.includes("](recordings/main/finding-a1a1a1a1a1.png)"), "the Markdown links its picture beside it");

    // A second report removes the first's evidence it no longer shows, and leaves a file it never wrote.
    fs.writeFileSync(path.join(dir, "team-report", "notes.txt"), "the team's own notes");
    writeTeamReport(dir, teamReportData(teamSource({ findings: [] })));
    assert.ok(!fs.existsSync(path.join(dir, "team-report", "recordings", "main", "finding-a1a1a1a1a1.png")), "the old picture went with its report");
    assert.equal(fs.readFileSync(path.join(dir, "team-report", "notes.txt"), "utf8"), "the team's own notes");
    assert.ok(fs.existsSync(path.join(dir, "recordings", "main", "finding-a1a1a1a1a1.png")), "the original picture is untouched");
    assert.deepEqual(treeOf(root, path.join("project", ".scenescout")), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("team report: a folder that is not .scenescout/, a linked evidence folder and a linked picture never lead outside it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-report-"));
  try {
    const dir = path.join(root, "project", ".scenescout");
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(path.join(dir, "recordings", "main"), { recursive: true });
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "secret.txt"), "private");
    const data = teamReportData(teamSource());

    assert.throws(() => writeTeamReport(path.join(root, "project"), data), /only inside a project's \.scenescout folder/);
    assert.deepEqual(fs.readdirSync(path.join(root, "project")), [".scenescout"], "nothing was written in the project itself");

    // The evidence folder is a link out of .scenescout/: refused, and nothing lands where it points.
    fs.symlinkSync(elsewhere, path.join(dir, TEAM_EVIDENCE_DIR), "dir");
    assert.throws(() => writeTeamReport(dir, data), /is not a folder SceneScout made/);
    assert.deepEqual(fs.readdirSync(elsewhere), ["secret.txt"]);
    assert.ok(!fs.existsSync(path.join(dir, TEAM_REPORT_FILE)));
    fs.unlinkSync(path.join(dir, TEAM_EVIDENCE_DIR));

    // A folder inside the evidence that links out is refused before anything is written through it, a folder included.
    fs.writeFileSync(path.join(dir, "recordings", "main", "finding-a1a1a1a1a1.png"), "picture bytes");
    fs.mkdirSync(path.join(dir, TEAM_EVIDENCE_DIR));
    fs.symlinkSync(elsewhere, path.join(dir, TEAM_EVIDENCE_DIR, "recordings"), "dir");
    assert.throws(() => writeTeamReport(dir, data), /is a link or a file, not a folder SceneScout made/);
    assert.deepEqual(fs.readdirSync(elsewhere), ["secret.txt"], "no folder or picture was made through the link");
    fs.unlinkSync(path.join(dir, TEAM_EVIDENCE_DIR, "recordings"));

    // An earlier manifest naming a file behind a linked folder never removes the file the link leads to.
    fs.writeFileSync(path.join(elsewhere, "victim.txt"), "keep me");
    fs.symlinkSync(elsewhere, path.join(dir, TEAM_EVIDENCE_DIR, "sub"), "dir");
    fs.writeFileSync(
      path.join(dir, TEAM_EVIDENCE_DIR, TEAM_MANIFEST_FILE),
      JSON.stringify({ generator: TEAM_REPORT_GENERATOR, files: [{ file: "team-report/sub/victim.txt", bytes: 7, sha256: "0".repeat(64) }] }),
    );
    writeTeamReport(dir, teamReportData(teamSource({ findings: [] })));
    assert.equal(fs.readFileSync(path.join(elsewhere, "victim.txt"), "utf8"), "keep me", "nothing outside was removed");
    fs.unlinkSync(path.join(dir, TEAM_EVIDENCE_DIR, "sub"));
    fs.rmSync(path.join(elsewhere, "victim.txt"));

    // A picture that is a link to a file outside is not copied into the evidence.
    fs.rmSync(path.join(dir, "recordings", "main", "finding-a1a1a1a1a1.png"));
    fs.symlinkSync(path.join(elsewhere, "secret.txt"), path.join(dir, "recordings", "main", "finding-a1a1a1a1a1.png"));
    const report = writeTeamReport(dir, data);
    assert.equal(report.pictures, 0, "the linked picture is not evidence");
    assert.equal(report.missingPictures, 1);
    assert.deepEqual(fs.readdirSync(elsewhere), ["secret.txt"], "nothing was written outside");
    assert.ok(!fs.readFileSync(report.path, "utf8").includes("private"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("team report: an earlier manifest naming a path that climbs out, or an absolute one, removes nothing outside", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-report-"));
  try {
    const dir = path.join(root, "project", ".scenescout");
    fs.mkdirSync(path.join(dir, TEAM_EVIDENCE_DIR), { recursive: true });
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "keep me");
    fs.writeFileSync(path.join(dir, "keep.txt"), "keep me too");
    const named = [
      "team-report/../../../victim.txt",
      "team-report/../keep.txt",
      victim,
      "team-report/..\\..\\..\\victim.txt",
      "C:\\victim.txt",
      "../victim.txt",
    ];
    fs.writeFileSync(
      path.join(dir, TEAM_EVIDENCE_DIR, TEAM_MANIFEST_FILE),
      JSON.stringify({ generator: TEAM_REPORT_GENERATOR, files: named.map((file) => ({ file, bytes: 7, sha256: "0".repeat(64) })) }),
    );
    writeTeamReport(dir, teamReportData(teamSource({ findings: [] })));
    assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
    assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "keep me too");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("team report: only pictures are copied into the evidence, never another file a finding's picture path names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-report-"));
  try {
    const dir = path.join(root, "project", ".scenescout");
    fs.mkdirSync(path.join(dir, "auth"), { recursive: true });
    fs.writeFileSync(path.join(dir, "auth", "admin.json"), '{"cookies":[{"name":"session","value":"live"}]}');
    fs.writeFileSync(path.join(dir, "report.md"), "an older report");
    const data = teamReportData(
      teamSource({
        findings: [
          finding("a1a1a1a1a1", { picture: "auth/admin.json" } as Partial<Finding>),
          finding("b2b2b2b2b2", { picture: "report.md" } as Partial<Finding>),
          finding("c3c3c3c3c3", { picture: "manifest.json" } as Partial<Finding>),
        ],
      }),
    );
    const report = writeTeamReport(dir, data);
    assert.ok(!fs.existsSync(path.join(dir, TEAM_EVIDENCE_DIR, "auth")), "a saved sign-in is never copied into the folder made for sharing");
    const files = report.manifest.map((m) => m.file);
    assert.equal(new Set(files).size, files.length, `each file is listed once: ${files.join(", ")}`);
    // Every hash the manifest lists is the file on disk.
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, TEAM_EVIDENCE_DIR, TEAM_MANIFEST_FILE), "utf8")) as { files: TeamEvidenceEntry[] };
    for (const e of manifest.files)
      if (e.sha256 !== null)
        assert.equal(
          createHash("sha256")
            .update(fs.readFileSync(path.join(dir, e.file)))
            .digest("hex"),
          e.sha256,
          e.file,
        );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("team report: the site's address is shown without a user name, password or token in it", () => {
  const address = "https://bob:hunter2@staging.example.com/app?access_token=abcdef123456&tab=1";
  const data = teamReportData(teamSource({ address }));
  const html = teamReportHtml(data, TEAM_EVIDENCE);
  const md = teamReportMarkdown(data, new Set());
  for (const out of [html, md, data.address]) {
    assert.ok(!out.includes("hunter2"), "no password");
    assert.ok(!out.includes("bob:"), "no user name");
    assert.ok(!out.includes("abcdef123456"), "no token");
  }
  assert.ok(data.address.startsWith("https://staging.example.com/app?"), data.address);
  assert.ok(data.address.includes("tab=1"), "the rest of the address is kept");
  assert.equal(teamReportData(teamSource({ address: "https://staging.example.com" })).address, "https://staging.example.com", "a plain address is unchanged");
});

test("team report: the sign-off table fits a phone's width", () => {
  const html = teamReportHtml(teamReportData(teamSource()), TEAM_EVIDENCE);
  // Three blank columns at 9em each are wider than a phone: the page scrolled sideways and the role was broken a letter per line.
  assert.match(html, /@media \(max-width: ?600px\) \{[^}]*table\.sign td\.blank \{ ?min-width: ?0/);
  assert.match(html, /table\.sign td:first-child \{ ?white-space: ?nowrap/);
});

// ---- The end-of-check card (design 2.9): src/engine/recap.ts ----

const RECAP_GOLDEN = path.join(ROOT, "scripts", "golden", "recap.svg");
const RECAP: RecapFigures = {
  address: "https://staging.example.com/shop",
  pagesChecked: 14,
  problems: { blocksUsers: 2, annoying: 3, cosmetic: 1, worthALook: 4 },
  fixed: 2,
  durationMs: 17 * 60_000 + 5_000,
  endedAt: "2026-10-17T10:20:00.000Z",
  ended: "done",
};

test("recap: the same figures always draw the same SVG, held to scripts/golden/recap.svg", () => {
  const svg = recapSvg(RECAP);
  assert.equal(recapSvg(RECAP), svg, "two renders are identical");
  if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(RECAP_GOLDEN, svg);
  assert.equal(svg, readText(RECAP_GOLDEN), "the recap matches scripts/golden/recap.svg (UPDATE_GOLDEN=1 rewrites it after an intended change)");
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  // No script, no link out, no outside resource: a picture the person can forward.
  assert.doesNotMatch(svg, /<script|href=|xlink|<foreignObject|url\(|on[a-z]+=/i);
  // Every figure is drawn: pages, the problems by impact and their total (worth a look is not a problem), fixed, time and date.
  const lines = recapLines(RECAP);
  assert.deepEqual(lines.rows, [
    ["Pages checked", "14"],
    ["Problems found", "6"],
    ["Block users", "2"],
    ["Annoying", "3"],
    ["Cosmetic", "1"],
    ["Worth a look", "4"],
    ["Confirmed fixed", "2"],
    ["Time taken", "17 min"],
  ]);
  for (const [label, value] of lines.rows) assert.ok(svg.includes(`>${label}<`) && svg.includes(`>${value}<`), label);
  assert.ok(svg.includes(">2026-10-17<"));
  assert.match(recapSvg({ ...RECAP, ended: "stopped" }), />SceneScout check, stopped early</);
});

test("recap: the address and every figure are escaped, a figure that is not a count draws 0, and a long address is cut", () => {
  const hostile = recapSvg({
    ...RECAP,
    address: `https://x.example/<script>alert("1")</script>&'\u001b[31m`,
    pagesChecked: Number.NaN,
    problems: { blocksUsers: -3, annoying: 1.7, cosmetic: Infinity, worthALook: "9" as unknown as number },
    fixed: Number.POSITIVE_INFINITY,
    durationMs: -1,
    endedAt: "<b>yesterday</b>",
  });
  assert.doesNotMatch(hostile, /<script|<b>|\u001b/);
  assert.ok(hostile.includes("&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt;&amp;&#39;"));
  assert.ok(!hostile.includes("yesterday"), "a date that is not one is left out");
  const rows = recapLines({ ...RECAP, pagesChecked: Number.NaN, problems: { blocksUsers: -3, annoying: 1.7, cosmetic: Infinity, worthALook: 0 } }).rows;
  assert.deepEqual(rows.slice(0, 5), [
    ["Pages checked", "0"],
    ["Problems found", "1"],
    ["Block users", "0"],
    ["Annoying", "1"],
    ["Cosmetic", "0"],
  ]);
  const long = recapLines({ ...RECAP, address: `https://staging.example.com/${"a".repeat(200)}` }).address;
  assert.equal(long.length, RECAP_ADDRESS_MAX);
  assert.ok(long.endsWith("…"));
  assert.deepEqual(
    [recapDuration(0), recapDuration(59_000), recapDuration(60_000), recapDuration(65 * 60_000)],
    ["under a minute", "under a minute", "1 min", "1 h 5 min"],
  );
});

test("recap: the figures are a guided check's own once it has ended, and confirmed fixed counts only re-checks during it", () => {
  const progress = {
    phase: "done" as const,
    pages: { checked: 9, found: 12 },
    problems: { blocksUsers: 1, annoying: 0, cosmetic: 2, worthALook: 0 },
    time: { usedMs: 600_000, budgetMs: 1_200_000 },
  };
  const started = Date.parse("2026-10-17T10:00:00.000Z");
  const findings = [
    { verdict: "gone" as const, verifiedAt: "2026-10-17T10:05:00.000Z" },
    { verdict: "gone" as const, verifiedAt: "2026-10-16T10:05:00.000Z" },
    // Re-checked gone after the check ended: not this check's.
    { verdict: "gone" as const, verifiedAt: "2026-10-17T11:00:00.000Z" },
    { verdict: "present" as const, verifiedAt: "2026-10-17T10:06:00.000Z" },
    {},
  ];
  const f = recapFigures(progress, "https://staging.example.com", findings, started, started + 600_000);
  assert.deepEqual(f, {
    address: "https://staging.example.com",
    pagesChecked: 9,
    problems: progress.problems,
    fixed: 1,
    durationMs: 600_000,
    endedAt: "2026-10-17T10:10:00.000Z",
    ended: "done",
  });
  assert.equal(recapFigures({ ...progress, phase: "stopped" }, "x", [], started, started)?.ended, "stopped");
  for (const phase of ["starting", "signing-in", "exploring", "needs-you", "writing-report"] as const)
    assert.equal(recapFigures({ ...progress, phase }, "x", [], started, started), null, `${phase}: not ended`);
});

test("recap: an address an XML reader would refuse, or one cut inside a character, still draws a picture that parses", () => {
  // U+FFFE and U+FFFF pass the address check but are not XML characters: the whole SVG would fail to open.
  assert.equal(recapAddress("https://x.example/\uFFFEa\uFFFF"), "https://x.example/ a");
  // A cut at RECAP_ADDRESS_MAX never leaves half of a character drawn outside the basic plane.
  const cut = recapAddress(`https://x.example/${"a".repeat(RECAP_ADDRESS_MAX - 19)}\u{1F600}${"b".repeat(40)}`);
  assert.doesNotMatch(cut, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no lone surrogate");
  assert.ok(cut.endsWith("…"));
  // The same address in the attribute and the text: a quote or angle bracket never closes either.
  const svg = recapSvg({ ...RECAP, address: `https://x.example/"><script>alert(1)</script><a href="javascript:alert(1)">` });
  // Every tag is one the recap draws, and every attribute value is closed by its own quote: nothing the address carried became markup.
  const tags = svg.match(/<[^>]*>/g) ?? [];
  for (const tag of tags) assert.match(tag, /^<\/?(svg|rect|text)(\s+[A-Za-z-]+="[^"<>]*")*\s*\/?>$/, tag);
  assert.equal(svg.replace(/<[^>]*>/g, "").includes("<"), false);
  assert.match(svg, /aria-label="SceneScout check: https:\/\/x\.example\/&quot;&gt;&lt;script&gt;/);
});

test("recap: a save writes recap.svg inside .scenescout only, replacing a link at the name rather than writing through it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-recap-"));
  try {
    const project = path.join(root, "site");
    const dir = path.join(project, ".scenescout");
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "keep me");
    fs.symlinkSync(outside, path.join(dir, RECAP_FILE));
    const svg = recapSvg(RECAP);
    assert.equal(writeRecap(dir, svg), path.join(dir, RECAP_FILE));
    assert.equal(fs.readFileSync(outside, "utf8"), "keep me", "the file the link pointed at is untouched");
    assert.ok(fs.lstatSync(path.join(dir, RECAP_FILE)).isFile(), "the link was replaced by the picture");
    assert.equal(fs.readFileSync(path.join(dir, RECAP_FILE), "utf8"), svg);
    // A .scenescout that is itself a link to another folder is refused, writing nothing there.
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    const linked = path.join(root, "linked");
    fs.mkdirSync(linked);
    fs.symlinkSync(elsewhere, path.join(linked, ".scenescout"));
    assert.throws(() => writeRecap(path.join(linked, ".scenescout"), svg), /link/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    // Only a project's .scenescout folder; one not there yet is made.
    assert.throws(() => writeRecap(project, svg), /\.scenescout/);
    const fresh = path.join(root, "fresh", ".scenescout");
    fs.mkdirSync(path.dirname(fresh));
    assert.equal(writeRecap(fresh, svg), path.join(fresh, RECAP_FILE));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
