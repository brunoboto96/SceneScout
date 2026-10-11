/**
 * The run-status pane, an MCP App: its resource, scout_status and the tool the pane polls.
 *
 * Registered by mcp-server.ts, in the order the tools have always been listed.
 */
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BrowserEngine } from "../engine/browser.js";
import { LIVE_ENV } from "../engine/live.js";
import { MCP_APP_MIME, paneData, paneText, STATUS_PANE_URI, STATUS_POLL_TOOL, STATUS_TOOL, type PaneCoverage, type PaneData } from "../engine/status-pane.js";
import { statusPanePage } from "../engine/status-pane-page.js";

import { engines, PKG_VERSION, server, errorText, board, lastWriter, liveAddress, liveError } from "../server-context.js";

// ---- The run-status pane: an MCP App (SEP-1865, `io.modelcontextprotocol/ui`, spec 2026-01-26). ----
// scout_status links the pane through _meta.ui.resourceUri; the pane polls the
// app-only tool. Neither goes through a session queue: like the live view, a
// watcher must never wait behind the agent's calls, and both only read.
function statusPaneData(): PaneData {
  const eng = [lastWriter ? engines.get(lastWriter.session) : undefined, ...engines.values()].find((e): e is BrowserEngine => !!e?.memory);
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
  return paneData({
    nowMs: Date.now(),
    version: PKG_VERSION,
    live: liveAddress,
    liveError,
    liveOff: process.env[LIVE_ENV] === "off",
    sessions: board.list(),
    findings: memory ? memory.findings : null,
    runStart: memory?.sessionStart,
    coverage,
  });
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
      description: "The run's sessions, open findings by severity, coverage and the live view's address, refreshed every few seconds.",
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
