/**
 * Cleanup of browsers orphaned by a crashed run.
 *
 * Deciding which processes to SIGKILL is a pure function of `ps` output, so it
 * lives here rather than in browser.ts and is table-tested: the cost of a wrong
 * answer is killing somebody else's browser.
 */
import { execFileSync } from "node:child_process";

/** Launch flag stamped into our browsers' command lines so the reaper can recognise them. */
export const BROWSER_MARKER = "scenescout-session";
/** Markers earlier versions stamped. Launch uses only the current one; the reaper must still recognise a browser orphaned by a crash just before an upgrade. */
const REAPABLE_MARKERS = [BROWSER_MARKER, "scenecraft-session"];

/**
 * Which pids in a `ps -eo pid=,ppid=,command=` listing are ours to reap.
 * Conservative on three axes: the command line must point into the
 * ms-playwright cache, the parent must be gone (re-parented to pid 1), AND the
 * command line must carry our marker (passed as a launch flag precisely so it
 * shows up in `ps`).
 *
 * That last check is why this is narrow enough to run at startup. Matching on
 * "orphaned Playwright browser" alone reaches every Playwright process on the
 * machine — someone else's test suite, an unrelated automation job, a browser
 * whose wrapper died while its owner lived — and SIGKILLs it. Only reap what
 * this tool launched.
 */
export function orphanPids(psOutput: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, ppidStr, command] = m;
    if (!command.includes("ms-playwright") || !/chrom|firefox|webkit/i.test(command)) continue;
    if (!REAPABLE_MARKERS.some((marker) => command.includes(marker))) continue;
    if (Number(ppidStr) !== 1) continue;
    pids.push(Number(pidStr));
  }
  return pids;
}

/**
 * Kill orphaned Playwright browser processes left behind by a crashed or
 * SIGKILL'd previous run (a dead parent can't close its browser, and the
 * leftover has been observed to wedge subsequent launches).
 *
 * Best-effort and POSIX-only; returns how many were reaped.
 */
export function reapOrphanBrowsers(): number {
  if (process.platform === "win32") return 0;
  let reaped = 0;
  try {
    const psOut = execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5000 });
    for (const pid of orphanPids(psOut)) {
      try {
        process.kill(pid, "SIGKILL");
        reaped += 1;
      } catch {
        /* already gone or not ours to kill */
      }
    }
  } catch {
    /* ps unavailable or timed out — reaping is best-effort */
  }
  if (reaped > 0) console.error(`[scenescout] reaped ${reaped} orphaned browser process(es) from a previous run`);
  return reaped;
}
