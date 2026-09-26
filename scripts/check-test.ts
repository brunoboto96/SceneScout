/**
 * Unit tests for `scenescout check`'s rules: how a route's measurements become
 * issues, what fails the gate, the arguments it accepts and the SARIF it
 * writes. The browser half is in scripts/smoke/check.ts, against the demo app.
 *
 *   npx tsx --test --test-name-pattern "gate" scripts/check-test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  summaryOutputs,
  verdict,
} from "../action/check-action.mjs";
import { brokenImageIssues, geometryIssues } from "../src/engine/collector.ts";
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
import { checkRetestPlan, retestResults, wellFormedFindings, type MeasuredPage } from "../src/engine/verify.ts";
import {
  CHECK_OPTION_NAMES,
  CHECK_RULES,
  DEFAULT_SETTINGS,
  type GateRetests,
  describeSettings,
  exitCodeOf,
  retestGateFailures,
  formatCheck,
  gateFailures,
  geometryRule,
  issuesFromRoutes,
  parseCheckArgs,
  redactFlowRuns,
  redactRoutes,
  refusedFlowReason,
  withoutOwnResponse,
  summarise,
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
  ];
  const rules = lines.map((l) => geometryRule(l));
  assert.deepEqual(
    rules,
    ["covered-control", "clipped-control", "offpage-control", "overlapping-controls", "clipped-control", "clipped-control", "clipped-control", null],
    lines.join("\n"),
  );
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

test("--ignore drops a rule entirely", () => {
  const r = route({ design: [{ rule: "contrast", detail: "1.7:1" }], geometry: ['e1 "A" overlaps e2 "B" (90%)'] });
  assert.deepEqual(
    issuesFromRoutes([r], ORIGIN, ["contrast"]).map((i) => i.rule),
    ["overlapping-controls"],
  );
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
    unvisited: [],
    ignored: [],
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

test("SARIF: severities map to levels, rules list only what was found, locations are relative to the app", () => {
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
  const sarif = toSarif(result(issues), "9.9.9") as {
    version: string;
    runs: Array<{
      tool: { driver: { rules: Array<{ id: string }> } };
      originalUriBaseIds: { APP: { uri: string } };
      results: Array<{
        ruleId: string;
        level: string;
        locations: Array<{ physicalLocation: { artifactLocation: { uri: string; uriBaseId: string } } }>;
        partialFingerprints: Record<string, string>;
      }>;
    }>;
  };
  assert.equal(sarif.version, "2.1.0");
  const run = sarif.runs[0];
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id).sort(), ["contrast", "page-error"]);
  assert.equal(run.originalUriBaseIds.APP.uri, `${ORIGIN}/`);
  const byRule = Object.fromEntries(run.results.map((r) => [r.ruleId, r]));
  assert.equal(byRule["page-error"].level, "error");
  assert.equal(byRule["contrast"].level, "note");
  assert.deepEqual(byRule["page-error"].locations[0].physicalLocation.artifactLocation, { uri: "orders", uriBaseId: "APP" });
  assert.ok(byRule["page-error"].partialFingerprints["scenescoutCheck/v1"]);
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
    // Spelled out, not read from DEFAULT_SETTINGS: a default that drifts to allow, stop or never must fail here.
    retest: true,
    flowWrites: "never",
    onRefusedStep: "report",
    gateRetests: "high",
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
    flows: "/work/ci/flows",
    retest: false,
    flowWrites: "allow",
    onRefusedStep: "stop",
    gateRetests: "all",
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
    [["http://x", "--browser", "ie"], /--browser must be one of/],
    [["http://x", "--level", "high"], /unknown option --level/],
    [["http://x", "--fail-on"], /--fail-on needs a value/],
    [["http://x", "--fail-on", "--mode", "observe"], /--fail-on needs a value/],
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
    "storage-state": "auth/user.json",
    browser: "webkit",
    project: "site",
    out: "results",
    flows: "off",
    retest: "off",
    "flow-writes": "allow",
    "on-refused-step": "stop",
    "gate-retests": "never",
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
    flows: "off",
    retest: false,
    flowWrites: "allow",
    onRefusedStep: "stop",
    gateRetests: "never",
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
  assert.deepEqual(summaryOutputs(json), { passed: "false", failing: "1", high: "1", medium: "1", low: "1", "could-not-run": "0", "retests-failing": "0" });
  assert.equal(summaryOutputs(null), null);
  assert.equal(summaryOutputs({}), null);
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
