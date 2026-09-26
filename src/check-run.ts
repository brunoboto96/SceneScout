/**
 * Runs `scenescout check`: attach, crawl every route the engine can find,
 * measure each one, replay the saved flows, re-test the open findings a page
 * load can reproduce, and write the verdict. The rules live in
 * engine/check.ts, engine/flow.ts and engine/verify.ts; this file only drives
 * the browser and the files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "./engine/browser.js";
import {
  issuesFromRoutes,
  redactFlowRuns,
  redactRoute,
  redactRoutes,
  settingsOf,
  withoutOwnResponse,
  type CheckOptions,
  type CheckResult,
  type RouteHealth,
} from "./engine/check.js";
import { loadFlows, resolveFlowsDir, type Flow, type FlowRun, type SkippedFlowFile } from "./engine/flow.js";
import { MemoryStore, MEMORY_DIRNAME, type Finding } from "./engine/memory.js";
import { checkRetestPlan, retestResults, wellFormedFindings } from "./engine/verify.js";

/** Link discovery rounds: each crawl reveals the routes its pages link to. Past a few, a site is paginating rather than revealing. */
const MAX_ROUNDS = 6;

/** What a check reads from the project before it starts: its saved flows and the findings earlier runs left. */
export interface CheckInputs {
  flows: Flow[];
  /** Entries of the flows directory that were not replayed, each with its reason. */
  skippedFlows?: SkippedFlowFile[];
  /** The project's findings, or null when --retest is off or the project has no memory yet. */
  findings: Finding[] | null;
}

/**
 * Read the flows and the findings, before any browser starts. Throws with a
 * sentence naming the file and the field on anything it cannot read: a flow
 * that is silently skipped is a flow that silently passes.
 */
export function readCheckInputs(options: CheckOptions): CheckInputs {
  const where = resolveFlowsDir(options.flows, options.projectDir, (p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
  if ("error" in where) throw new Error(where.error);
  const { flows, skipped: skippedFlows } = where.dir ? loadFlows(where.dir) : { flows: [], skipped: [] };
  if (!options.retest) return { flows, skippedFlows, findings: null };
  // Read, never written: a check leaves the project's memory as it found it.
  const memoryPath = path.join(options.projectDir, MEMORY_DIRNAME, "memory.json");
  if (!fs.existsSync(memoryPath)) return { flows, skippedFlows, findings: null };
  let findings: unknown;
  try {
    findings = (JSON.parse(fs.readFileSync(memoryPath, "utf8")) as { findings?: unknown }).findings;
  } catch (err) {
    throw new Error(
      `could not read ${memoryPath} to re-test its findings (${err instanceof Error ? err.message : String(err)}). Pass --retest off to check without it`,
    );
  }
  if (findings !== undefined && !Array.isArray(findings)) throw new Error(`${memoryPath}: "findings" is not a list. Pass --retest off to check without it`);
  return { flows, skippedFlows, findings: wellFormedFindings((findings as unknown[] | undefined) ?? []) };
}

export async function runCheck(
  options: CheckOptions,
  log: (line: string) => void = () => {},
  inputs: CheckInputs = { flows: [], findings: null },
): Promise<CheckResult> {
  // A throwaway memory: a check is one run, and a store shared with earlier
  // exploratory runs would count their visits as this check's and skip those routes.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-check-"));
  const engine = new BrowserEngine();
  const start = new URL(options.url);
  try {
    // Attached at the origin: the engine joins every crawled path onto the URL
    // it attached to, so attaching to a start page with a path would double it.
    const attached = await engine.attach({
      url: start.origin,
      projectDir: options.projectDir,
      memoryStore: new MemoryStore(scratch),
      mode: options.mode,
      storageStatePath: options.storageStatePath,
      ...(options.browser ? { browser: options.browser } : {}),
      objective: "Deterministic check: visit every route and measure it",
      task: "Checking every route",
    });
    // A saved session that no longer signs in would check the sign-in page and call it the app.
    const authFailed = attached.split("\n").find((line) => line.startsWith("⚠ AUTH FAILED"));
    if (authFailed) throw new Error(authFailed.replace(/ Continuing now tests a logged-out app\.$/, "").replace(/re-attach/, "run the check again"));
    const routes: RouteHealth[] = [];
    const crawl = async (paths: string[] | undefined, limit: number): Promise<void> => {
      await engine.crawl(paths, { inspect: true, limit });
      routes.push(...engine.lastCrawlHealth);
    };
    if (options.paths) {
      await crawl(options.paths.slice(0, options.maxRoutes), options.maxRoutes);
    } else {
      // The start page first, whatever else is known: it is the one route the user named.
      await crawl([`${start.pathname}${start.search}${start.hash}`], 1);
      for (let round = 0; round < MAX_ROUNDS && routes.length < options.maxRoutes; round++) {
        if (engine.crawlableRoutes().length === 0) break;
        await crawl(undefined, options.maxRoutes - routes.length);
        log(`  ${routes.length} route(s) checked`);
      }
    }
    // Pages of open findings the crawl did not load exactly: loaded now, so each re-test has its own measurement.
    // Kept apart from `routes`: they are measured only to re-test, never checked against the page rules, and do not count
    // towards --max-routes. With --paths the check stays on the paths it was given.
    const plan = inputs.findings ? checkRetestPlan(inputs.findings) : null;
    const retestPages: RouteHealth[] = [];
    if (plan && !options.paths) {
      const missing = [...new Set(plan.candidates.map((c) => c.path))].filter((p) => !routes.some((r) => r.path === p));
      if (missing.length > 0) {
        await engine.crawl(missing, { limit: missing.length, measureOnly: true });
        retestPages.push(...engine.lastCrawlHealth);
        log(`  ${missing.length} page(s) of open findings loaded only to re-test them`);
      }
    }
    const flowRuns: FlowRun[] = [];
    for (const flow of inputs.flows) {
      // --flow-writes never: observe's rule, whatever --mode lets the crawl do.
      const replay = await engine.replayFlow(flow.steps, options.flowWrites === "never" ? "observe" : options.mode);
      flowRuns.push({ name: flow.name, file: flow.file, steps: flow.steps.length, ...replay });
      log(`  flow ${flow.name}: ${replay.outcome.status}${replay.outcome.status === "passed" ? "" : ` at step ${replay.outcome.step}`}`);
      // --on-refused-step stop: nothing after a refused step runs, and the check ends without a verdict.
      if (replay.outcome.status === "refused" && options.onRefusedStep === "stop") break;
    }
    const retest = plan
      ? {
          open: plan.open,
          extraPages: retestPages.length,
          results: retestResults(
            plan.candidates,
            [...routes, ...retestPages].map((r) => ({
              path: r.path,
              status: r.status,
              ...(r.loadError !== undefined ? { loadError: r.loadError } : {}),
              loginRedirect: r.loginRedirect,
              httpErrors: withoutOwnResponse(r)
                .violations.filter((v) => v.kind === "http_error")
                .map((v) => v.detail),
            })),
          ),
        }
      : null;
    const measured = redactRoutes(routes.map(withoutOwnResponse));
    const flows = redactFlowRuns(flowRuns);
    return {
      url: redactRoute(options.url),
      generatedAt: new Date().toISOString(),
      mode: options.mode,
      failOn: options.failOn,
      routes: measured,
      issues: issuesFromRoutes(measured, start.origin, options.ignore, flows),
      // Routes that failed to load are issues already; "not visited" is only what --max-routes left out.
      unvisited: options.paths ? [] : engine.crawlableRoutes().map(redactRoute),
      ignored: options.ignore,
      flows,
      skippedFlows: inputs.skippedFlows ?? [],
      retest,
      settings: settingsOf(options),
    };
  } finally {
    await engine.close().catch((err: unknown) => log(`closing the browser failed: ${err instanceof Error ? err.message : String(err)}`));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Where a check writes when not told: beside the project's other SceneScout output, which is already ignored by git. */
export function defaultCheckDir(projectDir: string): string {
  return path.join(projectDir, MEMORY_DIRNAME, "check");
}
