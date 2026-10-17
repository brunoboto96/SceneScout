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

/** The handle types that are this process's own TCP sockets: a server listening, and a connection to or from one. */
const TCP_HANDLES = new Set(["TCPServerWrap", "TCPSocketWrap", "TCPWrap"]);

/**
 * The TCP sockets open now in this process that were not open at `baseline`:
 * a stand-in server a suite never closed, or a connection to one nobody ended.
 * A browser's pipes and process are the process check's to find, and timers
 * the end-of-run check's, so they are left out here.
 */
export function socketsLeft(baseline: string[], now: string[]): string[] {
  return extraHandles(baseline, now).filter((type) => TCP_HANDLES.has(type));
}

/** One TCP socket on the machine, from the operating system's table. `pid` is known on Windows only. */
export interface TcpRow {
  state: string;
  local: string;
  remote: string;
  pid?: number;
}

/** The states the three tables name differently, in netstat's spelling. */
const STATE_NAMES: Record<string, string> = {
  LISTENING: "LISTEN",
  ESTAB: "ESTABLISHED",
  "TIME-WAIT": "TIME_WAIT",
  "CLOSE-WAIT": "CLOSE_WAIT",
  "FIN-WAIT-1": "FIN_WAIT_1",
  "FIN-WAIT-2": "FIN_WAIT_2",
  "SYN-SENT": "SYN_SENT",
  "SYN-RECV": "SYN_RECEIVED",
  SYN_RCVD: "SYN_RECEIVED",
  "LAST-ACK": "LAST_ACK",
};

/**
 * The machine's TCP sockets, from `netstat -ano` on Windows (with the owning
 * process), `netstat -an -p tcp` on macOS, or `ss -tan` on Linux. Lines that
 * are not a TCP socket (headings, UDP) are skipped.
 */
export function parseTcpTable(text: string): TcpRow[] {
  const rows: TcpRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    // Windows: TCP <local> <remote> <state> <pid>
    if (f[0] === "TCP" && f.length >= 5 && /^\d+$/.test(f[4])) {
      rows.push({ state: STATE_NAMES[f[3]] ?? f[3], local: f[1], remote: f[2], pid: Number(f[4]) });
      continue;
    }
    // macOS: tcp4|tcp6|tcp46 <recv-q> <send-q> <local> <remote> <state>
    if (/^tcp(4|6|46)?$/.test(f[0]) && f.length >= 6) {
      rows.push({ state: STATE_NAMES[f[5]] ?? f[5], local: f[3], remote: f[4] });
      continue;
    }
    // Linux ss: <state> <recv-q> <send-q> <local> <peer>
    if (f.length >= 5 && /^\d+$/.test(f[1]) && /^\d+$/.test(f[2]) && /^[A-Z][A-Z-]+[A-Z0-9]$/.test(f[0])) {
      rows.push({ state: STATE_NAMES[f[0]] ?? f[0], local: f[3], remote: f[4] });
    }
  }
  return rows;
}

/** How many sockets are in each state. */
export function tcpStateCounts(rows: TcpRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return counts;
}

/** One line for the log: the total and each state's count, the largest first. */
export function socketLine(rows: TcpRow[]): string {
  const states = Object.entries(tcpStateCounts(rows)).sort((a, b) => b[1] - a[1]);
  const head = `${rows.length} TCP sockets on this machine`;
  return states.length === 0 ? head : `${head}: ${states.map(([s, n]) => `${s} ${n}`).join(", ")}`;
}

/**
 * The processes holding the most sockets, as "name (pid): count", for a table
 * that names its owners (Windows). Pid 0 is the system's: a socket in
 * TIME_WAIT has no process left, so it is not counted against one.
 */
export function busiestOwners(rows: TcpRow[], names: Map<number, string>, limit: number): string[] {
  const byPid = new Map<number, number>();
  for (const row of rows) if (row.pid) byPid.set(row.pid, (byPid.get(row.pid) ?? 0) + 1);
  return [...byPid.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([pid, n]) => `${names.has(pid) ? `${names.get(pid)} (${pid})` : String(pid)}: ${n}`);
}

/** Process names by pid, from Windows' `tasklist /FO CSV /NH`. */
export function parseTasklist(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^"([^"]*)","(\d+)"/);
    if (m) names.set(Number(m[2]), m[1]);
  }
  return names;
}
