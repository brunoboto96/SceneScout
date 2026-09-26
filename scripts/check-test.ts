/**
 * Unit tests for `scenescout check`'s rules: how a route's measurements become
 * issues, what fails the gate, the arguments it accepts and the SARIF it
 * writes. The browser half is in scripts/smoke/check.ts, against the demo app.
 *
 *   npx tsx --test --test-name-pattern "gate" scripts/check-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
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
  CHECK_OPTION_NAMES,
  CHECK_RULES,
  formatCheck,
  gateFailures,
  geometryRule,
  issuesFromRoutes,
  parseCheckArgs,
  redactRoutes,
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
  return { url: `${ORIGIN}/`, generatedAt: "2026-09-25T00:00:00.000Z", mode: "read-only", failOn, routes: [route()], issues, unvisited: [], ignored: [] };
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
  assert.deepEqual(parsed.options, { url: "http://127.0.0.1:3000/", projectDir: "/work/app", failOn: "high", mode: "read-only", maxRoutes: 50, ignore: [] });
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
  assert.deepEqual(summaryOutputs(json), { passed: "false", failing: "1", high: "1", medium: "1", low: "1" });
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
