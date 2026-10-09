/**
 * Unit tests for the template-driven test report of a recorded check
 * (`scenescout check --record --template <file.json>`): the template's schema
 * and its errors, the flow metadata it reads (id, requirements, expected), the
 * deterministic page (a golden file), deviations, the evidence manifest and
 * escaping. The browser half is in scripts/smoke/check.ts.
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
        title: "Saved flow broke",
        routes: ["/orders"],
        evidence: 'flow "cancel an order" (02-cancel.json) step 3 of 4',
      } as CheckResult["issues"][number],
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
  assert.equal(bad({ requirements: "REQ-1", steps: [nav] }), "f.json: requirements Expected array, received string");
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
