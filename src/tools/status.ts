/**
 * The run-status pane, an MCP App: its resource, scout_status and the tool the pane polls.
 *
 * Registered by mcp-server.ts, in the order the tools have always been listed.
 */
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MCP_APP_MIME, paneData, paneText, STATUS_PANE_URI, STATUS_POLL_TOOL, STATUS_TOOL, type PaneCoverage, type PaneData } from "../engine/status-pane.js";
import { statusPanePage } from "../engine/status-pane-page.js";

import { classify, LIVE_ENV, type SessionStatus } from "../engine/live.js";
import type { Finding } from "../engine/memory.js";
import { guidedProgress, type GuidedProgress, type ProgressSession } from "../engine/progress.js";
import { PKG_VERSION, server, errorText, board, liveAddress, liveError, guidedPlans, guidedRuns, guidedSessions, projectEngine } from "../server-context.js";

// ---- The run-status pane: an MCP App (SEP-1865, `io.modelcontextprotocol/ui`, spec 2026-01-26). ----
// scout_status links the pane through _meta.ui.resourceUri; the pane polls the
// app-only tool. Neither goes through a session queue: like the live view, a
// watcher must never wait behind the agent's calls, and both only read.
function statusPaneData(): PaneData {
  const eng = projectEngine();
  const memory = eng?.memory ?? null;
  let coverage: PaneCoverage | null = null;
  if (eng && memory) {
    const all = eng.allKnownRoutes();
    const cov = memory.coverage();
    coverage = {
      routesVisited: all.length - eng.unvisitedKnownRoutes().length,
      routesTotal: all.length,
      states: cov.states,
      elementsExercised: cov.elementsExercised,
      elementsTotal: cov.elementsTotal,
    };
  }
  const nowMs = Date.now();
  const sessions = board.list();
  const guided = guidedPaneProgress(nowMs, sessions, coverage, memory ? memory.findings : []);
  return paneData({
    nowMs,
    version: PKG_VERSION,
    live: liveAddress,
    liveError,
    liveOff: process.env[LIVE_ENV] === "off",
    sessions,
    findings: memory ? memory.findings : null,
    runStart: memory?.sessionStart,
    coverage,
    ...(guided ? { guided } : {}),
  });
}

/** The progress of the guided check on show, built from the board's entries for the sessions carrying its plan. */
function guidedPaneProgress(
  nowMs: number,
  board: readonly SessionStatus[],
  coverage: PaneCoverage | null,
  findings: readonly Finding[],
): GuidedProgress | undefined {
  const planId = guidedRuns.focused;
  const plan = planId ? guidedPlans.get(planId) : undefined;
  if (!plan) return undefined;
  const sessions: ProgressSession[] = [];
  for (const s of board) {
    const held = guidedSessions.get(s.session);
    if (held?.planId !== plan.planId) continue;
    sessions.push({
      session: s.session,
      state: classify(s, nowMs),
      tool: s.tool,
      url: s.url,
      since: s.since,
      ...(s.task ? { task: s.task } : {}),
      ...(held.area ? { area: held.area } : {}),
    });
  }
  const trouble = guidedRuns.trouble(plan.planId);
  return guidedProgress({ nowMs, plan, run: guidedRuns.get(plan.planId), sessions, coverage, findings, ...(trouble ? { trouble } : {}) });
}

function statusResult(): CallToolResult {
  try {
    const data = statusPaneData();
    return { content: [{ type: "text", text: paneText(data) }], structuredContent: { ...data } };
  } catch (err) {
    return errorText(err);
  }
}

export function registerStatusTools(): void {
  server.registerResource(
    "scenescout-status",
    STATUS_PANE_URI,
    {
      title: "SceneScout run status",
      description:
        "The run's sessions, open findings by severity, coverage and the live view's address, refreshed every few seconds; in a guided check, its progress in plain words and the newest finding cards.",
      mimeType: MCP_APP_MIME,
      // No outside origin: the page is one self-contained document, so the host's restrictive default CSP applies.
      _meta: { ui: { csp: {}, prefersBorder: true } },
    },
    () => ({
      contents: [{ uri: STATUS_PANE_URI, mimeType: MCP_APP_MIME, text: statusPanePage(PKG_VERSION), _meta: { ui: { csp: {}, prefersBorder: true } } }],
    }),
  );

  server.registerTool(
    STATUS_TOOL,
    {
      title: "Run status",
      description:
        "Show the person running you how the run stands: each session's objective and current task, open findings by severity, coverage, and the live view's address. " +
        "In a guided check it also shows the check's progress in plain words: what is happening now, each area's state, pages and time against the plan's limits, problems so far and the newest cards, and the clicking it saved with what that figure is based on. " +
        "Call it when the user wants to watch or asks how the run is going. A host that renders MCP Apps shows a pane that keeps itself up to date; every other host gets the same as text, and you pass the `Live view:` address on. Takes no input and touches no browser.",
      // The legacy flat key alongside _meta.ui.resourceUri, as the ext-apps SDK's registerAppTool sets both for hosts that read only the old one.
      _meta: { ui: { resourceUri: STATUS_PANE_URI }, "ui/resourceUri": STATUS_PANE_URI },
    },
    async () => statusResult(),
  );

  server.registerTool(
    STATUS_POLL_TOOL,
    {
      title: "Run status (for the pane)",
      description: `Called by the ${STATUS_TOOL} pane every few seconds to refresh itself. Not for the agent: call ${STATUS_TOOL} instead.`,
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => statusResult(),
  );
}
