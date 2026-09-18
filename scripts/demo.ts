/**
 * Regenerates examples/: a sample report and screenshots, produced by running
 * the real engine against the bundled demo app (demo-app/).
 *
 *   npm run demo
 *
 * In a real run an AI agent decides where to look and writes the findings.
 * Here those two jobs are scripted so the output is reproducible: the path
 * through the app and the wording of each finding are fixed below. Everything
 * else in the report — oracle violations, policy blocks, geometry, page
 * scores, coverage, the gap ledger — is whatever the engine observed.
 *
 * Imports the compiled engine for the reason given in scripts/smoke/harness.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserEngine } from "../dist/engine/browser.js";
import { computeGaps, generateReport } from "../dist/engine/report.js";
// @ts-expect-error — plain .mjs, no types; it exports createDemoServer().
import { createDemoServer } from "../demo-app/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "examples");
const PORT = 4173;
const verbose = process.argv.includes("--verbose");

const engine = new BrowserEngine();
const show = (label: string, text: string): string => {
  console.log(`\n── ${label}`);
  console.log(verbose ? text : text.split("\n").slice(0, 6).join("\n"));
  return text;
};
/** The ref the latest snapshot gave to the element with this data-testid. */
const refOf = (snapshot: string, testid: string): string => {
  const m = snapshot.match(new RegExp(`(e\\d+) [^\\n]*\\[testid=${testid}[,\\]]`));
  if (!m) throw new Error(`no element with testid "${testid}" in the snapshot:\n${snapshot}`);
  return m[1];
};
async function shot(name: string): Promise<void> {
  const { base64 } = await engine.screenshot();
  fs.writeFileSync(path.join(outDir, "screenshots", `${name}.png`), Buffer.from(base64, "base64"));
}
type FindingInput = Parameters<NonNullable<BrowserEngine["memory"]>["addFinding"]>[0];
function finding(f: Omit<FindingInput, "url" | "state">): void {
  engine.memory!.addFinding({ ...f, url: engine.currentUrl, state: engine.currentState || "(unknown)" });
}

async function main(): Promise<void> {
  fs.mkdirSync(path.join(outDir, "screenshots"), { recursive: true });
  const server = createDemoServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: Error) => reject(new Error(`could not start the demo app on port ${PORT}: ${err.message}`)));
    server.listen(PORT, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${PORT}`;
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-demo-"));

  try {
    show("attach", await engine.attach({ url: baseUrl, projectDir, mode: "read-only" }));
    show("snapshot /", await engine.snapshot());
    await shot("dashboard");
    finding({
      severity: "medium",
      category: "visual",
      title: 'The "New: bulk import" badge sits on top of the All orders button',
      detail:
        "On the dashboard the badge overlaps most of the All orders button, hiding its label and taking the clicks aimed at it. The geometry oracle measured the overlap from layout boxes; no screenshot was needed to find it.",
      evidence: '"All orders" overlaps "New: bulk import" (81%)',
    });
    finding({
      severity: "low",
      category: "network",
      title: "The dashboard chart image is missing",
      detail:
        'The "This week" chart never loads. The page still works, but the largest element above the fold is a broken image, and the 404 adds a console error to every dashboard visit.',
      evidence: "GET /img/weekly-chart.png → HTTP 404",
    });

    // Breadth first: one call visits every route the links revealed.
    show("crawl", await engine.crawl());
    show("crawl again (routes found on those pages)", await engine.crawl());

    // Orders: the Archived filter.
    await engine.navigate("/orders.html");
    let snap = await engine.snapshot(true);
    show("select Archived", await engine.select(refOf(snap, "orders-status-filter"), "archived"));
    await shot("orders-archived");
    finding({
      severity: "high",
      category: "http-error",
      title: "Filtering orders by Archived fails, and the page shows an empty table instead of an error",
      detail:
        'Choosing Status → Archived makes the orders request fail with a 500. The table is then drawn empty with no message, so the user reads "there are no archived orders" when the truth is "the request failed". The other filter values work.',
      evidence: "GET /api/orders?status=archived → HTTP 500",
    });

    // Reports: the export button.
    await engine.navigate("/reports.html");
    snap = await engine.snapshot(true);
    show("click Export CSV", await engine.click(refOf(snap, "reports-export-csv")));
    finding({
      severity: "high",
      category: "page-error",
      title: "Export CSV throws and nothing is downloaded",
      detail: "Clicking Export CSV raises an uncaught exception. No file is produced and the page gives no feedback, so the button appears to do nothing.",
      evidence: "Cannot read properties of undefined (reading 'rows')",
    });
    await engine.navigate("/reports-scheduled.html");
    await engine.snapshot(true);
    finding({
      severity: "medium",
      category: "dead-end",
      title: "Scheduled reports is a dead end: no navigation and no way back",
      detail:
        "The page reached from Reports → Scheduled reports has no header, no links and no controls. The only way out is the browser's back button. The crawl flagged it as a dead end with 0 interactable elements.",
      evidence: "/reports-scheduled.html — 200 · 0 el · DEAD-END",
    });

    // The task a user actually came for, measured.
    await engine.navigate("/");
    snap = await engine.snapshot(true);
    show("journey start", engine.startJourney("create an order for a new customer"));
    await engine.click(refOf(snap, "dash-new-order"));
    snap = await engine.snapshot(true);
    show("submit the empty form", await engine.click(refOf(snap, "new-order-submit")));
    finding({
      severity: "medium",
      category: "ux-confusing",
      title: "Submitting the new-order form without a customer does nothing and says nothing",
      detail:
        "With Customer empty, Create order sends no request, shows no validation message and does not move focus to the field. A first-time user cannot tell whether the click registered.",
      evidence: "submit-style click fired ZERO network requests and no navigation",
    });
    snap = await engine.snapshot(true);
    await engine.type(refOf(snap, "new-order-customer"), "Alder & Pine Outfitters");
    snap = await engine.snapshot(true);
    show("impatient double-click on Create order", await engine.click(refOf(snap, "new-order-submit"), 2));
    await shot("new-order");
    finding({
      severity: "high",
      category: "data-inconsistency",
      title: "A double-click on Create order creates two orders",
      detail:
        "The submit button stays enabled while the request is in flight, and the endpoint accepts the repeat. One impatient double-click produced two identical POSTs and two orders. Disable the button during submit, and make the create idempotent.",
      evidence: "2× click fired the same state-changing request 2× (POST /api/orders)",
    });
    show("journey end", engine.endJourney(true));

    await engine.navigate("/orders-new.html");
    show("design audit /orders-new.html", await engine.designAudit());
    finding({
      severity: "low",
      category: "visual",
      title: "Helper text under Customer is too faint to read",
      detail: "The hint below the Customer field fails WCAG contrast by a wide margin. The same .hint style is likely used on other forms.",
      evidence: "1.73:1 (needs 4.5:1) rgba(184, 192, 202, 1) on rgb(246, 248, 250)",
    });
    finding({
      severity: "low",
      category: "ux-polish",
      title: "The confirmation email field has no label, only a placeholder",
      detail:
        "The field is announced to assistive technology without a name, and the placeholder disappears as soon as the user types. The crawl counted it as the one unnamed control on this page.",
      evidence: "/orders-new.html — 200 · 12 el · 1 unnamed",
    });

    // An order: the sticky bar, and what read-only refuses.
    await engine.navigate("/order.html?id=1042");
    snap = show("snapshot /order", await engine.snapshot(true));
    await shot("order-detail");
    finding({
      severity: "high",
      category: "visual",
      title: "The Save notes button is covered by the bar at the bottom of the order page",
      detail:
        "The save row is sticky at the bottom of the viewport, and a fixed bar added later sits on top of it. The button is present, labelled and enabled, but it cannot be seen, and a click aimed at it lands on the bar. It only becomes reachable after scrolling to the very end of the page. Found by hit-testing the button's centre, since box overlap cannot tell which of two pinned elements is on top.",
      evidence: '"Save notes" is COVERED by pinned chrome [order-stickybar]',
    });
    show("click Save notes", await engine.click(refOf(snap, "order-save")));
    snap = await engine.snapshot(true);
    show("click Delete order (read-only)", await engine.click(refOf(snap, "order-delete")));

    await engine.navigate("/settings.html");
    snap = await engine.snapshot(true);
    show("click Delete workspace (read-only)", await engine.click(refOf(snap, "settings-delete-workspace")));

    // Craft and accessibility, on three representative pages.
    for (const route of ["/", "/order.html?id=1042"]) {
      await engine.navigate(route);
      show(`design audit ${route}`, await engine.designAudit());
    }

    engine.memory!.addAssumption("app", "Harbor is a single-role order desk: no login, every visitor can create, edit and delete orders.", "demo");
    engine.memory!.addAssumption("risks", "Forms do not guard against repeat submission; check every new create flow with a double-click.", "demo");

    const all = engine.allKnownRoutes();
    const unvisited = engine.unvisitedKnownRoutes();
    const extras = {
      routesVisited: all.length - unvisited.length,
      routesTotal: all.length,
      designAudits: engine.designAuditCount,
      createdResources: engine.createdResources,
      unvisitedRoutes: unvisited,
      policyAttributed: engine.oracleLog.policyAttributed,
    };
    show("gap ledger", computeGaps(engine.memory!, extras).join("\n") || "(empty)");
    const report = generateReport(engine.memory!, engine.oracleLog.all, extras);
    fs.writeFileSync(path.join(outDir, "report.md"), stabilise(report.markdown, projectDir));
    console.log(
      `\nWrote ${path.relative(process.cwd(), path.join(outDir, "report.md"))} and ${fs.readdirSync(path.join(outDir, "screenshots")).length} screenshots.`,
    );
  } finally {
    await engine.close().catch((err: unknown) => console.error(`closing the browser failed: ${err instanceof Error ? err.message : String(err)}`));
    server.closeAllConnections();
    server.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/** Things that differ on every run and would make the committed example churn. */
function stabilise(markdown: string, projectDir: string): string {
  return markdown
    .split(projectDir)
    .join("<project>")
    .replace(/^Generated: .*$/m, "Generated: (by `npm run demo`)")
    .replace(/\| \d{4}-\d{2}-\d{2} \|/g, "| (run date) |");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
