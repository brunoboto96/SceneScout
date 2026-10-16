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
import { DEFAULT_ACTION_TIMEOUT_MS } from "../../dist/engine/limits.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "a continued run's path to a page";

const pathOf = (engine: BrowserEngine): string => new URL(engine.currentUrl || "about:blank").pathname;

async function session<T>(name: string, baseUrl: string, start: string, body: (engine: BrowserEngine) => Promise<T>, actionTimeoutMs?: number): Promise<T> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `ft-path-${name}-`));
  const engine = new BrowserEngine();
  engine.sessionKey = name;
  try {
    await engine.attach({ url: `${baseUrl}${start}`, projectDir, mode: "read-only", actionTimeoutMs });
    return await body(engine);
  } finally {
    await engine.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/** What a plan may take past the one wait on its missing target: the steps before it, settling and the failure's own bookkeeping, with room for a loaded runner (the old wait was over 60 s). */
const PLAN_SLACK_MS = 5000;

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
  // A path whose button the page no longer has fails, and says so: the run then navigates instead. The click waits out
  // the action limit, so this session runs at the engine's default rather than the smoke runner's raised one.
  await session(
    "later-changed",
    baseUrl,
    "/path-gated-start.html",
    async (engine) => {
      const changed = steps.map((s) => (s.action === "click" ? { ...s, target: 'role=button[name="Open file"]' } : s));
      const started = Date.now();
      const transcript = await engine.runPlan(changed);
      const tookMs = Date.now() - started;
      const outcome = prefixOutcome(transcript, changed.length, "/path-gated-detail.html");
      // At the lower limit, a step before the click that ran out would also fail the path: the reason must be the click.
      const at = changed.findIndex((s) => s.action === "click") + 1;
      check(
        "a path the page changed under is reported as not repeated, at the click on the button it no longer has",
        !outcome.ok && new RegExp(`^${at} of ${changed.length} step\\(s\\) ran: ${at}\\. click role=button\\[name="Open file"\\] → FAILED`).test(outcome.why),
        JSON.stringify(outcome),
      );
      // The missing button is waited for once, at the action limit: no read of it may wait on Playwright's own 30 s.
      check(
        `...and the plan gives up on the missing button within the action limit (${DEFAULT_ACTION_TIMEOUT_MS / 1000}s) plus ${PLAN_SLACK_MS / 1000}s`,
        tookMs <= DEFAULT_ACTION_TIMEOUT_MS + PLAN_SLACK_MS,
        `took ${(tookMs / 1000).toFixed(1)}s`,
      );
    },
    DEFAULT_ACTION_TIMEOUT_MS,
  );

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
