/**
 * A close that hangs must not leave the browser running. The browser context's
 * close is made to hang (as a wedged renderer's does), and the browser server's
 * close too, so only the kill can end it; after close() returns, within its
 * bound, the browser's process and every process in its group must be gone.
 * The bounds are lowered through their environment variables so this takes
 * about a second; the other escalation paths are table-tested in dispatch-test. A tool call still waiting on the
 * page when close() starts (a navigation to a server that never answers) must
 * have settled by then too, so nothing of it can write into the project after
 * the close. The contrast is a plain close, which ends the browser without
 * reaching either escalation.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, BrowserServer } from "playwright";
import { BrowserEngine } from "../../dist/engine/browser.js";
import { BROWSER_CLOSE_ENV, TEARDOWN_ENV } from "../../dist/engine/teardown.js";
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

/** Whether a process is running (EPERM: running, but not ours to signal). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const hang = (): Promise<void> => new Promise<void>(() => {});

/** 500 ms teardown + 300 ms browser close + 300 ms kill, and slack for a loaded machine. */
const BOUND_MS = 500 + 300 + 300 + 1500;

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
async function closeWith(baseUrl: string, projectDir: string, label: string, hanging: boolean): Promise<void> {
  const engine = new BrowserEngine();
  await engine.attach({ url: `${baseUrl}/index.html`, projectDir, mode: "read-only" });
  const inner = engine as unknown as { context: BrowserContext; server: BrowserServer };
  const pid = inner.server.process().pid;
  check(`${label}: the launched browser's process id is known`, pid !== undefined && processAlive(pid), String(pid));
  if (pid === undefined) return void (await engine.close());
  if (hanging) {
    inner.context.close = hang;
    inner.server.close = hang;
  }
  // A tool call still waiting on the page as the close starts, as a call the watchdog cut off would be.
  let settled = false;
  const pending = engine.navigate(`${baseUrl}/never-answers`).then(
    () => (settled = true),
    () => (settled = true),
  );
  const started = Date.now();
  await engine.close();
  const took = Date.now() - started;
  check(`${label}: close() returns within its bound`, took < BOUND_MS, `${took}ms`);
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
  const saved = { teardown: process.env[TEARDOWN_ENV], browserClose: process.env[BROWSER_CLOSE_ENV] };
  process.env[TEARDOWN_ENV] = "500";
  process.env[BROWSER_CLOSE_ENV] = "300";
  try {
    await closeWith(baseUrl, projectDir, "a plain close", false);
    await closeWith(baseUrl, projectDir, "a close whose context and browser both hang", true);
  } finally {
    for (const [name, value] of [
      [TEARDOWN_ENV, saved.teardown],
      [BROWSER_CLOSE_ENV, saved.browserClose],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
