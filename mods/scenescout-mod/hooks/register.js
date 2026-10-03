/**
 * SceneScout's optional Claude Code mod. It adds only what an MCP server
 * cannot: a pane in the Claude Code CLI and the desktop Code tab that keeps
 * itself up to date (`/scenescout-pane`), and, when the user sets
 * `lane_model`, the model SceneScout lane agents start on. The scenescout
 * plugin, its skill and its server work the same without it.
 *
 * Every rule lives in ./pane.js, which has no mods API in it and is
 * table-tested. This file only wires those rules to events.
 */
import {
  COMMAND,
  PANE_ID,
  POLL_MS,
  callPlan,
  fallbackText,
  laneModelSetting,
  readResult,
  renderPane,
  serverCandidates,
  spawnModel,
  unreachable,
} from "./pane.js";

/** What the pane draws: the last poll's result. */
let view = { kind: "loading" };
/** Whether the pane is open; the timer polls only while it is. */
let isOpen = false;
/** Whether a poll is in flight, so a slow server never has two at once. */
let isPolling = false;
/** The [server, tool] pair that answered last, tried first next time. */
let lastGood = null;
/** The poll timer, so a second session.start replaces it rather than adding one. */
let timer = null;

export function register(on, options) {
  const lane = laneModelSetting(options?.lane_model);
  const servers = serverCandidates(options?.mcp_server);

  on("session.start", async ($, e, next) => {
    // session.start runs again after a reload of this mod; keep one timer.
    timer?.cancel();
    timer = $.clock.every(POLL_MS, async () => {
      if (isOpen) await poll($, servers);
    });
    if (lane.error) $.ui.log(lane.error);
    // Last, because a refused name throws and skips the rest of this hook.
    await $.command.register({ name: COMMAND, description: "Open the SceneScout run pane: sessions, findings, coverage and the live view", immediate: true });
    return next(e);
  });

  on("command.run", { command: "scenescout-pane" }, async ($) => {
    await poll($, servers);
    // Where nothing draws (the VS Code chat panel, claude -p), print the server's text instead.
    const surfaces = await $.session.surfaces();
    if (surfaces.length === 0) return { text: fallbackText(view) };
    isOpen = true;
    await $.ui.open({ id: PANE_ID, title: "SceneScout", closeOnEscape: true });
    return {};
  });

  on("ui.close", async ($, e, next) => {
    if (e.id === PANE_ID) isOpen = false;
    return next(e);
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    return renderPane($.ui.resolve(e), view);
  });

  // Registered only when the user chose a model: with lane_model empty the mod never sees a spawn.
  if (lane.model) {
    on("agent.spawn", async ($, e, next) => {
      const model = spawnModel(e, lane.model);
      return next(model ? { ...e, model } : e);
    });
  }
}

/** One poll: try each server and tool until one answers, then redraw. */
async function poll($, servers) {
  if (isPolling) return;
  isPolling = true;
  try {
    const failures = [];
    let next = null;
    // The first error the server itself reported, shown when no other pair answers.
    let reported = null;
    for (const [server, tool] of callPlan(servers, lastGood)) {
      try {
        const read = readResult(await $.mcp.call(server, tool, {}), await $.clock.now());
        // A host may refuse an app-only tool with an error result rather than a throw: try the next pair.
        if (read.kind === "error") {
          reported ??= read;
          failures.push(`${server} ${tool}: ${read.error.slice(0, 120)}`);
          continue;
        }
        lastGood = [server, tool];
        next = read;
        break;
      } catch (err) {
        failures.push(`${server} ${tool}: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
      }
    }
    view = next ?? reported ?? unreachable(failures, await $.clock.now());
  } finally {
    isPolling = false;
  }
  $.ui.invalidate("ui.render");
}
