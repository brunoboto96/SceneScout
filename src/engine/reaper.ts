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

/** A `ps -eo pid=,ppid=,command=` listing. Throws when ps is missing or times out. */
function psListing(): string {
  return execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5000 });
}

/**
 * The browsers running as direct children of `parentPid`, by pid. By name, not
 * by the ms-playwright cache path: PLAYWRIGHT_BROWSERS_PATH can put them
 * anywhere, and only this process's own children are candidates.
 */
function browserChildren(psOutput: string, parentPid: number): Set<number> {
  const pids = new Set<number>();
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || Number(m[2]) !== parentPid) continue;
    if (/chrom|firefox|webkit/i.test(m[3])) pids.add(Number(m[1]));
  }
  return pids;
}

/**
 * The pid of the browser a launch started, from `ps` listings taken just before
 * and just after it. Playwright starts the browser as a direct child of this
 * process (for WebKit, the shell wrapper that runs it) but does not expose its
 * pid on a launched Browser. Exactly one new browser child, or undefined:
 * guessing between two would risk killing another session's browser, so
 * callers serialise launches to keep the answer exact.
 */
export function launchedBrowserPid(before: string, after: string, parentPid: number): number | undefined {
  const existing = browserChildren(before, parentPid);
  const fresh = [...browserChildren(after, parentPid)].filter((pid) => !existing.has(pid));
  return fresh.length === 1 ? fresh[0] : undefined;
}

/** Whether `pid` is, in a `ps` listing, still a browser running as a direct child of `parentPid`: not a pid reused by something else since. */
export function isBrowserChild(psOutput: string, pid: number, parentPid: number): boolean {
  return browserChildren(psOutput, parentPid).has(pid);
}

/** Whether the browser this process launched as `pid` is still running as its child. False when ps cannot answer: a pid not confirmed as ours is never killed. */
export function ownBrowserRunning(pid: number): boolean {
  if (!processAlive(pid)) return false;
  const ps = browserPsListing();
  return ps !== "" && isBrowserChild(ps, pid, process.pid);
}

/** A `ps` listing for launchedBrowserPid, or "" where there is no ps (Windows) or it failed: the pid is then unknown. */
export function browserPsListing(): string {
  if (process.platform === "win32") return "";
  try {
    return psListing();
  } catch (err) {
    console.error(`[scenescout] could not list processes to record the browser's pid: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

/** Whether a process is running. EPERM means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * SIGKILL a browser this process launched, by the pid launchedBrowserPid found.
 * Playwright starts each browser as the leader of its own process group, so the
 * group is killed first: that reaches the browser's helpers, and WebKit's real
 * binary under its shell wrapper. The pid alone where there is no group.
 */
export function killBrowserProcess(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch {
      /* not a group leader: kill the process alone, below */
    }
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch (err) {
    console.error(`[scenescout] could not kill browser process ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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
    const psOut = psListing();
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
