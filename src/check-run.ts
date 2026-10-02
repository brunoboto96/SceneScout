/**
 * Runs `scenescout check`: attach, crawl every route the engine can find,
 * measure each one, picture the targets of any visual baselines, replay the
 * saved flows, re-test the open findings a page load can reproduce, and write
 * the verdict. The rules live in engine/check.ts, engine/flow.ts,
 * engine/verify.ts and engine/baseline.ts; this file only drives the browser
 * and the files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BASELINE_CAPTURE,
  baselineFiles,
  baselineMeta,
  defaultBaselinesDir,
  elementTarget,
  isVisualPicture,
  judgeBaseline,
  missingTargetsMessage,
  parseBaselineTargets,
  readStoredBaseline,
  TARGETS_FILE,
  VISUAL_DIRNAME,
  visualFiles,
  type BaselineResult,
  type BaselineRun,
  type BaselineTarget,
} from "./engine/baseline.js";
import { BrowserEngine } from "./engine/browser.js";
import {
  checkFindings,
  redactBaselineRun,
  redactFlowRuns,
  redactRoute,
  redactRoutes,
  settingsOf,
  unmeasuredReason,
  withoutOwnResponse,
  type CheckOptions,
  type CheckResult,
  type RouteHealth,
} from "./engine/check.js";
import { loadFlows, resolveFlowsDir, type Flow, type FlowRun, type SkippedFlowFile } from "./engine/flow.js";
import { MemoryStore, MEMORY_DIRNAME, writeSelfIgnore, type Finding } from "./engine/memory.js";
import { decodePng, encodePng, type RgbaImage } from "./engine/png.js";
import { firstLineOf } from "./engine/limits.js";
import { checkRetestPlan, retestResults, wellFormedFindings } from "./engine/verify.js";

/** Link discovery rounds: each crawl reveals the routes its pages link to. Past a few, a site is paginating rather than revealing. */
const MAX_ROUNDS = 6;

/** What a check reads from the project before it starts: its saved flows, the findings earlier runs left, and the targets of any visual baselines. */
export interface CheckInputs {
  flows: Flow[];
  /** Entries of the flows directory that were not replayed, each with its reason. */
  skippedFlows?: SkippedFlowFile[];
  /** The project's findings, or null when --retest is off or the project has no memory yet. */
  findings: Finding[] | null;
  /** What --baseline compare or update pictures, from the baselines folder's targets.json; absent with --baseline off. */
  baselineTargets?: BaselineTarget[];
}

/** The baselines folder a check uses: the one --baselines names, else the project's own. */
export function baselinesDirOf(options: CheckOptions): string {
  return options.baselinesDir ?? defaultBaselinesDir(options.projectDir);
}

/** Read and validate targets.json. A missing or invalid one stops the check before it starts: baselines that silently compare nothing pass by never running. */
function readBaselineTargets(options: CheckOptions): BaselineTarget[] {
  const file = path.join(baselinesDirOf(options), TARGETS_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`--baseline ${options.baseline}: ${missingTargetsMessage(file)}`);
    throw new Error(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseBaselineTargets(text, file);
  if (!parsed.ok) throw new Error(`baseline targets: ${parsed.error}`);
  return parsed.targets;
}

/**
 * Read the flows, the findings and the baseline targets, before any browser
 * starts. Throws with a sentence naming the file and the field on anything it
 * cannot read: a flow that is silently skipped is a flow that silently passes.
 */
export function readCheckInputs(options: CheckOptions): CheckInputs {
  const where = resolveFlowsDir(options.flows, options.projectDir, (p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
  if ("error" in where) throw new Error(where.error);
  const loaded = where.dir ? loadFlows(where.dir) : { flows: [], skipped: [] };
  const read = { flows: loaded.flows, skippedFlows: loaded.skipped, ...(options.baseline !== "off" ? { baselineTargets: readBaselineTargets(options) } : {}) };
  if (!options.retest) return { ...read, findings: null };
  // Read, never written: a check leaves the project's memory as it found it.
  const memoryPath = path.join(options.projectDir, MEMORY_DIRNAME, "memory.json");
  if (!fs.existsSync(memoryPath)) return { ...read, findings: null };
  let findings: unknown;
  try {
    findings = (JSON.parse(fs.readFileSync(memoryPath, "utf8")) as { findings?: unknown }).findings;
  } catch (err) {
    throw new Error(
      `could not read ${memoryPath} to re-test its findings (${err instanceof Error ? err.message : String(err)}). Pass --retest off to check without it`,
    );
  }
  if (findings !== undefined && !Array.isArray(findings)) throw new Error(`${memoryPath}: "findings" is not a list. Pass --retest off to check without it`);
  return { ...read, findings: wellFormedFindings((findings as unknown[] | undefined) ?? []) };
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
      actionTimeoutMs: options.actionTimeoutMs,
      navTimeoutMs: options.navTimeoutMs,
      // Named rather than left to attach's defaults: a baseline is only comparable with a picture taken in the same window, at the same scale.
      ...(options.baseline !== "off" ? { viewport: BASELINE_CAPTURE.viewport, deviceScaleFactor: BASELINE_CAPTURE.deviceScaleFactor } : {}),
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
    // Before the flows, so a picture is of the page as a visit finds it, not as a flow left it. Not when the crawl
    // reached only sign-in pages: the check has no verdict then, and an update would write sign-in pages as baselines.
    if (options.baseline !== "off" && !inputs.baselineTargets)
      throw new Error(`--baseline ${options.baseline} was given no targets: read them with readCheckInputs`);
    const baselines =
      options.baseline !== "off" && inputs.baselineTargets && unmeasuredReason(routes, !options.paths) === null
        ? await takeBaselines(engine, options, options.baseline, inputs.baselineTargets, log)
        : null;
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
    const pictured = baselines ? redactBaselineRun(baselines) : null;
    const { issues, worthALook } = checkFindings(measured, start.origin, options.ignore, flows, pictured);
    return {
      url: redactRoute(options.url),
      generatedAt: new Date().toISOString(),
      mode: options.mode,
      failOn: options.failOn,
      routes: measured,
      issues,
      worthALook,
      // Routes that failed to load are issues already; "not visited" is only what --max-routes left out.
      unvisited: options.paths ? [] : engine.crawlableRoutes().map(redactRoute),
      ignored: options.ignore,
      flows,
      skippedFlows: inputs.skippedFlows ?? [],
      retest,
      settings: settingsOf(options),
      baselines: pictured,
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

/** A file's bytes, or null when there is no such file. Any other failure to read it is thrown. */
function readIfThere(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Remove the pictures an earlier run left under <out>/visual/, so none is
 * kept or uploaded as this run's. Only files named as a check names them
 * (isVisualPicture) are removed, then any folder that leaves empty: the
 * output folder is one a project chose, and whatever else it holds stays.
 */
function clearVisualPictures(outDir: string): void {
  const root = path.join(outDir, VISUAL_DIRNAME);
  let folders: fs.Dirent[];
  try {
    folders = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const folder of folders.filter((f) => f.isDirectory())) {
    const dir = path.join(root, folder.name);
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (file.isFile() && isVisualPicture(folder.name, file.name)) fs.rmSync(path.join(dir, file.name));
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
  if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
}

/** The baselines folder as the report names it: relative to the project when inside it, with forward slashes. */
function shownDir(dir: string, projectDir: string): string {
  const rel = path.relative(projectDir, dir);
  if (rel === "") return ".";
  return rel.startsWith("..") || path.isAbsolute(rel) ? dir : rel.split(path.sep).join("/");
}

/**
 * --baseline compare|update: take each target's picture, judge it against its
 * stored baseline (baseline.ts), and write what the judgement says to write: a
 * new baseline under update, and under compare the baseline, the picture now
 * and the changed pixels of a target that changed, beside the report. A page
 * load per target, so no picture depends on the one taken before it.
 */
async function takeBaselines(
  engine: BrowserEngine,
  options: CheckOptions,
  mode: BaselineRun["mode"],
  targets: readonly BaselineTarget[],
  log: (line: string) => void,
): Promise<BaselineRun> {
  const dir = baselinesDirOf(options);
  const outDir = options.outDir ?? defaultCheckDir(options.projectDir);
  const engineName = engine.browserEngine;
  const at = (root: string, rel: string): string => path.join(root, ...rel.split("/"));
  // The default folders are inside .scenescout/, which ignores itself, and its .gitignore is written before anything goes
  // there: a run that ends early must not leave pictures a `git add -A` would pick up. A folder the project named is its own.
  if (!options.outDir || (!options.baselinesDir && mode === "update")) {
    const scenescoutDir = path.join(options.projectDir, MEMORY_DIRNAME);
    fs.mkdirSync(scenescoutDir, { recursive: true });
    writeSelfIgnore(scenescoutDir);
  }
  clearVisualPictures(outDir);
  const results: BaselineResult[] = [];
  try {
    for (const target of targets) {
      const files = baselineFiles(engineName, target);
      const own = { path: target.path, element: target.element, baseline: files.png };
      const shown = `${target.element} on ${redactRoute(target.path)}`;
      const element = elementTarget(target.element);
      // parseBaselineTargets refuses such an element; one reaching here must not be pictured as the whole page instead.
      if (element === undefined) throw new Error(`baseline target ${shown} names neither the page nor an element`);
      let shot: Awaited<ReturnType<BrowserEngine["captureForBaseline"]>>;
      let image: RgbaImage;
      try {
        shot = await engine.captureForBaseline(target.path, element, BASELINE_CAPTURE);
        image = decodePng(shot.png);
      } catch (err) {
        // A closed browser, or a mistake in this code, is the check's failure, never the app's: the check ends "could not run".
        if (!engine.alive || err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError) throw err;
        const why = firstLineOf(err);
        results.push({ ...own, status: "not-captured", detail: why });
        log(`  baseline ${shown}: not captured (${why})`);
        continue;
      }
      const capture = { ...BASELINE_CAPTURE, viewport: shot.viewport, deviceScaleFactor: shot.deviceScaleFactor };
      const storedPng = readIfThere(at(dir, files.png));
      const storedJson = readIfThere(at(dir, files.json));
      const stored = readStoredBaseline(target, engineName, storedPng, storedJson === null ? null : storedJson.toString("utf8"));
      const { diffImage, ...verdict } = judgeBaseline({
        mode,
        threshold: options.baselineThreshold,
        stored,
        now: { capture, platform: process.platform, image },
      });
      const result: BaselineResult = { ...own, ...verdict, ...(shot.cut ? { partial: shot.cut } : {}) };
      if (verdict.status === "updated") {
        fs.mkdirSync(path.dirname(at(dir, files.png)), { recursive: true });
        fs.writeFileSync(at(dir, files.png), shot.png);
        const meta = baselineMeta({
          target,
          engine: engineName,
          platform: process.platform,
          capture,
          size: { width: image.width, height: image.height },
          capturedAt: new Date().toISOString(),
        });
        fs.writeFileSync(at(dir, files.json), JSON.stringify(meta, null, 2) + "\n");
      }
      if (diffImage && storedPng) {
        const pictures = visualFiles(target);
        fs.mkdirSync(path.dirname(at(outDir, pictures.diff)), { recursive: true });
        fs.writeFileSync(at(outDir, pictures.expected), storedPng);
        fs.writeFileSync(at(outDir, pictures.actual), shot.png);
        fs.writeFileSync(at(outDir, pictures.diff), encodePng(diffImage));
        result.files = pictures;
      }
      results.push(result);
      log(`  baseline ${shown}: ${result.status}${result.diff ? ` (${result.diff.percent}% changed)` : ""}`);
    }
  } finally {
    // Reported, never thrown: an error from the loop above must not be replaced by this one.
    await engine.endBaselineCaptures().catch((err: unknown) => log(`  could not stop requesting reduced motion: ${firstLineOf(err)}`));
  }
  return { mode, engine: engineName, threshold: options.baselineThreshold, dir: shownDir(dir, options.projectDir), results };
}
