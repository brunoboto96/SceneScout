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
import { check, type SmokeContext } from "./harness.ts";

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

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  const server = createDemoServer() as http.Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "scout-check-"));
  try {
    await runAll({ baseUrl, server, base, work });
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
  } finally {
    await engine.close();
  }
}
