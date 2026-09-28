/**
 * What a smoke suite may not leave behind: a process it started, or a handle
 * that keeps node running.
 *
 * A browser a suite launched and never closed is still this process's child
 * when the suite ends, so the reaper (which only takes browsers whose parent
 * has died) never sees it, and its pipe keeps node's event loop alive: every
 * check passes and `npm test` then waits forever. These rules are pure
 * functions of `ps` output and of process.getActiveResourcesInfo(), so
 * dispatch-test can table-test them without a browser.
 */

/** A process still running under this one. */
export interface Leftover {
  pid: number;
  command: string;
}

/**
 * Every process below `rootPid` in a `ps -A -o pid=,ppid=,command=` listing,
 * children and their children alike: a browser's helper processes hang under
 * the browser, not under node. Two children are not the suite's and are left
 * out: the `ps` that produced the listing, and the esbuild service tsx starts
 * the first time it transforms a file at run time, which lives as long as node
 * does and does not keep it running.
 */
export function descendants(psOutput: string, rootPid: number): Leftover[] {
  const rows: Array<{ pid: number; ppid: number; command: string }> = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
  }
  const under = new Set([rootPid]);
  const found: Leftover[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (under.has(row.pid) || !under.has(row.ppid)) continue;
      under.add(row.pid);
      grew = true;
      if (row.ppid === rootPid && (/^(\S*\/)?ps\s/.test(row.command) || /\/esbuild --service=/.test(row.command))) continue;
      found.push({ pid: row.pid, command: row.command });
    }
  }
  return found;
}

/**
 * The handles open now that were not open at `baseline`, by type, as a
 * multiset: two sockets where there was one is one too many. Types come from
 * process.getActiveResourcesInfo() ("Timeout", "TCPServerWrap", "PipeWrap", ...).
 */
export function extraHandles(baseline: string[], now: string[]): string[] {
  const left = new Map<string, number>();
  for (const type of baseline) left.set(type, (left.get(type) ?? 0) + 1);
  const extra: string[] = [];
  for (const type of now) {
    const n = left.get(type) ?? 0;
    if (n > 0) left.set(type, n - 1);
    else extra.push(type);
  }
  return extra;
}
