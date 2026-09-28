/**
 * A close that hangs must not leave the browser running. The browser context's
 * close is made to hang (as a wedged renderer's does), and then the browser's
 * own close too; after close() returns, within its bound, the browser's process
 * and every process in its group must be gone. A tool call still waiting on the
 * page when close() starts (a navigation to a server that never answers) must
 * have settled by then too, so nothing of it can write into the project after
 * the close. The contrast is a plain close, which ends the browser without
 * reaching either escalation.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { BROWSER_CLOSE_MS, TEARDOWN_MS } from "../../dist/engine/dispatch.js";
import { processAlive } from "../../dist/engine/reaper.js";
import { check, eventually, type SmokeContext } from "./harness.ts";

export const title = "teardown bound";

/** Pids in the process group `pgid` leads: the browser and its helpers (Playwright starts each browser as a group leader). */
function inGroup(pgid: number): number[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8", timeout: 5000 });
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => group === pgid && pid !== undefined)
    .map(([pid]) => pid);
}

const hang = (): Promise<void> => new Promise<void>(() => {});

/** Every file under `dir` with its size and modification time: what "the project folder is unchanged" compares. */
function folderState(dir: string): string {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const file = path.join(e.parentPath, e.name);
      const st = fs.statSync(file);
      return `${path.relative(dir, file)} ${st.size} ${st.mtimeMs}`;
    })
    .sort()
    .join("\n");
}

/** Attach, make the named closes hang, close, and check that close() returned in bound and nothing of the browser is left. */
async function closeWith(baseUrl: string, projectDir: string, label: string, hanging: Array<"context" | "browser">, boundMs: number): Promise<void> {
  const engine = new BrowserEngine();
  await engine.attach({ url: `${baseUrl}/index.html`, projectDir, mode: "read-only" });
  const pid = engine.browserProcessId;
  check(`${label}: the launched browser's process id is known`, pid !== undefined && processAlive(pid), String(pid));
  if (pid === undefined) return void (await engine.close());
  const inner = engine as unknown as { context: BrowserContext; browser: Browser };
  if (hanging.includes("context")) inner.context.close = hang;
  if (hanging.includes("browser")) inner.browser.close = hang;
  // A tool call still waiting on the page as the close starts, as a call the watchdog cut off would be.
  let settled = false;
  const pending = engine.navigate(`${baseUrl}/never-answers`).then(
    () => (settled = true),
    () => (settled = true),
  );
  const started = Date.now();
  await engine.close();
  const took = Date.now() - started;
  check(`${label}: close() returns within its bound`, took < boundMs + 2000, `${took}ms`);
  const gone = await eventually(() => !processAlive(pid) && inGroup(pid).length === 0, 3000);
  check(`${label}: the browser's process and its helpers are gone once close() returns`, gone, `still running: ${inGroup(pid).join(", ")}`);
  check(
    `${label}: a page call pending at close has settled by the time the browser is gone`,
    await eventually(() => settled, 1000),
    `after ${Date.now() - started}ms`,
  );
  const atClose = folderState(projectDir);
  await new Promise((r) => setTimeout(r, 1000));
  check(`${label}: the project folder is unchanged a second after close() returns`, folderState(projectDir) === atClose);
  await pending;
}

export async function run({ baseUrl, projectDir }: SmokeContext): Promise<void> {
  if (process.platform === "win32") {
    console.log("  (skipped: the process checks use ps)");
    return;
  }
  await closeWith(baseUrl, projectDir, "a plain close", [], TEARDOWN_MS);
  await closeWith(baseUrl, projectDir, "a context close that hangs", ["context"], TEARDOWN_MS + BROWSER_CLOSE_MS);
  await closeWith(baseUrl, projectDir, "a context and browser close that hang", ["context", "browser"], TEARDOWN_MS + BROWSER_CLOSE_MS);
}
