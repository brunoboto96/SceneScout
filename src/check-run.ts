/**
 * Runs `scenescout check`: attach, crawl every route the engine can find,
 * measure each one, and write the verdict. The rules live in engine/check.ts;
 * this file only drives the browser and the files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserEngine } from "./engine/browser.js";
import { issuesFromRoutes, redactRoute, redactRoutes, withoutOwnResponse, type CheckOptions, type CheckResult, type RouteHealth } from "./engine/check.js";
import { MemoryStore, MEMORY_DIRNAME } from "./engine/memory.js";

/** Link discovery rounds: each crawl reveals the routes its pages link to. Past a few, a site is paginating rather than revealing. */
const MAX_ROUNDS = 6;

export async function runCheck(options: CheckOptions, log: (line: string) => void = () => {}): Promise<CheckResult> {
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
    const measured = redactRoutes(routes.map(withoutOwnResponse));
    return {
      url: redactRoute(options.url),
      generatedAt: new Date().toISOString(),
      mode: options.mode,
      failOn: options.failOn,
      routes: measured,
      issues: issuesFromRoutes(measured, start.origin, options.ignore),
      // Routes that failed to load are issues already; "not visited" is only what --max-routes left out.
      unvisited: options.paths ? [] : engine.crawlableRoutes().map(redactRoute),
      ignored: options.ignore,
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
