/**
 * How a run actually spent its time.
 *
 * The engine was never the slow part of a long run: in a four-session
 * validation pass the median gap between one action and the next was under a
 * second, while the browsers sat idle for roughly four fifths of the elapsed
 * time, waiting on the agent to decide what to do. One session in that run
 * performed a single action and then held a browser open for an hour.
 *
 * None of that was visible anywhere. It had to be computed by hand from the
 * JSONL trail afterwards, which is exactly the kind of number a run should
 * hand you. These rules are pure so they can be table-tested; the report and
 * the live view both read them.
 */
import type { ActionLogEntry } from "./memory.js";

/**
 * Log entries that are not actions: a stated task, an attach, the note that a
 * resource was created. They carry no browser work and take no time, so
 * counting them inflates the action count and drags the median gap toward
 * zero. One real run logged 325 entries of which 107 were stated tasks.
 */
const MARKER_ACTIONS = new Set(["task", "attach", "created-resource", "journey:start", "journey:end", "record:full", "record:failed"]);

/** Whether a log entry represents work the browser actually did. */
export function isActing(action: string): boolean {
  return !MARKER_ACTIONS.has(action);
}

/** A gap longer than this is the agent thinking, not the browser working. */
export const IDLE_GAP_MS = 30_000;
/** A session with no action for this long is probably forgotten, and is holding a browser for nothing. */
export const STALE_SESSION_MS = 5 * 60_000;

export interface SessionPace {
  session: string;
  actions: number;
  /** First to last action, in milliseconds. */
  spanMs: number;
  /** The typical gap between consecutive actions — what the engine costs per step. */
  medianGapMs: number;
  /** The longest the browser stood still. */
  maxGapMs: number;
  /** Share of the span spent in gaps over IDLE_GAP_MS, 0–1. */
  idleShare: number;
  /** Milliseconds since this session's last action, given the clock passed in. */
  quietMs: number;
  /** How many of its actions kept a frame. Zero on a run that was not recorded. */
  framed: number;
}

export interface RunPace {
  sessions: SessionPace[];
  /** First action of any session to the last, in milliseconds. */
  spanMs: number;
  actions: number;
  /** Sessions whose last action is older than STALE_SESSION_MS: holding a browser, doing nothing. */
  quiet: string[];
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The pace of each session in the log, and of the run as a whole. `nowMs` is
 * passed rather than read so the numbers are the same every time they are
 * computed from the same log.
 */
export function measurePace(log: readonly ActionLogEntry[], nowMs: number, attached: readonly string[] = []): RunPace {
  const stillOpen = new Set(attached);
  const bySession = new Map<string, ActionLogEntry[]>();
  for (const entry of log) {
    if (!isActing(entry.action)) continue;
    const name = entry.session ?? "default";
    const list = bySession.get(name);
    if (list) list.push(entry);
    else bySession.set(name, [entry]);
  }

  const sessions: SessionPace[] = [];
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const [session, entries] of bySession) {
    const times = entries.map((e) => Date.parse(e.at)).filter((t) => Number.isFinite(t));
    if (times.length === 0) continue;
    times.sort((a, b) => a - b);
    first = Math.min(first, times[0]);
    last = Math.max(last, times[times.length - 1]);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
    const spanMs = times[times.length - 1] - times[0];
    const idleMs = gaps.filter((g) => g > IDLE_GAP_MS).reduce((sum, g) => sum + g, 0);
    sessions.push({
      session,
      actions: entries.length,
      spanMs,
      medianGapMs: median([...gaps].sort((a, b) => a - b)),
      maxGapMs: gaps.length > 0 ? Math.max(...gaps) : 0,
      idleShare: spanMs > 0 ? idleMs / spanMs : 0,
      quietMs: Math.max(0, nowMs - times[times.length - 1]),
      framed: entries.filter((e) => e.frame).length,
    });
  }
  sessions.sort((a, b) => b.actions - a.actions);
  return {
    sessions,
    spanMs: sessions.length > 0 ? last - first : 0,
    actions: sessions.reduce((sum, x) => sum + x.actions, 0),
    // Only a session that is STILL ATTACHED can be holding a browser. A lane
    // that finished and closed is quiet because it is gone, and warning about
    // it told the reader to close something that no longer exists — which is
    // what the first run of this report did for six of its eleven sessions.
    quiet: sessions.filter((s) => s.quietMs > STALE_SESSION_MS && stillOpen.has(s.session)).map((s) => s.session),
  };
}

/** Milliseconds as a person says them: 45s, 4m12s, 1h03m. */
export function sayDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The run's pace as report lines. Says what the numbers mean, because "idle
 * 84%" reads as a fault in the engine when it is a description of how the
 * agent paced itself.
 */
export function formatPace(pace: RunPace): string[] {
  if (pace.sessions.length === 0) return [];
  const lines = [
    `## How the run was paced`,
    ``,
    `${pace.actions} action(s) over ${sayDuration(pace.spanMs)}. Stated tasks and attaches are not counted: they take no time. Idle share is time the browser stood still waiting for the agent, not time the engine spent working.`,
    ``,
    `| Session | Actions | Span | Median gap | Longest gap | Idle | Frames |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
  ];
  for (const s of pace.sessions) {
    lines.push(
      `| ${s.session} | ${s.actions} | ${sayDuration(s.spanMs)} | ${sayDuration(s.medianGapMs)} | ${sayDuration(s.maxGapMs)} | ${Math.round(s.idleShare * 100)}% | ${s.framed} |`,
    );
  }
  lines.push(``);
  if (pace.quiet.length > 0) {
    lines.push(
      `⚠ Held a browser with nothing to do for over ${sayDuration(STALE_SESSION_MS)}: ${pace.quiet.join(", ")}. A session waiting for its turn should be closed and re-attached when it is needed.`,
      ``,
    );
  }
  return lines;
}
