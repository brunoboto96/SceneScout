/**
 * Several engines sharing one memory: multi-role collaboration, the role capability matrix, the gap ledger and report honesty.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { generateReport } from "../../dist/engine/report.js";
import { check, until, type SmokeContext } from "./harness.ts";

export const title = "multi-session and report honesty";

export async function run({ baseUrl, projectDir }: SmokeContext): Promise<void> {
  console.log("multi-session: two engines, two live browsers, ONE shared memory (multi-role collaboration)");
  const { MemoryStore } = await import("../../dist/engine/memory.js");
  const sharedStore = new MemoryStore(projectDir);
  const engA = new BrowserEngine();
  const engB = new BrowserEngine();
  await engA.attach({ url: baseUrl, projectDir, mode: "read-only", memoryStore: sharedStore });
  await engB.attach({ url: baseUrl, projectDir, mode: "read-only", memoryStore: sharedStore });
  engA.role = "role-alpha";
  engB.role = "role-beta";
  await engA.navigate("/");
  await engA.snapshot();
  await engB.navigate("/page2.html");
  await engB.snapshot();
  check(
    "both sessions live at once on different pages",
    engA.attached && engB.attached && engA.currentUrl !== engB.currentUrl,
    `${engA.currentUrl} vs ${engB.currentUrl}`,
  );
  check("sessions share one memory instance (no write races, findings merge)", engA.memory === engB.memory);
  const [sharedFinding] = sharedStore.addFinding({
    severity: "low",
    category: "other",
    title: "multi-session shared-memory probe",
    detail: "d",
    url: engA.currentUrl,
    state: "/multi#probe",
  });
  check(
    "finding recorded via one role is visible to the other",
    engB.memory!.findings.some((f) => f.id === sharedFinding.id),
  );
  // Concurrency: two sessions' work must OVERLAP in time, not queue. Each
  // navigate is a real round-trip; if the server serialized every call
  // globally (the pre-0.9 behaviour) the elapsed time would be ~the sum of
  // both, and the interleave markers below would come out strictly ordered.
  const order: string[] = [];
  const startedAt = Date.now();
  const [msA, msB] = await Promise.all([
    (async () => {
      const t = Date.now();
      order.push("A:start");
      await engA.navigate("/page2.html");
      order.push("A:end");
      return Date.now() - t;
    })(),
    (async () => {
      const t = Date.now();
      order.push("B:start");
      await engB.navigate("/");
      order.push("B:end");
      return Date.now() - t;
    })(),
  ]);
  const wall = Date.now() - startedAt;
  check(
    "two sessions' navigations overlap in wall-clock (concurrent, not queued)",
    wall < msA + msB,
    `wall=${wall}ms vs sum=${msA + msB}ms (A=${msA}, B=${msB})`,
  );
  check(
    "both sessions started before either finished (true interleave)",
    order.indexOf("A:start") < order.indexOf("B:end") && order.indexOf("B:start") < order.indexOf("A:end"),
    order.join(" → "),
  );
  check(
    "each session kept its own page after concurrent navigation",
    engA.currentUrl.includes("page2") && !engB.currentUrl.includes("page2"),
    `${engA.currentUrl} vs ${engB.currentUrl}`,
  );

  // Journey isolation: the action log is SHARED across sessions, so a journey
  // measured in one role must not absorb a concurrent role's navigations —
  // that would inflate its path, screen count, and backtracks with another
  // person's clicks.
  engA.sessionKey = "alpha";
  engB.sessionKey = "beta";
  await engA.navigate("/");
  engA.startJourney("Alpha's task");
  await engB.navigate("/page2.html"); // concurrent OTHER session — must not count
  await engB.navigate("/");
  await engA.navigate("/broken.html"); // alpha's single real step
  const isoJourney = engA.endJourney(true, "iso");
  check("journey counts only its own session's navigations, not a concurrent role's", /· 1 navigations ·/.test(isoJourney), isoJourney);
  check("a concurrent session's screens don't leak into the journey path", !isoJourney.includes("page2"), isoJourney);

  // Cross-session ownership: role A creates, role B must be able to act on
  // it. Ownership lives on the shared MemoryStore precisely because
  // "submit → approve" handoffs are the point of multi-role testing; if it
  // were per-engine, every handoff would be blocked as "not yours".
  const shareStore = new MemoryStore(projectDir);
  const engC = new BrowserEngine();
  const engD = new BrowserEngine();
  await engC.attach({ url: baseUrl, projectDir, mode: "safe-write", memoryStore: shareStore });
  await engD.attach({ url: baseUrl, projectDir, mode: "safe-write", memoryStore: shareStore });
  const cSnap = await engC.snapshot(true);
  const refIn = (snap: string, label: string): string => {
    const m = snap.match(new RegExp(`(e\\d+) [a-z]+ "${label}"`));
    if (!m) throw new Error(`ref not found for ${label}`);
    return m[1];
  };
  await engC.click(refIn(cSnap, "Create item")); // role C creates /api/items/42
  await until("role C's creation to reach the shared ownership set", () => engD.createdResources.some((r) => r.includes("id=42")));
  check(
    "creation by role C is visible in the shared run ownership",
    engD.createdResources.some((r) => r.includes("id=42")),
    JSON.stringify(engD.createdResources),
  );
  const dSnap = await engD.snapshot(true);
  const dResult = await engD.click(refIn(dSnap, "Sync own item")); // role D mutates C's resource
  check("role D may mutate a resource role C created (multi-role handoff not blocked)", !dResult.includes("WRITE-POLICY blocked"), dResult);
  const dForeign = await engD.click(refIn(dSnap, "Sync foreign item"));
  check("foreign resources are still blocked for both roles", dForeign.includes("WRITE-POLICY blocked"), dForeign);
  await engC.close();
  await engD.close();

  console.log("role capability matrix + gap ledger + bounded report summary");
  check(
    "role access recorded per role",
    Object.keys(sharedStore.roleAccess).includes("role-alpha") && Object.keys(sharedStore.roleAccess).includes("role-beta"),
    JSON.stringify(sharedStore.roleAccess),
  );
  const multiReport = generateReport(sharedStore, [], { routesVisited: 2, routesTotal: 2, designAudits: 0 });
  check(
    "report renders the role capability matrix when ≥2 roles ran",
    multiReport.markdown.includes("Role capability matrix"),
    multiReport.markdown.match(/Role capability matrix[^\n]*/)?.[0] ?? "missing",
  );
  check(
    "gap ledger enumerates what was NOT tested",
    multiReport.markdown.includes("Gap ledger") && multiReport.markdown.includes("never design-audited"),
    multiReport.markdown.match(/## Gap ledger[\s\S]{0,300}/)?.[0] ?? "missing",
  );
  check(
    "tool-facing summary is bounded (full reports blew client token limits)",
    multiReport.summary.length < 4000 && multiReport.summary.includes("Gap ledger"),
    `summary length ${multiReport.summary.length}`,
  );

  console.log("report honesty: stale scores flagged, one-role routes kept out of the permission matrix");
  {
    const { MemoryStore: MS } = await import("../../dist/engine/memory.js");
    const repDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-report-"));
    const rs = new MS(repDir);
    // A score written BEFORE this session (a previous run's measurement) must
    // not silently rank as if it were re-measured today.
    rs.setPageScore("/stale-page", {
      overall: 40,
      a11y: 40,
      craft: 40,
      consistency: 40,
      clarity: 40,
      at: "2020-01-01T00:00:00.000Z",
      url: "http://x/stale-page",
    });
    rs.setPageScore("/fresh-page", {
      overall: 90,
      a11y: 90,
      craft: 90,
      consistency: 90,
      clarity: 90,
      at: new Date().toISOString(),
      url: "http://x/fresh-page",
    });
    // alpha and beta both tried /shared and diverged — a real boundary.
    // Only alpha ever tried /alpha-only — that is coverage, not permission.
    rs.recordRoleAccess("alpha", "/shared", "reached");
    rs.recordRoleAccess("beta", "/shared", "landed:/login");
    rs.recordRoleAccess("alpha", "/alpha-only", "reached");
    const rep = generateReport(rs, [], { routesVisited: 2, routesTotal: 2, designAudits: 1 });
    check(
      "a score carried over from an earlier run is marked stale",
      /\/stale-page[^\n]*stale/.test(rep.markdown),
      rep.markdown.match(/\|[^\n]*stale-page[^\n]*/)?.[0] ?? "no row",
    );
    check(
      "a score measured this session is NOT marked stale",
      !/\/fresh-page[^\n]*stale/.test(rep.markdown),
      rep.markdown.match(/\|[^\n]*fresh-page[^\n]*/)?.[0] ?? "no row",
    );
    check(
      "a genuinely divergent route stays in the permission matrix",
      /\|\s*`\/shared`/.test(rep.markdown),
      rep.markdown.match(/\|[^\n]*\/shared[^\n]*/)?.[0] ?? "missing",
    );
    check(
      "a route only ONE role visited is excluded (coverage gap, not a denial)",
      !/\|\s*`\/alpha-only`/.test(rep.markdown),
      rep.markdown.match(/\|[^\n]*alpha-only[^\n]*/)?.[0] ?? "correctly absent",
    );
    check(
      "the omission is disclosed rather than silent",
      rep.markdown.includes("visited by only ONE role"),
      rep.markdown.match(/[^\n]*only ONE role[^\n]*/)?.[0] ?? "not disclosed",
    );
    rs.flush(); // settle the debounced write before its directory goes away
    fs.rmSync(repDir, { recursive: true, force: true });
  }

  await engA.close();
  check("closing one session leaves the other alive", engB.attached && !engA.attached);
  await engB.close();
}
