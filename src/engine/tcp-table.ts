/**
 * The machine's TCP table, read from the operating system and put in one line
 * for a log. A page load that fails with net::ERR_NO_BUFFER_SPACE was refused a
 * socket by the system (on Windows, WSAENOBUFS: no socket buffers or ports
 * left); the engine logs this line before it retries such a load
 * (limits.ts loadRetryCause), and the smoke harness logs it after every suite.
 *
 * The parsing is pure and table-tested in dispatch-test; readMachineSockets
 * runs the commands, through a runner a test can stand in for.
 */
import { execFile } from "node:child_process";

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

/** The states Windows' netstat prints, after STATE_NAMES. */
const WINDOWS_STATES = new Set([
  "LISTENING",
  "ESTABLISHED",
  "TIME_WAIT",
  "CLOSE_WAIT",
  "FIN_WAIT_1",
  "FIN_WAIT_2",
  "SYN_SENT",
  "SYN_RECEIVED",
  "LAST_ACK",
  "CLOSING",
  "CLOSED",
  "BOUND",
  "DELETE_TCB",
]);

/**
 * The machine's TCP sockets, from `netstat -ano` on Windows (with the owning
 * process), `netstat -an -p tcp` on macOS, or `ss -tan` on Linux. Lines that
 * are not a TCP socket (headings, UDP) are skipped. On Windows the state is the
 * first field after the remote address that names a state, and the process is
 * the field after it, so a column added after the process (the offload state of
 * `netstat -ano -o`) does not move it. A localised state name matches none, so
 * the process is then the last field and the state everything between.
 */
export function parseTcpTable(text: string): TcpRow[] {
  const rows: TcpRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    // Windows: TCP <local> <remote> <state…> <pid>
    if (f[0] === "TCP" && f.length >= 5) {
      const at = f.findIndex((field, i) => i >= 3 && WINDOWS_STATES.has(field.toUpperCase()));
      if (at >= 3 && /^\d+$/.test(f[at + 1] ?? "")) {
        const state = f[at].toUpperCase();
        rows.push({ state: STATE_NAMES[state] ?? state, local: f[1], remote: f[2], pid: Number(f[at + 1]) });
        continue;
      }
      const last = f[f.length - 1];
      if (/^\d+$/.test(last)) {
        const state = f.slice(3, -1).join(" ");
        rows.push({ state: STATE_NAMES[state] ?? state, local: f[1], remote: f[2], pid: Number(last) });
        continue;
      }
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

/** Runs a command and resolves with its standard output. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<string>;

/** How long one command of the reader may take. */
const READ_TIMEOUT_MS = 5000;

const runCommand: CommandRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: READ_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

const firstLine = (err: unknown): string => (err instanceof Error ? err.message.split("\n")[0] : String(err));

/**
 * The machine's TCP table as one line. With `owners` set, on Windows also the
 * processes holding the most sockets, by name and pid: that is for a CI log
 * only. The default leaves them out, because the engine puts this line in the
 * report (limits.ts LoadRetry.sockets) and a process name or pid belongs
 * nowhere a person shares. Never throws: a table that cannot be read says so in the
 * line, and a process list that cannot be read leaves the table it read.
 */
export async function readMachineSockets(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = runCommand,
  options: { owners?: boolean } = {},
): Promise<string> {
  let rows: TcpRow[];
  try {
    const [cmd, args] = platform === "win32" ? ["netstat", ["-ano"]] : platform === "darwin" ? ["netstat", ["-an", "-p", "tcp"]] : ["ss", ["-tan"]];
    rows = parseTcpTable(await run(cmd, args));
  } catch (err) {
    return `(could not read the TCP table: ${firstLine(err)})`;
  }
  if (platform !== "win32" || !options.owners) return socketLine(rows);
  let names: Map<number, string>;
  try {
    names = parseTasklist(await run("tasklist", ["/FO", "CSV", "/NH"]));
  } catch (err) {
    return `${socketLine(rows)} (could not name their processes: ${firstLine(err)})`;
  }
  const owners = busiestOwners(rows, names, 3);
  return `${socketLine(rows)}${owners.length ? `; most held by ${owners.join(", ")}` : ""}`;
}
