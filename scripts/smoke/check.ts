/**
 * `scenescout check` end to end: the real CLI against a fresh demo app. It
 * must find the defects the demo seeds that show at page load, stay quiet
 * about the pages that are fine, and exit with the code its gate promises.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs, no types; it exports createDemoServer().
import { createDemoServer } from "../../demo-app/server.mjs";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { BROWSER, check, type SmokeContext } from "./harness.ts";

export const title = "check (deterministic gate)";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");

type Summary = {
  gate: { failOn: string; passed: boolean };
  routes: Array<{ path: string; controls: number }>;
  issues: Array<{ rule: string; severity: string; evidence: string; routes: string[] }>;
};

/** Asynchronous on purpose: the demo app is served from this process, and a synchronous spawn would stop it answering. */
function runCli(args: string[]): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, "check", ...args],
      { encoding: "utf8", timeout: 300_000, env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
      (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === "number" ? err.code : null) : 0, out: `${stdout}\n${stderr}` }),
    );
  });
}

export async function run({ baseUrl, foreignBaseUrl, stats }: SmokeContext): Promise<void> {
  const server = createDemoServer() as http.Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "scout-check-"));
  try {
    await runAll({ baseUrl, server, base, work });
    await flowsAndRetests({ baseUrl, stats, work });
    await flowWriteEdges({ baseUrl, foreignBaseUrl, stats, work });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function runAll({ baseUrl, server, base, work }: { baseUrl: string; server: http.Server; base: string; work: string }): Promise<void> {
  try {
    const out = path.join(work, "out");
    const first = await runCli([base, "--project", work, "--out", out]);
    check("the demo app passes the default gate: nothing it seeds at page load is high", first.status === 0, first.out.slice(-1500));
    const summary = JSON.parse(fs.readFileSync(path.join(out, "check.json"), "utf8")) as Summary;
    const has = (rule: string, evidence: RegExp, route?: string): boolean =>
      summary.issues.some((i) => i.rule === rule && evidence.test(i.evidence) && (route === undefined || i.routes.includes(route)));
    check("the dashboard chart's 404", has("client-error", /GET \/img\/weekly-chart\.png → HTTP 404/, "/"), JSON.stringify(summary.issues));
    check("...and the broken image it leaves", has("broken-image", /weekly-chart\.png/, "/"));
    check("the badge covering All orders", has("overlapping-controls", /"All orders" overlaps "New: bulk import"/, "/"));
    check("the faint hint text, with its ratio", has("contrast", /1\.73:1/, "/orders-new.html"));
    check(
      "the confirmation email field, labelled only by its placeholder",
      has("placeholder-only-label", /new-order-email.*Confirmation email/, "/orders-new.html") &&
        !summary.issues.some((i) => i.rule === "unnamed-control" && i.routes.includes("/orders-new.html")),
      JSON.stringify(summary.issues.filter((i) => i.routes.includes("/orders-new.html"))),
    );
    check("the Save notes button under the fixed bar", has("covered-control", /"Save notes" is COVERED by pinned chrome/));
    check("the Scheduled reports dead end", has("dead-end", /reports-scheduled/, "/reports-scheduled.html"));
    const healthy = ["/approvals.html", "/inventory.html", "/customers.html", "/audit.html"];
    check(
      "the healthy pages were checked, and no issue is charged to them",
      healthy.every((p) => summary.routes.some((r) => r.path === p)) && healthy.every((p) => !summary.issues.some((i) => i.routes.includes(p))),
      JSON.stringify(summary.issues.filter((i) => i.routes.some((r) => r !== "/" && !r.startsWith("/order") && !r.startsWith("/reports")))),
    );
    check(
      "every route it links to was reached",
      summary.routes.length >= 12 && summary.routes.every((r) => r.controls > 0 || r.path === "/reports-scheduled.html"),
      JSON.stringify(summary.routes),
    );
    check("the report and SARIF are written beside the summary", fs.existsSync(path.join(out, "report.md")) && fs.existsSync(path.join(out, "check.sarif")));
    check("the report starts with the verdict", /\*\*PASSED\*\*/.test(fs.readFileSync(path.join(out, "report.md"), "utf8").split("\n").slice(0, 6).join("\n")));

    const strict = await runCli([base, "--project", work, "--out", path.join(work, "strict"), "--fail-on", "medium", "--paths", "/"]);
    check("the same app fails a medium gate, with exit code 1", strict.status === 1, strict.out.slice(-800));
    const scoped = JSON.parse(fs.readFileSync(path.join(work, "strict", "check.json"), "utf8")) as Summary;
    check("--paths checks only those paths", scoped.routes.length === 1 && scoped.routes[0].path === "/", JSON.stringify(scoped.routes));

    const scheduled = ["--project", work, "--fail-on", "medium", "--paths", "/reports-scheduled.html"];
    const notIgnored = await runCli([base, ...scheduled, "--out", path.join(work, "not-ignored")]);
    const ignored = await runCli([base, ...scheduled, "--out", path.join(work, "ignored"), "--ignore", "dead-end"]);
    check("the dead end alone fails a medium gate...", notIgnored.status === 1, notIgnored.out.slice(-800));
    check("...and --ignore dead-end takes it out", ignored.status === 0, ignored.out.slice(-800));

    const capped = await runCli([base, "--project", work, "--out", path.join(work, "capped"), "--max-routes", "3"]);
    const cappedSummary = JSON.parse(fs.readFileSync(path.join(work, "capped", "check.json"), "utf8")) as Summary & { unvisited: string[] };
    check(
      "--max-routes stops at that many routes and lists the rest as not visited",
      capped.status === 0 && cappedSummary.routes.length === 3 && cappedSummary.unvisited.length > 0,
      `${capped.status} ${JSON.stringify(cappedSummary.routes)} ${JSON.stringify(cappedSummary.unvisited)}`,
    );

    const version = (JSON.parse(fs.readFileSync(path.join(path.dirname(cli), "..", "package.json"), "utf8")) as { version: string }).version;
    const help = await runCli(["--help"]);
    check(
      "the help's first line names the version, so an old global install cannot pass for this one",
      help.status === 0 && help.out.split("\n")[0].startsWith(`SceneScout ${version} — `) && /scenescout check <url>/.test(help.out),
      help.out.slice(0, 200),
    );

    const bad = await runCli([base, "--mode", "destructive"]);
    check("a bad argument exits 2, not the gate's 1", bad.status === 2 && /--mode must be observe or read-only/.test(bad.out), bad.out);
  } finally {
    server.closeAllConnections();
    server.close();
  }
  // Nothing listening any more: a check that cannot reach the app has not passed, and has not failed the gate either.
  const down = await runCli([base, "--project", work, "--out", path.join(work, "down")]);
  check("an unreachable app exits 2", down.status === 2 && /no page loaded|could not run/.test(down.out), down.out.slice(-800));

  // The fixture app: a linked page whose server hangs up is tried once, not on every discovery round.
  const links = await runCli([`${baseUrl}/check-links.html`, "--project", work, "--out", path.join(work, "links")]);
  const linkSummary = JSON.parse(fs.readFileSync(path.join(work, "links", "check.json"), "utf8")) as Summary & { unvisited: string[] };
  const dropped = linkSummary.routes.filter((r) => r.path === "/drop-connection");
  check(
    "a page that fails to load is one route and one issue, not one per round",
    dropped.length === 1 &&
      linkSummary.issues.filter((i) => i.rule === "route-load-failed").length === 1 &&
      !linkSummary.unvisited.includes("/drop-connection"),
    JSON.stringify({ routes: linkSummary.routes, unvisited: linkSummary.unvisited }),
  );
  check("...and fails the default gate", links.status === 1, links.out.slice(-600));

  // The same field labelled every way that counts, then by its placeholder alone, then by nothing but its name attribute.
  await runCli([`${baseUrl}/field-labels.html`, "--project", work, "--out", path.join(work, "labels"), "--paths", "/field-labels.html"]);
  const labelIssues = (JSON.parse(fs.readFileSync(path.join(work, "labels", "check.json"), "utf8")) as Summary).issues.filter((i) =>
    ["placeholder-only-label", "unnamed-control"].includes(i.rule),
  );
  check(
    "only the field with nothing but a placeholder is filed as placeholder-only; a label, aria-label, wrapping label, aria-labelledby or title each count",
    labelIssues
      .filter((i) => i.rule === "placeholder-only-label")
      .map((i) => i.evidence)
      .join("|") === 'textbox [testid=field-placeholder-only] "Email"',
    JSON.stringify(labelIssues),
  );
  check(
    "...and the field with only a name attribute, and the one whose blank aria-label hides its placeholder, are unnamed; a submit button named by its value is not",
    labelIssues
      .filter((i) => i.rule === "unnamed-control")
      .map((i) => i.evidence)
      .join("|") === "textbox [testid=field-name-only]|textbox [testid=field-blank-aria-label]",
    JSON.stringify(labelIssues),
  );

  // Every page bounced to sign-in: only the sign-in page was measured, which is no verdict on the app.
  const walled = await runCli([baseUrl, "--project", work, "--out", path.join(work, "walled"), "--paths", "/members/a,/members/b"]);
  check(
    "a check that only reached sign-in exits 2 and says why",
    walled.status === 2 && /sent the browser to sign-in/.test(walled.out),
    walled.out.slice(-800),
  );
  // The start page bounces, and the sign-in page links to a public page that loads fine.
  const walledStart = await runCli([`${baseUrl}/check-walled/home`, "--project", work, "--out", path.join(work, "walled-start")]);
  check(
    "...and so does one whose start page bounced, however many public pages the sign-in page links to",
    walledStart.status === 2 && /start page sent the browser to sign-in/.test(walledStart.out),
    walledStart.out.slice(-800),
  );

  // A route that failed to load stays unvisited in the project's memory: one outage is not coverage.
  const projectDir = path.join(work, "memory-project");
  fs.mkdirSync(projectDir);
  const engine = new BrowserEngine();
  try {
    await engine.attach({ url: baseUrl, projectDir, mode: "read-only" });
    await engine.crawl(["/check-links.html"]);
    await engine.crawl();
    const failed = engine.lastCrawlHealth.some((r) => r.path === "/drop-connection" && r.loadError !== undefined);
    check(
      "a failed load is not retried by the next crawl, but still counts as never visited",
      failed && engine.unvisitedKnownRoutes().includes("/drop-connection") && !engine.crawlableRoutes().includes("/drop-connection"),
      JSON.stringify({ unvisited: engine.unvisitedKnownRoutes(), crawlable: engine.crawlableRoutes() }),
    );
    const again = await engine.crawl();
    check(
      "...and a crawl with nothing new says which routes failed and how to retry them, not that everything was visited",
      /failed to load earlier/.test(again) && /\/drop-connection/.test(again) && !/every known route has been visited/.test(again),
      again,
    );
    await engine.attach({ url: baseUrl, projectDir, mode: "read-only" });
    check("a new attach gives a failed route another try", engine.crawlableRoutes().includes("/drop-connection"), JSON.stringify(engine.crawlableRoutes()));

    // The snapshot still shows the placeholder, so the field can be told apart, and says it is not a label.
    await engine.navigate("/field-labels.html");
    const snap = await engine.snapshot(true);
    const lineOf = (testid: string): string => snap.split("\n").find((l) => l.includes(`testid=${testid}`)) ?? "";
    check(
      "the snapshot flags a field whose only label is its placeholder, and shows the placeholder as its name",
      /textbox "Email" \[.*no label: placeholder only/.test(lineOf("field-placeholder-only")) &&
        /textbox "email" \[.*no label\b/.test(lineOf("field-name-only")) &&
        /textbox "\(unnamed\)" \[.*no label(?!:)/.test(lineOf("field-blank-aria-label")),
      snap,
    );
    check(
      "...and flags none of the labelled ones",
      ["field-label-for", "field-aria-label", "field-label-wrapping", "field-labelledby", "field-title", "field-submit"].every(
        (t) => lineOf(t) && !/no label/.test(lineOf(t)),
      ),
      snap,
    );
    const crawled = await engine.crawl(["/field-labels.html"]);
    check("the crawl counts the three unlabelled fields as unnamed, each once", /field-labels\.html — 200 · \d+ el.* · 3 unnamed/.test(crawled), crawled);
  } finally {
    await engine.close();
  }
}

type FlowSummary = Summary & {
  flows: Array<{ name: string; file: string; status: string; step?: number; reason?: string }>;
  retest: { open: number; results: Array<{ id: string; verdict: string; note?: string }> } | null;
};

/**
 * Saved flows and re-tests, against the fixture app. The flow pair is one flow
 * run against two pages that differ in one fact, the endpoint behind "Show
 * details", so a failure on the broken page can only be the flow noticing it.
 */
async function flowsAndRetests({ baseUrl, stats, work }: { baseUrl: string; stats: SmokeContext["stats"]; work: string }): Promise<void> {
  const flowFor = (page: string) => ({
    name: "show details",
    steps: [
      { action: "navigate", target: page },
      { action: "type", target: "label=Filter", value: "abc" },
      { action: "click", target: 'role=button[name="Show details"]' },
      { action: "expect-text", text: "Details loaded" },
      { action: "expect-url", pattern: "details=open$" },
      { action: "expect-request", request: "GET /api/allow", status: 200 },
    ],
  });
  const project = (name: string, flows: Record<string, unknown>): string => {
    const dir = path.join(work, name);
    fs.mkdirSync(path.join(dir, ".scenescout", "flows"), { recursive: true });
    for (const [file, flow] of Object.entries(flows)) fs.writeFileSync(path.join(dir, ".scenescout", "flows", file), JSON.stringify(flow));
    return dir;
  };
  const checkWith = async (dir: string, extra: string[] = []) => {
    const out = path.join(dir, "out");
    const r = await runCli([`${baseUrl}/check-flow.html`, "--project", dir, "--out", out, "--paths", "/check-flow.html", ...extra]);
    const file = path.join(out, "check.json");
    return { ...r, summary: fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as FlowSummary) : null };
  };

  const honest = await checkWith(project("flow-honest", { "details.json": flowFor("/check-flow.html") }));
  check(
    "a saved flow that still works passes the gate, and the report says it ran",
    honest.status === 0 &&
      honest.summary?.flows.length === 1 &&
      honest.summary.flows[0].status === "passed" &&
      !honest.summary.issues.some((i) => i.rule === "flow-step-failed"),
    `${honest.status} ${JSON.stringify(honest.summary?.flows)} ${honest.out.slice(-600)}`,
  );

  const broken = await checkWith(project("flow-broken", { "details.json": flowFor("/check-flow-broken.html") }));
  const brokeAt = broken.summary?.issues.find((i) => i.rule === "flow-step-failed");
  check(
    "...and the same flow against the page where its request fails breaks the gate, naming the flow and the step",
    broken.status === 1 &&
      brokeAt?.severity === "high" &&
      /^flow "show details" \(details\.json\) step 4 of 6, expect text "Details loaded": no visible text "Details loaded"/.test(brokeAt.evidence) &&
      brokeAt.routes.includes("/check-flow-broken.html"),
    `${broken.status} ${JSON.stringify(broken.summary?.issues)} ${broken.out.slice(-600)}`,
  );
  check(
    "...with the failed request the flow caused as its own issue",
    broken.summary?.issues.some((i) => i.rule === "server-error" && /GET \/api\/refuse\/500 → HTTP 500/.test(i.evidence)) === true,
    JSON.stringify(broken.summary?.issues),
  );

  const missing = await checkWith(
    project("flow-missing", {
      "details.json": {
        ...flowFor("/check-flow.html"),
        steps: [...flowFor("/check-flow.html").steps.slice(0, 1), { action: "click", target: "testid=flow-nowhere" }],
      },
    }),
  );
  check(
    "a step whose control is gone breaks the flow at that step",
    missing.status === 1 &&
      missing.summary?.flows[0]?.status === "failed" &&
      missing.summary.flows[0].step === 2 &&
      /nothing visible matches testid=flow-nowhere/.test(missing.summary.flows[0].reason ?? ""),
    `${missing.status} ${JSON.stringify(missing.summary?.flows)}`,
  );

  // A step that would write. The same flow, under the default and under --flow-writes allow, both in read-only mode,
  // which on its own would let an ordinary POST through.
  const addFlow = {
    steps: [
      { action: "navigate", target: "/check-flow.html" },
      { action: "click", target: "testid=flow-add" },
      { action: "expect-text", text: "Added" },
    ],
  };
  const posts = () => stats.writes["POST /api/items"] ?? 0;
  const before = posts();
  const never = await checkWith(project("flow-write-never", { "add.json": addFlow }));
  check(
    "--flow-writes never (the default) refuses a flow's POST even in read-only mode: exit 2 naming the flow, the step and the request, and nothing reaches the server",
    never.status === 2 &&
      /could not run a saved flow: flow "add" \(add\.json\) step 2 of 3, click testid=flow-add: the observe write policy refused POST \/api\/items\. Flows replay with --flow-writes never/.test(
        never.out,
      ) &&
      posts() === before,
    `${never.status} ${never.out.slice(-800)} writes=${JSON.stringify(stats.writes)}`,
  );
  const allow = await checkWith(project("flow-write-allow", { "add.json": addFlow }), ["--flow-writes", "allow"]);
  check(
    "...and --flow-writes allow replays it under --mode read-only, which sends the POST and lets the flow pass",
    allow.status === 0 &&
      allow.summary?.flows[0]?.status === "passed" &&
      posts() === before + 1 &&
      (allow.summary as { settings?: { flowWrites?: string } }).settings?.flowWrites === "allow",
    `${allow.status} ${JSON.stringify(allow.summary?.flows)} writes=${JSON.stringify(stats.writes)} ${allow.out.slice(-600)}`,
  );

  // A refused flow first, a flow that works second: report keeps going and writes every verdict, stop ends at the refusal.
  const both = { "add.json": addFlow, "details.json": flowFor("/check-flow.html") };
  const reported = await checkWith(project("flow-report", both));
  check(
    "--on-refused-step report (the default): the refused flow is marked could not run, the next flow still runs and passes, the results are written, and the check exits 2",
    reported.status === 2 &&
      reported.summary?.flows.map((f) => `${f.file}:${f.status}`).join(",") === "add.json:refused,details.json:passed" &&
      (reported.summary as { gate?: { couldNotRun?: number } }).gate?.couldNotRun === 1 &&
      /\*\*COULD NOT RUN\*\*/.test(reported.out),
    `${reported.status} ${JSON.stringify(reported.summary?.flows)} ${reported.out.slice(-600)}`,
  );
  const stopped = await checkWith(project("flow-stop", both), ["--on-refused-step", "stop"]);
  check(
    "...and stop exits 2 at the refusal: the next flow never runs and no results are written",
    stopped.status === 2 && stopped.summary === null && /flow add: refused/.test(stopped.out) && !/flow show details:/.test(stopped.out),
    `${stopped.status} ${stopped.out.slice(-800)}`,
  );

  const invalid = await checkWith(
    project("flow-invalid", {
      "bad.json": {
        steps: [
          { action: "navigate", target: "/check-flow.html" },
          { action: "click", taget: "testid=x" },
        ],
      },
    }),
  );
  check(
    "a flow file that is not valid stops the check before it starts, naming the file and the field",
    invalid.status === 2 &&
      /flow bad\.json: steps\[1\]\.target is required; steps\[1\] unknown field\(s\) "taget"/.test(invalid.out) &&
      invalid.summary === null,
    invalid.out.slice(-600),
  );
  const off = await checkWith(project("flow-off", { "bad.json": { steps: [] } }), ["--flows", "off"]);
  check("--flows off leaves the saved flows alone", off.status === 0 && off.summary?.flows.length === 0, off.out.slice(-600));

  // Two open findings naming the same failed request: one on the page that still makes it on load, one on a page that no longer does.
  const dir = path.join(work, "retest");
  fs.mkdirSync(path.join(dir, ".scenescout"), { recursive: true });
  const filed = (id: string, page: string) => ({
    id,
    severity: "high",
    category: "http-error",
    title: `Summary fails (${id})`,
    detail: "",
    evidence: "GET /api/fail-500 500",
    url: `${baseUrl}${page}`,
    state: `${page}#s`,
    repro: [`crawl ${page} @ ${baseUrl}${page}`, `snapshot @ ${baseUrl}${page}`],
    foundAt: "2026-09-01T00:00:00.000Z",
    runs: 2,
  });
  const memory = JSON.stringify({ version: 1, states: {}, findings: [filed("still", "/check-retest.html"), filed("gone", "/check-flow.html")] });
  const memoryPath = path.join(dir, ".scenescout", "memory.json");
  fs.writeFileSync(memoryPath, memory);
  const retested = await runCli([`${baseUrl}/check-flow.html`, "--project", dir, "--out", path.join(dir, "out"), "--fail-on", "never"]);
  const rs = JSON.parse(fs.readFileSync(path.join(dir, "out", "check.json"), "utf8")) as FlowSummary;
  const verdictOf = (id: string) => rs.retest?.results.find((r) => r.id === id)?.verdict;
  check(
    "an open finding whose failed request still fails when its page loads is reported as reproducing, the page loaded for it though no link led there",
    retested.status === 0 && verdictOf("still") === "reproduces",
    `${retested.status} ${JSON.stringify(rs.retest)} ${JSON.stringify(rs.routes)}`,
  );
  check(
    "...and that page, loaded only for the re-test, is not a checked route and no page rule is applied to it",
    !rs.routes.some((r) => r.path === "/check-retest.html") &&
      !rs.issues.some((i) => i.routes.includes("/check-retest.html")) &&
      (rs.retest as { extraPages?: number } | null)?.extraPages === 1,
    `${JSON.stringify(rs.routes)} ${JSON.stringify(rs.issues)}`,
  );
  // The default gate, with re-tests not gating: the 500 behind the re-tested page must not fail it through the page rules.
  const ungated = await runCli([`${baseUrl}/check-flow.html`, "--project", dir, "--out", path.join(dir, "out-ungated"), "--gate-retests", "never"]);
  const us = JSON.parse(fs.readFileSync(path.join(dir, "out-ungated", "check.json"), "utf8")) as FlowSummary;
  check(
    "with the default --fail-on and --gate-retests never, a finding that still fails on a page loaded only to re-test it leaves the check at exit 0",
    ungated.status === 0 && us.retest?.results.find((r) => r.id === "still")?.verdict === "reproduces",
    `${ungated.status} ${JSON.stringify(us.issues)} ${ungated.out.slice(-600)}`,
  );
  const gated = await runCli([`${baseUrl}/check-flow.html`, "--project", dir, "--out", path.join(dir, "out-gated")]);
  check("...and with the default --gate-retests high, the same finding (filed high) fails the gate", gated.status === 1, gated.out.slice(-600));
  check(
    "...and the same finding on a page that loads cleanly is reported as possibly fixed",
    verdictOf("gone") === "possibly-fixed",
    JSON.stringify(rs.retest),
  );
  check("...and the check leaves the project's memory exactly as it found it", fs.readFileSync(memoryPath, "utf8") === memory);
  // A re-test load measures and nothing else: the page stays on the unvisited list, and its links are not harvested.
  const unvisitedWith = async (retest: "on" | "off") => {
    const out = path.join(dir, `out-unvisited-${retest}`);
    await runCli([`${baseUrl}/check-retest-start.html`, "--project", dir, "--out", out, "--max-routes", "1", "--fail-on", "never", "--retest", retest]);
    const j = JSON.parse(fs.readFileSync(path.join(out, "check.json"), "utf8")) as FlowSummary & { unvisited: string[] };
    return { unvisited: j.unvisited, verdict: j.retest?.results.find((r) => r.id === "still")?.verdict };
  };
  const withRetest = await unvisitedWith("on");
  const withoutRetest = await unvisitedWith("off");
  check(
    "a page loaded only to re-test stays on the unvisited list, and the page it links to is not added to it",
    withRetest.verdict === "reproduces" &&
      JSON.stringify(withRetest.unvisited) === JSON.stringify(withoutRetest.unvisited) &&
      withRetest.unvisited.includes("/check-retest.html") &&
      !withRetest.unvisited.includes("/check-links-2.html"),
    `${JSON.stringify(withRetest)} vs ${JSON.stringify(withoutRetest)}`,
  );
  const noRetest = await runCli([`${baseUrl}/check-flow.html`, "--project", dir, "--out", path.join(dir, "out-off"), "--retest", "off"]);
  const offSummary = JSON.parse(fs.readFileSync(path.join(dir, "out-off", "check.json"), "utf8")) as FlowSummary;
  check(
    "--retest off neither re-tests nor loads the findings' pages",
    noRetest.status === 0 && offSummary.retest === null && !offSummary.routes.some((r) => r.path === "/check-retest.html"),
    `${noRetest.status} ${JSON.stringify(offSummary.routes)}`,
  );
}

/**
 * The edges of the flow write rule, against test-app/check-flow-writes.html:
 * a beacon to another origin that no step causes, a write that lands after the
 * last step, and a form posted with Enter two ways.
 */
async function flowWriteEdges({
  baseUrl,
  foreignBaseUrl,
  stats,
  work,
}: {
  baseUrl: string;
  foreignBaseUrl: string;
  stats: SmokeContext["stats"];
  work: string;
}): Promise<void> {
  const runFlows = async (name: string, flows: Record<string, unknown>) => {
    const dir = path.join(work, name);
    fs.mkdirSync(path.join(dir, ".scenescout", "flows"), { recursive: true });
    for (const [file, flow] of Object.entries(flows)) fs.writeFileSync(path.join(dir, ".scenescout", "flows", file), JSON.stringify(flow));
    const out = path.join(dir, "out");
    const r = await runCli([`${baseUrl}/check-flow.html`, "--project", dir, "--out", out, "--paths", "/check-flow.html"]);
    const file = path.join(out, "check.json");
    type Row = { file: string; status: string; step?: number; reason?: string; refusedBackground?: string[] };
    const json = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { flows: Row[]; issues: Summary["issues"] }) : null;
    return { ...r, flows: json?.flows ?? null, issues: json?.issues ?? [] };
  };
  const writes = (key: string) => stats.writes[key] ?? 0;

  const other = encodeURIComponent(foreignBaseUrl);
  // A contrastive pair on one page, both to the same second origin: a click that POSTs with fetch, and a beacon on a timer.
  const itemsAtStart = writes("POST /api/items");
  const beaconsAtStart = writes("POST /api/beacon");
  const remote = await runFlows("flow-remote-fetch", {
    "remote.json": {
      steps: [
        { action: "navigate", target: `/check-flow-writes.html?other=${other}` },
        { action: "click", target: "testid=writes-add-remote" },
        { action: "expect-text", text: "Added" },
      ],
    },
  });
  check(
    "a click whose fetch POSTs to another origin (an API on another port) is charged to that step: the flow could not run, exit 2",
    remote.status === 2 &&
      remote.flows?.[0]?.status === "refused" &&
      remote.flows[0].step === 2 &&
      /POST http:\/\/127\.0\.0\.1:\d+\/api\/items/.test(remote.flows[0].reason ?? ""),
    `${remote.status} ${JSON.stringify(remote.flows)} ${remote.out.slice(-600)}`,
  );
  const beaconFlow = {
    steps: [
      { action: "navigate", target: `/check-flow-writes.html?beacon=${other}` },
      { action: "type", target: "label=Title", value: "abc" },
      { action: "expect-text", text: "Ready" },
    ],
  };
  for (const attempt of [1, 2]) {
    const beacon = await runFlows(`flow-beacon-${attempt}`, { "beacon.json": beaconFlow });
    check(
      `...while a sendBeacon to that same origin on a timer is refused and listed as a background request, charged to no step: the flow passes (run ${attempt})`,
      beacon.status === 0 &&
        beacon.flows?.[0]?.status === "passed" &&
        (beacon.flows[0].refusedBackground ?? []).some((s) => /POST http:\/\/127\.0\.0\.1:\d+\/api\/beacon/.test(s)),
      `${beacon.status} ${JSON.stringify(beacon.flows)} ${beacon.out.slice(-600)}`,
    );
  }
  // A beacon still in flight as the flow leaves the page is one sent during unload: refused too, on every engine (unloadWriteInterception).
  check(
    `...and neither the fetch nor any beacon reached the other origin, one in flight as the page is left included (${BROWSER})`,
    writes("POST /api/items") === itemsAtStart && writes("POST /api/beacon") === beaconsAtStart,
    JSON.stringify(stats.writes),
  );

  // The same timer sending a fetch to the app's own origin is charged: a check cannot tell it from the step's own write.
  const heartbeatsBefore = writes("POST /api/heartbeat");
  for (const attempt of [1, 2]) {
    const heartbeat = await runFlows(`flow-heartbeat-${attempt}`, {
      "heartbeat.json": {
        steps: [
          { action: "navigate", target: "/check-flow-writes.html?heartbeat=1" },
          { action: "expect-text", text: "Ready" },
        ],
      },
    });
    check(
      `a same-origin fetch heartbeat on a timer is charged to the step it lands in: the flow could not run, exit 2 (run ${attempt})`,
      heartbeat.status === 2 && heartbeat.flows?.[0]?.status === "refused" && /POST \/api\/heartbeat/.test(heartbeat.flows[0].reason ?? ""),
      `${heartbeat.status} ${JSON.stringify(heartbeat.flows)} ${heartbeat.out.slice(-600)}`,
    );
  }
  check("...and no heartbeat reached the server", writes("POST /api/heartbeat") === heartbeatsBefore, JSON.stringify(stats.writes));

  // A beacon sent as the flow leaves the page: refused under the flow's rule on every engine, and listed.
  const leavesBefore = writes("POST /api/leave");
  const leave = await runFlows("flow-leave-beacon", {
    "leave.json": {
      steps: [
        { action: "navigate", target: "/check-flow-writes.html" },
        { action: "click", target: "testid=writes-save-on-leave" },
        { action: "expect-text", text: "Will save on leave" },
      ],
    },
  });
  const listed = (leave.flows?.[0]?.refusedBackground ?? []).some((s) => /\/api\/leave/.test(s));
  check(
    `${BROWSER}: a beacon sent on pagehide as the flow leaves the page is refused under the flow's rule and listed as a background request; the flow passes and nothing reaches the server`,
    leave.status === 0 && leave.flows?.[0]?.status === "passed" && writes("POST /api/leave") === leavesBefore && listed,
    `${leave.status} ${JSON.stringify(leave.flows)} writes=${JSON.stringify(stats.writes)}`,
  );

  const itemsBefore = writes("POST /api/items");
  const late = await runFlows("flow-late-write", {
    "late.json": {
      steps: [
        { action: "navigate", target: "/check-flow-writes.html" },
        { action: "click", target: "testid=writes-save-later" },
        { action: "expect-text", text: "Saving shortly" },
      ],
    },
  });
  check(
    "a write that goes out after the last step's own checks is still refused and charged to the last step, and never reaches the server",
    late.status === 2 &&
      late.flows?.[0]?.status === "refused" &&
      late.flows[0].step === 3 &&
      /^after the last step\b.*POST \/api\/items/.test(late.flows[0].reason ?? "") &&
      writes("POST /api/items") === itemsBefore,
    `${late.status} ${JSON.stringify(late.flows)} ${late.out.slice(-600)}`,
  );

  const form = await runFlows("flow-form-post", {
    "enter-in-field.json": {
      steps: [
        { action: "navigate", target: "/check-flow-writes.html" },
        { action: "type", target: "label=Title", value: "abc", pressEnter: true },
      ],
    },
    "press-enter.json": {
      steps: [
        { action: "navigate", target: "/check-flow-writes.html" },
        { action: "type", target: "label=Title", value: "abc" },
        { action: "press", value: "Enter" },
      ],
    },
  });
  check(
    "a form posted with Enter, from type's pressEnter or from a press step, is refused under --flow-writes never: both flows could not run, the check exits 2, and no POST reaches the server",
    form.status === 2 &&
      form.flows?.map((f) => `${f.file}:${f.status}:${f.step}`).join(",") === "enter-in-field.json:refused:2,press-enter.json:refused:3" &&
      form.flows.every((f) => /POST \/api\/items/.test(f.reason ?? "")) &&
      writes("POST /api/items") === itemsBefore,
    `${form.status} ${JSON.stringify(form.flows)} writes=${JSON.stringify(stats.writes)}`,
  );

  // A navigate step to a page answering 500, whose URL carries a token: the step's failure is the one issue, not a second server-error.
  const errPage = await runFlows("flow-navigate-500", {
    "error-page.json": { steps: [{ action: "navigate", target: "/api/fail-500?token=Q7x9Rt2mLp4VzK8w" }] },
  });
  check(
    "a navigate step to a page that answers 500 is the flow's failure, and the page's own response is not a second issue, even with a token in its URL",
    errPage.status === 1 &&
      errPage.flows?.[0]?.status === "failed" &&
      /answered HTTP 500/.test(errPage.flows[0].reason ?? "") &&
      !errPage.issues.some((i) => i.rule === "server-error" && /fail-500/.test(i.evidence)),
    `${errPage.status} ${JSON.stringify(errPage.issues)}`,
  );
}
