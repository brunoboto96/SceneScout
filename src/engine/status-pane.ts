/**
 * The run-status pane: an MCP App (SEP-1865, extension `io.modelcontextprotocol/ui`)
 * that a host able to render one shows inline, and the text every other host
 * shows instead.
 *
 * `scout_status` links the pane's `ui://` resource through `_meta.ui.resourceUri`.
 * The pane polls an app-only tool (`_meta.ui.visibility: ["app"]`) for what is
 * built here, because the spec delivers no server notification to a view after
 * it renders. A host that does not render MCP Apps treats `scout_status` as a
 * plain tool, so its text has to stand alone: it always carries the live view's
 * address.
 *
 * What the pane gets is what the live view already shows (ADR 7): each
 * session's board entry, the open findings counted by severity, and the
 * coverage figures in the report's summary. The board's text is redacted when
 * it is written, and no token is returned except the one in the live view's
 * address, which answers on this machine only.
 *
 * Nothing here imports Playwright or the MCP SDK, so every rule is table-tested.
 */
import { classify, formatDuration, type SessionState, type SessionStatus } from "./live.js";
import type { Finding } from "./memory.js";

/** The pane's resource. `ui://` is the scheme the extension reserves for views. */
export const STATUS_PANE_URI = "ui://scenescout/status.html";
/** The only content type the 2026-01-26 specification defines for a view. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";
/** The protocol version the pane names in `ui/initialize`. */
export const MCP_APPS_PROTOCOL = "2026-01-26";
/** The model-facing tool: returns the text and links the pane. */
export const STATUS_TOOL = "scout_status";
/** The app-only tool the pane polls. A host that implements visibility keeps it out of the model's list. */
export const STATUS_POLL_TOOL = "scout_status_poll";
/** How often the pane polls, in milliseconds: inside the 2–3 s the system-monitor example uses. */
export const STATUS_POLL_MS = 2500;

export interface PaneSession {
  session: string;
  role: string;
  state: SessionState;
  /** The tool running, or the one that ran last when idle. */
  tool: string;
  /** How long the session has been in that state, in milliseconds. */
  forMs: number;
  url: string;
  objective?: string;
  task?: string;
}

/** Open defects by severity, as the report's summary counts them: worth-a-look and resolved findings are counted apart. */
export interface PaneFindings {
  open: number;
  high: number;
  medium: number;
  low: number;
  /** Open defects first filed in this run. */
  thisRun: number;
  worthALook: number;
  resolved: number;
}

/** The report summary's coverage figures. `routesTotal` 0 means no route is known yet. */
export interface PaneCoverage {
  routesVisited: number;
  routesTotal: number;
  states: number;
  elementsExercised: number;
  elementsTotal: number;
}

export interface PaneData {
  at: string;
  version: string;
  /** The loopback live-view address, token included; null while the live view is not up. */
  liveUrl: string | null;
  /** Why there is no address, in a sentence. Present exactly when `liveUrl` is null. */
  liveNote?: string;
  sessions: PaneSession[];
  /** Null before any session has attached to a project. */
  findings: PaneFindings | null;
  coverage: PaneCoverage | null;
}

export type PaneFinding = Pick<Finding, "severity" | "status" | "tier" | "foundAt">;

export interface PaneInput {
  nowMs: number;
  version: string;
  live: { port: number; token: string } | null;
  /** Why the live view could not start, when it could not. */
  liveError: string | null;
  /** SCENESCOUT_LIVE=off: the port is never opened. */
  liveOff: boolean;
  sessions: readonly SessionStatus[];
  /** The project's findings, or null when no session holds a project. */
  findings: readonly PaneFinding[] | null;
  /** When the run began, so "this run" can be told from history. */
  runStart?: string;
  coverage: PaneCoverage | null;
}

/** The live view's address. One place builds it, so the pane, the text and the attach result agree. */
export function liveViewUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/${token}/`;
}

export function countFindings(findings: readonly PaneFinding[], runStart?: string): PaneFindings {
  const counts: PaneFindings = { open: 0, high: 0, medium: 0, low: 0, thisRun: 0, worthALook: 0, resolved: 0 };
  for (const f of findings) {
    if (f.status === "resolved") counts.resolved += 1;
    else if (f.tier === "worth_a_look") counts.worthALook += 1;
    else {
      counts.open += 1;
      counts[f.severity] += 1;
      if (runStart !== undefined && f.foundAt >= runStart) counts.thisRun += 1;
    }
  }
  return counts;
}

/** What the pane renders and the app-only tool returns. Pure: the server gathers the input. */
export function paneData(input: PaneInput): PaneData {
  const sessions = input.sessions.map((s): PaneSession => {
    const out: PaneSession = {
      session: s.session,
      role: s.role,
      state: classify(s, input.nowMs),
      tool: s.tool,
      forMs: Math.max(0, input.nowMs - new Date(s.since).getTime()),
      url: s.url,
    };
    if (s.objective) out.objective = s.objective;
    if (s.task) out.task = s.task;
    return out;
  });
  const data: PaneData = {
    at: new Date(input.nowMs).toISOString(),
    version: input.version,
    liveUrl: input.live ? liveViewUrl(input.live.port, input.live.token) : null,
    sessions,
    findings: input.findings ? countFindings(input.findings, input.runStart) : null,
    coverage: input.coverage,
  };
  if (!data.liveUrl) {
    data.liveNote = input.liveOff
      ? "The live view is off: SCENESCOUT_LIVE=off is set in the server's environment."
      : input.liveError
        ? `The live view could not start: ${input.liveError}`
        : "The live view starts with the first scout_attach.";
  }
  return data;
}

function sessionLine(s: PaneSession): string {
  const what =
    s.state === "idle"
      ? `idle ${formatDuration(s.forMs)} after ${s.tool}`
      : `${s.state === "stuck" ? "STUCK in" : "running"} ${s.tool} for ${formatDuration(s.forMs)}`;
  const lines = [`- ${s.session} (${s.role}): ${what}${s.url ? ` on ${s.url}` : ""}`];
  if (s.task) lines.push(`  task: ${s.task}`);
  if (s.objective) lines.push(`  objective: ${s.objective}`);
  return lines.join("\n");
}

/**
 * The tool's text: everything the pane shows, for a host that shows no pane.
 * The first line is the live view's address, in the `Live view:` form the
 * attach result uses, so an agent that relays one relays the other.
 */
export function paneText(data: PaneData): string {
  const lines = [
    data.liveUrl
      ? `Live view: ${data.liveUrl} — open it to watch every session. It answers on this machine only and cannot act on the run.`
      : `Live view: not available. ${data.liveNote ?? ""}`.trimEnd(),
  ];
  if (data.sessions.length === 0) lines.push("No session is attached.");
  else {
    lines.push(`${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"}:`);
    for (const s of data.sessions) lines.push(sessionLine(s));
  }
  if (data.findings) {
    const f = data.findings;
    const extra = [f.worthALook ? `${f.worthALook} worth a look` : "", f.resolved ? `${f.resolved} resolved` : ""].filter(Boolean).join(", ");
    lines.push(`Open findings: ${f.open} (${f.high} high, ${f.medium} medium, ${f.low} low), ${f.thisRun} this run${extra ? `; ${extra}` : ""}`);
  }
  if (data.coverage) {
    const c = data.coverage;
    const routes = c.routesTotal > 0 ? `routes ${c.routesVisited}/${c.routesTotal} · ` : "";
    lines.push(`Coverage: ${routes}${c.states} states · ${c.elementsExercised}/${c.elementsTotal} elements exercised`);
  }
  return lines.join("\n");
}
