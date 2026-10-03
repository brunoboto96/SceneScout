/**
 * Unit tests for `scenescout check`'s rules: how a route's measurements become
 * issues, what fails the gate, the arguments it accepts and the SARIF it
 * writes. The browser half is in scripts/smoke/check.ts, against the demo app.
 *
 *   npx tsx --test --test-name-pattern "gate" scripts/check-test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  ACTION_ONLY_INPUTS,
  browsersPath,
  checkArgs,
  defaultArtifactName,
  engineOf,
  explainError,
  hasCheckCommand,
  noCheckCommand,
  installTarget,
  isVersionSpec,
  npmCommand,
  outDirFor,
  picturesDir,
  SUMMARY_OUTPUT_NAMES,
  summaryOutputs,
  verdict,
} from "../action/check-action.mjs";
import { brokenImageIssues, geometryIssues } from "../src/engine/collector.ts";
import { analyzeDesign, type DesignPayload, type StyleRecord } from "../src/engine/design.ts";
import { isFileMediaType, isNonPageResource, mediaTypeOf } from "../src/engine/crawl.ts";
import { httpErrorDetail } from "../src/engine/oracles.ts";
import {
  loadFlows,
  matchRequest,
  parseFlow,
  parseTarget,
  requestPathMatches,
  resolveFlowsDir,
  splitRefusals,
  statusMatches,
  urlMatches,
  type FlowRun,
} from "../src/engine/flow.ts";
import { writeSelfIgnore, type Finding } from "../src/engine/memory.ts";
import {
  BASELINE_CAPTURE,
  baselineEvidence,
  baselineFiles,
  baselineFingerprint,
  baselineMeta,
  captureDifferences,
  defaultBaselinesDir,
  elementFile,
  elementTarget,
  isChange,
  isVisualPicture,
  judgeBaseline,
  MAX_BASELINE_TARGETS,
  missingTargetsMessage,
  parseBaselineMeta,
  parseBaselineTargets,
  parseThreshold,
  readStoredBaseline,
  routeFolder,
  NEXT_FRAME_SCRIPT,
  STOP_ANIMATIONS_SCRIPT,
  steadyPicture,
  unsteadyNote,
  VISUAL_DIRNAME,
  visualFiles,
  type BaselineMeta,
  type BaselineResult,
  type BaselineRun,
  type BaselineTarget,
  type CaptureSettings,
} from "../src/engine/baseline.ts";
import { cutByViewport } from "../src/engine/capture.ts";
import { encodePng, type RgbaImage } from "../src/engine/png.ts";
import {
  echoesListedRequest,
  firstLook,
  firstRunSummary,
  formatFirstRun,
  GUIDE_URL,
  modeSentence,
  pagesAffected,
  resourceOf,
  sameAddress,
  shellArg,
  stopReason,
  unreachableReason,
  writtenByFirstLook,
  type FirstRunFacts,
} from "../src/first-run.ts";
import { checkRetestPlan, retestResults, wellFormedFindings, type MeasuredPage } from "../src/engine/verify.ts";
import { resolveSarifAnchor, sarifFilesFor, workflowFileOf } from "../src/engine/sarif.ts";
import {
  CHECK_OPTION_NAMES,
  CHECK_RULES,
  checkFindings,
  DEFAULT_SETTINGS,
  FAIL_ON,
  WORTH_A_LOOK_RULES,
  type GateRetests,
  describeSettings,
  exitCodeOf,
  retestGateFailures,
  formatCheck,
  gateFailures,
  geometryRule,
  issuesFromRoutes,
  needsSignInText,
  parseCheckArgs,
  redactBaselineRun,
  redactFlowRuns,
  redactRoutes,
  refusedFlowReason,
  withoutOwnResponse,
  summarise,
  SHARED_CHROME_ROUTE,
  splitResources,
  toSarif,
  toSummaryJson,
  unmeasuredReason,
  type CheckIssue,
  type CheckResult,
  type RouteHealth,
} from "../src/engine/check.ts";

const ORIGIN = "http://127.0.0.1:4173";

/** A healthy route; override only what a case is about. */
function route(over: Partial<RouteHealth> = {}): RouteHealth {
  return {
    path: "/",
    url: `${ORIGIN}/`,
    status: 200,
    loginRedirect: false,
    elements: 10,
    unnamed: [],
    placeholderOnly: [],
    violations: [],
    geometry: [],
    brokenImages: [],
    design: [],
    ...over,
  };
}

function issue(severity: CheckIssue["severity"], rule: CheckIssue["rule"] = "page-error"): CheckIssue {
  return { rule, severity, evidence: "x", routes: ["/"], fingerprint: "f" };
}

test("a healthy route produces no issues", () => {
  assert.deepEqual(issuesFromRoutes([route()], ORIGIN), []);
});

/** A control as the geometry oracle takes it; override what a case is about. */
function box(ref: string, name: string, over: Partial<Parameters<typeof geometryIssues>[0][number]> = {}): Parameters<typeof geometryIssues>[0][number] {
  return { ref, name, role: "button", xpath: `/html/body/${ref}`, rect: { x: 100, y: 100, w: 80, h: 30 }, ...over };
}

test("every line the real geometry oracle writes maps to its rule, and its '…and N more' tails to none", () => {
  const vp = { width: 1280, height: 900 };
  const lines = [
    ...geometryIssues([box("e1", "Save", { coveredBy: "[bar]" })], vp),
    ...geometryIssues([box("e2", "Help", { clipped: true })], vp),
    ...geometryIssues([box("e3", "Menu", { rect: { x: -400, y: 0, w: 40, h: 40 } })], vp),
    ...geometryIssues([box("e4", "All orders"), box("e5", "New")], vp),
    ...geometryIssues(
      ["a", "b", "c", "d", "e"].map((n, i) => box(`e${10 + i}`, n, { clipped: true, xpath: `/x${i}`, rect: { x: i * 100, y: 0, w: 50, h: 20 } })),
      vp,
    ),
    ...geometryIssues(
      ["a", "b", "c"].map((n, i) => box(`e${20 + i}`, n, { scrolledOutIn: `[wrap-${i}]`, xpath: `/y${i}`, rect: { x: i * 100, y: 300, w: 50, h: 20 } })),
      vp,
    ),
  ];
  const rules = lines.map((l) => geometryRule(l));
  assert.deepEqual(
    rules,
    [
      "covered-control",
      "clipped-control",
      "offpage-control",
      "overlapping-controls",
      "clipped-control",
      "clipped-control",
      "clipped-control",
      null,
      "scrolled-out-controls",
      "scrolled-out-controls",
      null,
    ],
    lines.join("\n"),
  );
});

/** A design payload of ordinary style records, each overridden by one entry of `over`. */
function designPayload(over: object[]): DesignPayload {
  const base: StyleRecord = {
    tag: "div",
    testid: null,
    text: "text",
    textLen: 4,
    interactive: false,
    rect: { x: 0, y: 0, w: 200, h: 40 },
    fontSize: 16,
    fontWeight: 400,
    fontFamily: "Inter",
    lineHeight: 24,
    textTransform: "none",
    textAlign: "left",
    underline: false,
    color: "rgb(0, 0, 0)",
    bg: "rgb(255, 255, 255)",
    padding: [8, 8, 8, 8],
    marginV: [0, 0],
    radius: 4,
    shadow: "",
    clipped: false,
    fixed: false,
    required: false,
    submitish: false,
    sideStripe: false,
    gradientText: false,
    glass: false,
    glow: false,
    aiGradient: false,
    inputType: "",
    role: "",
    filled: false,
    inForm: false,
    inRow: false,
    inSearch: false,
    inBreadcrumb: false,
    shell: false,
  };
  return {
    records: over.map((o) => ({ ...base, ...o })),
    page: { scrollW: 1280, clientW: 1280, headings: [{ level: 1, size: 30, text: "Page" }], images: [], density: 10, focusSamples: [] },
  };
}

test("intended layering is no issue in the check, while the same layout without it still is", () => {
  const vp = { width: 1280, height: 900 };
  const rulesOf = (geometry: string[], design: RouteHealth["design"] = []) => issuesFromRoutes([route({ geometry, design })], ORIGIN).map((i) => i.rule);
  // A skip link parked above the page, against a button parked at the same spot.
  const parked = { x: 8, y: -72, w: 138, h: 40 };
  assert.deepEqual(rulesOf(geometryIssues([box("e1", "Skip to content", { role: "link", href: "#main", focusable: true, rect: parked })], vp)), []);
  assert.deepEqual(rulesOf(geometryIssues([box("e1", "Export", { focusable: true, rect: parked })], vp)), ["offpage-control"]);
  // A clear button inside a search field's padding, against one with no padding reserved for it.
  const field = (r: number) => box("e1", "Search", { role: "textbox", rect: { x: 100, y: 100, w: 300, h: 36 }, fieldPad: { l: 8, r } });
  const clear = box("e2", "Clear", { rect: { x: 368, y: 106, w: 24, h: 24 } });
  assert.deepEqual(rulesOf(geometryIssues([field(36), clear], vp)), []);
  assert.deepEqual(rulesOf(geometryIssues([field(8), clear], vp)), ["overlapping-controls"]);
  // A small target alone in its row, against two side by side.
  const icon = (testid: string, x: number) => ({ tag: "button", testid, text: "", textLen: 0, interactive: true, rect: { x, y: 16, w: 16, h: 16 } });
  const designOf = (records: object[]) => analyzeDesign(designPayload(records), vp).defects;
  assert.deepEqual(rulesOf([], designOf([icon("select", 0)])), []);
  assert.deepEqual(rulesOf([], designOf([icon("select", 0), icon("remove", 20)])), ["tiny-target", "tiny-target"]);
});

test("every OVERLAY line the probe can write is classified: the certain ones block, the placement ones do not", () => {
  // The probe's messages live in a script that runs in the page; read them from its source.
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "probes.ts"), "utf8");
  const openings = [...source.matchAll(/issues\.push\("(OVERLAY: [^"]*)"/g)].map((m) => m[1]);
  assert.equal(openings.length, 5, openings.join("\n"));
  const blocking = openings.filter((o) => geometryRule(o) === "blocking-overlay");
  const placement = openings.filter((o) => geometryRule(o) === "dialog-layout");
  assert.equal(blocking.length + placement.length, openings.length, openings.join("\n"));
  assert.deepEqual(
    blocking.map((o) => /DISABLED|backdrop|open dialog/.exec(o)?.[0] ?? o),
    ["DISABLED", "backdrop", "open dialog"],
  );
  assert.equal(placement.length, 2, placement.join("\n"));
  // The probe builds the dialog lines from pieces; the classifier sees the whole line.
  assert.equal(geometryRule('OVERLAY: open dialog "Edit" appears EMPTY (0 chars, 0 controls) over a grayed-out page'), "blocking-overlay");
  assert.equal(
    geometryRule('OVERLAY: dialog "Edit" is far off-centre — 300px empty band above it while the page is grayed out (broken centering)'),
    "dialog-layout",
  );
});

test("controls scrolled out of view sideways are worth a look, never an issue the gate counts", () => {
  const [line] = geometryIssues([box("e7", "Edit", { scrolledOutIn: "[orders-wrap]" })], { width: 1280, height: 900 });
  const { issues, worthALook } = checkFindings([route({ geometry: [line] })], ORIGIN);
  assert.deepEqual(issues, []);
  assert.deepEqual(
    worthALook.map((o) => [o.rule, o.evidence]),
    [["scrolled-out-controls", line]],
  );
});

test("a layout line no rule knows is kept as a low layout-issue, not dropped", () => {
  const [one] = issuesFromRoutes([route({ geometry: ["e9 something new the oracle learned to say"] })], ORIGIN);
  assert.equal(one.rule, "layout-issue");
  assert.equal(one.severity, "low");
});

test("the broken-image oracle's own tail line is not an issue of its own", () => {
  const scan = { images: Array.from({ length: 6 }, (_, i) => ({ alt: `img ${i}`, src: `${ORIGIN}/i${i}.png`, testid: null })), total: 7 };
  const lines = brokenImageIssues(scan, ORIGIN);
  assert.ok(
    lines.some((l) => /more images/.test(l)),
    lines.join("\n"),
  );
  const issues = issuesFromRoutes([route({ brokenImages: lines })], ORIGIN);
  assert.equal(issues.length, 5);
  assert.ok(issues.every((i) => i.rule === "broken-image" && /FAILED TO LOAD/.test(i.evidence)));
});

test("the same fact on two routes is one issue listing both, even when the snapshot refs differ", () => {
  const issues = issuesFromRoutes(
    [
      route({ path: "/a", geometry: ['e3 "All orders" overlaps e4 "New" (84%)'] }),
      route({ path: "/b", geometry: ['e17 "All orders" overlaps e18 "New" (84%)'] }),
    ],
    ORIGIN,
  );
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].routes, ["/a", "/b"]);
  assert.equal(issues[0].evidence, '"All orders" overlaps "New" (84%)');
});

test("the app's origin is taken out of evidence, so a preview URL does not make every issue new", () => {
  const onLaptop = issuesFromRoutes(
    [route({ violations: [{ kind: "http_error", severity: "medium", detail: httpErrorDetail("GET", `${ORIGIN}/img/a.png`, 404), url: ORIGIN }] })],
    ORIGIN,
  );
  const preview = "https://pr-12.preview.example.com";
  const onPreview = issuesFromRoutes(
    [route({ violations: [{ kind: "http_error", severity: "medium", detail: httpErrorDetail("GET", `${preview}/img/a.png`, 404), url: preview }] })],
    preview,
  );
  assert.equal(onLaptop[0].evidence, "GET /img/a.png → HTTP 404");
  assert.equal(onLaptop[0].fingerprint, onPreview[0].fingerprint);
});

test("request failures: a 5xx is a high server error, a 4xx a medium client error", () => {
  const issues = issuesFromRoutes(
    [
      route({
        violations: [
          { kind: "http_error", severity: "high", detail: httpErrorDetail("GET", "/api/a", 500), url: ORIGIN },
          { kind: "http_error", severity: "medium", detail: httpErrorDetail("GET", "/api/b", 404), url: ORIGIN },
          { kind: "http_error", severity: "high", detail: httpErrorDetail("GET", "/api/c?token=Q7x9Rt2mLp4VzK8w", 502), url: ORIGIN },
        ],
      }),
    ],
    ORIGIN,
  );
  assert.deepEqual(
    issues.map((i) => [i.rule, i.severity]),
    [
      ["server-error", "high"],
      ["server-error", "high"],
      ["client-error", "medium"],
    ],
  );
});

test("a token posted to any origin is its own high rule and fails the default gate", () => {
  const detail = 'jwt token at data.access_token ("eyJh…" 212 chars) posted with targetOrigin "*" to the window of /signin';
  const issues = issuesFromRoutes([route({ violations: [{ kind: "postmessage_token", severity: "high", detail, url: ORIGIN }] })], ORIGIN);
  assert.deepEqual(
    issues.map((i) => [i.rule, i.severity]),
    [["postmessage-token", "high"]],
  );
  assert.deepEqual(
    gateFailures(issues, "high").map((i) => i.rule),
    ["postmessage-token"],
  );
});

test("a console error does not fail the default gate; the page error beside it does", () => {
  const issues = issuesFromRoutes(
    [
      route({
        violations: [
          { kind: "console_error", severity: "high", detail: "Failed to load resource", url: ORIGIN },
          { kind: "page_error", severity: "high", detail: "x is undefined", url: ORIGIN },
        ],
      }),
    ],
    ORIGIN,
  );
  assert.deepEqual(
    gateFailures(issues, "high").map((i) => i.rule),
    ["page-error"],
  );
});

test("an embed's failure is capped at medium, however bad it looks", () => {
  const [one] = issuesFromRoutes(
    [
      route({
        violations: [
          { kind: "http_error", severity: "high", detail: "POST https://pay.example.com/x → HTTP 500", url: ORIGIN, embed: "https://pay.example.com" },
        ],
      }),
    ],
    ORIGIN,
  );
  assert.equal(one.severity, "medium");
  assert.equal(one.embed, "https://pay.example.com");
});

test("a page that failed to load is only that: not also a dead end", () => {
  const issues = issuesFromRoutes([route({ status: null, loadError: "Timeout 15000ms exceeded", elements: 0 })], ORIGIN);
  assert.deepEqual(
    issues.map((i) => i.rule),
    ["route-load-failed"],
  );
});

test("an error page and a sign-in bounce are not dead ends; an empty 200 is", () => {
  const rules = (r: RouteHealth): string[] => issuesFromRoutes([r], ORIGIN).map((i) => i.rule);
  assert.deepEqual(rules(route({ status: 404, elements: 0 })), ["route-client-error"]);
  assert.deepEqual(rules(route({ status: 503, elements: 0 })), ["route-server-error"]);
  assert.deepEqual(rules(route({ loginRedirect: true, url: `${ORIGIN}/login`, elements: 0 })), ["auth-redirect"]);
  assert.deepEqual(rules(route({ elements: 0 })), ["dead-end"]);
});

test("whether a route answered as a page is decided by its content type, not its path", () => {
  const cases: Array<[number | null, string | undefined, boolean, string]> = [
    [200, "application/rss+xml", true, "an RSS feed"],
    [200, "application/atom+xml", true, "an Atom feed"],
    [200, "application/xml", true, "a sitemap"],
    [200, "text/xml", true, "XML served as text"],
    [200, "application/json", true, "JSON"],
    [200, "text/plain", true, "robots.txt or a licence file"],
    [200, "application/pdf", true, "a PDF"],
    [200, "image/png", true, "an image"],
    [304, "application/rss+xml", true, "a feed the cache confirmed"],
    [200, "text/html", false, "a page"],
    [200, "application/xhtml+xml", false, "an XHTML page"],
    [404, "text/plain", false, "a plain-text 404: the error is the route's, not a file"],
    [500, "application/rss+xml", false, "a feed that failed"],
    [null, "application/rss+xml", false, "nothing answered"],
    [200, undefined, false, "no content type: read as a page, as before"],
  ];
  for (const [status, contentType, expected, what] of cases) assert.equal(isNonPageResource({ status, contentType }), expected, what);
  // Whatever the status, a file's content type says the route answered: a browser that downloads a missing feed has still been told 404.
  assert.equal(isFileMediaType("application/rss+xml"), true);
  assert.equal(isFileMediaType("text/html; charset=utf-8"), false);
  assert.equal(isFileMediaType(undefined), false);
  assert.equal(mediaTypeOf("Text/HTML; charset=utf-8"), "text/html");
  assert.equal(mediaTypeOf("  "), undefined);
  assert.equal(mediaTypeOf(undefined), undefined);
});

test("a feed or a text file with no controls is not a dead end; the same route served as HTML is", () => {
  const rules = (r: RouteHealth): string[] => issuesFromRoutes([r], ORIGIN).map((i) => i.rule);
  const feed = { path: "/feed", elements: 0 };
  assert.deepEqual(rules(route({ ...feed, contentType: "application/rss+xml" })), []);
  assert.deepEqual(rules(route({ ...feed, contentType: "text/plain" })), []);
  assert.deepEqual(rules(route({ ...feed, contentType: "application/xml" })), []);
  assert.deepEqual(rules(route({ ...feed, contentType: "text/html" })), ["dead-end"]);
  assert.deepEqual(rules(route({ ...feed, contentType: "application/xhtml+xml" })), ["dead-end"]);
  // A feed that fails is still reported, as the route's own error.
  assert.deepEqual(rules(route({ ...feed, status: 404, contentType: "application/rss+xml" })), ["route-client-error"]);
  assert.deepEqual(rules(route({ ...feed, status: 502, contentType: "text/plain" })), ["route-server-error"]);
});

test("routes that are not pages are listed apart, and do not count as routes checked", () => {
  const page = route({ path: "/" });
  const feed = route({ path: "/feed", elements: 0, contentType: "application/rss+xml" });
  const failing = route({ path: "/broken-feed", status: 500, elements: 0, contentType: "application/rss+xml" });
  const { pages, resources } = splitResources([page, feed, failing]);
  assert.deepEqual(
    pages.map((r) => r.path),
    ["/", "/broken-feed"],
  );
  assert.deepEqual(resources, [{ path: "/feed", status: 200, contentType: "application/rss+xml" }]);
  const r: CheckResult = { ...result([]), routes: pages, resources };
  const report = formatCheck(r);
  assert.match(report, /· 2 route\(s\) ·/);
  assert.match(report, /## Not pages[\s\S]*\| \/feed \| 200 \| application\/rss\+xml \|/);
  assert.doesNotMatch(report.split("## Not pages")[0], /\| \/feed \|/);
  assert.doesNotMatch(formatCheck(result([])), /## Not pages/);
  const json = toSummaryJson(r, "1") as { routes: Array<{ path: string }>; resources: unknown[] };
  assert.deepEqual(
    json.routes.map((x) => x.path),
    ["/", "/broken-feed"],
  );
  assert.deepEqual(json.resources, resources);
  assert.deepEqual((toSummaryJson(result([]), "1") as { resources: unknown[] }).resources, []);
});

test("--ignore drops a rule entirely", () => {
  const r = route({ design: [{ rule: "contrast", detail: "1.7:1" }], geometry: ['e1 "A" overlaps e2 "B" (90%)'] });
  assert.deepEqual(
    issuesFromRoutes([r], ORIGIN, ["contrast"]).map((i) => i.rule),
    ["overlapping-controls"],
  );
});

test("an error page can be exempted while the same server error on another path still fails the gate", () => {
  const shared = { kind: "console_error" as const, severity: "medium" as const, detail: "Failed to load resource", url: ORIGIN };
  const intended = route({ path: "/error", status: 500, elements: 0, violations: [shared] });
  const broken = route({ path: "/records/12", status: 500, elements: 0, violations: [shared] });
  const pages = [intended, broken];
  const open = issuesFromRoutes(pages, ORIGIN);
  assert.equal(gateFailures(open, "high").length, 2, "both 500s fail the default gate");
  assert.deepEqual(
    open.filter((i) => i.rule === "console-error").map((i) => i.routes),
    [["/error", "/records/12"]],
    "the same console error is one issue seen on both routes",
  );

  const exemptPage = issuesFromRoutes(pages, ORIGIN, [], [], [{ path: "/error" }]);
  assert.deepEqual(
    exemptPage.map((i) => ({ rule: i.rule, routes: i.routes })),
    [
      { rule: "route-server-error", routes: ["/records/12"] },
      { rule: "console-error", routes: ["/records/12"] },
    ],
  );
  assert.equal(gateFailures(exemptPage, "high").length, 1);
  assert.equal(gateFailures(issuesFromRoutes(pages, ORIGIN, [], [], [{ path: "/error/details" }]), "high").length, 2, "a longer path is a different route");

  const exemptRule = issuesFromRoutes(pages, ORIGIN, [], [], [{ path: "/error", rule: "route-server-error" }]);
  assert.deepEqual(exemptRule.find((i) => i.rule === "route-server-error")?.routes, ["/records/12"]);
  assert.deepEqual(exemptRule.find((i) => i.rule === "console-error")?.routes, ["/error", "/records/12"]);
  assert.equal(gateFailures(exemptRule, "high").length, 1);

  const report = formatCheck({ ...result(exemptPage), ignoredPaths: [{ path: "/error" }, { path: "/records/12", rule: "route-server-error" }] });
  assert.match(report, /Paths exempted by --ignore-path: \/error, route-server-error:\/records\/12/);
  assert.match(report, /\*\*FAILED\*\*/);

  const colonPath = parseCheckArgs(["http://127.0.0.1:3000", "--ignore-path", "/files/a:b"], "/work");
  assert.ok(colonPath.ok);
  if (colonPath.ok) assert.deepEqual(colonPath.options.ignorePaths, [{ path: "/files/a:b" }]);
});

test("shared-chrome design defects are filed once, against the shell rather than a page", () => {
  const defect = { rule: "contrast" as const, detail: '<a> "Home" — 2.1:1', chrome: true };
  const issues = issuesFromRoutes([route({ path: "/a", design: [defect] }), route({ path: "/b", design: [defect] })], ORIGIN);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].routes, ["(shared chrome)"]);
});

test("a credential in a failing request's URL does not reach the report", () => {
  const [one] = issuesFromRoutes(
    [route({ violations: [{ kind: "http_error", severity: "medium", detail: "GET /api/x?api_key=Q7x9Rt2mLp4VzK8w → HTTP 401", url: ORIGIN }] })],
    ORIGIN,
  );
  assert.ok(!one.evidence.includes("Q7x9Rt2mLp4VzK8w"), one.evidence);
});

test("the gate: fails on its severity or worse, never below it, and never with 'never'", () => {
  const mediumOnly = [issue("medium"), issue("low")];
  assert.equal(gateFailures(mediumOnly, "high").length, 0);
  assert.equal(gateFailures(mediumOnly, "medium").length, 1);
  assert.equal(gateFailures(mediumOnly, "low").length, 2);
  assert.equal(gateFailures([issue("high")], "high").length, 1);
  assert.equal(gateFailures([issue("high")], "never").length, 0);
});

function result(issues: CheckIssue[], failOn: CheckResult["failOn"] = "high"): CheckResult {
  return {
    url: `${ORIGIN}/`,
    generatedAt: "2026-09-25T00:00:00.000Z",
    mode: "read-only",
    failOn,
    routes: [route()],
    issues,
    worthALook: [],
    unvisited: [],
    ignored: [],
    ignoredPaths: [],
    flows: [],
    retest: null,
    settings: { ...DEFAULT_SETTINGS },
    skippedFlows: [],
  };
}

test("the report leads with the verdict", () => {
  assert.match(formatCheck(result([issue("medium")])), /\*\*PASSED\*\*/);
  assert.match(formatCheck(result([issue("high")])), /\*\*FAILED\*\* — 1 issue/);
  assert.equal(summarise(result([issue("high")], "never")).passed, true);
});

test("a backslash before a pipe cannot turn the pipe back into a column", () => {
  const r: CheckResult = { ...result([]), routes: [route({ path: "/a\\|b" })] };
  const row = formatCheck(r)
    .split("\n")
    .find((l) => l.startsWith("| /a"))!;
  // Unescaped pipes are column separators: the row must still have exactly five.
  assert.equal(row.replace(/\\./g, "").split("|").length - 1, 5, row);
});

test("a backtick in a route cannot close the code span it is shown in", () => {
  const md = formatCheck({ ...result([{ ...issue("high"), routes: ["/a`b"] }]), unvisited: ["/c``d"] });
  assert.ok(md.includes("`` /a`b ``"), md);
  assert.ok(md.includes("``` /c``d ```"), md);
});

test("a pipe in evidence cannot break the report's markdown", () => {
  const md = formatCheck(result([{ ...issue("high"), evidence: "a | b\nc" }]));
  assert.match(md, /a \\\| b c/);
});

type SarifShape = {
  version: string;
  runs: Array<{
    tool: { driver: { rules: Array<{ id: string }> } };
    originalUriBaseIds?: unknown;
    properties: { app: string };
    results: Array<{
      ruleId: string;
      level: string;
      message: { text: string };
      locations: Array<{
        physicalLocation: { artifactLocation: { uri: string; uriBaseId?: string } };
        logicalLocations: Array<{ kind: string; fullyQualifiedName: string }>;
      }>;
      partialFingerprints: Record<string, string>;
      properties: { routes: string[]; flow?: string };
    }>;
  }>;
};

test("SARIF: severities map to levels, rules list only what was found, locations are a repository file with the route beside it", () => {
  const issues = issuesFromRoutes(
    [
      route({
        path: "/orders",
        violations: [{ kind: "page_error", severity: "high", detail: "boom", url: ORIGIN }],
        design: [{ rule: "contrast", detail: "1.7:1" }],
      }),
    ],
    ORIGIN,
  );
  const sarif = toSarif(result(issues), "9.9.9", { anchor: ".github/workflows/check.yml" }) as SarifShape;
  assert.equal(sarif.version, "2.1.0");
  const run = sarif.runs[0];
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id).sort(), ["contrast", "page-error"]);
  assert.equal(run.originalUriBaseIds, undefined, "no location is relative to the app any more");
  assert.equal(run.properties.app, ORIGIN);
  const byRule = Object.fromEntries(run.results.map((r) => [r.ruleId, r]));
  assert.equal(byRule["page-error"].level, "error");
  assert.equal(byRule["contrast"].level, "note");
  // Code scanning drops a result whose location is not a file in the repository.
  assert.deepEqual(byRule["page-error"].locations[0].physicalLocation.artifactLocation, { uri: ".github/workflows/check.yml" });
  assert.deepEqual(byRule["page-error"].locations[0].logicalLocations, [{ kind: "resource", name: "/orders", fullyQualifiedName: "/orders" }]);
  assert.deepEqual(byRule["page-error"].properties.routes, ["/orders"]);
  assert.match(byRule["page-error"].message.text, / — on \/orders$/);
  assert.equal(byRule["page-error"].partialFingerprints["scenescoutCheck/v1"], issues.find((i) => i.rule === "page-error")!.fingerprint);
  assert.ok(!JSON.stringify(sarif).includes('"uriBaseId"'));
});

test("SARIF: an issue a saved flow raised points at the flow's file; the same kind of issue from a crawled page points at the anchor", () => {
  const v = { kind: "http_error" as const, severity: "high" as const, detail: httpErrorDetail("GET", `${ORIGIN}/api/things/42`, 500), url: `${ORIGIN}/things` };
  const files = { anchor: "package.json", flowsDir: ".scenescout/flows" };
  const uriOf = (issues: CheckIssue[]): string[] =>
    (toSarif(result(issues), "1", files) as SarifShape).runs[0].results.map((r) => r.locations[0].physicalLocation.artifactLocation.uri);
  const fromFlow = issuesFromRoutes([route({ path: "/" })], ORIGIN, [], [flowRun({ outcome: BROKE, violations: [{ path: "/things", violation: v }] })]);
  assert.deepEqual(uriOf(fromFlow), [".scenescout/flows/details.json", ".scenescout/flows/details.json"]);
  const fromPage = issuesFromRoutes([route({ path: "/things", violations: [v] })], ORIGIN);
  assert.deepEqual(uriOf(fromPage), ["package.json"]);
  // Seen on a crawled page first and then in a flow: still the flow's file, and the fingerprint is the page issue's.
  const both = issuesFromRoutes([route({ path: "/", violations: [v] })], ORIGIN, [], [flowRun({ violations: [{ path: "/things", violation: v }] })]);
  assert.deepEqual(uriOf(both), [".scenescout/flows/details.json"]);
  assert.equal(both[0].fingerprint, fromPage[0].fingerprint, "the location moved; the alert's identity did not");
  // Flows read from outside the repository have no file code scanning could open: the anchor.
  assert.deepEqual(
    (toSarif(result(fromFlow), "1", { anchor: "package.json" }) as SarifShape).runs[0].results.map((r) => r.locations[0].physicalLocation.artifactLocation.uri),
    ["package.json", "package.json"],
  );
});

test("SARIF anchor: the option, else the running workflow's file, else package.json, else README.md", () => {
  const ref = "an-owner/a-repo/.github/workflows/ui-check.yml@refs/pull/7/merge";
  const none = (): boolean => false;
  const all = (): boolean => true;
  const cases: Array<[string, Parameters<typeof resolveSarifAnchor>[0], { file: string; source: string }]> = [
    ["option wins over the workflow", { option: "docs/ui.md", env: { GITHUB_WORKFLOW_REF: ref }, exists: all }, { file: "docs/ui.md", source: "option" }],
    ["workflow set", { env: { GITHUB_WORKFLOW_REF: ref }, exists: all }, { file: ".github/workflows/ui-check.yml", source: "workflow" }],
    ["workflow not set, package.json there", { env: {}, exists: all }, { file: "package.json", source: "fallback" }],
    ["workflow not set, only README.md", { env: {}, exists: (f) => f === "README.md" }, { file: "README.md", source: "fallback" }],
    ["workflow ref of the wrong shape", { env: { GITHUB_WORKFLOW_REF: "nonsense" }, exists: all }, { file: "package.json", source: "fallback" }],
  ];
  for (const [name, input, want] of cases) assert.deepEqual(resolveSarifAnchor(input), want, name);
  assert.equal(workflowFileOf("o/r/.github/workflows/a.yml@main"), ".github/workflows/a.yml");
  assert.equal(workflowFileOf("o/r/.github/workflows/a.yml"), ".github/workflows/a.yml");
  assert.equal(workflowFileOf("o/r/.github/workflows/a.yml@refs/heads/fix@2"), ".github/workflows/a.yml", "a branch name may hold @");
  assert.equal(workflowFileOf("o/r/../../etc/passwd@main"), null);
  assert.equal(workflowFileOf(undefined), null);
});

test("SARIF anchor: a missing file is warned about by name and skipped for the next one that exists; with none, the SARIF is still written", () => {
  const ref = "o/r/.github/workflows/ui-check.yml@refs/heads/main";
  const only =
    (...present: string[]) =>
    (f: string): boolean =>
      present.includes(f);
  // The contrastive pair: the same option, present and then missing.
  const present = resolveSarifAnchor({ option: "docs/ui.md", env: {}, exists: only("docs/ui.md", "package.json") });
  assert.deepEqual(present, { file: "docs/ui.md", source: "option" }, "no warning when the file is there");
  const missing = resolveSarifAnchor({ option: "docs/ui.md", env: {}, exists: only("package.json") });
  assert.equal(missing.file, "package.json");
  assert.equal(missing.source, "fallback");
  assert.match(missing.warning ?? "", /--sarif-file-anchor docs\/ui\.md is not in the repository; results point at package\.json instead/);
  assert.ok(!missing.warning!.includes("\n"), "one line");
  // The same pair for the workflow file.
  assert.equal(resolveSarifAnchor({ env: { GITHUB_WORKFLOW_REF: ref }, exists: only(".github/workflows/ui-check.yml") }).warning, undefined);
  const noWorkflow = resolveSarifAnchor({ env: { GITHUB_WORKFLOW_REF: ref }, exists: only("README.md") });
  assert.equal(noWorkflow.file, "README.md");
  assert.match(noWorkflow.warning ?? "", /the workflow file \.github\/workflows\/ui-check\.yml is not in the repository; results point at README\.md/);
  // A quiet fallback chain is not a warning: package.json missing, README.md there.
  assert.equal(resolveSarifAnchor({ env: {}, exists: only("README.md") }).warning, undefined);
  // Nothing exists: the first candidate is kept, and the warning says code scanning will drop the results.
  const none = resolveSarifAnchor({ option: "docs/ui.md", env: { GITHUB_WORKFLOW_REF: ref }, exists: () => false });
  assert.equal(none.file, "docs/ui.md");
  assert.match(none.warning ?? "", /tried --sarif-file-anchor docs\/ui\.md, the workflow file .*package\.json, README\.md.*code scanning will drop them/);
  assert.equal(resolveSarifAnchor({ env: {}, exists: () => false }).file, "package.json");
});

test("an explicit --sarif-file-anchor that does not exist is parsed, not refused: the warning comes when the SARIF is written", () => {
  const parsed = parseCheckArgs(["http://127.0.0.1:3000", "--sarif-file-anchor=no/such/file.md"], "/work");
  assert.ok(parsed.ok && parsed.options.sarifFileAnchor === "no/such/file.md");
  const files = sarifFilesFor({ option: "no/such/file.md", env: {}, projectDir: "/w/repo", exists: (p) => p === path.join("/w/repo", "package.json") });
  assert.equal(files.anchor, "package.json");
  assert.match(files.warning ?? "", /no\/such\/file\.md is not in the repository/);
});

test("SARIF files: relative to the Actions checkout when there is one, else the project; flows outside it fall back to the anchor", () => {
  const exists = (p: string): boolean =>
    [path.join("/w/repo", "package.json"), path.join("/w/repo", ".github/workflows/ui.yml"), path.join("/w/repo/app", "README.md")].includes(p);
  const ref = "o/r/.github/workflows/ui.yml@refs/heads/main";
  assert.deepEqual(
    sarifFilesFor({
      env: { GITHUB_WORKSPACE: "/w/repo", GITHUB_WORKFLOW_REF: ref },
      projectDir: "/w/repo/app",
      flowsDir: "/w/repo/app/.scenescout/flows",
      exists,
    }),
    { anchor: ".github/workflows/ui.yml", source: "workflow", flowsDir: "app/.scenescout/flows" },
  );
  assert.deepEqual(sarifFilesFor({ env: { GITHUB_WORKSPACE: "/w/repo" }, projectDir: "/w/repo/app", flowsDir: "/elsewhere/flows", exists }), {
    anchor: "package.json",
    source: "fallback",
  });
  assert.deepEqual(sarifFilesFor({ env: {}, projectDir: "/w/repo/app", flowsDir: null, exists }), { anchor: "README.md", source: "fallback" });
});

test("--sarif-file-anchor: a file relative to the repository root, never outside it", () => {
  const parse = (v: string) => parseCheckArgs(["http://127.0.0.1:3000", `--sarif-file-anchor=${v}`], "/work");
  const ok = parse("./docs\\ui.md");
  assert.ok(ok.ok && ok.options.sarifFileAnchor === "docs/ui.md");
  for (const bad of ["/etc/passwd", "C:/x.md", "../outside.md", "docs/", " "]) {
    const r = parse(bad);
    assert.ok(!r.ok && /--sarif-file-anchor/.test(r.error), bad);
  }
  const absent = parseCheckArgs(["http://127.0.0.1:3000"], "/work");
  assert.ok(absent.ok && absent.options.sarifFileAnchor === undefined);
});

test("a field labelled only by its placeholder is its own medium rule, apart from a control with no name at all", () => {
  const issues = issuesFromRoutes(
    [route({ path: "/new", unnamed: ["textbox [testid=search-box]"], placeholderOnly: ['textbox [testid=email-field] "Your email"'] })],
    ORIGIN,
  );
  assert.deepEqual(
    issues.map((i) => [i.rule, i.severity, i.evidence]),
    [
      ["placeholder-only-label", "medium", 'textbox [testid=email-field] "Your email"'],
      ["unnamed-control", "medium", "textbox [testid=search-box]"],
    ],
  );
  assert.equal(gateFailures(issues, "high").length, 0, "neither fails the default gate");
  const sarif = toSarif(result(issues), "9.9.9") as { runs: Array<{ tool: { driver: { rules: Array<{ id: string; help: { text: string } }> } } }> };
  const rule = sarif.runs[0].tool.driver.rules.find((r) => r.id === "placeholder-only-label");
  assert.match(rule?.help.text ?? "", /disappears as soon as the user types/);
  assert.deepEqual(issuesFromRoutes([route({ placeholderOnly: ['textbox "Your email"'] })], ORIGIN, ["placeholder-only-label"]), [], "--ignore takes it out");
});

test("every rule has a severity, a title and help text", () => {
  for (const [id, r] of Object.entries(CHECK_RULES)) {
    assert.ok(["high", "medium", "low"].includes(r.severity), id);
    assert.ok(r.title.length > 0 && r.help.length > 0, id);
  }
  // A worth-a-look rule has no severity, and names the convention that would decide it.
  for (const [id, r] of Object.entries(WORTH_A_LOOK_RULES)) {
    assert.ok(!("severity" in r), id);
    assert.ok(r.title.length > 0 && r.help.length > 0 && r.convention.length > 0, id);
    assert.ok(!(id in CHECK_RULES), `${id} is in one tier, not both`);
  }
});

// ---------------------------------------------------------------------------
// Worth a look: convention-dependent observations. The two routes below are
// identical but for the design audit's convention-dependent lines, and the
// gate must say the same thing about both at every --fail-on.
// ---------------------------------------------------------------------------

const CONVENTION_DEPENDENT = [
  { rule: "off-grid-spacing" as const, detail: "paddings off a 4px grid: 7px, 13px" },
  { rule: "indistinct-link" as const, detail: "links with no underline in the body-text colour rgba(17, 17, 17, 1)" },
];
const plainRoute = route({ path: "/list", design: [{ rule: "contrast", detail: '<p> "Hint" — 2.10:1 (needs 4.5:1)' }] });
const lookRoute = route({ path: "/list", design: [...plainRoute.design, ...CONVENTION_DEPENDENT] });

function fullResult(r: RouteHealth, failOn: CheckResult["failOn"]): CheckResult {
  const { issues, worthALook } = checkFindings([r], ORIGIN);
  return { ...result(issues, failOn), routes: [r], worthALook };
}

test("worth a look: convention-dependent rules land in their own tier, with the convention named, and nothing else moves", () => {
  const plain = checkFindings([plainRoute], ORIGIN);
  const look = checkFindings([lookRoute], ORIGIN);
  assert.deepEqual(look.issues, plain.issues, "the defects are the same with or without the observations");
  assert.deepEqual(plain.worthALook, []);
  assert.deepEqual(
    look.worthALook.map((o) => [o.rule, o.convention]),
    [
      ["indistinct-link", WORTH_A_LOOK_RULES["indistinct-link"].convention],
      ["off-grid-spacing", "a 4px spacing scale"],
    ],
  );
  assert.deepEqual(
    issuesFromRoutes([lookRoute], ORIGIN).map((i) => i.rule),
    ["contrast"],
    "issuesFromRoutes is the defect tier only",
  );
  // Deduplicated like issues: the same shell observation on two pages is one entry on both routes.
  const shell = { rule: "off-grid-spacing" as const, detail: "paddings off a 4px grid: 6px", chrome: true };
  const twice = checkFindings([route({ path: "/a", design: [shell] }), route({ path: "/b", design: [shell] })], ORIGIN);
  assert.equal(twice.worthALook.length, 1);
  assert.deepEqual(twice.worthALook[0].routes, ["(shared chrome)"]);
  // --ignore takes them like any rule.
  assert.deepEqual(
    checkFindings([lookRoute], ORIGIN, ["off-grid-spacing"]).worthALook.map((o) => o.rule),
    ["indistinct-link"],
  );
  // A small target is WCAG 2.2 AA's published minimum, not a project convention: it stays a low issue, with the fingerprint it always had.
  const small = checkFindings([route({ design: [{ rule: "tiny-target", detail: "button [close] — 14×14px" }] })], ORIGIN);
  assert.deepEqual(small.worthALook, []);
  assert.deepEqual(
    small.issues.map((i) => [i.rule, i.severity, i.fingerprint]),
    [["tiny-target", "low", createHash("sha256").update("tiny-target\u0000button [close] — 14×14px").digest("hex").slice(0, 32)]],
  );
});

test("worth a look: never fails the gate at any --fail-on, and the verdict is the one the identical page without them gets", () => {
  for (const failOn of FAIL_ON) {
    const plain = fullResult(plainRoute, failOn);
    const look = fullResult(lookRoute, failOn);
    assert.equal(look.worthALook.length, 2);
    assert.deepEqual(summarise(look), summarise(plain), `--fail-on ${failOn}`);
    assert.equal(exitCodeOf(look), exitCodeOf(plain), `--fail-on ${failOn}`);
  }
  // With nothing else on the page, the strictest gate still passes.
  const only = { ...fullResult(route({ design: CONVENTION_DEPENDENT }), "low") };
  assert.equal(only.issues.length, 0);
  assert.equal(summarise(only).passed, true);
  assert.equal(exitCodeOf(only), 0);
  assert.deepEqual(summarise(only).counts, { high: 0, medium: 0, low: 0 }, "not counted at any severity");
});

test("worth a look: SARIF level note with the convention, the report's own section, and check.json apart from issues", () => {
  const look = fullResult(lookRoute, "low");
  const sarif = toSarif(look, "1") as {
    runs: Array<{
      tool: { driver: { rules: Array<{ id: string; defaultConfiguration: { level: string }; properties?: { tags: string[] } }> } };
      results: Array<{ ruleId: string; level: string; message: { text: string }; properties?: { tier: string; convention: string } }>;
    }>;
  };
  const run = sarif.runs[0];
  const lookResults = run.results.filter((r) => r.ruleId in WORTH_A_LOOK_RULES);
  assert.equal(lookResults.length, 2);
  for (const r of lookResults) {
    assert.equal(r.level, "note", r.ruleId);
    assert.equal(r.properties?.tier, "worth-a-look");
    assert.match(r.message.text, /^Worth a look — .*A defect only if your project uses /);
  }
  // The rules this run reported, each declared at level note (SARIF declares only the rules a run used).
  for (const id of new Set(lookResults.map((r) => r.ruleId))) {
    const rule = run.tool.driver.rules.find((r) => r.id === id)!;
    assert.equal(rule.defaultConfiguration.level, "note", id);
    assert.deepEqual(rule.properties?.tags, ["worth-a-look"]);
  }
  assert.equal(run.results.find((r) => r.ruleId === "contrast")?.level, "note", "a low defect stays as it was");

  const md = formatCheck(look);
  const plainMd = formatCheck(fullResult(plainRoute, "low"));
  assert.match(md, /\*\*FAILED\*\* — 1 issue\(s\) at the gate's severity · 0 high · 0 medium · 1 low · 2 worth a look, never gated/);
  assert.match(plainMd, /\*\*FAILED\*\* — 1 issue\(s\) at the gate's severity · 0 high · 0 medium · 1 low\n/);
  const section = md.indexOf("## Worth a look (2)");
  assert.ok(section > md.indexOf("## Low (1)"), "below the counted issues");
  assert.ok(section < md.indexOf("## Routes"));
  assert.match(md, /never fail the gate, at any --fail-on/);
  assert.match(
    md,
    /\*\*Spacing off a 4px grid\*\* `off-grid-spacing`: paddings off a 4px grid: 7px, 13px — a defect only if your project uses a 4px spacing scale — `\/list`/,
  );
  assert.ok(!plainMd.includes("Worth a look"), "no section when there is nothing in it");
  assert.match(md, /\| \/list \| 200 \| 10 \| 1 \|/, "the route's issue count is the defects only");

  const json = toSummaryJson(look, "1") as {
    counts: object;
    gate: { failing: number };
    issues: CheckIssue[];
    worthALook: Array<{ rule: string; convention: string }>;
  };
  const plainJson = toSummaryJson(fullResult(plainRoute, "low"), "1") as typeof json;
  assert.deepEqual(json.counts, plainJson.counts);
  assert.deepEqual(json.gate, plainJson.gate);
  assert.deepEqual(json.issues, plainJson.issues);
  assert.deepEqual(
    json.worthALook.map((o) => o.rule),
    ["indistinct-link", "off-grid-spacing"],
  );
  assert.deepEqual(plainJson.worthALook, []);
});

test("worth a look: an open finding filed as worth a look is never re-tested by a check, so it can never gate", () => {
  const base: Finding = {
    id: "f1",
    severity: "high",
    category: "http-error",
    title: "t",
    detail: "d",
    evidence: "GET /api/things 500",
    url: `${ORIGIN}/things`,
    state: "/things#1",
    repro: ["navigate @ /things"],
    foundAt: "2026-09-25T00:00:00.000Z",
    runs: 1,
  };
  assert.equal(checkRetestPlan([base]).candidates.length, 1, "the same finding as a defect is re-tested");
  const look = checkRetestPlan([{ ...base, tier: "worth_a_look", convention: "a 4px spacing scale" }]);
  assert.equal(look.candidates.length, 0);
  assert.equal(look.open, 0, "and not counted among the open findings a check leaves to a run");
});

test("arguments: the defaults", () => {
  const parsed = parseCheckArgs(["http://127.0.0.1:3000"], "/work/app");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.options, {
    url: "http://127.0.0.1:3000/",
    projectDir: "/work/app",
    failOn: "high",
    mode: "read-only",
    maxRoutes: 50,
    ignore: [],
    ignorePaths: [],
    // Spelled out, not read from DEFAULT_SETTINGS: a default that drifts to allow, stop or never must fail here.
    retest: true,
    flowWrites: "never",
    onRefusedStep: "report",
    gateRetests: "high",
    // Off unless asked for: a check writes no picture and compares none by default.
    baseline: "off",
    // 0.1, not 0: a gate that fails on anti-aliasing noise between runs teaches a team to ignore it.
    baselineThreshold: 0.1,
  });
});

test("arguments: every option, in both spellings, with relative paths resolved against the working directory", () => {
  const parsed = parseCheckArgs(
    [
      "https://app.example.com/start",
      "--fail-on=medium",
      "--mode",
      "observe",
      "--max-routes",
      "10",
      "--paths",
      "/a, /b",
      "--ignore",
      "contrast,tiny-target",
      "--ignore-path",
      "/error, route-server-error:/records/12",
      "--storage-state",
      "auth/user.json",
      "--project",
      "site",
      "--out=/tmp/out",
      "--browser",
      "webkit",
      "--flows",
      "ci/flows",
      "--retest=off",
      "--flow-writes",
      "allow",
      "--on-refused-step=stop",
      "--gate-retests",
      "all",
      "--baseline",
      "compare",
      "--baselines=tests/visual",
      "--baseline-threshold",
      "0.5",
    ],
    "/work",
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.options, {
    url: "https://app.example.com/start",
    projectDir: "/work/site",
    outDir: "/tmp/out",
    failOn: "medium",
    mode: "observe",
    storageStatePath: "/work/auth/user.json",
    browser: "webkit",
    maxRoutes: 10,
    paths: ["/a", "/b"],
    ignore: ["contrast", "tiny-target"],
    ignorePaths: [{ path: "/error" }, { path: "/records/12", rule: "route-server-error" }],
    flows: "/work/ci/flows",
    retest: false,
    flowWrites: "allow",
    onRefusedStep: "stop",
    gateRetests: "all",
    baseline: "compare",
    baselinesDir: "/work/tests/visual",
    baselineThreshold: 0.5,
  });
});

test("arguments: each mistake is refused with a sentence", () => {
  const refused: Array<[string[], RegExp]> = [
    [[], /exactly one URL/],
    [["a", "b"], /exactly one URL/],
    [["not a url"], /not a URL/],
    [["file:///etc/passwd"], /only http and https/],
    [["http://x", "--fail-on", "critical"], /--fail-on must be/],
    [["http://x", "--mode", "safe-write"], /--mode must be observe or read-only/],
    [["http://x", "--mode", "destructive"], /--mode must be observe or read-only/],
    [["http://x", "--retest", "yes"], /--retest must be on or off/],
    [["http://x", "--flows", " "], /--flows needs a directory, or off/],
    [["http://x", "--flow-writes", "always"], /--flow-writes must be one of never, allow/],
    [["http://x", "--on-refused-step", "skip"], /--on-refused-step must be one of report, stop/],
    [["http://x", "--gate-retests", "medium"], /--gate-retests must be one of never, high, all/],
    [["http://x", "--max-routes", "0"], /--max-routes/],
    [["http://x", "--max-routes", "151"], /--max-routes/],
    [["http://x", "--max-routes", "2.5"], /--max-routes/],
    [["http://x", "--paths", "orders"], /each starting with \//],
    [["http://x", "--paths", " , "], /--paths is empty/],
    [["http://x", "--ignore", "contrast,nope"], /unknown rule\(s\) in --ignore: nope/],
    [["http://x", "--ignore-path", " , "], /--ignore-path is empty/],
    [["http://x", "--ignore-path", "error"], /--ignore-path entries are paths starting with \//],
    [["http://x", "--ignore-path", "route-server-error:error"], /--ignore-path entries are paths starting with \//],
    [["http://x", "--ignore-path", "nope:/error,also:/records/12"], /unknown rule\(s\) in --ignore-path: nope, also/],
    [["http://x", "--ignore-path", "/error:route-server-error"], /names a rule as rule:\/path/],
    [["http://x", "--browser", "ie"], /--browser must be one of/],
    [["http://x", "--level", "high"], /unknown option --level/],
    [["http://x", "--fail-on"], /--fail-on needs a value/],
    [["http://x", "--fail-on", "--mode", "observe"], /--fail-on needs a value/],
    [["http://x", "--baseline", "approve"], /--baseline must be one of off, compare, update/],
    [["http://x", "--baseline", "compare", "--baseline-threshold", "101"], /--baseline-threshold must be a percentage from 0 to 100/],
    [["http://x", "--baseline", "compare", "--baseline-threshold", "-1"], /--baseline-threshold must be a percentage/],
    [["http://x", "--baseline", "compare", "--baseline-threshold", "a lot"], /--baseline-threshold must be a percentage/],
    [["http://x", "--baseline", "update", "--baselines", " "], /--baselines needs a directory/],
    // A setting that would do nothing without --baseline is pointed out, not ignored.
    [["http://x", "--baselines", "tests/visual"], /apply only with --baseline compare or --baseline update/],
    [["http://x", "--baseline", "off", "--baseline-threshold", "1"], /apply only with --baseline compare or --baseline update/],
  ];
  for (const [args, message] of refused) {
    const parsed = parseCheckArgs(args, "/work");
    assert.ok(!parsed.ok, args.join(" "));
    assert.match(parsed.error, message, args.join(" "));
  }
});

test("a check that reached no page, or only the sign-in page, has no verdict to give", () => {
  assert.match(unmeasuredReason([route({ status: null, loadError: "net::ERR_CONNECTION_REFUSED", elements: 0 })], true) ?? "", /no page loaded/);
  assert.match(unmeasuredReason([route({ loginRedirect: true }), route({ path: "/b", loginRedirect: true })], true) ?? "", /sign-in/);
  // A bounced start page is not rescued by the sign-in page's own links loading.
  assert.match(unmeasuredReason([route({ loginRedirect: true }), route({ path: "/forgot-password" })], true) ?? "", /start page sent the browser to sign-in/);
  // A later page behind the wall does not make the app unmeasured, and neither does one that failed beside one that loaded.
  assert.equal(unmeasuredReason([route(), route({ path: "/admin", loginRedirect: true })], true), null);
  // With --paths the first path is not a start page: one walled path among public ones is an issue, not "unmeasured".
  assert.equal(unmeasuredReason([route({ path: "/account", loginRedirect: true }), route({ path: "/pricing" })], false), null);
  assert.equal(unmeasuredReason([route({ status: null, loadError: "x", elements: 0 }), route({ path: "/b" })], true), null);
});

test("a page the design audit could not measure is disclosed in the verdict and the JSON, not read as clean", () => {
  const r: CheckResult = { ...result([]), routes: [route(), route({ path: "/b", auditError: "no visible styled elements to measure" })] };
  assert.match(formatCheck(r), /\*\*PASSED\*\*[^\n]*design not measured on 1 route\(s\)/);
  const json = toSummaryJson(r, "9.9.9") as { routes: Array<{ path: string; designNotMeasured?: string }> };
  assert.deepEqual(
    json.routes.map((x) => x.designNotMeasured ?? null),
    [null, "no visible styled elements to measure"],
  );
});

test("a failing page is one issue: its own response is not counted again as a request error", () => {
  const url = `${ORIGIN}/broken`;
  const issues = issuesFromRoutes(
    [
      withoutOwnResponse(
        route({
          path: "/broken",
          url,
          status: 500,
          violations: [
            { kind: "http_error", severity: "high", detail: httpErrorDetail("GET", url, 500), url },
            { kind: "http_error", severity: "high", detail: httpErrorDetail("GET", `${ORIGIN}/api/data`, 500), url },
          ],
        }),
      ),
    ],
    ORIGIN,
  );
  assert.deepEqual(issues.map((i) => i.rule).sort(), ["route-server-error", "server-error"]);
  assert.equal(issues.find((i) => i.rule === "server-error")!.evidence, "GET /api/data → HTTP 500");
});

test("a token in a route's link is redacted everywhere the route is written", () => {
  const [r] = redactRoutes([
    route({
      path: "/reset?token=Q7x9Rt2mLp4VzK8w",
      url: `${ORIGIN}/reset?token=Q7x9Rt2mLp4VzK8w`,
      violations: [{ kind: "page_error", severity: "high", detail: "boom", url: `${ORIGIN}/reset?token=Q7x9Rt2mLp4VzK8w` }],
    }),
  ]);
  const written =
    JSON.stringify(r) +
    formatCheck({ ...result(issuesFromRoutes([r], ORIGIN)), routes: [r] }) +
    JSON.stringify(toSarif(result(issuesFromRoutes([r], ORIGIN)), "1"));
  assert.ok(!written.includes("Q7x9Rt2mLp4VzK8w"), written);
  assert.equal(r.path, "/reset?token=[redacted]");
});

test("credentials in the URL are refused rather than written into the report", () => {
  const parsed = parseCheckArgs(["https://user:hunter2@staging.example.com/"], "/work");
  assert.ok(!parsed.ok);
  assert.match(parsed.error, /no credentials in the URL/);
});

test("SARIF tells a shared-shell location apart from the start page", () => {
  const issues = issuesFromRoutes(
    [
      route({
        path: "/",
        design: [
          { rule: "contrast", detail: "a" },
          { rule: "contrast", detail: "b", chrome: true },
        ],
      }),
    ],
    ORIGIN,
  );
  const locs = (toSarif(result(issues), "1") as { runs: Array<{ results: Array<{ locations: Array<{ message?: { text: string } }> }> }> }).runs[0].results.map(
    (r) => r.locations[0].message?.text ?? null,
  );
  assert.deepEqual(locs.sort(), [null, "the app's shared shell, on every page that renders it"].sort());
});

test("a page's own error status is one issue even when its URL carried a token, a #fragment, or ran past the oracle's cut-off", () => {
  const raw = `${ORIGIN}/reset?token=Q7x9Rt2mLp4VzK8w&${"x".repeat(240)}#step2`;
  const [r] = redactRoutes([
    withoutOwnResponse(
      route({
        path: "/reset?token=Q7x9Rt2mLp4VzK8w&x#step2",
        url: raw,
        status: 404,
        violations: [{ kind: "http_error", severity: "medium", detail: httpErrorDetail("GET", raw.replace(/#.*$/, ""), 404), url: raw }],
      }),
    ),
  ]);
  assert.deepEqual(
    issuesFromRoutes([r], ORIGIN).map((i) => i.rule),
    ["route-client-error"],
  );
});

// ---------------------------------------------------------------------------
// The GitHub Action (action.yml + action/check-action.mjs). Its inputs are the
// CLI's options by name, so the two lists are held equal here: adding an
// option to one and not the other fails this suite, not a user's workflow.
// ---------------------------------------------------------------------------

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readYaml = (rel: string): Record<string, any> => parseYaml(fs.readFileSync(path.join(REPO, rel), "utf8"));
const action = readYaml("action.yml");
const actionInputs = Object.keys(action.inputs as Record<string, unknown>);
/** The inputs as the runner hands them over: every input, at its default. */
const defaultInputs = (): Record<string, string> =>
  Object.fromEntries(Object.entries(action.inputs as Record<string, { default?: string }>).map(([k, v]) => [k, v.default ?? ""]));

test("action: every input that is not the action's own is a `scenescout check` option, and every option is an input", () => {
  const forwarded = actionInputs.filter((name) => !ACTION_ONLY_INPUTS.includes(name)).sort();
  const options: string[] = [...CHECK_OPTION_NAMES].sort();
  assert.deepEqual(
    forwarded,
    options,
    `options missing from action.yml: ${options.filter((o) => !forwarded.includes(o)).join(", ") || "none"}; ` +
      `inputs the CLI does not accept: ${forwarded.filter((f) => !options.includes(f)).join(", ") || "none"}`,
  );
  // A name left in ACTION_ONLY_INPUTS after its input is removed would hide a CLI option of that name from the action.
  assert.deepEqual(
    ACTION_ONLY_INPUTS.filter((name) => !actionInputs.includes(name)),
    [],
  );
});

test("action: the arguments it builds are ones the CLI accepts, carrying every option and none of the action's own inputs", () => {
  const inputs = {
    ...defaultInputs(),
    url: "http://127.0.0.1:3000/start",
    "fail-on": "medium",
    mode: "observe",
    "max-routes": "10",
    paths: "/a,/b",
    ignore: "contrast",
    "ignore-path": "/error,route-server-error:/records/12",
    "storage-state": "auth/user.json",
    browser: "webkit",
    project: "site",
    out: "results",
    flows: "off",
    retest: "off",
    "flow-writes": "allow",
    "on-refused-step": "stop",
    "gate-retests": "never",
    baseline: "update",
    baselines: "tests/visual",
    "baseline-threshold": "0.25",
    cli: "dist/cli.js",
    "upload-sarif": "true",
  };
  const args = checkArgs(inputs);
  assert.equal(args[0], "check");
  const parsed = parseCheckArgs(args.slice(1), "/work");
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.options, {
    url: "http://127.0.0.1:3000/start",
    projectDir: "/work/site",
    outDir: "/work/results",
    failOn: "medium",
    mode: "observe",
    storageStatePath: "/work/auth/user.json",
    browser: "webkit",
    maxRoutes: 10,
    paths: ["/a", "/b"],
    ignore: ["contrast"],
    ignorePaths: [{ path: "/error" }, { path: "/records/12", rule: "route-server-error" }],
    flows: "off",
    retest: false,
    flowWrites: "allow",
    onRefusedStep: "stop",
    gateRetests: "never",
    baseline: "update",
    baselinesDir: "/work/tests/visual",
    baselineThreshold: 0.25,
  });
  for (const own of ACTION_ONLY_INPUTS.filter((n) => n !== "url")) assert.ok(!args.some((a) => a.startsWith(`--${own}`)), own);
});

test("action: its defaults are the CLI's defaults, and an empty input is left to the CLI", () => {
  const args = checkArgs({ ...defaultInputs(), url: "http://127.0.0.1:3000" });
  const viaAction = parseCheckArgs(args.slice(1), "/work");
  const direct = parseCheckArgs(["http://127.0.0.1:3000", "--browser", "chromium"], "/work");
  assert.ok(viaAction.ok && direct.ok);
  assert.deepEqual(viaAction.options, direct.options);
  assert.ok(!args.some((a) => a.startsWith("--max-routes") || a.startsWith("--paths") || a.startsWith("--out")));
  // An input whose CLI default is not the empty string says what that default is, and it is the parser's.
  const threshold = String((parseThreshold(undefined) as { value: number }).value);
  assert.ok(
    (action.inputs["baseline-threshold"].description as string).includes(`Empty means ${threshold},`),
    `the baseline-threshold input should say "Empty means ${threshold},"`,
  );
});

test("action: a missing url or an unknown browser stops it before anything is downloaded", () => {
  assert.throws(() => checkArgs({ ...defaultInputs(), url: "  " }), /url input is required/);
  assert.throws(() => engineOf({ browser: "ie" }), /must be one of chromium, firefox, webkit/);
  assert.equal(engineOf({ browser: "" }), "chromium");
  assert.equal(installTarget("chromium"), "chromium-headless-shell");
  assert.equal(installTarget("webkit"), "webkit");
});

test("action: it reads results from where the CLI writes them", () => {
  assert.equal(outDirFor({ out: "", project: "" }, "/work"), path.resolve("/work", ".scenescout", "check"));
  assert.equal(outDirFor({ out: "", project: "site" }, "/work"), path.resolve("/work", "site", ".scenescout", "check"));
  assert.equal(outDirFor({ out: "results", project: "site" }, "/work"), path.resolve("/work", "results"));
});

test("action: the browser cache it saves is the one Playwright downloads to", () => {
  assert.equal(browsersPath({}, "linux", "/home/u"), "/home/u/.cache/ms-playwright");
  assert.equal(browsersPath({ XDG_CACHE_HOME: "/cache" }, "linux", "/home/u"), "/cache/ms-playwright");
  assert.equal(browsersPath({}, "darwin", "/Users/u"), "/Users/u/Library/Caches/ms-playwright");
  assert.equal(browsersPath({ LOCALAPPDATA: "C:\\Users\\r\\AppData\\Local" }, "win32", "C:\\Users\\r"), "C:\\Users\\r\\AppData\\Local\\ms-playwright");
  assert.equal(browsersPath({ PLAYWRIGHT_BROWSERS_PATH: "/pw" }, "linux", "/home/u"), "/pw");
});

test("action: npm is started without a shell, and only a plain version, range or tag is installed", () => {
  assert.deepEqual(npmCommand("linux", "/usr/bin/node"), { file: "npm", prefixArgs: [] });
  assert.deepEqual(
    npmCommand("win32", "C:\\node\\node.exe", () => true),
    { file: "C:\\node\\node.exe", prefixArgs: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js"] },
  );
  assert.throws(() => npmCommand("win32", "C:\\node\\node.exe", () => false), /npm was not found/);
  for (const ok of ["3.10.0", "^3.10", "~3.10.1", "latest", "3.10.0-next.1"]) assert.ok(isVersionSpec(ok), ok);
  for (const bad of ["", "3 && curl x", "3|x", "$(id)", "3;x", "3>x"]) assert.ok(!isVersionSpec(bad), bad);
});

test("action: the exit code decides how the step ends, and a setup problem never reads as a failing app", () => {
  assert.deepEqual(verdict({ exitCode: 0, failOn: "high", url: "http://x" }), { exit: 0, annotation: null });
  const failed = verdict({ exitCode: "1", failing: "3", failOn: "medium", url: "http://x" });
  assert.equal(failed.exit, 1);
  assert.match(failed.annotation ?? "", /^::error title=SceneScout check failed::3 issue\(s\) at medium severity or worse on http:\/\/x/);
  const broken = verdict({ exitCode: "2", failOn: "high", url: "http://x", error: "Could not load http://x — is the app running?\nsecond line" });
  assert.equal(broken.exit, 2);
  assert.match(broken.annotation ?? "", /^::error title=SceneScout check could not run::No verdict for http:\/\/x: Could not load/);
  assert.ok(!(broken.annotation ?? "").includes("\n"), "a newline would end the annotation early");
  // A crash or a signal is not the gate's 1.
  for (const exitCode of ["137", "signal SIGKILL", NaN]) assert.equal(verdict({ exitCode, failOn: "high", url: "http://x" }).exit, 2, String(exitCode));
});

test("action: a CLI older than the action says so, instead of a bare could-not-run", () => {
  // The usage line the CLI prints today; a release before `check` has none.
  assert.ok(hasCheckCommand("  scenescout check <url>            Visit every route, measure each one"));
  assert.ok(!hasCheckCommand("  scenescout doctor                 Check the setup and print the fix"));
  assert.ok(hasCheckCommand(fs.readFileSync(path.join(REPO, "src", "cli.ts"), "utf8")), "the CLI's usage text no longer has the line the action looks for");
  assert.match(noCheckCommand("3.9.0"), /^scenescout 3\.9\.0 has no check command.*vX\.Y\.Z tag.*version input/);
  assert.match(
    explainError("unknown option --timeout", "3.10.0"),
    /^scenescout 3\.10\.0 does not accept the timeout input, so it is older than this action\. .*vX\.Y\.Z/,
  );
  // Any other error is the CLI's own sentence, untouched.
  assert.equal(explainError("Could not load http://x — is the app running?", "3.10.0"), "Could not load http://x — is the app running?");
  assert.equal(explainError(undefined, "3.10.0"), "");
});

test("action: each use in a job gets its own artifact name, so a second use does not collide with the first", () => {
  assert.equal(defaultArtifactName("check", 1), "scenescout-check-check");
  assert.equal(defaultArtifactName("check", 2), "scenescout-check-check-2");
  assert.equal(defaultArtifactName("ui check/x", 1), "scenescout-check-ui_check_x");
  assert.equal(defaultArtifactName(undefined, 3), "scenescout-check-3");
  assert.equal(defaultInputs()["artifact-name"], "", "a fixed default name collides on the second use");
});

test("action: an upload that fails cannot hide the verdict, and a failed gate still saves the browser cache", () => {
  const steps = action.runs.steps as Array<{ name: string; if?: string; uses?: string }>;
  const step = (name: string) => steps.find((s) => s.name === name)!;
  for (const name of ["Keep the results", "Upload to code scanning", "Verdict"]) assert.match(step(name).if ?? "", /^always\(\) && /, name);
  const names = steps.map((s) => s.name);
  assert.ok(names.indexOf("Save the browser cache") < names.indexOf("Run the check"), "saved before any verdict exists");
  assert.match(step("Restore the browser cache").uses ?? "", /^actions\/cache\/restore@/);
  assert.match(step("Save the browser cache").uses ?? "", /^actions\/cache\/save@/);
  assert.ok(!steps.some((s) => /^actions\/cache@/.test(s.uses ?? "")), "the combined action saves only when the job succeeds");
});

test("action: its outputs are check.json's numbers, and nothing when there is no verdict", () => {
  const json = toSummaryJson(result([issue("high"), issue("medium", "contrast"), issue("low", "contrast")]), "1.0.0");
  assert.deepEqual(summaryOutputs(json), {
    passed: "false",
    failing: "1",
    high: "1",
    medium: "1",
    low: "1",
    "could-not-run": "0",
    "retests-failing": "0",
    "worth-a-look": "0",
  });
  assert.equal(summaryOutputs(null), null);
  assert.equal(summaryOutputs({}), null);
  // The worth-a-look count is its own output, and moves none of the others.
  const looks = toSummaryJson(fullResult(lookRoute, "low"), "1.0.0");
  const plain = toSummaryJson(fullResult(plainRoute, "low"), "1.0.0");
  const { "worth-a-look": lookCount, ...lookRest } = summaryOutputs(looks)!;
  const { "worth-a-look": plainCount, ...plainRest } = summaryOutputs(plain)!;
  assert.equal(lookCount, "2");
  assert.equal(plainCount, "0");
  assert.deepEqual(lookRest, plainRest);
  // A check.json written before the tier existed has no list, and reads as none.
  const { worthALook: _dropped, ...older } = looks as Record<string, unknown>;
  assert.equal(summaryOutputs(older)?.["worth-a-look"], "0");
  // Every output it sets is declared in action.yml, read from the run step, and listed for the no-verdict case.
  const declared = action.outputs as Record<string, { value: string }>;
  assert.deepEqual(Object.keys(summaryOutputs(json)!).sort(), [...SUMMARY_OUTPUT_NAMES].sort());
  for (const name of SUMMARY_OUTPUT_NAMES) assert.equal(declared[name]?.value, `\${{ steps.run.outputs.${name} }}`, name);
});

test("action: third-party steps are pinned by commit, and no input is pasted into a script", () => {
  const steps = action.runs.steps as Array<{ uses?: string; run?: string }>;
  const source = fs.readFileSync(path.join(REPO, "action.yml"), "utf8");
  for (const s of steps.filter((s) => s.uses)) {
    assert.match(s.uses!, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${s.uses} is not pinned to a full commit SHA`);
    assert.ok(new RegExp(`${s.uses!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} # v\\d`).test(source), `${s.uses} has no "# vX" comment naming its version`);
  }
  // `${{ }}` inside `run:` is substituted before the shell parses it: an input would become code.
  for (const s of steps.filter((s) => s.run)) assert.ok(!s.run!.includes("${{"), `a run: script interpolates an expression:\n${s.run}`);
});

test("action: this repository runs it against the demo app, gated by the required check, and never uploads the demo's SARIF here", () => {
  const workflow = readYaml(".github/workflows/test.yml");
  assert.ok(readYaml(".github/workflows/release.yml").jobs, "release.yml parses");
  const jobs = workflow.jobs as Record<string, { needs?: string[]; steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
  const found = Object.entries(jobs).find(([, j]) => j.steps?.some((s) => s.uses === "./"));
  assert.ok(found, "no job in test.yml runs the local action (uses: ./)");
  const [name, job] = found;
  assert.ok(jobs.test.needs?.includes(name), `the required "test" job does not need ${name}`);
  const uses = job.steps!.filter((s) => s.uses === "./");
  assert.ok(uses.length >= 2, "the default gate and a stricter one");
  for (const s of uses) {
    assert.equal(String(s.with?.["upload-sarif"]), "false", "the demo's seeded defects must never become this repository's code-scanning alerts");
    assert.equal(s.with?.cli, "dist/cli.js", "the dogfood runs the CLI built from this commit, not the published one");
  }
});

// ---------------------------------------------------------------------------
// Saved flows (engine/flow.ts): the file format, the matching rules, and how a
// replay becomes issues and a verdict. The replay itself is in the smoke suite.
// ---------------------------------------------------------------------------

const FLOW = {
  name: "open details",
  steps: [
    { action: "navigate", target: "/things" },
    { action: "click", target: 'role=button[name="Show details"]' },
    { action: "type", target: "label=Search", value: "abc", pressEnter: true },
    { action: "select", target: "testid=sort", value: "newest" },
    { action: "press", value: "Escape" },
    { action: "expect-text", text: "Details loaded" },
    { action: "expect-url", pattern: "^/things(\\?|$)" },
    { action: "expect-request", request: "GET /api/things/*", status: "2xx" },
  ],
};

test("flows: a valid flow parses, and takes its file name when it names itself nothing", () => {
  const parsed = parseFlow(JSON.stringify(FLOW), "details.json");
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.flow.name, "open details");
  assert.equal(parsed.flow.steps.length, 8);
  const unnamed = parseFlow(JSON.stringify({ steps: FLOW.steps }), "details.json");
  assert.ok(unnamed.ok && unnamed.flow.name === "details");
});

test("flows: every mistake names the file and the field", () => {
  const bad = (steps: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ steps, ...extra });
  const nav = { action: "navigate", target: "/" };
  const cases: Array<[string, RegExp]> = [
    ["{ not json", /^f\.json: not valid JSON/],
    [bad([]), /^f\.json: steps needs at least one step/],
    [
      bad([nav, { action: "hover", target: "testid=x" }]),
      /^f\.json: steps\[1\]\.action must be one of navigate, click, type, select, press, expect-text, expect-url, expect-request/,
    ],
    [bad([nav, { action: "click" }]), /^f\.json: steps\[1\]\.target is required/],
    [bad([nav, { action: "click", target: "#save" }]), /^f\.json: steps\[1\]\.target must be testid=…, text=…, label=… or role=/],
    [bad([nav, { action: "click", tragte: "testid=x", target: "testid=x" }]), /^f\.json: steps\[1\] unknown field\(s\) "tragte"/],
    [bad([{ action: "click", target: "testid=x" }]), /^f\.json: steps\[0\]\.action must be "navigate"/],
    [bad([{ action: "navigate", target: "https://elsewhere.example/" }]), /^f\.json: steps\[0\]\.target must be a path on the app/],
    [bad([nav, { action: "expect-url", pattern: "(" }]), /^f\.json: steps\[1\]\.pattern is not a valid regular expression/],
    [bad([nav, { action: "expect-request", request: "/api/x", status: 200 }]), /^f\.json: steps\[1\]\.request must be a method and a path/],
    [bad([nav, { action: "expect-request", request: "GET /api/x", status: "ok" }]), /^f\.json: steps\[1\]\.status/],
    [bad([nav, { action: "type", target: "label=Name" }]), /^f\.json: steps\[1\]\.value is required/],
    [bad([nav], { steps2: [] }), /^f\.json: \(the whole file\) unknown field\(s\) "steps2"/],
    [bad(Array.from({ length: 51 }, () => nav)), /^f\.json: steps holds at most 50 steps/],
  ];
  for (const [text, re] of cases) {
    const parsed = parseFlow(text, "f.json");
    assert.ok(!parsed.ok, text);
    assert.match(parsed.error, re, text);
  }
});

test("flows: targets are scout_run_plan's, plus role with an optional name", () => {
  assert.deepEqual(parseTarget("testid=save"), { by: "testid", value: "save" });
  assert.deepEqual(parseTarget("text=Saved!"), { by: "text", value: "Saved!" });
  assert.deepEqual(parseTarget("label=Email address"), { by: "label", value: "Email address" });
  assert.deepEqual(parseTarget("role=button"), { by: "role", role: "button" });
  assert.deepEqual(parseTarget('role=button[name="Save draft"]'), { by: "role", role: "button", name: "Save draft" });
  assert.deepEqual(parseTarget("role=Link[name='Next page']"), { by: "role", role: "link", name: "Next page" });
  assert.deepEqual(parseTarget("role=tab[name=Settings]"), { by: "role", role: "tab", name: "Settings" });
  for (const bad of ["", "testid=", "#save", "role=", "role=button[label=x]", "css=.save"]) assert.equal(parseTarget(bad), null, bad);
});

test("flows: a URL pattern sees the path, query and hash, never the origin", () => {
  assert.ok(urlMatches("^/things/\\d+$", "http://127.0.0.1:3000/things/42"));
  assert.ok(urlMatches("^/things/\\d+$", "https://preview-7.example.com/things/42"));
  assert.ok(urlMatches("tab=open", "http://x/things?tab=open"));
  assert.ok(!urlMatches("^127", "http://127.0.0.1:3000/"));
  assert.ok(!urlMatches("^/things/\\d+$", "http://x/things/new"));
});

test("flows: an expected request matches by method and path, with * for one segment and a status or a class", () => {
  assert.ok(requestPathMatches("/api/things/*", "/api/things/42"));
  assert.ok(requestPathMatches("/api/things/", "/api/things"));
  assert.ok(!requestPathMatches("/api/things/*", "/api/things/42/notes"));
  assert.ok(!requestPathMatches("/api/things", "/api/thing"));
  assert.ok(statusMatches(200, 200) && !statusMatches(200, 201));
  assert.ok(statusMatches("2xx", 204) && !statusMatches("2xx", 304));
  const seen = [
    { method: "GET", url: "http://x/api/things/42?full=1", status: 500 },
    { method: "POST", url: "http://x/api/things/42", status: 200 },
  ];
  assert.deepEqual(matchRequest({ request: "POST /api/things/*", status: 200 }, seen), { ok: true });
  assert.deepEqual(matchRequest({ request: "GET /api/things/*", status: "2xx" }, seen), { ok: false, reason: "GET /api/things/* answered 500, expected 2xx" });
  assert.deepEqual(matchRequest({ request: "GET /api/other", status: 200 }, seen), {
    ok: false,
    reason: "no GET /api/other request was sent since the last action",
  });
});

test("flows: the directory is the one named, none when off, and otherwise the project's own when it exists", () => {
  const own = path.join("/p", ".scenescout", "flows");
  assert.deepEqual(
    resolveFlowsDir(undefined, "/p", (d) => d === own),
    { dir: own },
  );
  assert.deepEqual(
    resolveFlowsDir(undefined, "/p", () => false),
    { dir: null },
  );
  assert.deepEqual(
    resolveFlowsDir("off", "/p", () => true),
    { dir: null },
  );
  assert.deepEqual(
    resolveFlowsDir("/ci/flows", "/p", () => true),
    { dir: "/ci/flows" },
  );
  // Named and missing is a mistake, not a check with no flows.
  assert.deepEqual(
    resolveFlowsDir("/ci/flows", "/p", () => false),
    { error: "--flows: no directory at /ci/flows" },
  );
});

test("flows: a directory is read in name order, other files are left alone, and one bad flow stops it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-flows-"));
  try {
    fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify({ steps: [{ action: "navigate", target: "/b" }] }));
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ steps: [{ action: "navigate", target: "/a" }] }));
    fs.writeFileSync(path.join(dir, "notes.md"), "not a flow");
    assert.deepEqual(
      loadFlows(dir).flows.map((f) => f.file),
      ["a.json", "b.json"],
    );
    fs.writeFileSync(path.join(dir, "c.json"), JSON.stringify({ steps: [{ action: "click", target: "testid=x" }] }));
    assert.throws(() => loadFlows(dir), /^Error: flow c\.json: steps\[0\]\.action must be "navigate"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function flowRun(over: Partial<FlowRun> = {}): FlowRun {
  return {
    name: "open details",
    file: "details.json",
    steps: 4,
    outcome: { status: "passed" },
    violations: [],
    refusedBackground: [],
    websockets: [],
    ...over,
  };
}
const BROKE: FlowRun["outcome"] = {
  status: "failed",
  step: 3,
  did: 'expect text "Details loaded"',
  reason: 'no visible text "Details loaded" within 5s',
  path: "/things",
};

test("flows: a broken step is a high issue naming the flow and the step, and fails the default gate; a flow that passed adds nothing", () => {
  const broke = issuesFromRoutes([route()], ORIGIN, [], [flowRun({ outcome: BROKE })]);
  assert.deepEqual(
    broke.map((i) => [i.rule, i.severity, i.evidence, i.routes]),
    [
      [
        "flow-step-failed",
        "high",
        'flow "open details" (details.json) step 3 of 4, expect text "Details loaded": no visible text "Details loaded" within 5s',
        ["/things"],
      ],
    ],
  );
  assert.equal(gateFailures(broke, "high").length, 1);
  const passed = issuesFromRoutes([route()], ORIGIN, [], [flowRun()]);
  assert.deepEqual(passed, []);
  assert.deepEqual(issuesFromRoutes([route()], ORIGIN, ["flow-step-failed"], [flowRun({ outcome: BROKE })]), []);
});

test("flows: what the oracles caught during a flow goes through the page rules, and is one issue with the same failure on a crawled page", () => {
  const v = { kind: "http_error" as const, severity: "high" as const, detail: httpErrorDetail("GET", `${ORIGIN}/api/things/42`, 500), url: `${ORIGIN}/things` };
  const issues = issuesFromRoutes([route({ path: "/", violations: [v] })], ORIGIN, [], [flowRun({ violations: [{ path: "/things", violation: v }] })]);
  assert.deepEqual(
    issues.map((i) => [i.rule, i.evidence, i.routes]),
    [["server-error", "GET /api/things/42 → HTTP 500", ["/", "/things"]]],
  );
});

const REFUSED = flowRun({
  name: "add",
  file: "add.json",
  steps: 2,
  outcome: { status: "refused", step: 2, did: "click testid=add", reason: "the observe write policy refused POST /api/things", path: "/things" },
});

test("flows: a refused step is no issue about the app, and says which setting refused it", () => {
  assert.deepEqual(issuesFromRoutes([route()], ORIGIN, [], [REFUSED]), []);
  const never = { flows: [flowRun(), REFUSED], mode: "read-only" as const, settings: { ...DEFAULT_SETTINGS } };
  assert.match(
    refusedFlowReason(never) ?? "",
    /^flow "add" \(add\.json\) step 2 of 2, click testid=add: the observe write policy refused POST \/api\/things\. Flows replay with --flow-writes never, so no step may send a write whatever --mode says/,
  );
  assert.match(
    refusedFlowReason({ ...never, settings: { ...DEFAULT_SETTINGS, flowWrites: "allow" } }) ?? "",
    /Flows replay under --mode read-only, which refuses that write/,
  );
  assert.equal(refusedFlowReason({ ...never, flows: [flowRun(), flowRun({ outcome: BROKE })] }), null);
});

test("on-refused-step report: the flow is marked could not run, everything else keeps its verdict, and the exit code is 2", () => {
  const passedRest: CheckResult = { ...result([]), flows: [flowRun({ name: "details" }), REFUSED] };
  assert.equal(summarise(passedRest).passed, true, "the rest passed");
  assert.equal(summarise(passedRest).couldNotRun, 1);
  assert.equal(exitCodeOf(passedRest), 2);
  const md = formatCheck(passedRest);
  assert.match(md, /\*\*COULD NOT RUN\*\* — 1 flow\(s\) had a step refused \(see Flows\); the rest passed — /);
  assert.match(
    md,
    /- ⊘ add \(`add\.json`\): could not run — step 2 of 2, click testid=add: the observe write policy refused POST \/api\/things _\(--flow-writes never\)_/,
  );
  assert.match(md, /- ✓ details/);
  const failedRest: CheckResult = { ...result([issue("high")]), flows: [REFUSED] };
  assert.match(formatCheck(failedRest), /\*\*COULD NOT RUN\*\* — .*the rest failed — 1 issue/);
  assert.equal(exitCodeOf(failedRest), 2, "incomplete outranks the gate");
  const json = toSummaryJson(passedRest, "1.0.0") as { gate: { passed: boolean; couldNotRun: number } };
  assert.deepEqual([json.gate.passed, json.gate.couldNotRun], [true, 1]);
  const sarif = toSarif(passedRest, "1") as {
    runs: Array<{ invocations: Array<{ executionSuccessful: boolean; toolExecutionNotifications: Array<{ message: { text: string } }> }>; results: unknown[] }>;
  };
  const inv = sarif.runs[0].invocations[0];
  assert.equal(inv.executionSuccessful, false);
  assert.match(inv.toolExecutionNotifications[0].message.text, /^Could not run: flow "add" \(add\.json\) step 2 of 2/);
  assert.deepEqual(sarif.runs[0].results, [], "a flow that could not run is not a result about the app");
  // With nothing refused the run is complete, and the exit code is the gate's.
  const whole: CheckResult = { ...result([]), flows: [flowRun()] };
  assert.equal(exitCodeOf(whole), 0);
  assert.equal((toSarif(whole, "1") as typeof sarif).runs[0].invocations[0].executionSuccessful, true);
  assert.equal(exitCodeOf(result([issue("high")])), 1);
});

test("settings: the report and check.json say what the check was allowed to do", () => {
  const r = result([]);
  assert.equal(describeSettings(r), "flow writes: never (flows replay under observe) · refused step: report · re-tests: on, gating those filed high");
  assert.equal(
    describeSettings({ ...r, settings: { flowWrites: "allow", onRefusedStep: "stop", gateRetests: "all", retest: true } }),
    "flow writes: allow (flows replay under read-only) · refused step: stop · re-tests: on, gating every one still reproducing",
  );
  assert.match(describeSettings({ ...r, settings: { ...DEFAULT_SETTINGS, retest: false } }), /re-tests: off$/);
  assert.match(formatCheck(r), /^Settings — flow writes: never/m);
  assert.deepEqual((toSummaryJson(r, "1") as { settings: unknown }).settings, DEFAULT_SETTINGS);
});

test("flows: the report and check.json say how each flow went", () => {
  const r: CheckResult = {
    ...result(issuesFromRoutes([], ORIGIN, [], [flowRun({ outcome: BROKE })])),
    flows: [flowRun({ name: "listed" }), flowRun({ outcome: BROKE })],
  };
  const md = formatCheck(r);
  assert.match(md, /## Flows \(2\)/);
  assert.match(md, /- ✓ listed \(`details\.json`\): 4 step\(s\) passed/);
  assert.match(md, /- ✗ open details \(`details\.json`\): step 3 of 4, expect text "Details loaded": no visible text/);
  assert.match(md, /\*\*FAILED\*\*/);
  const json = toSummaryJson(r, "1.0.0") as { flows: unknown[] };
  assert.deepEqual(json.flows, [
    { name: "listed", file: "details.json", steps: 4, status: "passed", refusedBackground: [], websockets: [] },
    {
      name: "open details",
      file: "details.json",
      steps: 4,
      status: "failed",
      step: 3,
      did: 'expect text "Details loaded"',
      reason: 'no visible text "Details loaded" within 5s',
      path: "/things",
      refusedBackground: [],
      websockets: [],
    },
  ]);
});

test("flows: a token in a flow's page or request URL is redacted before anything is written", () => {
  const v = { kind: "http_error" as const, severity: "high" as const, detail: "GET /x → HTTP 500", url: `${ORIGIN}/reset?token=Q7x9Rt2mLp4VzK8w` };
  const [clean] = redactFlowRuns([
    flowRun({
      outcome: { ...BROKE, did: "navigate /reset?token=Q7x9Rt2mLp4VzK8w", path: "/reset?token=Q7x9Rt2mLp4VzK8w" } as FlowRun["outcome"],
      violations: [{ path: "/reset?token=Q7x9Rt2mLp4VzK8w", violation: v }],
      refusedBackground: ["POST https://collector.example/c?token=Q7x9Rt2mLp4VzK8w"],
      websockets: ["wss://live.example/socket?token=Q7x9Rt2mLp4VzK8w"],
    }),
  ]);
  assert.ok(!JSON.stringify(clean).includes("Q7x9Rt2mLp4VzK8w"), JSON.stringify(clean));
  // Everything written from it: the report, check.json and the SARIF.
  const r: CheckResult = { ...result(issuesFromRoutes([], ORIGIN, [], [clean])), flows: [clean] };
  const written = formatCheck(r) + JSON.stringify(toSummaryJson(r, "1")) + JSON.stringify(toSarif(r, "1"));
  assert.ok(written.includes("navigate /reset?token=[redacted]"), written);
  assert.ok(!written.includes("Q7x9Rt2mLp4VzK8w"), written);
});

test("flows: the flows directory is the one part of .scenescout/ that git does not ignore", (t) => {
  const git = spawnSync("git", ["--version"]);
  if (git.status !== 0) return t.skip("git is not installed");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "scout-ignore-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const dir = path.join(repo, ".scenescout");
    fs.mkdirSync(path.join(dir, "flows"), { recursive: true });
    writeSelfIgnore(dir);
    for (const f of ["memory.json", "flows/notes.txt", "flows/sign-in.json"]) fs.writeFileSync(path.join(dir, f), "{}");
    const untracked = spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    assert.equal(untracked, "?? .scenescout/flows/sign-in.json");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Re-testing open findings (engine/verify.ts): which ones a page load can
// reproduce, and what a load says about each.
// ---------------------------------------------------------------------------

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    severity: "high",
    category: "http-error",
    title: "Summary widget fails to load",
    detail: "",
    evidence: "GET /api/summary 500",
    url: `${ORIGIN}/dashboard?range=week`,
    state: "/dashboard#x",
    repro: [`crawl /dashboard?range=week @ ${ORIGIN}/dashboard?range=week`, `snapshot @ ${ORIGIN}/dashboard?range=week`],
    foundAt: "2026-09-01T00:00:00.000Z",
    runs: 1,
    ...over,
  };
}

test("retest: only a failed GET whose page was only looked at can be re-tested by loading the page", () => {
  const plan = (f: Finding) => checkRetestPlan([f]).candidates;
  assert.deepEqual(
    plan(finding()).map((c) => [c.path, c.signatures]),
    [["/dashboard?range=week", ["GET /api/summary 500"]]],
  );
  // How the page was reached is not part of the reproduction: only what happened on it.
  assert.equal(plan(finding({ repro: [`click Reports @ ${ORIGIN}/dashboard`, `design-audit @ ${ORIGIN}/dashboard`] })).length, 1);
  const refused: Array<[string, Partial<Finding>]> = [
    ["a click on the page", { repro: [`navigate @ ${ORIGIN}/dashboard`, `click Refresh @ ${ORIGIN}/dashboard`] }],
    ["a plan step on the page", { repro: [`navigate @ ${ORIGIN}/dashboard`, `plan:type label=Search @ ${ORIGIN}/dashboard`] }],
    ["a replayed request", { repro: [`navigate @ ${ORIGIN}/dashboard`, `request GET /api/summary @ ${ORIGIN}/dashboard`] }],
    ["an action it does not know", { repro: [`navigate @ ${ORIGIN}/dashboard`, `something-new @ ${ORIGIN}/dashboard`] }],
    ["no repro at all", { repro: [] }],
    ["a failed POST", { evidence: "POST /api/summary 500" }],
    ["a GET and a POST", { evidence: "GET /api/summary 500 after POST /api/refresh 500" }],
    ["no status", { evidence: "GET /api/summary" }],
    ["no request", { evidence: "widget summary shows 0" }],
    ["a redacted secret in its URL", { url: `${ORIGIN}/reset?token=[redacted] [1 secret redacted]` }],
    ["resolved", { status: "resolved" }],
  ];
  for (const [why, over] of refused) assert.deepEqual(plan(finding(over)), [], why);
  assert.equal(checkRetestPlan([finding(), finding({ id: "f2", status: "resolved" }), finding({ id: "f3", evidence: "copy is unclear" })]).open, 2);
});

const page = (over: Partial<MeasuredPage> = {}): MeasuredPage => ({
  path: "/dashboard?range=week",
  status: 200,
  loginRedirect: false,
  httpErrors: [],
  ...over,
});

test("retest: the same failure on load reproduces it; a clean load says possibly fixed; no load says nothing", () => {
  const [c] = checkRetestPlan([finding()]).candidates;
  const verdict = (pages: MeasuredPage[]) => retestResults([c], pages)[0];
  assert.equal(verdict([page({ httpErrors: [httpErrorDetail("GET", `${ORIGIN}/api/summary?x=1`, 500)] })]).verdict, "reproduces");
  // Another status on the same request is a different failure: not this finding reproducing.
  assert.equal(verdict([page({ httpErrors: [httpErrorDetail("GET", `${ORIGIN}/api/summary`, 404)] })]).verdict, "possibly-fixed");
  assert.equal(verdict([page()]).verdict, "possibly-fixed");
  assert.deepEqual(
    [verdict([]), verdict([page({ status: null, loadError: "net::ERR_CONNECTION_RESET" })]), verdict([page({ loginRedirect: true })])].map((r) => [
      r.verdict,
      r.note,
    ]),
    [
      ["not-reached", "the page was not visited"],
      ["not-reached", "the page did not load"],
      ["not-reached", "the page sent the browser to sign-in"],
    ],
  );
  // The document's own status is not among the violations the check keeps, so it is read from the route.
  const [own] = checkRetestPlan([finding({ evidence: "GET /dashboard 500" })]).candidates;
  assert.equal(retestResults([own], [page({ status: 500 })])[0].verdict, "reproduces");
});

const RETESTS: NonNullable<CheckResult["retest"]> = {
  open: 4,
  results: [
    { id: "f1", severity: "high", title: "Summary widget fails to load", path: "/dashboard", signatures: ["GET /api/summary 500"], verdict: "reproduces" },
    { id: "f2", severity: "medium", title: "Avatar 404", path: "/", signatures: ["GET /img/a.png 404"], verdict: "reproduces" },
    { id: "f3", severity: "high", title: "Feed fails", path: "/feed", signatures: ["GET /api/feed 500"], verdict: "possibly-fixed" },
  ],
};

test("gate-retests: high gates a still-reproducing finding filed high, all gates every one, never gates none; possibly fixed never does", () => {
  const at = (gateRetests: GateRetests, failOn: CheckResult["failOn"] = "high"): CheckResult => ({
    ...result([], failOn),
    retest: RETESTS,
    settings: { ...DEFAULT_SETTINGS, gateRetests },
  });
  assert.deepEqual(
    retestGateFailures(at("high")).map((r) => r.id),
    ["f1"],
  );
  assert.deepEqual(
    retestGateFailures(at("all")).map((r) => r.id),
    ["f1", "f2"],
  );
  assert.deepEqual(retestGateFailures(at("never")), []);
  // --fail-on never reports only, re-tests included.
  assert.deepEqual(retestGateFailures(at("all", "never")), []);
  assert.deepEqual([summarise(at("high")).passed, summarise(at("high")).failing, summarise(at("high")).retestsFailing], [false, 1, 1]);
  assert.equal(exitCodeOf(at("high")), 1);
  assert.equal(summarise(at("never")).passed, true);
  assert.equal(exitCodeOf(at("never")), 0);
  const md = formatCheck(at("high"));
  assert.match(md, /\*\*FAILED\*\* — 1 failing the gate \(0 issue\(s\), 1 re-tested finding\(s\)\)/);
  assert.match(md, /\[high\] Summary widget fails to load \(f1\) on `\/dashboard`: still reproduces — \*\*fails the gate\*\*/);
  assert.match(md, /\[medium\] Avatar 404 \(f2\) on `\/`: still reproduces — `GET/);
  assert.match(md, /\[high\] Feed fails \(f3\) on `\/feed`: possibly fixed/);
  assert.match(md, /1 open finding\(s\) need an interaction to reproduce/);
  const sarif = toSarif(at("high"), "1") as {
    runs: Array<{ results: Array<{ ruleId: string; message: { text: string } }>; tool: { driver: { rules: Array<{ id: string }> } } }>;
  };
  assert.deepEqual(
    sarif.runs[0].results.map((x) => x.ruleId),
    ["open-finding-reproduces"],
  );
  assert.ok(sarif.runs[0].tool.driver.rules.some((x) => x.id === "open-finding-reproduces"));
  assert.deepEqual((toSarif(at("never"), "1") as typeof sarif).runs[0].results, []);
  assert.deepEqual((toSummaryJson(at("high"), "1.0.0") as { retest: unknown }).retest, RETESTS);
});

test("retest: a hand-edited memory entry the rules cannot read is left out, not a crash", () => {
  const good = finding();
  const kept = wellFormedFindings([
    good,
    null,
    "x",
    { ...good, id: 7 },
    { ...good, evidence: 500 },
    { ...good, repro: "crawl /" },
    { ...good, url: undefined },
  ]);
  assert.deepEqual(kept, [good]);
  assert.equal(checkRetestPlan(kept).candidates.length, 1);
});

test("action: a partly-run check names the flow that could not run and what the rest found; a true no-verdict exit keeps its message", () => {
  const error =
    'could not run a saved flow: flow "add" (add.json) step 2 of 2, click testid=add: the observe write policy refused POST /api/things. Flows replay with --flow-writes never';
  const restPassed = verdict({ exitCode: "2", failOn: "high", url: "http://x", error, passed: "true", failing: "0", couldNotRun: "1" });
  assert.equal(restPassed.exit, 2);
  assert.match(
    restPassed.annotation ?? "",
    /^::error title=SceneScout check could not run 1 flow\(s\)::On http:\/\/x: flow "add" \(add\.json\) step 2 of 2, click testid=add: the observe write policy refused POST \/api\/things\. .* The rest of the check passed\. The report is on the job summary/,
  );
  assert.ok(!/No verdict|setup problem/.test(restPassed.annotation ?? ""), restPassed.annotation ?? "");
  const restFailed = verdict({ exitCode: "2", failOn: "medium", url: "http://x", error, passed: "false", failing: "3", couldNotRun: "1" });
  assert.match(restFailed.annotation ?? "", /The rest of the check failed: 3 issue\(s\) at medium severity or worse\./);
  // No check.json (the outputs are empty), or one with nothing that could not run: the check had no verdict at all.
  for (const partial of [
    { passed: "", couldNotRun: "" },
    { passed: "true", couldNotRun: "0" },
  ]) {
    const none = verdict({ exitCode: "2", failOn: "high", url: "http://x", error: "Could not load http://x", ...partial });
    assert.match(
      none.annotation ?? "",
      /^::error title=SceneScout check could not run::No verdict for http:\/\/x: Could not load http:\/\/x\. This is a setup problem/,
      JSON.stringify(partial),
    );
  }
  // check.json's couldNotRun reaches the step's outputs, and a missing field reads as none.
  const json = toSummaryJson({ ...result([]), flows: [REFUSED] }, "1.0.0");
  assert.equal(summaryOutputs(json)?.["could-not-run"], "1");
  assert.equal(summaryOutputs({ gate: { passed: true }, counts: {} })?.["could-not-run"], "0");
});

test("action: the verdict step is handed what a partly-run message needs", () => {
  const steps = action.runs.steps as Array<{ name: string; env?: Record<string, string> }>;
  const env = steps.find((s) => s.name === "Verdict")!.env ?? {};
  assert.equal(env.PASSED, "${{ steps.run.outputs.passed }}");
  assert.equal(env.COULD_NOT_RUN, "${{ steps.run.outputs.could-not-run }}");
});

test("flows: a role target must name an ARIA role, so a typo stops the check when the file is read", () => {
  const flow = (target: string) =>
    JSON.stringify({
      steps: [
        { action: "navigate", target: "/" },
        { action: "click", target },
      ],
    });
  const typo = parseFlow(flow('role=buton[name="Save"]'), "f.json");
  assert.ok(!typo.ok);
  assert.match(typo.error, /^f\.json: steps\[1\]\.target names the role "buton", which is not an ARIA role/);
  for (const ok of ['role=button[name="Save"]', "role=link", "role=textbox[name=Email]", "role=tab"]) assert.ok(parseFlow(flow(ok), "f.json").ok, ok);
});

test("flows: a refused beacon or ping is listed, not charged to the step, whatever its origin; every other refused write is charged, wherever it goes", () => {
  const app = "http://127.0.0.1:4173";
  assert.deepEqual(
    splitRefusals(
      [
        { sig: `POST ${app}/api/things`, type: "fetch" },
        // An API on another port is still the step's write.
        { sig: "POST http://127.0.0.1:5999/api/things", type: "fetch" },
        { sig: "POST http://127.0.0.1:5999/collect", type: "xhr" },
        { sig: `navigation to ${app}/submit`, type: "document" },
        { sig: "POST http://127.0.0.1:5999/beacon", type: "ping" },
        { sig: `POST ${app}/beacon`, type: "beacon" },
        { sig: "POST (no kind recorded)" },
      ],
      app,
    ),
    {
      charged: [
        "POST /api/things",
        "POST http://127.0.0.1:5999/api/things",
        "POST http://127.0.0.1:5999/collect",
        "navigation to /submit",
        "POST (no kind recorded)",
      ],
      background: ["POST http://127.0.0.1:5999/beacon", `POST ${app}/beacon`],
    },
  );
  const r: CheckResult = {
    ...result([]),
    flows: [flowRun({ refusedBackground: ["POST http://127.0.0.1:5999/beacon"], websockets: ["ws://127.0.0.1:4173/live"] })],
  };
  const md = formatCheck(r);
  assert.match(md, /refused background requests \(beacons and pings, not charged to a step\): `POST http:\/\/127\.0\.0\.1:5999\/beacon`/);
  assert.match(md, /WebSocket connections opened \(not covered by the write rule\): `ws:\/\/127\.0\.0\.1:4173\/live`/);
  assert.equal(exitCodeOf(r), 0, "a refused beacon alone leaves the flow passed");
  const json = toSummaryJson(r, "1") as { flows: Array<{ refusedBackground: string[]; websockets: string[] }> };
  assert.deepEqual([json.flows[0].refusedBackground, json.flows[0].websockets], [["POST http://127.0.0.1:5999/beacon"], ["ws://127.0.0.1:4173/live"]]);
});

test("flows: what else is in the flows directory is listed as skipped with its reason; a link is followed only inside the directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scout-skip-"));
  try {
    const dir = path.join(root, "flows");
    fs.mkdirSync(path.join(dir, "old"), { recursive: true });
    const valid = JSON.stringify({ steps: [{ action: "navigate", target: "/" }] });
    fs.writeFileSync(path.join(dir, "a.json"), valid);
    fs.writeFileSync(path.join(dir, "README.md"), "notes");
    fs.writeFileSync(path.join(root, "outside.json"), valid);
    fs.symlinkSync(path.join(dir, "a.json"), path.join(dir, "b.json"));
    fs.symlinkSync(path.join(root, "outside.json"), path.join(dir, "c.json"));
    fs.symlinkSync(path.join(root, "missing.json"), path.join(dir, "d.json"));
    const { flows, skipped } = loadFlows(dir);
    assert.deepEqual(
      flows.map((f) => f.file),
      ["a.json", "b.json"],
    );
    assert.deepEqual(skipped, [
      { file: "README.md", reason: "not a .json file" },
      { file: "c.json", reason: "a symbolic link to a file outside the flows directory" },
      { file: "d.json", reason: "a symbolic link to nothing" },
      { file: "old", reason: "a directory: flows are not read from subdirectories" },
    ]);
    const md = formatCheck({ ...result([]), skippedFlows: skipped });
    assert.match(md, /- skipped `c\.json`: a symbolic link to a file outside the flows directory/);
    assert.deepEqual((toSummaryJson({ ...result([]), skippedFlows: skipped }, "1") as { skippedFlows: unknown }).skippedFlows, skipped);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retest: pages loaded only to re-test are counted in the report, apart from the routes", () => {
  const r: CheckResult = { ...result([]), retest: { open: 1, extraPages: 2, results: [] } };
  assert.match(
    formatCheck(r),
    /2 page\(s\) were loaded only to re-test these findings; they are not in the routes above and no page rule was applied to them\./,
  );
});

test("action: the annotation says what failing counts when re-tested findings are in it", () => {
  // --gate-retests all: 3 failing, 2 of them re-tested findings, 1 an issue.
  const failed = verdict({ exitCode: "1", failing: "3", retestsFailing: "2", failOn: "high", url: "http://x" });
  assert.match(
    failed.annotation ?? "",
    /::3 failing the gate \(1 issue\(s\) at high severity or worse, 2 re-tested finding\(s\) still reproducing\) on http:\/\/x\./,
  );
  // No re-tests in the gate: the sentence is the one it always was.
  assert.match(
    verdict({ exitCode: "1", failing: "3", retestsFailing: "0", failOn: "high", url: "http://x" }).annotation ?? "",
    /::3 issue\(s\) at high severity or worse on http/,
  );
  const partial = verdict({ exitCode: "2", failing: "2", retestsFailing: "2", failOn: "high", url: "http://x", error: "x", passed: "false", couldNotRun: "1" });
  assert.match(
    partial.annotation ?? "",
    /The rest of the check failed: 2 failing the gate \(0 issue\(s\) at high severity or worse, 2 re-tested finding\(s\) still reproducing\)/,
  );
  const r: CheckResult = {
    ...result([]),
    retest: { open: 1, results: [{ id: "f", severity: "high", title: "t", path: "/", signatures: ["GET /x 500"], verdict: "reproduces" }] },
  };
  assert.equal(summaryOutputs(toSummaryJson(r, "1"))?.["retests-failing"], "1");
  const steps = action.runs.steps as Array<{ name: string; env?: Record<string, string> }>;
  assert.equal(steps.find((s) => s.name === "Verdict")!.env?.RETESTS_FAILING, "${{ steps.run.outputs.retests-failing }}");
});

test("SARIF: a gating re-test's level is the severity its finding was filed at", () => {
  const at = (severity: string): string => {
    const r: CheckResult = {
      ...result([]),
      retest: { open: 1, results: [{ id: "f", severity, title: "t", path: "/", signatures: ["GET /x 500"], verdict: "reproduces" }] },
      settings: { ...DEFAULT_SETTINGS, gateRetests: "all" },
    };
    return (toSarif(r, "1") as { runs: Array<{ results: Array<{ level: string }> }> }).runs[0].results[0].level;
  };
  assert.deepEqual(["high", "medium", "low", "critical"].map(at), ["error", "warning", "note", "error"]);
});

// ---------------------------------------------------------------------------
// Visual baselines (engine/baseline.ts): the targets file, where the files
// go, what a baseline records, the verdict, and how an unmet baseline becomes
// an issue. Taking the pictures is in the smoke suite (scripts/smoke/baselines.ts).
// ---------------------------------------------------------------------------

/** A picture of one colour, with pixels painted another where a case says. */
function picture(width: number, height: number, paint: Array<[number, number]> = []): RgbaImage {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (const [x, y] of paint) data.set([200, 30, 30, 255], (y * width + x) * 4);
  return { width, height, data };
}

const PLAN: BaselineTarget = { path: "/plans", element: "testid=plan" };
const capture = (over: Partial<CaptureSettings> = {}): CaptureSettings => ({ ...BASELINE_CAPTURE, ...over });
const storedMeta = (over: Partial<BaselineMeta> = {}, image = picture(10, 10)): BaselineMeta => ({
  ...baselineMeta({
    target: PLAN,
    engine: "chromium",
    platform: "linux",
    capture: capture(),
    size: { width: image.width, height: image.height },
    capturedAt: "2026-10-01T00:00:00.000Z",
  }),
  ...over,
});

test("baselines: a targets file lists a path and an element, and the element defaults to the page", () => {
  const parsed = parseBaselineTargets(
    JSON.stringify({ targets: [{ path: "/" }, { path: "/plans", element: "testid=plan" }, { path: "/plans", element: 'role=button[name="Change plan"]' }] }),
    "targets.json",
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.targets, [
    { path: "/", element: "page" },
    { path: "/plans", element: "testid=plan" },
    { path: "/plans", element: 'role=button[name="Change plan"]' },
  ]);
  // An element is named the way a saved flow names its target; "page" is the viewport.
  assert.equal(elementTarget("page"), null);
  assert.deepEqual(elementTarget("testid=plan"), { by: "testid", value: "plan" });
  assert.deepEqual(elementTarget("label=Email"), { by: "label", value: "Email" });
  assert.equal(elementTarget("#plan"), undefined);
});

test("baselines: every mistake in the targets file names the file and the field", () => {
  const bad = (json: unknown): string => {
    const parsed = parseBaselineTargets(typeof json === "string" ? json : JSON.stringify(json), "targets.json");
    assert.ok(!parsed.ok, JSON.stringify(json));
    return parsed.error;
  };
  const cases: Array<[unknown, RegExp]> = [
    ["{", /^targets\.json: not valid JSON/],
    [{}, /^targets\.json: targets is required/],
    [{ targets: [] }, /^targets\.json: targets lists nothing to keep a baseline of/],
    [{ targets: [{ element: "page" }] }, /^targets\.json: targets\[0\]\.path is required/],
    [{ targets: [{ path: "plans" }] }, /targets\[0\]\.path must be a path on the app, starting with \//],
    [{ targets: [{ path: "/a b" }] }, /targets\[0\]\.path must be a path on the app/],
    [{ targets: [{ path: "/", element: "#save" }] }, /targets\[0\]\.element must be page or testid=…, text=…, label=… or role=/],
    [{ targets: [{ path: "/", element: "role=buton" }] }, /targets\[0\]\.element names the role "buton", which is not an ARIA role/],
    [{ targets: [{ path: "/", elemnt: "page" }] }, /targets\[0\] unknown field\(s\) "elemnt"/],
    [{ targets: [{ path: "/" }], threshold: 1 }, /^targets\.json: \(the whole file\) unknown field\(s\) "threshold"/],
    [{ targets: [{ path: "/" }, { path: "/", element: "page" }] }, /targets\[1\] repeats targets\[0\]/],
    [{ targets: Array.from({ length: MAX_BASELINE_TARGETS + 1 }, (_, i) => ({ path: `/p${i}` })) }, /targets holds at most 100 targets/],
  ];
  for (const [json, message] of cases) assert.match(bad(json), message);
  assert.match(missingTargetsMessage("vis/targets.json"), /^there is no vis\/targets\.json: list the pages and elements .*"element": "testid=profile-card"/);
});

test("baselines: one folder per engine and per route; names that read alike never share a file, and nothing in a name leaves its folder", () => {
  assert.match(routeFolder("/"), /^index-[0-9a-f]{8}$/);
  assert.match(routeFolder("/settings/profile"), /^settings-profile-[0-9a-f]{8}$/);
  assert.notEqual(routeFolder("/a-b"), routeFolder("/a/b"));
  assert.notEqual(routeFolder("/a"), routeFolder("/A"));
  assert.equal(elementFile("page"), "page");
  assert.match(elementFile("testid=plan"), /^testid-plan-[0-9a-f]{8}$/);
  assert.notEqual(elementFile("testid=Plan"), elementFile("testid=plan"), "test ids are case-sensitive");
  for (const hostile of ["/../../etc/passwd", "/..", "/%2e%2e/x", "/" + "x".repeat(300)]) {
    assert.match(routeFolder(hostile), /^[a-z0-9-]{1,57}$/, hostile);
    assert.match(elementFile(`testid=${hostile}`), /^[a-z0-9-]{1,57}$/, hostile);
  }
  const files = baselineFiles("webkit", PLAN);
  assert.equal(files.png, `webkit/${routeFolder("/plans")}/${elementFile("testid=plan")}.png`);
  assert.equal(files.json, files.png.replace(/\.png$/, ".json"));
  assert.notEqual(baselineFiles("chromium", PLAN).png, files.png, "a picture from one browser is never another's baseline");
  assert.deepEqual(visualFiles(PLAN), {
    expected: `visual/${routeFolder("/plans")}/${elementFile("testid=plan")}.expected.png`,
    actual: `visual/${routeFolder("/plans")}/${elementFile("testid=plan")}.actual.png`,
    diff: `visual/${routeFolder("/plans")}/${elementFile("testid=plan")}.diff.png`,
  });
  // Unless a folder is named, baselines stay inside .scenescout/, which git ignores.
  assert.equal(defaultBaselinesDir("/work/app"), path.join("/work/app", ".scenescout", "baselines"));
});

test("baselines: a baseline's JSON says what it is of and how it was taken, and reads back", () => {
  const meta = storedMeta();
  const parsed = parseBaselineMeta(JSON.stringify(meta));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.meta, meta);
  assert.deepEqual(Object.keys(meta.capture).sort(), ["animations", "caret", "deviceScaleFactor", "margin", "reducedMotion", "viewport"]);
  assert.deepEqual(BASELINE_CAPTURE, {
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    margin: 8,
    reducedMotion: "reduce",
    animations: "disabled",
    caret: "hide",
  });
  const bad = parseBaselineMeta(JSON.stringify({ ...meta, capture: { ...meta.capture, viewport: undefined } }));
  assert.ok(!bad.ok && /capture\.viewport is required/.test(bad.error), bad.ok ? "" : bad.error);
  assert.ok(!parseBaselineMeta("{").ok);
});

test("baselines: two pictures are compared only when taken alike; each setting that differs is named", () => {
  assert.deepEqual(captureDifferences(capture(), capture()), []);
  assert.deepEqual(captureDifferences(capture({ viewport: { width: 1440, height: 900 } }), capture()), ["viewport 1440×900 (now 1280×900)"]);
  assert.deepEqual(captureDifferences(capture({ deviceScaleFactor: 2, margin: 0 }), capture()), ["device scale 2 (now 1)", "margin 0px (now 8px)"]);
  assert.deepEqual(captureDifferences(capture({ animations: "allow", caret: "initial" }), capture()), [
    "animations allow (now disabled)",
    "caret initial (now hide)",
  ]);
});

test("baselines: a stored baseline is usable, absent, or unusable with the reason — never silently either of the others", () => {
  const image = picture(10, 10);
  const png = encodePng(image);
  const json = JSON.stringify(storedMeta());
  assert.equal(readStoredBaseline(PLAN, "chromium", null, null), null);
  const usable = readStoredBaseline(PLAN, "chromium", png, json);
  assert.ok(usable && "image" in usable && usable.image.width === 10 && usable.meta.element === "testid=plan");
  const problem = (stored: ReturnType<typeof readStoredBaseline>): string =>
    stored && "problem" in stored ? stored.problem : `not a problem: ${JSON.stringify(stored)}`;
  assert.match(problem(readStoredBaseline(PLAN, "chromium", null, json)), /its PNG is missing/);
  assert.match(problem(readStoredBaseline(PLAN, "chromium", png, null)), /the JSON beside its PNG is missing/);
  assert.match(problem(readStoredBaseline(PLAN, "chromium", png, "{")), /its JSON is not valid/);
  assert.match(
    problem(readStoredBaseline({ ...PLAN, element: "testid=other" }, "chromium", png, json)),
    /describes testid=plan on \/plans in chromium, not this target/,
  );
  assert.match(problem(readStoredBaseline(PLAN, "firefox", png, json)), /in chromium, not this target/);
  assert.match(problem(readStoredBaseline(PLAN, "chromium", Buffer.from("not a png"), json)), /its PNG cannot be read: not a PNG/);
  assert.match(problem(readStoredBaseline(PLAN, "chromium", encodePng(picture(12, 10)), json)), /its PNG is 12×10 where its JSON says 10×10/);
});

test("baselines: compare — none yet is listed and never fails; the same picture matches at 0%; a change past the threshold is a change", () => {
  const before = picture(10, 10);
  const now = { capture: capture(), platform: "linux", image: picture(10, 10) };
  const stored = { meta: storedMeta(), image: before };
  assert.deepEqual(judgeBaseline({ mode: "compare", threshold: 0, stored: null, now }), { status: "no-baseline" });
  const same = judgeBaseline({ mode: "compare", threshold: 0, stored, now });
  assert.equal(same.status, "matches");
  assert.equal(same.diff?.percent, 0);
  assert.equal(same.diffImage, undefined, "no picture is kept for a match");
  // One pixel of a hundred: a change at a threshold of 0, within a 1% one, a change again just under it.
  const onePixel = { ...now, image: picture(10, 10, [[3, 4]]) };
  const changed = judgeBaseline({ mode: "compare", threshold: 0, stored, now: onePixel });
  assert.equal(changed.status, "changed");
  assert.equal(changed.diff?.changedPixels, 1);
  assert.equal(changed.diff?.percent, 1);
  assert.ok(changed.diffImage && changed.diffImage.width === 10);
  assert.equal(judgeBaseline({ mode: "compare", threshold: 1, stored, now: onePixel }).status, "matches", "exactly the threshold is allowed");
  assert.equal(judgeBaseline({ mode: "compare", threshold: 0.99, stored, now: onePixel }).status, "changed");
  // Exactly the threshold, where floating point puts the share a hair past it: 7 of 100 is 7.000000000000001%.
  assert.ok(!isChange({ changed: 7, total: 100, sizeChanged: false }, 7));
  assert.ok(!isChange({ changed: 8064, total: 1280 * 900, sizeChanged: false }, 0.7));
  assert.ok(isChange({ changed: 8065, total: 1280 * 900, sizeChanged: false }, 0.7));
  // A change of size always counts, whatever the threshold.
  const taller = judgeBaseline({ mode: "compare", threshold: 100, stored, now: { ...now, image: picture(10, 11) } });
  assert.equal(taller.status, "changed");
  assert.deepEqual([taller.diff?.sizeChanged, taller.diff?.baseline, taller.diff?.now], [true, { width: 10, height: 10 }, { width: 10, height: 11 }]);
  assert.ok(isChange({ changed: 0, total: 100, sizeChanged: true }, 100));
  assert.ok(!isChange({ changed: 0, total: 100, sizeChanged: false }, 0));
});

test("baselines: compare — a baseline taken with other settings, or one that cannot be read, is unusable, never a comparison", () => {
  const now = { capture: capture(), platform: "linux", image: picture(10, 10) };
  const other = judgeBaseline({
    mode: "compare",
    threshold: 0,
    stored: { meta: storedMeta({ capture: capture({ viewport: { width: 390, height: 844 } }) }), image: picture(10, 10) },
    now,
  });
  assert.deepEqual(other, { status: "unusable", detail: "it was taken with other settings: viewport 390×844 (now 1280×900)" });
  assert.deepEqual(judgeBaseline({ mode: "compare", threshold: 0, stored: { problem: "its PNG is missing" }, now }), {
    status: "unusable",
    detail: "its PNG is missing",
  });
});

test("baselines: update — writes a missing, unusable or changed baseline, and leaves alone one compare would accept", () => {
  const now = { capture: capture(), platform: "linux", image: picture(10, 10) };
  const stored = { meta: storedMeta(), image: picture(10, 10) };
  // `updated` is the status that writes the new picture as the baseline (check-run).
  assert.deepEqual(judgeBaseline({ mode: "update", threshold: 0, stored: null, now }), { status: "updated", detail: "it had no baseline" });
  assert.deepEqual(judgeBaseline({ mode: "update", threshold: 0, stored: { problem: "x" }, now }), {
    status: "updated",
    detail: "replaced one that could not be used: x",
  });
  assert.equal(
    judgeBaseline({ mode: "update", threshold: 0, stored: { meta: storedMeta({ capture: capture({ margin: 0 }) }), image: picture(10, 10) }, now }).status,
    "updated",
  );
  const same = judgeBaseline({ mode: "update", threshold: 0, stored, now });
  assert.equal(same.status, "matches", "an update that changes nothing changes no file");
  // As compare judges it: past the threshold is written, within it is left, so noise under the threshold changes no file.
  const onePixel = { ...now, image: picture(10, 10, [[0, 0]]) };
  const moved = judgeBaseline({ mode: "update", threshold: 0, stored, now: onePixel });
  assert.deepEqual([moved.status, moved.detail, moved.diffImage], ["updated", "it was 1% different (1 of 100 pixels)", undefined]);
  assert.equal(judgeBaseline({ mode: "update", threshold: 1, stored, now: onePixel }).status, "matches");
  // A change of size is written whatever the threshold.
  assert.equal(judgeBaseline({ mode: "update", threshold: 100, stored, now: { ...now, image: picture(11, 10) } }).status, "updated");
  // Update never reports a target unusable or changed: it takes it again.
  for (const stored2 of [{ problem: "x" }, { meta: storedMeta(), image: picture(10, 10, [[1, 1]]) }])
    assert.ok(!["unusable", "changed"].includes(judgeBaseline({ mode: "update", threshold: 0, stored: stored2, now }).status));
});

test("baselines: only pictures named as a check names them are cleared from the output folder", () => {
  for (const name of Object.values(visualFiles(PLAN))) {
    const [, folder, file] = name.split("/");
    assert.ok(isVisualPicture(folder, file), name);
  }
  const page = visualFiles({ path: "/", element: "page" }).diff.split("/");
  assert.ok(isVisualPicture(page[1], page[2]));
  for (const [folder, file] of [
    ["plans-1a2b3c4d", "notes.png"],
    ["plans-1a2b3c4d", "diff.png"],
    ["plans-1a2b3c4d", "page.diff.png.bak"],
    ["plans", "page.diff.png"],
    ["my-screens", "home-1a2b3c4d.actual.png"],
    ["plans-1a2b3c4d", "testid-plan-1a2b3c4d.baseline.png"],
  ])
    assert.ok(!isVisualPicture(folder, file), `${folder}/${file}`);
});

test("baselines: a baseline from another operating system is still compared, with a note that text is drawn differently there", () => {
  const now = { capture: capture(), platform: "linux", image: picture(10, 10) };
  const fromMac = { meta: storedMeta({ platform: "darwin" }), image: picture(10, 10) };
  const fromHere = { meta: storedMeta(), image: picture(10, 10) };
  const r = judgeBaseline({ mode: "compare", threshold: 0, stored: fromMac, now });
  assert.equal(r.status, "matches");
  assert.equal(r.platformNote, "its baseline was taken on darwin and this check ran on linux");
  assert.equal(judgeBaseline({ mode: "compare", threshold: 0, stored: fromHere, now }).platformNote, undefined);
  // Asked to update where the check runs, a baseline from another system is replaced however close it came;
  // the same picture taken on this system, within the threshold, is left as it was.
  const retaken = judgeBaseline({ mode: "update", threshold: 0.1, stored: fromMac, now });
  assert.deepEqual([retaken.status, retaken.detail, retaken.platformNote], ["updated", "replaced one taken on darwin", undefined]);
  assert.equal(judgeBaseline({ mode: "update", threshold: 0.1, stored: fromHere, now }).status, "matches");
});

test("baselines: --baseline-threshold is a percentage from 0 to 100, and 0.1 when not given", () => {
  assert.deepEqual(parseThreshold(undefined), { ok: true, value: 0.1 });
  assert.deepEqual(parseThreshold("0"), { ok: true, value: 0 }, "0 stays available: every changed pixel counts");
  assert.deepEqual(parseThreshold("0.5"), { ok: true, value: 0.5 });
  assert.deepEqual(parseThreshold("100"), { ok: true, value: 100 });
  for (const bad of ["", " ", "-0.1", "100.1", "5%", "NaN", "Infinity"]) assert.ok(!parseThreshold(bad).ok, bad);
});

test("baselines: at the default threshold an unchanged picture reads 0%, a few anti-aliased pixels pass, and a restyle past 0.1% does not", () => {
  const threshold = (parseThreshold(undefined) as { value: number }).value;
  const stored = { meta: storedMeta({}, picture(100, 100)), image: picture(100, 100) };
  const now = (paint: Array<[number, number]>) => ({ capture: capture(), platform: "linux", image: picture(100, 100, paint) });
  const pixels = (n: number): Array<[number, number]> => Array.from({ length: n }, (_, i): [number, number] => [i, 0]);
  const same = judgeBaseline({ mode: "compare", threshold, stored, now: now([]) });
  assert.deepEqual([same.status, same.diff?.percent], ["matches", 0], "an unchanged picture still reads 0%");
  // 10,000 pixels: 10 is exactly 0.1% and passes; 11 is past it.
  assert.equal(judgeBaseline({ mode: "compare", threshold, stored, now: now(pixels(3)) }).status, "matches", "the odd anti-aliased pixel passes");
  assert.equal(judgeBaseline({ mode: "compare", threshold, stored, now: now(pixels(10)) }).status, "matches");
  const restyled = judgeBaseline({ mode: "compare", threshold, stored, now: now(pixels(11)) });
  assert.deepEqual([restyled.status, restyled.diff?.percent], ["changed", 0.11]);
  // The same three pixels at 0: every changed pixel counts.
  assert.equal(judgeBaseline({ mode: "compare", threshold: 0, stored, now: now(pixels(3)) }).status, "changed");
});

/** A run of baselines as check-run hands it to the rules. */
function baselineRun(results: BaselineResult[], over: Partial<BaselineRun> = {}): BaselineRun {
  return { mode: "compare", engine: "chromium", threshold: 0, dir: "tests/visual", results, ...over };
}
const changedPlan: BaselineResult = {
  path: "/plans",
  element: "testid=plan",
  status: "changed",
  baseline: "chromium/plans-1/testid-plan-2.png",
  diff: { percent: 4.21, changedPixels: 421, totalPixels: 10000, sizeChanged: false, baseline: { width: 100, height: 100 }, now: { width: 100, height: 100 } },
  files: {
    expected: "visual/plans-1/testid-plan-2.expected.png",
    actual: "visual/plans-1/testid-plan-2.actual.png",
    diff: "visual/plans-1/testid-plan-2.diff.png",
  },
};
const missingPlan: BaselineResult = {
  path: "/plans",
  element: "testid=gone",
  status: "not-captured",
  detail: `page.goto: net::ERR_CONNECTION_REFUSED at ${ORIGIN}/plans`,
  baseline: "chromium/plans-1/testid-gone-3.png",
};
const otherStatuses: BaselineResult[] = (["matches", "no-baseline", "updated"] as const).map((status) => ({
  path: "/",
  element: "page",
  status,
  baseline: "chromium/index-1/page.png",
}));

test("baselines: a change, and a target that could not be pictured, are each one high visual-change issue; nothing else is", () => {
  const { issues } = checkFindings([route()], ORIGIN, [], [], baselineRun([changedPlan, missingPlan, ...otherStatuses]));
  assert.deepEqual(
    issues.map((i) => [i.rule, i.severity, i.routes]),
    [
      ["visual-change", "high", ["/plans"]],
      ["visual-change", "high", ["/plans"]],
    ],
  );
  assert.equal(
    issues[0].evidence,
    "testid=plan on /plans: 4.21% of its pixels changed (421 of 10000; allowed: 0%) — diff: visual/plans-1/testid-plan-2.diff.png",
  );
  // The app's origin is taken out, as from any evidence.
  assert.equal(issues[1].evidence, "testid=gone on /plans could not be captured: page.goto: net::ERR_CONNECTION_REFUSED at /plans");
  assert.ok(!checkFindings([route()], ORIGIN, [], [], baselineRun(otherStatuses)).issues.length, "no baseline yet, a match and an update are not issues");
  assert.deepEqual(checkFindings([route()], ORIGIN, ["visual-change"], [], baselineRun([changedPlan])).issues, [], "--ignore takes it like any rule");
  assert.deepEqual(
    checkFindings([route()], ORIGIN, [], [], baselineRun([changedPlan]), [{ path: "/plans" }]).issues,
    [],
    "a path exemption takes the picture on that route",
  );
  assert.equal(
    checkFindings([route()], ORIGIN, [], [], baselineRun([changedPlan]), [{ path: "/other" }]).issues.length,
    1,
    "another path leaves the picture in the gate",
  );
  // Under update the sentence says the baseline was not written.
  assert.match(
    checkFindings([route()], ORIGIN, [], [], baselineRun([missingPlan], { mode: "update" })).issues[0].evidence,
    /, so its baseline was not written$/,
  );
  const sized = { ...changedPlan, diff: { ...changedPlan.diff!, sizeChanged: true, now: { width: 100, height: 104 } } };
  assert.match(
    baselineEvidence(sized, { mode: "compare", threshold: 5 }) ?? "",
    /its size changed from 100×100 to 100×104, which always counts \(4\.21% of its pixels differ\)/,
  );
});

test("baselines: the same target changing by another amount is the same alert; another target or browser is another", () => {
  const again = { ...changedPlan, diff: { ...changedPlan.diff!, percent: 9.5, changedPixels: 950 } };
  const fp = (r: BaselineResult, engine: BaselineRun["engine"] = "chromium") =>
    checkFindings([route()], ORIGIN, [], [], baselineRun([r], { engine })).issues[0].fingerprint;
  assert.equal(fp(again), fp(changedPlan));
  assert.notEqual(fp(changedPlan, "webkit"), fp(changedPlan));
  assert.notEqual(fp({ ...changedPlan, element: "testid=other" }), fp(changedPlan));
  assert.equal(fp(changedPlan), baselineFingerprint("chromium", changedPlan));
});

test("baselines: an unmet baseline fails the default gate; with --fail-on never it is reported and passes", () => {
  const withBaselines = (failOn: CheckResult["failOn"]): CheckResult => {
    const run = baselineRun([changedPlan]);
    return { ...result(checkFindings([route()], ORIGIN, [], [], run).issues, failOn), baselines: run };
  };
  assert.deepEqual([summarise(withBaselines("high")).passed, exitCodeOf(withBaselines("high"))], [false, 1]);
  assert.deepEqual([summarise(withBaselines("never")).passed, exitCodeOf(withBaselines("never"))], [true, 0]);
  const sarif = toSarif(withBaselines("high"), "1", { anchor: ".github/workflows/check.yml", flowsDir: "flows" }) as {
    runs: Array<{
      results: Array<{
        ruleId: string;
        level: string;
        message: { text: string };
        partialFingerprints: Record<string, string>;
        locations: Array<{ physicalLocation: { artifactLocation: { uri: string } }; logicalLocations: Array<{ name: string }> }>;
      }>;
    }>;
  };
  const [only] = sarif.runs[0].results;
  assert.deepEqual([only.ruleId, only.level], ["visual-change", "error"]);
  assert.match(
    only.message.text,
    /^Differs from its visual baseline: testid=plan on \/plans: 4\.21% .*diff: visual\/plans-1\/testid-plan-2\.diff\.png — on \/plans$/,
  );
  // No flow raised it, so it points at the anchor file code scanning keeps, with its page as the logical location.
  assert.deepEqual(
    only.locations.map((l) => [l.physicalLocation.artifactLocation.uri, l.logicalLocations[0].name]),
    [[".github/workflows/check.yml", "/plans"]],
  );
  assert.equal(only.partialFingerprints["scenescoutCheck/v1"], baselineFingerprint("chromium", changedPlan));
});

test("baselines: the report lists every target with what became of it, and check.json carries the run", () => {
  const run = baselineRun([changedPlan, missingPlan, ...otherStatuses]);
  const r: CheckResult = { ...result(checkFindings([route()], ORIGIN, [], [], run).issues), baselines: run };
  const report = formatCheck(r);
  assert.match(
    report,
    /## Visual baselines \(5\)\n\nCompared in chromium, baselines in `tests\/visual` · 0% of a picture's pixels may change · 1 changed · 1 not captured · 1 no baseline yet · 1 updated · 1 match/,
  );
  assert.match(
    report,
    /- ✗ `testid=plan` on `\/plans`: 4\.21% of its pixels changed \(421 of 10000; allowed: 0%\) — expected `visual\/plans-1\/testid-plan-2\.expected\.png`, now `[^`]+\.actual\.png`, diff `[^`]+\.diff\.png`/,
  );
  // A target compared with nothing is named beside the verdict: nothing compared is not a match.
  assert.match(report.split("\n").slice(0, 6).join("\n"), / · 1 visual target\(s\) not compared: no baseline yet/);
  assert.doesNotMatch(formatCheck({ ...r, baselines: baselineRun([changedPlan]) }), /not compared: no baseline yet/);
  assert.match(report, /- ⊘ `testid=gone` on `\/plans`: could not be captured: /);
  assert.match(report, /- ✓ `page` on `\/`: matches \(0% changed\)/);
  assert.match(report, /- ○ `page` on `\/`: no baseline yet/);
  assert.match(
    report,
    /A target with no baseline yet is listed and never fails; one whose baseline cannot be used fails until it is taken again\. Run the check with `--baseline update`/,
  );
  assert.match(report, /the changed pixels in red/);
  assert.doesNotMatch(report, /another operating system/);
  const noted = formatCheck({
    ...r,
    baselines: baselineRun([{ ...changedPlan, platformNote: "its baseline was taken on darwin and this check ran on linux" }]),
  });
  assert.match(noted, /_\(its baseline was taken on darwin and this check ran on linux\)_/);
  assert.match(noted, /Some baselines were taken on another operating system/);
  const updated = formatCheck({ ...r, baselines: baselineRun([{ ...otherStatuses[2], detail: "it had no baseline" }, otherStatuses[0]], { mode: "update" }) });
  assert.match(updated, /Updated in chromium, baselines in `tests\/visual` · 0% of a picture's pixels may change · 1 updated · 1 left as they were/);
  assert.match(updated, /↻ `page` on `\/`: baseline written to `chromium\/index-1\/page\.png` \(it had no baseline\)/);
  assert.match(updated, /✓ `page` on `\/`: within the threshold of its baseline \(0% changed\), which was left as it was/);
  assert.doesNotMatch(formatCheck(result([])), /Visual baselines/);
  const json = toSummaryJson(r, "1") as { baselines: BaselineRun | null };
  assert.deepEqual(json.baselines, run);
  assert.equal((toSummaryJson(result([]), "1") as { baselines: unknown }).baselines, null, "off reads as null");
});

test("baselines: a token in a target's path, or in the reason a picture was not taken, is redacted before anything is written", () => {
  // Built the way check-run builds them: the file names come from the target's path.
  const target: BaselineTarget = { path: "/reset?token=abc123def456ghi789", element: "page" };
  const changedLeak: BaselineResult = { ...changedPlan, ...target, baseline: baselineFiles("chromium", target).png, files: visualFiles(target) };
  // Assembled here so that no whole token sits in this file (hygiene-test allows them only in the redaction fixtures).
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJl"].join(".");
  const missingLeak: BaselineResult = {
    ...target,
    element: "testid=gone",
    status: "not-captured",
    detail: `page.goto: interrupted by another navigation to https://sso.example.com/cb?access_token=${jwt}`,
    baseline: baselineFiles("chromium", { ...target, element: "testid=gone" }).png,
  };
  assert.doesNotMatch(routeFolder(target.path), /abc123/, "a token never becomes part of a file name");
  assert.notEqual(routeFolder(target.path), routeFolder("/reset?token=zzz999yyy888xxx777"), "two targets that differ only by a token still have a file each");
  const run = redactBaselineRun(baselineRun([changedLeak, missingLeak]));
  const r: CheckResult = { ...result(checkFindings([route()], ORIGIN, [], [], run).issues), baselines: run };
  for (const written of [formatCheck(r), JSON.stringify(toSummaryJson(r, "1")), JSON.stringify(toSarif(r, "1"))]) {
    assert.doesNotMatch(written, /abc123def456ghi789|eyJhbGciOiJIUzI1NiJ9/);
  }
  assert.equal(r.issues.length, 2, "both are still filed");
});

test("baselines: an unusable baseline is filed, as a change is; a change with no comparison attached is still filed", () => {
  const unusable: BaselineResult = { path: "/plans", element: "page", status: "unusable", detail: "its PNG is missing", baseline: "chromium/plans-1/page.png" };
  const { issues } = checkFindings([route()], ORIGIN, [], [], baselineRun([unusable]));
  assert.equal(issues.length, 1);
  assert.match(issues[0].evidence, /^page on \/plans: its baseline cannot be used \(its PNG is missing\); run the check with --baseline update/);
  assert.match(baselineEvidence({ ...changedPlan, diff: undefined }, { mode: "compare", threshold: 0 }) ?? "", /it no longer matches its baseline/);
  assert.equal(
    baselineEvidence({ ...unusable, status: "no-baseline", detail: undefined }, { mode: "compare", threshold: 0 }),
    null,
    "no baseline yet never fails",
  );
});

test("baselines: an element that reaches outside the window is pictured only where it is inside, and says so", () => {
  const vp = { width: 1280, height: 900 };
  assert.equal(cutByViewport({ x: 32, y: 40, width: 320, height: 200 }, vp), null);
  assert.equal(cutByViewport({ x: -0.5, y: 0, width: 1280.5, height: 900.4 }, vp), null, "a fractional edge is not a cut");
  assert.equal(
    cutByViewport({ x: 0, y: -300, width: 1280, height: 2400 }, vp),
    "only the part inside the 1280×900 window is pictured: the element is 1280×2400",
  );
  assert.match(cutByViewport({ x: 900, y: 10, width: 600, height: 40 }, vp) ?? "", /the element is 600×40/);
});

test("baselines: the script that stops animations finishes the finite ones and cancels those that never end", () => {
  const calls: string[] = [];
  const animation = (name: string, endTime: number | null) => ({
    effect: endTime === null ? null : { getComputedTiming: () => ({ endTime }) },
    finish: () => calls.push(`finish ${name}`),
    cancel: () => calls.push(`cancel ${name}`),
  });
  const document = { getAnimations: () => [animation("slide-in", 400), animation("spinner", Infinity), animation("detached", null)] };
  assert.equal(vm.runInNewContext(STOP_ANIMATIONS_SCRIPT, { document }), true);
  assert.deepEqual(calls, ["finish slide-in", "cancel spinner", "cancel detached"]);
});

test("baselines: a picture is kept once two taken a frame apart are the same, never the first one alone", async () => {
  // The pictures a page gives while it is still drawing: a frame from before the stop, then a script's last steps.
  const sequence = (...pictures: string[]) => {
    let i = 0;
    const log: string[] = [];
    return {
      log,
      take: async () => {
        const png = Buffer.from(pictures[Math.min(i, pictures.length - 1)]);
        log.push(`take ${png.toString()}`);
        i += 1;
        return png;
      },
      nextFrame: async () => void log.push("frame"),
    };
  };
  const still = sequence("a", "a");
  assert.deepEqual(await steadyPicture(still.take, still.nextFrame, 5000), { png: Buffer.from("a"), steady: true, takes: 2 });
  assert.deepEqual(still.log, ["take a", "frame", "take a"], "a frame passes between two pictures");

  const settling = sequence("stale", "step 1", "step 2", "done", "done");
  const kept = await steadyPicture(settling.take, settling.nextFrame, 5000);
  assert.deepEqual(kept, { png: Buffer.from("done"), steady: true, takes: 5 });

  // Two the same that are not next to each other are not still: a-b-a is a page that keeps moving.
  const flicker = sequence("a", "b", "a", "b", "a", "a");
  assert.equal((await steadyPicture(flicker.take, flicker.nextFrame, 5000)).takes, 6);

  // A page that never holds still: the last picture once the budget is spent, said to be unsteady.
  let clock = 0;
  let n = 0;
  const moving = { take: async () => Buffer.from(`frame ${n++}`), nextFrame: async () => void (clock += 400) };
  const gaveUp = await steadyPicture(moving.take, moving.nextFrame, 1000, () => clock);
  assert.deepEqual(gaveUp, { png: Buffer.from("frame 3"), steady: false, takes: 4 });
  assert.equal(
    unsteadyNote(5000),
    "the picture was still changing after about 5s, so the last one taken is used: something on the page keeps moving, and a comparison of it may not repeat",
  );
});

test("baselines: the next-frame script waits for two animation frames, and for a second when frames never come", async () => {
  const frames: Array<() => void> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const page = { requestAnimationFrame: (fn: () => void) => frames.push(fn), setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }) };
  const drawn = vm.runInNewContext(NEXT_FRAME_SCRIPT, { ...page, Promise }) as Promise<boolean>;
  assert.equal(frames.length, 1);
  frames.shift()!();
  assert.equal(frames.length, 1, "the first frame asks for a second");
  frames.shift()!();
  assert.equal(await drawn, true);
  assert.deepEqual(
    timers.map((t) => t.ms),
    [1000],
  );

  const noFrames = vm.runInNewContext(NEXT_FRAME_SCRIPT, { requestAnimationFrame: () => 0, setTimeout: (fn: () => void) => fn(), Promise }) as Promise<boolean>;
  assert.equal(await noFrames, false);
});

test("baselines: a picture that never held still says so on its line of the report", () => {
  const r = result([]);
  const note = unsteadyNote(5000);
  const report = formatCheck({ ...r, baselines: baselineRun([{ ...changedPlan, unsteady: note }]) });
  assert.match(
    report,
    /_\(the picture was still changing after about 5s, so the last one taken is used: something on the page keeps moving, and a comparison of it may not repeat\)_/,
  );
});

test("action: the pictures of changed baselines are kept with the results, and only when this run wrote them", () => {
  const changed = { baselines: { results: [{ status: "changed", files: { diff: "visual/a/b.diff.png" } }] } };
  const there = () => true;
  assert.equal(picturesDir(changed, "/out", there), path.join("/out", VISUAL_DIRNAME), "the folder the CLI writes its pictures to");
  assert.equal(picturesDir({ baselines: { results: [{ status: "matches" }] } }, "/out", there), "", "a folder an earlier run left is not this run's");
  assert.equal(picturesDir({ baselines: null }, "/out", there), "");
  assert.equal(picturesDir(null, "/out", there), "");
  assert.equal(
    picturesDir(changed, "/out", () => false),
    "",
  );
  const steps = action.runs.steps as Array<{ name: string; with?: { path?: string } }>;
  assert.match(steps.find((s) => s.name === "Keep the results")?.with?.path ?? "", /\$\{\{ steps\.run\.outputs\.visual \}\}/);
});

// ── The first run (`scenescout <url>`): what it leads with, its summary and its report ──

/** A failed request as the HTTP oracle records it. */
function httpError(url: string, status: number): RouteHealth["violations"][number] {
  return { kind: "http_error", severity: status >= 500 ? "high" : "medium", detail: httpErrorDetail("GET", url, status), url: `${ORIGIN}/` };
}

/** The broken-image oracle's own line for one image. */
function brokenImage(src: string, alt = "Chart"): string[] {
  return brokenImageIssues({ images: [{ alt, src, testid: null }], total: 1 }, `${ORIGIN}/`);
}

/** The browser's own console line about a load that failed. */
function loadEcho(detail: string, page = "/"): RouteHealth["violations"][number] {
  return { kind: "console_error", severity: "medium", detail, url: `${ORIGIN}${page}` };
}
const ECHO_404 = "Failed to load resource: the server responded with a status of 404 (Not Found)";

const rules = (issues: readonly CheckIssue[]): string[] => issues.map((i) => i.rule);

test("first look: the highest severity first, then the most pages affected", () => {
  const issues = issuesFromRoutes(
    [
      route({ path: "/", violations: [httpError(`${ORIGIN}/api/a`, 404)], unnamed: ["button [testid=menu]"] }),
      route({ path: "/b", unnamed: ["button [testid=menu]"], design: [{ rule: "contrast", detail: '<p> "x" — 2.1:1' }] }),
      route({
        path: "/c",
        unnamed: ["button [testid=menu]"],
        violations: [{ kind: "page_error", severity: "high", detail: "TypeError: x is undefined", url: `${ORIGIN}/c` }],
      }),
    ],
    ORIGIN,
  );
  assert.deepEqual(rules(firstLook(issues, 3)), ["page-error", "unnamed-control", "client-error"]);
  // Only three, whatever else there is; fewer when there are fewer.
  assert.equal(firstLook(issues, 3).length, 3);
  assert.deepEqual(rules(firstLook(issues, 3, 10)), ["page-error", "unnamed-control", "client-error", "contrast"]);
  assert.deepEqual(firstLook([], 3), []);
});

test("first look: an image that answers 404 is one thing to look at, not a failed request and a broken image", () => {
  const chart = `${ORIGIN}/img/chart.png`;
  const same = issuesFromRoutes(
    [route({ violations: [httpError(chart, 404)], brokenImages: brokenImage(chart), placeholderOnly: ['textbox [testid=email] "Email"'] })],
    ORIGIN,
  );
  assert.deepEqual(resourceOf(same.find((i) => i.rule === "client-error")!), "/img/chart.png");
  assert.deepEqual(resourceOf(same.find((i) => i.rule === "broken-image")!), "/img/chart.png");
  assert.deepEqual(rules(firstLook(same, 1)), ["client-error", "placeholder-only-label"], "the request is shown, the broken image it leaves is not");
  // The near miss: a different image is a different thing, and keeps its slot.
  const other = issuesFromRoutes(
    [
      route({
        violations: [httpError(chart, 404)],
        brokenImages: brokenImage(`${ORIGIN}/img/logo.png`, "Logo"),
        placeholderOnly: ['textbox [testid=email] "Email"'],
      }),
    ],
    ORIGIN,
  );
  assert.deepEqual(rules(firstLook(other, 1)), ["client-error", "broken-image", "placeholder-only-label"]);
  // Another site's image and its failed request match too: neither loses its origin.
  const cdn = "https://cdn.example.test/hero.jpg";
  const foreign = issuesFromRoutes([route({ violations: [httpError(cdn, 404)], brokenImages: brokenImage(cdn, "Hero") })], ORIGIN);
  assert.deepEqual(rules(firstLook(foreign, 1)), ["client-error"]);
});

test("first look: the same image is matched when redaction has rewritten its address, and when one record cut it shorter", () => {
  // A token in the query: both records are redacted the same way, and each ends with redaction's note.
  const signed = `${ORIGIN}/img/chart.png?token=a1b2c3d4e5f6g7h8`;
  const redacted = issuesFromRoutes([route({ violations: [httpError(signed, 404)], brokenImages: brokenImage(signed) })], ORIGIN);
  assert.ok(
    redacted.every((i) => / \[1 secret redacted\]$/.test(i.evidence)),
    JSON.stringify(redacted),
  );
  assert.deepEqual(rules(firstLook(redacted, 1)), ["client-error"]);
  // The page script keeps 160 characters of an image's address and the request oracle 200.
  const long = `${ORIGIN}/assets/${"a".repeat(120)}/${"b".repeat(60)}.png`;
  const cut = issuesFromRoutes([route({ violations: [httpError(long, 404)], brokenImages: brokenImage(long.slice(0, 160)) })], ORIGIN);
  assert.deepEqual(rules(firstLook(cut, 1)), ["client-error"]);
  // The near misses: a short address that merely starts a longer one is another resource.
  assert.equal(sameAddress("/img/a.png", "/img/a.png.map"), false);
  assert.equal(sameAddress(`/x/${"a".repeat(90)}`, `/x/${"a".repeat(90)}/more`), true);
  assert.equal(sameAddress("/img/a.png", "/img/b.png"), false);
});

test("first look: a console error comes after the other issues of its severity and reach, since its cause is usually listed too", () => {
  const issues = issuesFromRoutes(
    [
      route({
        violations: [loadEcho(ECHO_404)],
        placeholderOnly: ['textbox [testid=email] "Email"'],
        geometry: ['e3 button "Save" is COVERED by pinned chrome [bar] at this scroll position'],
      }),
    ],
    ORIGIN,
  );
  assert.deepEqual(rules(firstLook(issues, 1)), ["covered-control", "placeholder-only-label", "console-error"]);
  // A console error on more pages than the rest still outranks them: reach comes first.
  const wide = issuesFromRoutes(
    ["/", "/b"]
      .map((p) => route({ path: p, violations: [loadEcho("Widget failed", p)] }))
      .concat(route({ path: "/c", placeholderOnly: ['textbox [testid=email] "Email"'] })),
    ORIGIN,
  );
  assert.deepEqual(rules(firstLook(wide, 3)), ["console-error", "placeholder-only-label"]);
});

test("first look: the browser's console line about a failed load takes no slot while the request it echoes is listed", () => {
  const covered = 'e3 button "Save" is COVERED by pinned chrome [bar] at this scroll position';
  const pick = (routes: RouteHealth[]) => rules(firstLook(issuesFromRoutes(routes, ORIGIN), routes.length));
  // The 404 request and its echo on the same page: one slot, and the next issue gets the second.
  assert.deepEqual(pick([route({ violations: [httpError(`${ORIGIN}/img/chart.png`, 404), loadEcho(ECHO_404)], geometry: [covered] })]), [
    "client-error",
    "covered-control",
  ]);
  // Two pages, a different 404 on each: the echo is filed once for both pages, so it reaches further than either
  // request, and is still not the thing to look at.
  assert.deepEqual(
    pick([
      route({ path: "/", violations: [httpError(`${ORIGIN}/a.png`, 404), loadEcho(ECHO_404)] }),
      route({ path: "/b", violations: [httpError(`${ORIGIN}/b.png`, 404), loadEcho(ECHO_404, "/b")] }),
    ]),
    ["client-error", "client-error"],
  );
  // A server error and its line.
  const echo500 = "Failed to load resource: the server responded with a status of 500 (Internal Server Error)";
  assert.deepEqual(pick([route({ violations: [httpError(`${ORIGIN}/api/a`, 500), loadEcho(echo500)] })]), ["server-error"]);
  // A request redaction rewrote is still the one the line echoes.
  assert.deepEqual(pick([route({ violations: [httpError(`${ORIGIN}/api/a?token=a1b2c3d4e5f6g7h8`, 404), loadEcho(ECHO_404)] })]), ["client-error"]);
  // Near misses, each keeps its slot: another status, another page, a console error that is not a load echo.
  assert.deepEqual(pick([route({ violations: [httpError(`${ORIGIN}/api/a`, 404), loadEcho(echo500)] })]), ["client-error", "console-error"]);
  assert.deepEqual(
    pick([route({ path: "/", violations: [httpError(`${ORIGIN}/api/a`, 404)] }), route({ path: "/b", violations: [loadEcho(ECHO_404, "/b")] })]),
    ["client-error", "console-error"],
  );
  assert.deepEqual(pick([route({ violations: [httpError(`${ORIGIN}/api/a`, 404), loadEcho("Uncaught (in promise) Error: chart data missing")] })]), [
    "client-error",
    "console-error",
  ]);
  // A request that failed at the network level, and the browser's line naming the same error, or another one.
  const refused = {
    kind: "request_failed" as const,
    severity: "medium" as const,
    detail: `GET ${ORIGIN}/api/feed → net::ERR_CONNECTION_REFUSED`,
    url: `${ORIGIN}/`,
  };
  assert.deepEqual(pick([route({ violations: [refused, loadEcho("Failed to load resource: net::ERR_CONNECTION_REFUSED")] })]), ["request-failed"]);
  assert.deepEqual(pick([route({ violations: [refused, loadEcho("Failed to load resource: net::ERR_NAME_NOT_RESOLVED")] })]), [
    "request-failed",
    "console-error",
  ]);
  // With no request listed, the line is the only trace of the failure, and it is kept.
  const [lone] = issuesFromRoutes([route({ violations: [loadEcho(ECHO_404)] })], ORIGIN);
  assert.equal(echoesListedRequest(lone, [lone]), false);
});

test("first look: the app's shared shell counts as every page", () => {
  const issues = issuesFromRoutes(
    [
      route({
        path: "/",
        design: [
          { rule: "tiny-target", detail: '<a> "Help" 16×16', chrome: true },
          { rule: "contrast", detail: '<p> "x" — 2.1:1' },
        ],
      }),
      route({ path: "/b", design: [{ rule: "contrast", detail: '<p> "x" — 2.1:1' }] }),
      route({ path: "/c" }),
    ],
    ORIGIN,
  );
  const shell = issues.find((i) => i.rule === "tiny-target")!;
  assert.deepEqual(shell.routes, [SHARED_CHROME_ROUTE]);
  assert.equal(pagesAffected(shell, 3), 3);
  assert.deepEqual(rules(firstLook(issues, 3)), ["tiny-target", "contrast"]);
});

/** A first run's result: never gated, in observe mode, a 3-minute budget not reached, with what a case needs. */
function firstRunFacts(over: Partial<CheckResult> = {}, maxRoutes = 20): FirstRunFacts {
  return {
    result: {
      ...result([], "never"),
      mode: "observe",
      settings: { flowWrites: "never", onRefusedStep: "report", gateRetests: "never", retest: false },
      timeBudget: { ms: 180_000, reached: false },
      ...over,
    },
    options: { maxRoutes },
    elapsedMs: 41_000,
  };
}

test("with no session, a route sent to sign-in is a coverage gap, not an issue; with one, the same bounce is still reported", () => {
  // A contrastive pair: the same routes, and the only difference is whether the check was given a signed-in session.
  const routes = [
    route({ path: "/", geometry: ["e9 something new the oracle learned to say"] }),
    route({ path: "/things/new", loginRedirect: true, url: `${ORIGIN}/login?next=/things/new`, elements: 2 }),
    route({ path: "/things/7/edit", loginRedirect: true, url: `${ORIGIN}/login`, elements: 0 }),
  ];
  const signedOut = checkFindings(routes, ORIGIN, [], [], null, [], false);
  const signedIn = checkFindings(routes, ORIGIN, [], [], null, [], true);
  assert.deepEqual(rules(signedOut.issues), ["layout-issue"], "no auth-redirect, and a sign-in page with no controls is no dead end");
  assert.deepEqual(signedOut.needsSignIn, ["/things/new", "/things/7/edit"]);
  assert.deepEqual(
    signedIn.issues.filter((i) => i.rule === "auth-redirect").flatMap((i) => i.routes),
    ["/things/new", "/things/7/edit"],
  );
  assert.deepEqual(signedIn.needsSignIn, []);
  assert.deepEqual(checkFindings(routes, ORIGIN, [], [], null, [{ path: "/things/new" }], false).needsSignIn, ["/things/7/edit"], "--ignore-path exempts it");
  assert.deepEqual(checkFindings(routes, ORIGIN, ["auth-redirect"], [], null, [], false).needsSignIn, signedOut.needsSignIn, "--ignore does not");
  // A caller that does not say is treated as signed in, so nothing is hidden by default.
  assert.deepEqual(rules(issuesFromRoutes(routes, ORIGIN)), rules(signedIn.issues));
  assert.deepEqual(rules(issuesFromRoutes(routes, ORIGIN, [], [], [], false)), ["layout-issue"]);

  // The first look never has a session: its top three hold none of these, where a signed-in check's would lead with them.
  assert.ok(!rules(firstLook(signedOut.issues, routes.length)).includes("auth-redirect"));
  assert.equal(firstLook(signedIn.issues, routes.length)[0]?.rule, "auth-redirect");

  // The report says it once, with how to cover them, and does not count them against the gate.
  const report = (needsSignIn: string[] | undefined, issues: CheckIssue[]) =>
    formatCheck({ ...result(issues, "medium"), routes, ...(needsSignIn ? { needsSignIn } : {}) });
  const out = report(signedOut.needsSignIn, signedOut.issues);
  assert.equal(out.match(/2 routes need sign-in; give a role to cover them/g)?.length, 1, out);
  assert.match(out, /## Needs sign-in \(2\)/);
  assert.match(out, /`--storage-state`/);
  assert.match(out, /\*\*PASSED\*\*.* · 2 route\(s\) need sign-in, not covered/);
  assert.deepEqual((toSummaryJson({ ...result(signedOut.issues), needsSignIn: signedOut.needsSignIn }, "1") as { needsSignIn?: string[] }).needsSignIn, [
    "/things/new",
    "/things/7/edit",
  ]);
  const withSession = report(undefined, signedIn.issues);
  assert.match(withSession, /\*\*FAILED\*\*/);
  assert.doesNotMatch(withSession, /need sign-in/);
  assert.equal("needsSignIn" in (toSummaryJson(result(signedIn.issues), "1") as object), false);
  assert.equal(needsSignInText(1, "x"), "1 route needs sign-in; give a role to cover them: x.");

  // The first look's summary names the gap once, with the login command; a start page that bounced has its own note instead.
  const look = firstRunSummary(firstRunFacts({ routes, issues: signedOut.issues, needsSignIn: signedOut.needsSignIn }), "r");
  assert.equal(
    look.filter((l) => l.startsWith(`2 pages need sign-in; give a role to cover them: npx -y scenescout login ${ORIGIN}/ --role <name>`)).length,
    1,
    look.join("\n"),
  );
  const walledStart = firstRunSummary(firstRunFacts({ routes: [route({ loginRedirect: true, url: `${ORIGIN}/login` })], needsSignIn: ["/"] }), "r");
  assert.ok(!walledStart.some((l) => /need sign-in; give a role/.test(l)), walledStart.join("\n"));
});

const threeIssues = (): CheckIssue[] =>
  issuesFromRoutes(
    [
      route({ path: "/", violations: [httpError(`${ORIGIN}/img/chart.png`, 404)], brokenImages: brokenImage(`${ORIGIN}/img/chart.png`) }),
      route({ path: "/new", placeholderOnly: ['textbox [testid=email] "Email"'], design: [{ rule: "contrast", detail: '<p> "hint" — 1.7:1' }] }),
      route({ path: "/done", elements: 0 }),
    ],
    ORIGIN,
  );

test("the summary opens with the three issues to look at first, then the counts, the report and what to try next", () => {
  const issues = threeIssues();
  const routes = ["/", "/new", "/done"].map((p) => route({ path: p }));
  const lines = firstRunSummary(firstRunFacts({ issues, routes }), "scenescout-report/report.md");
  assert.equal(lines[0], "Look at these first:");
  assert.match(lines[1], /^ {2}1\. \[medium\] Request failed with a client error: GET \/img\/chart\.png → HTTP 404 \(on \/\)$/);
  assert.match(lines[2], /^ {2}2\. \[medium\] Dead end: \/done: 0 controls \(on \/done\)$/);
  assert.match(lines[3], /^ {2}3\. \[medium\] Field labelled only by its placeholder: .*\(on \/new\)$/);
  assert.equal(lines[4], "");
  assert.equal(lines[5], "3 pages looked at in 41 s in observe mode: 0 high · 4 medium · 1 low.");
  assert.equal(lines[6], "Report: scenescout-report/report.md");
  assert.match(lines.at(-1)!, /^Next: .*npx -y scenescout install.*scenescout check.*scenescout login <url> --role <name>.*Guide: https:\/\/github\.com\//);
  assert.ok(lines.at(-1)!.endsWith(GUIDE_URL));
});

test("the summary says where an issue was seen: one page, several, or every page for the shared shell", () => {
  const menu = (p: string) => route({ path: p, unnamed: ["button [testid=menu]"] });
  const several = firstRunSummary(firstRunFacts({ issues: issuesFromRoutes(["/", "/b", "/c"].map(menu), ORIGIN), routes: ["/", "/b", "/c"].map(menu) }), "r");
  assert.match(several[1], /\(on 3 pages: \/, \/b and 1 more\)$/);
  const shell = issuesFromRoutes([route({ design: [{ rule: "tiny-target", detail: '<a> "Help" 16×16', chrome: true }] })], ORIGIN);
  assert.match(firstRunSummary(firstRunFacts({ issues: shell }), "r")[1], /\(on every page\)$/);
});

test("the summary's counts name what is never counted and what was not measured", () => {
  const worthALook = [
    { rule: "off-grid-spacing" as const, evidence: "paddings off a 4px grid: 6px", routes: ["/"], convention: "a 4px spacing scale", fingerprint: "f" },
  ];
  const lines = firstRunSummary(firstRunFacts({ routes: [route({ auditError: "no visible styled elements to measure" })], worthALook }), "r");
  assert.ok(
    lines.includes("1 page looked at in 41 s in observe mode: 0 high · 0 medium · 0 low · 1 worth a look, never counted · design not measured on 1 page."),
    lines.join("\n"),
  );
});

test("the summary prints what a page said on one line, with no control character from the app reaching the terminal", () => {
  const thrown = {
    kind: "page_error" as const,
    severity: "high" as const,
    detail: "TypeError: boom\n    at render (app.js:1:1)\u001b[2J\u001b]0;owned\u0007",
    url: `${ORIGIN}/`,
  };
  const lines = firstRunSummary(firstRunFacts({ issues: issuesFromRoutes([route({ violations: [thrown] })], ORIGIN) }), "r");
  assert.equal(lines[1], "  1. [high] Uncaught exception: TypeError: boom at render (app.js:1:1) [2J ]0;owned (on /)");
  // A long one is cut, not wrapped.
  const long = { ...thrown, detail: `Error: ${"x".repeat(400)}` };
  const cut = firstRunSummary(firstRunFacts({ issues: issuesFromRoutes([route({ violations: [long] })], ORIGIN) }), "r")[1];
  assert.ok(cut.includes("x…") && cut.length < 220, cut);
});

test("the summary on an app with nothing to report says so, and still says where the report is and what next", () => {
  const lines = firstRunSummary(firstRunFacts({ routes: [route(), route({ path: "/b" })] }), "r/report.md");
  assert.equal(lines[0], "No issues found on the 2 pages looked at.");
  assert.ok(lines.includes("Report: r/report.md"));
  assert.match(lines.at(-1)!, /^Next: /);
});

test("the time a look took is read in whole seconds, then minutes and seconds, never 60 seconds", () => {
  const took = (ms: number): string =>
    firstRunSummary({ ...firstRunFacts({ routes: [route()] }), elapsedMs: ms }, "r")[2].replace(/^1 page looked at in (.+) in observe mode.*$/, "$1");
  assert.equal(took(41_000), "41 s");
  assert.equal(took(200), "1 s");
  assert.equal(took(59_600), "1 min 0 s");
  assert.equal(took(65_000), "1 min 5 s");
  assert.equal(took(119_700), "2 min 0 s");
});

test("the summary says which limit stopped the look: the time limit, the page limit and the link steps are told apart", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => route({ path: `/p${i}` }));
  const timeUp = firstRunSummary(firstRunFacts({ routes: twenty.slice(0, 7), unvisited: ["/x", "/y"], timeBudget: { ms: 180_000, reached: true } }), "r");
  assert.ok(
    timeUp.includes("Stopped after 3 minutes, the first look's time limit, with 2 more pages found and not looked at. --max-minutes raises it."),
    timeUp.join("\n"),
  );
  const full = firstRunSummary(firstRunFacts({ routes: twenty, unvisited: ["/x", "/y"] }), "r");
  assert.ok(
    full.includes("Stopped at 20 pages, the first look's limit, with 2 more pages found and not looked at. --max-routes raises it, up to 150."),
    full.join("\n"),
  );
  const one = firstRunSummary(firstRunFacts({ routes: twenty, unvisited: ["/x"] }), "r");
  assert.ok(
    one.some((l) => l.includes("with 1 more page found")),
    one.join("\n"),
  );
  // Neither limit reached and pages left: the link steps ran out, and neither option is offered as the fix.
  const deep = firstRunSummary(firstRunFacts({ routes: twenty.slice(0, 7), unvisited: ["/x"] }), "r");
  const note = deep.find((l) => l.startsWith("1 more page found and not looked at: links are followed 6 steps from the start page"));
  assert.ok(note && note.includes(`npx -y scenescout check ${ORIGIN}/ --paths /a,/b`) && !/--max-(routes|minutes)/.test(note), deep.join("\n"));
  // Every page found was looked at: nothing stopped it.
  const done = firstRunSummary(firstRunFacts({ routes: twenty, unvisited: [] }), "r");
  assert.ok(!done.some((l) => /^Stopped|more pages? found/.test(l)), done.join("\n"));
  assert.equal(stopReason({ routes: twenty, unvisited: [], timeBudget: { ms: 1, reached: true } }, 20), null);
});

test("the summary says when the start page was a sign-in page, or moved to another site", () => {
  const bounced = firstRunSummary(firstRunFacts({ routes: [route({ loginRedirect: true, url: `${ORIGIN}/login` })] }), "r");
  assert.ok(
    bounced.some((l) => /^The start page sent the browser to a sign-in page/.test(l) && l.includes(`npx -y scenescout login ${ORIGIN}/ --role <name>`)),
    bounced.join("\n"),
  );
  const open = firstRunSummary(firstRunFacts({ routes: [route()] }), "r");
  assert.ok(!open.some((l) => /sign-in page|moved to/.test(l)), open.join("\n"));
  // http to https, or to another host: the links there are another site's to the engine, so the look stopped at one page.
  const moved = firstRunSummary(firstRunFacts({ url: "http://app.example.test/", routes: [route({ url: "https://app.example.test/" })] }), "r");
  assert.ok(
    moved.includes(
      "The start page moved to https://app.example.test, so its links count as another site's and were not followed. To look further, run it there: npx -y scenescout https://app.example.test/.",
    ),
    moved.join("\n"),
  );
  // A page that did not load says nothing about where the app lives.
  const failed = firstRunSummary(
    firstRunFacts({ url: "http://app.example.test/", routes: [route({ url: "https://elsewhere.test/", loadError: "timeout", status: null })] }),
    "r",
  );
  assert.ok(!failed.some((l) => /moved to/.test(l)), failed.join("\n"));
});

test("the report opens with what to look at first and ends with what to try next; it never speaks of a gate", () => {
  const issues = threeIssues();
  const routes = ["/", "/new", "/done"].map((p) => route({ path: p }));
  const worthALook = [
    { rule: "off-grid-spacing" as const, evidence: "paddings off a 4px grid: 6px", routes: ["/"], convention: "a 4px spacing scale", fingerprint: "f" },
  ];
  const report = formatFirstRun(firstRunFacts({ issues, routes, worthALook, unvisited: ["/later"] }));
  const at = (text: string): number => {
    const i = report.indexOf(text);
    assert.ok(i >= 0, `the report has no "${text}"\n${report}`);
    return i;
  };
  assert.ok(report.startsWith("# SceneScout first look\n"));
  assert.ok(at("## Look at these first") < at("## Medium (4)"));
  assert.match(report, /\n1\. \[medium\] \*\*Request failed with a client error\*\* `client-error`: GET \/img\/chart\.png → HTTP 404/);
  assert.match(report, /\n3\. \[medium\] \*\*Field labelled only by its placeholder\*\*/);
  assert.ok(at("## Routes") < at("Not visited (past the link steps followed): `/later`"));
  assert.ok(at("## What to try next") > at("## Routes"));
  assert.ok(report.includes(`The guide: ${GUIDE_URL}`));
  // The mode it ran in, and what that mode lets out of the page, said as the safety model says it.
  assert.ok(report.includes(" · observe mode · "), report);
  assert.ok(report.includes(modeSentence("observe")), report);
  // A look, not a gate: no verdict, no settings line, and the worth-a-look note says nothing about failing a gate.
  assert.ok(!/\*\*PASSED\*\*|\*\*FAILED\*\*|gate:|--fail-on|Settings —/.test(report), report);
  // The check's own report keeps its gate wording.
  assert.match(formatCheck({ ...result([]), worthALook }), /never fail the gate, at any --fail-on/);
});

test("the summary and the report say which mode the look ran in, and what that mode lets out of the page", () => {
  const observe = firstRunFacts({ routes: [route()] });
  const readOnly = firstRunFacts({ routes: [route()], mode: "read-only" });
  assert.equal(firstRunSummary(observe, "r")[2], "1 page looked at in 41 s in observe mode: 0 high · 0 medium · 0 low.");
  assert.equal(firstRunSummary(readOnly, "r")[2], "1 page looked at in 41 s in read-only mode: 0 high · 0 medium · 0 low.");
  // Observe lets nothing but reads out, sign-in and token refresh apart; read-only lets a plain POST through, and says so.
  assert.equal(
    modeSentence("observe"),
    "In observe mode nothing but GET, HEAD and OPTIONS requests leaves the page, apart from signing in, signing out and refreshing a token: every other request a page sends is refused.",
  );
  assert.match(modeSentence("read-only"), /a plain POST the page's own scripts send goes through/);
  const observeReport = formatFirstRun(observe);
  const readOnlyReport = formatFirstRun(readOnly);
  assert.ok(
    observeReport.includes(" · observe mode · ") && observeReport.includes(modeSentence("observe")) && !observeReport.includes(modeSentence("read-only")),
  );
  assert.ok(
    readOnlyReport.includes(" · read-only mode · ") && readOnlyReport.includes(modeSentence("read-only")) && !readOnlyReport.includes(modeSentence("observe")),
  );
});

test("the commands the report suggests can be pasted into a shell: an address with ? or & in it is quoted, a plain one is not", () => {
  const plain = formatFirstRun(firstRunFacts({ url: `${ORIGIN}/` }));
  assert.ok(plain.includes(`\`npx -y scenescout check ${ORIGIN}/\``), plain);
  const query = formatFirstRun(firstRunFacts({ url: `${ORIGIN}/start?tab=1&view=all` }));
  assert.ok(query.includes(`\`npx -y scenescout check '${ORIGIN}/start?tab=1&view=all'\``), query);
  assert.ok(query.includes(`\`npx -y scenescout login '${ORIGIN}/start?tab=1&view=all' --role <name>\``), query);
  assert.equal(shellArg("http://x/it's"), "'http://x/it'\\''s'");
});

test("a first run that loaded no page could not reach the address; one page loaded is enough to report", () => {
  assert.equal(
    unreachableReason([route({ status: null, loadError: "net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/" })]),
    "net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/",
  );
  assert.equal(unreachableReason([]), "no page loaded");
  assert.equal(unreachableReason([route({ status: null, loadError: "timeout" }), route({ path: "/b" })]), null);
  // A page that answers with an error loaded: that is a finding, not an unreachable address.
  assert.equal(unreachableReason([route({ status: 500 })]), null);
});

test("the report and the JSON a first look writes begin the way a later look recognises as its own; anything else does not", () => {
  const facts = firstRunFacts({ issues: threeIssues(), routes: [route()] });
  assert.equal(writtenByFirstLook("report.md", formatFirstRun(facts)), true);
  assert.equal(writtenByFirstLook("check.json", JSON.stringify(toSummaryJson(facts.result, "1.0.0"), null, 2) + "\n"), true);
  // The near misses: a check's report, someone's notes, a JSON object of another shape.
  assert.equal(writtenByFirstLook("report.md", formatCheck(result([]))), false);
  assert.equal(writtenByFirstLook("report.md", "# My report\n"), false);
  assert.equal(writtenByFirstLook("check.json", '{\n  "mine": true\n}\n'), false);
  assert.equal(writtenByFirstLook("check.json", JSON.stringify(toSummaryJson(facts.result, "1.0.0"))), false, "not as a first look writes it");
});

test("a check's JSON records a time budget only when it had one", () => {
  const budget = toSummaryJson({ ...result([]), timeBudget: { ms: 180_000, reached: true } }, "1.0.0") as { timeBudget?: unknown };
  assert.deepEqual(budget.timeBudget, { ms: 180_000, reached: true });
  assert.equal("timeBudget" in (toSummaryJson(result([]), "1.0.0") as object), false);
});
