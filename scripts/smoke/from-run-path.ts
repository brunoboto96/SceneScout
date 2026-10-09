/**
 * A continued run reaching a page the way the earlier run did. One fixture's
 * detail page opens only through a step on its start page (a reference typed,
 * a button pressed); opened by its address it sends the browser back. Its
 * contrastive twin links the same detail page directly. The earlier run is a
 * real session whose action log becomes the record; the later run is a fresh
 * session replaying the path from that record (from-run.ts prefixPlan).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { buildRunRecord, prefixOutcome, prefixPlan } from "../../dist/engine/from-run.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "a continued run's path to a page";

const pathOf = (engine: BrowserEngine): string => new URL(engine.currentUrl || "about:blank").pathname;

async function session<T>(name: string, baseUrl: string, start: string, body: (engine: BrowserEngine) => Promise<T>): Promise<T> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `ft-path-${name}-`));
  const engine = new BrowserEngine();
  engine.sessionKey = name;
  try {
    await engine.attach({ url: `${baseUrl}${start}`, projectDir, mode: "read-only" });
    return await body(engine);
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

const ref = (snap: string, pattern: RegExp): string => pattern.exec(snap)?.[1] ?? "e0";

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  console.log("from-run path: a page reached only through a step on another is reached the same way by the next run");

  // ── the earlier run, on the page that needs a step ──
  const gated = await session("earlier-gated", baseUrl, "/path-gated-start.html", async (engine) => {
    await engine.navigate("/path-gated-start.html");
    const snap = await engine.snapshot();
    await engine.type(ref(snap, /(e\d+) textbox "Reference"/), "R-1");
    await engine.click(ref(snap, /(e\d+) button "Open record"/));
    check("the earlier run reached the detail page through the start page's step", pathOf(engine) === "/path-gated-detail.html", engine.currentUrl);
    const steps = engine.memory?.actionsThisRun() ?? [];
    return buildRunRecord({
      runId: "earlier",
      at: new Date().toISOString(),
      knownRoutes: [],
      steps,
      unexercised: [],
      forms: [],
      filled: [],
      unchosen: [],
      gaps: [],
    });
  });
  const plan = prefixPlan(gated, "/path-gated-detail.html");
  check(
    "the record's path to the detail page is the start page, the typed reference and the button",
    !!plan && "steps" in plan && !plan.direct,
    JSON.stringify(plan),
  );
  check("...and keeps no typed value", !JSON.stringify(gated).includes("R-1"), JSON.stringify(gated.steps));
  const steps = plan && "steps" in plan ? plan.steps : [];

  // ── the later run: by its address the page bounces; by the path it opens ──
  await session("later-direct", baseUrl, "/path-gated-start.html", async (engine) => {
    await engine.navigate("/path-gated-detail.html");
    await new Promise((r) => setTimeout(r, 300));
    check("opened by its address, the gated detail page sends the browser back", pathOf(engine) === "/path-gated-start.html", engine.currentUrl);
  });
  await session("later-path", baseUrl, "/path-gated-start.html", async (engine) => {
    const reply = await engine.runPlan(steps);
    const outcome = prefixOutcome(reply, steps.length, "/path-gated-detail.html");
    check("the earlier run's path replays in full", outcome.ok, reply);
    check(
      "...and lands on the detail page, with the stand-in reference",
      pathOf(engine) === "/path-gated-detail.html" && /Record SceneScout test/.test(await engine.snapshot()),
      engine.currentUrl,
    );
  });
  // A path whose button the page no longer has fails, and says so: the run then navigates instead.
  await session("later-changed", baseUrl, "/path-gated-start.html", async (engine) => {
    const changed = steps.map((s) => (s.action === "click" ? { ...s, target: 'role=button[name="Open file"]' } : s));
    const outcome = prefixOutcome(await engine.runPlan(changed), changed.length, "/path-gated-detail.html");
    check("a path the page changed under is reported as not repeated", !outcome.ok, JSON.stringify(outcome));
  });

  // ── the contrastive twin: the same detail page, linked directly ──
  const open = await session("earlier-open", baseUrl, "/path-open-start.html", async (engine) => {
    await engine.navigate("/path-open-detail.html");
    check("a directly linkable detail page opens by its address", pathOf(engine) === "/path-open-detail.html", engine.currentUrl);
    const steps = engine.memory?.actionsThisRun() ?? [];
    return buildRunRecord({
      runId: "earlier-open",
      at: new Date().toISOString(),
      knownRoutes: [],
      steps,
      unexercised: [],
      forms: [],
      filled: [],
      unchosen: [],
      gaps: [],
    });
  });
  const openPlan = prefixPlan(open, "/path-open-detail.html");
  check(
    "...so its record's path is the address alone, and the next run takes no steps to reach it",
    !!openPlan && "steps" in openPlan && openPlan.direct,
    JSON.stringify(openPlan),
  );
}
