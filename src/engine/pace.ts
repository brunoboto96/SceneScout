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
import { FORMS_READ_FAILED, FORMS_SUBMIT_UNMATCHED } from "./forms.js";

/**
 * Log entries that are not actions: a stated task, an attach, the note that a
 * resource was created. They carry no browser work and take no time, so
 * counting them inflates the action count and drags the median gap toward
 * zero. One real run logged 325 entries of which 107 were stated tasks.
 */
const MARKER_ACTIONS = new Set([
  "task",
  "attach",
  "close",
  "lane-report",
  "created-resource",
  "journey:start",
  "journey:end",
  "record:full",
  "record:failed",
  FORMS_READ_FAILED,
  FORMS_SUBMIT_UNMATCHED,
]);

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
  /** Share of the span (the WORKING time) spent in gaps over IDLE_GAP_MS, 0–1: the agent thinking at length while the lane was still testing. */
  idleShare: number;
  /** Milliseconds since this session's last action, given the clock passed in. */
  quietMs: number;
  /** How many of its actions kept a frame. Zero on a run that was not recorded. */
  framed: number;
  /**
   * From attach to the first action, summed over every attach. A session that
   * attached and never acted is all lead-in — and used to be missing from the
   * table altogether, because it had no actions to measure.
   */
  leadInMs: number;
  /**
   * From the last action to close (or to now, while still attached): the lane
   * has finished testing and holds its browser until it is collected. Kept
   * apart from the working time because it measures the planner, not the
   * lane: it grows with the number of lanes and with how long the slowest one
   * takes, however efficiently each lane worked. Summed into one "held idle"
   * figure, it made a run of eight quick lanes look like the idlest run.
   */
  afterFinishMs: number;
  /**
   * The part of afterFinishMs after the lane's report was folded — the browser
   * was no longer needed for anything. Null when no fold was recorded, which is
   * every single-agent run.
   */
  afterFoldMs: number | null;
}

/** The run's working time against its waiting time, summed over sessions. */
export interface RunWaiting {
  /** First-to-last action, summed over sessions. */
  workingMs: number;
  /** Of that, gaps over IDLE_GAP_MS. */
  workingIdleMs: number;
  leadInMs: number;
  afterFinishMs: number;
  /** Null when no session's report was folded. */
  afterFoldMs: number | null;
}

export interface RunPace {
  sessions: SessionPace[];
  /** First action of any session to the last, in milliseconds. */
  spanMs: number;
  actions: number;
  /** Sessions whose last action is older than STALE_SESSION_MS: holding a browser, doing nothing. */
  quiet: string[];
  waiting: RunWaiting;
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
  const lifecycle = new Map<string, ActionLogEntry[]>();
  for (const entry of log) {
    const name = entry.session ?? "default";
    const into = isActing(entry.action)
      ? bySession
      : entry.action === "attach" || entry.action === "close" || entry.action === "lane-report"
        ? lifecycle
        : null;
    if (!into) continue;
    const list = into.get(name);
    if (list) list.push(entry);
    else into.set(name, [entry]);
  }
  // A session that attached and never acted still held a browser.
  for (const name of lifecycle.keys()) if (!bySession.has(name)) bySession.set(name, []);

  const sessions: SessionPace[] = [];
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const [session, entries] of bySession) {
    const times = entries
      .map((e) => Date.parse(e.at))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    const edge = edges(lifecycle.get(session) ?? [], times, nowMs, stillOpen.has(session));
    if (times.length === 0) {
      if (edge.leadInMs > 0) {
        sessions.push({ session, actions: 0, spanMs: 0, medianGapMs: 0, maxGapMs: 0, idleShare: 0, quietMs: 0, framed: 0, ...edge });
      }
      continue;
    }
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
      ...edge,
    });
  }
  sessions.sort((a, b) => b.actions - a.actions);
  const folds = sessions.filter((s) => s.afterFoldMs !== null);
  const waiting: RunWaiting = {
    workingMs: sessions.reduce((sum, s) => sum + s.spanMs, 0),
    workingIdleMs: sessions.reduce((sum, s) => sum + s.idleShare * s.spanMs, 0),
    leadInMs: sessions.reduce((sum, s) => sum + s.leadInMs, 0),
    afterFinishMs: sessions.reduce((sum, s) => sum + s.afterFinishMs, 0),
    afterFoldMs: folds.length > 0 ? folds.reduce((sum, s) => sum + (s.afterFoldMs ?? 0), 0) : null,
  };
  return {
    waiting,
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

/**
 * Time at the edges of each attach: attach to first action (lead-in), and last
 * action to close (after finishing). An attach with no close after it ends at
 * the next attach, or at now while the session is still open. A log written
 * before close was recorded has no close marker; its closed sessions count no
 * trailing time, because when they closed is unknown. A fold marker after the
 * last action splits the trailing time at the moment the browser stopped being
 * needed.
 */
function edges(
  markers: readonly ActionLogEntry[],
  actionTimes: readonly number[],
  nowMs: number,
  stillOpen: boolean,
): { leadInMs: number; afterFinishMs: number; afterFoldMs: number | null } {
  const events = markers
    .map((m) => ({ kind: m.action, at: Date.parse(m.at) }))
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);
  let leadInMs = 0;
  let afterFinishMs = 0;
  let afterFoldMs: number | null = null;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].kind !== "attach") continue;
    const start = events[i].at;
    const next = events.slice(i + 1).find((e) => e.kind === "attach" || e.kind === "close");
    const end = next ? next.at : stillOpen ? nowMs : null;
    const inside = actionTimes.filter((t) => t >= start && (end === null || t <= end));
    if (inside.length === 0) {
      if (end !== null) leadInMs += end - start;
      continue;
    }
    leadInMs += inside[0] - start;
    if (end === null) continue;
    const lastAction = inside[inside.length - 1];
    afterFinishMs += end - lastAction;
    const fold = events.filter((e) => e.kind === "lane-report" && e.at >= lastAction && e.at <= end).at(-1);
    if (fold) afterFoldMs = (afterFoldMs ?? 0) + (end - fold.at);
  }
  return { leadInMs: Math.max(0, leadInMs), afterFinishMs: Math.max(0, afterFinishMs), afterFoldMs };
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
  const w = pace.waiting;
  const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%");
  const lines = [
    `## How the run was paced`,
    ``,
    `${pace.actions} action(s) over ${sayDuration(pace.spanMs)}. Stated tasks and attaches are not counted: they take no time.`,
    ``,
    `**While working** — first action to last, ${sayDuration(w.workingMs)} across sessions — ${pct(w.workingIdleMs, w.workingMs)} was spent in gaps over ${sayDuration(IDLE_GAP_MS)}, the agent thinking at length. That is how closely the sessions kept working.`,
    ``,
    `**After finishing**, sessions held their browsers for a further ${sayDuration(w.afterFinishMs)}` +
      (w.afterFoldMs !== null ? `, ${sayDuration(w.afterFoldMs)} of it after their report was already folded` : ``) +
      (w.afterFoldMs !== null
        ? `. That is time waiting to be collected and closed: it grows with the number of lanes and with the slowest one, not with how well any lane worked. Closing each lane as soon as its report is folded removes it.`
        : `: time from the last action to close.`) +
      ` (Before the first action: ${sayDuration(w.leadInMs)}.)`,
    ``,
    `| Session | Actions | Working | Median gap | Longest gap | Idle while working | After finishing | Frames |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|`,
  ];
  for (const s of pace.sessions) {
    const after = sayDuration(s.afterFinishMs) + (s.afterFoldMs !== null ? ` (${sayDuration(s.afterFoldMs)} after fold)` : ``);
    lines.push(
      `| ${s.session} | ${s.actions} | ${sayDuration(s.spanMs)} | ${sayDuration(s.medianGapMs)} | ${sayDuration(s.maxGapMs)} | ${Math.round(s.idleShare * 100)}% | ${after} | ${s.framed} |`,
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
