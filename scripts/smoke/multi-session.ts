/**
 * Several engines sharing one memory: multi-role collaboration, the role capability matrix, the gap ledger and report honesty.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { generateReport } from "../../dist/engine/report.js";
import { check, eventually, heldPageCount, releaseHeldPages, until, type SmokeContext } from "./harness.ts";

export const title = "multi-session and report honesty";

export async function run({ baseUrl, projectDir }: SmokeContext): Promise<void> {
  // Every engine this suite opens, so a throw half-way cannot leave live
  // browsers behind while the runner carries on to the next suite.
  const opened: BrowserEngine[] = [];
  const track = (engine: BrowserEngine): BrowserEngine => {
    opened.push(engine);
    return engine;
  };
  try {
    console.log("multi-session: two engines, two live browsers, ONE shared memory (multi-role collaboration)");
    const { MemoryStore } = await import("../../dist/engine/memory.js");
    const sharedStore = new MemoryStore(projectDir);
    const engA = track(new BrowserEngine());
    const engB = track(new BrowserEngine());
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
    // Concurrency: two sessions' work must OVERLAP, not queue. A's navigation
    // is held by the server until B's has finished, so B finishing at all is
    // the proof: had calls been serialized globally (the pre-0.9 behaviour), B
    // would have queued behind A and could not finish until A was let go.
    const order: string[] = [];
    order.push("A:start");
    const navA = engA.navigate("/page2.html?held=1").then(
      () => void order.push("A:end"),
      (err: unknown) => void order.push(`A:failed ${err instanceof Error ? err.message : String(err)}`),
    );
    await until("A's navigation to be held by the server", () => heldPageCount() === 1);
    order.push("B:start");
    const navB = engB.navigate("/").then(
      () => void order.push("B:end"),
      (err: unknown) => void order.push(`B:failed ${err instanceof Error ? err.message : String(err)}`),
    );
    const bSettled = () => order.some((e) => e === "B:end" || e.startsWith("B:failed"));
    const overlapped = (await eventually(bSettled)) && order.includes("B:end");
    releaseHeldPages();
    await Promise.all([navA, navB]);
    check("a session's navigation finishes while another session's is still in flight (concurrent, not queued)", overlapped, order.join(" → "));
    check("both sessions started before either finished (true interleave)", order.join(" → ") === "A:start → B:start → B:end → A:end", order.join(" → "));
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
    const engC = track(new BrowserEngine());
    const engD = track(new BrowserEngine());
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
  } finally {
    await Promise.allSettled(opened.map((engine) => engine.close()));
  }
}
