#!/usr/bin/env node
/**
 * SceneScout MCP server (stdio).
 *
 * Exposes deterministic browser-exploration tools — Playwright actions, state
 * memory, oracles, findings, report — to any MCP client. The client (e.g.
 * Claude Code on a subscription) is the brain, and no LLM call happens here
 * unless finding dedup is set to ask a model judge (SCENESCOUT_DEDUP, or
 * scout_attach {dedup}): then a filing the dedup rule keeps apart is put to a
 * model, through the client when it is a `scenescout ci` run, else with a key
 * from this process's environment (engine/dedup.ts).
 *
 * The server process is a per-conversation daemon and behaves like one:
 * - Multi-session, genuinely concurrent: named sessions each own a live
 *   browser (scout_attach {session}); every per-session tool takes an optional
 *   `session` override so a controller can dispatch commands to MULTIPLE
 *   sessions in parallel — the two calls actually run concurrently, not
 *   one at a time — while calls targeting the SAME session still serialize
 *   (a single browser's ref table/fingerprint is shared mutable state and
 *   cannot process overlapping actions). scout_session sets a convenience
 *   default so single-session workflows never need to pass `session`.
 * - Watchdog: every tool call has a hard time budget — a wedged browser
 *   returns a diagnosable error instead of hanging the conversation, and
 *   that session's queue keeps moving (other sessions are unaffected).
 * - Self-healing: orphaned browser processes from crashed runs are reaped at
 *   startup and on launch failure; attach retries once after reaping.
 * - Observable: .scenescout/status.json in the tested project always shows
 *   what EVERY session is doing right now (`scenescout status <project>`), and
 *   a loopback-only live view shows what each one is looking at
 *   (`scenescout watch <project>`, engine/live.ts, ADR 7).
 *
 * This file starts the server and registers the tools. Their shared state and
 * helpers are in server-context.ts, and the tools are in tools/, one module per
 * area, registered below in the order they have always been listed.
 */
import fs from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { reapOrphanBrowsers } from "./engine/reaper.js";
import { ticketDirsFrom, ticketDirWarnings } from "./engine/tickets.js";
import { LIVE_TOKEN_FILE, liveEngines, liveTokenFileName, pidAlive, statusFileName } from "./engine/live.js";
import { engines, server, live, liveDirs, liveTokenWrites, pendingLogins, guidedPlans, setOperatorPolicy } from "./server-context.js";
import { fsPolicyReader, readLaunchPolicy } from "./engine/project-config.js";
import { registerGuideTools } from "./tools/guide.js";
import { registerLaneTools } from "./tools/lanes.js";
import { registerSessionTools, registerCloseTool } from "./tools/sessions.js";
import { registerExploreTools } from "./tools/explore.js";
import { registerStatusTools } from "./tools/status.js";
import { registerResultTools } from "./tools/results.js";

registerGuideTools();
registerLaneTools();
registerSessionTools();
registerExploreTools();
registerStatusTools();
registerResultTools();
registerCloseTool();

async function main(): Promise<void> {
  // Configuration that can only be wrong is reported now, by the person who set it, not to an agent mid-run.
  const ticketDirs = ticketDirsFrom(process.env);
  if ("error" in ticketDirs) {
    console.error(`SceneScout MCP server not started: ${ticketDirs.error}. Fix it where the server is configured and start it again.`);
    process.exit(1);
  }
  for (const warning of ticketDirWarnings(ticketDirs.dirs)) console.error(`[scenescout] ${warning}.`);
  // The operator's config is read from where the server was started (or SCENESCOUT_CONFIG), never from a folder an agent names.
  const config = readLaunchPolicy(process.env, process.cwd(), fsPolicyReader);
  if (!config.ok) {
    console.error(`SceneScout MCP server not started: ${config.error}. Fix it and start the server again.`);
    process.exit(1);
  }
  setOperatorPolicy(config.loaded);
  if (config.loaded.policy.requireGuidedPlan) guidedPlans.require();
  if (config.loaded.sources.length > 0) console.error(`[scenescout] config: ${config.loaded.sources.join(", ")}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // A client that exits by closing the pipe sends no signal. Without this the
  // process, its port, its browsers and its token file all outlived the run.
  const clientGone = (): void => {
    void shutdown().finally(() => process.exit(0));
  };
  transport.onclose = clientGone;
  // The transport reports a closed pipe on some platforms and not others, and
  // on Windows the SIGTERM a client sends next is a plain kill that runs no
  // handler. stdin ending is the one signal every platform gives.
  process.stdin.once("end", clientGone);
  process.stdin.once("close", clientGone);
  // Self-heal across restarts: browsers whose parent crashed/was killed can
  // linger and have been observed to wedge fresh launches. After connect —
  // the stdio handshake must not wait on a full process-table scan.
  setImmediate(() => reapOrphanBrowsers());
}

async function shutdown(): Promise<void> {
  // The token outlives nothing: a file left behind would name a port some other process may get next.
  await Promise.allSettled(liveTokenWrites.values());
  for (const dir of liveDirs) {
    try {
      fs.rmSync(path.join(dir, liveTokenFileName(process.pid)), { force: true });
      fs.rmSync(path.join(dir, statusFileName(process.pid)), { force: true });
      // The shared names belong to whichever engine is still running, so they
      // are only removed when this process is the last one holding them.
      if (liveEngines(dir, pidAlive).filter((e) => e.pid !== process.pid).length === 0) {
        fs.rmSync(path.join(dir, LIVE_TOKEN_FILE), { force: true });
      }
    } catch (err) {
      console.error(`[scenescout] could not remove the live view's token file in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await Promise.allSettled([live?.stop(), ...[...engines.values()].map((e) => e.close()), ...pendingLogins.all().map((p) => p.cancel())]);
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

main().catch((err) => {
  console.error("SceneScout MCP server failed:", err);
  process.exit(1);
});
