/**
 * The mod's rules, with no mods API in them, so every one is table-tested
 * (scripts/live-test.ts) without Claude Code running.
 *
 * The pane draws what the SceneScout server's `scout_status_poll` tool returns:
 * the same data the MCP App pane and the live view show. A mod plugin is
 * installed on its own, so it cannot import the engine's code; the few names
 * and the duration format it shares with the server are copied here, and the
 * test holds them equal to the engine's.
 */

/** The command that opens the pane. */
export const COMMAND = "scenescout-pane";
/** The pane's id, which the render hook checks before drawing. */
export const PANE_ID = "scenescout-run";
/** The app-only tool the MCP App pane polls. */
export const STATUS_POLL_TOOL = "scout_status_poll";
/** The model-facing tool with the same result, tried when a host does not route a call to an app-only tool. */
export const STATUS_TOOL = "scout_status";
/** How often the pane polls, as the MCP App pane does. */
export const POLL_MS = 2500;
/** The names the server goes by: registered with `scenescout install`, and started by the scenescout plugin. */
export const DEFAULT_SERVERS = ["scenescout", "plugin:scenescout:scenescout"];

/** Letters, digits, dots, colons, dashes, underscores and the `[1m]`-style suffix: an alias or a model id, and nothing else. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}(\[[A-Za-z0-9]{1,8}\])?$/;

/**
 * The lane-model setting, read once at load. Empty means the hook stays off.
 * A value that cannot be a model name is refused with a sentence saying so,
 * rather than being passed to the Agent tool to fail there.
 *
 * @param {unknown} value
 * @returns {{ model: string | null, error?: string }}
 */
export function laneModelSetting(value) {
  if (value === undefined || value === null) return { model: null };
  if (typeof value !== "string") return { model: null, error: "lane_model is not text, so lane agents keep the model Claude Code picks." };
  const model = value.trim();
  if (model === "") return { model: null };
  if (!MODEL_PATTERN.test(model)) {
    return {
      model: null,
      error: `lane_model ${JSON.stringify(model.slice(0, 40))} is not a model alias or id, so lane agents keep the model Claude Code picks.`,
    };
  }
  return { model };
}

/**
 * Whether a subagent about to start is a SceneScout lane. A lane is told to
 * attach its own session and to report with `scout_lane_report`; the planner
 * hands it the brief that says so. A fork inherits its parent's model whatever
 * is set, so it is never one.
 *
 * @param {{ prompt?: unknown, fork?: unknown }} spawn
 */
export function isLaneSpawn(spawn) {
  if (spawn.fork === true) return false;
  const prompt = typeof spawn.prompt === "string" ? spawn.prompt : "";
  return prompt.includes("scout_attach") || prompt.includes("scout_lane_report");
}

/**
 * The model to give a spawn, or null to leave it as it is.
 *
 * @param {{ prompt?: unknown, fork?: unknown, model?: unknown }} spawn
 * @param {string | null} configured
 * @returns {string | null}
 */
export function spawnModel(spawn, configured) {
  if (!configured || !isLaneSpawn(spawn)) return null;
  return spawn.model === configured ? null : configured;
}

/**
 * The servers to try, in order: the configured name first, then the defaults.
 *
 * @param {unknown} configured
 * @returns {string[]}
 */
export function serverCandidates(configured) {
  const named = typeof configured === "string" ? configured.trim() : "";
  return [...new Set([named, ...DEFAULT_SERVERS].filter(Boolean))];
}

/**
 * Every [server, tool] pair to try, the pair that answered last first, so a
 * working connection costs one call per poll.
 *
 * @param {readonly string[]} servers
 * @param {readonly [string, string] | null} lastGood
 * @returns {Array<[string, string]>}
 */
export function callPlan(servers, lastGood) {
  /** @type {Array<[string, string]>} */
  const pairs = [];
  for (const server of servers) for (const tool of [STATUS_POLL_TOOL, STATUS_TOOL]) pairs.push([server, tool]);
  if (!lastGood) return pairs;
  const rest = pairs.filter(([s, t]) => !(s === lastGood[0] && t === lastGood[1]));
  return [[lastGood[0], lastGood[1]], ...rest];
}

/** @param {unknown} v */
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The structured result, when it has the shape the server sends. */
function paneDataOf(/** @type {unknown} */ structured) {
  if (!isRecord(structured) || !Array.isArray(structured.sessions)) return null;
  return structured;
}

/**
 * The live view's address in a status text's first line, the `Live view:`
 * form the server always writes.
 *
 * @param {string} text
 */
export function liveUrlInText(text) {
  const m = /^Live view: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/m.exec(text);
  return m ? m[1] : null;
}

/**
 * What one poll gave: the server's data when it sent it structured, its text
 * always, or the error it reported.
 *
 * @param {{ content?: unknown, isError?: unknown, structuredContent?: unknown }} result
 * @param {number} nowMs
 */
export function readResult(result, nowMs) {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .filter((b) => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (result.isError === true) return { kind: "error", at: nowMs, error: text || "The SceneScout server reported an error." };
  const data = paneDataOf(result.structuredContent);
  if (data) return { kind: "data", at: nowMs, data, text };
  if (text) return { kind: "text", at: nowMs, text, liveUrl: liveUrlInText(text) };
  return { kind: "error", at: nowMs, error: "The SceneScout server answered with nothing to show." };
}

/**
 * The view when no server answered, naming each server tried and why.
 *
 * @param {readonly string[]} failures one "server: reason" line each
 * @param {number} nowMs
 */
export function unreachable(failures, nowMs) {
  const tried = failures.length ? ` Tried ${failures.join("; ")}.` : "";
  return {
    kind: "error",
    at: nowMs,
    error: `No SceneScout server answered.${tried} Install the scenescout plugin or run \`npx -y scenescout install\`, or set this mod's mcp_server to the name /mcp lists.`,
  };
}

/**
 * The pane's link target. The pane's Link takes an https address or
 * http://localhost only, and the live view answers a `localhost` Host header
 * as well as `127.0.0.1`, so the loopback address is spelled with localhost.
 *
 * @param {unknown} url
 * @returns {string | null}
 */
export function linkHref(url) {
  if (typeof url !== "string") return null;
  const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})(\/[A-Za-z0-9_-]+\/)$/.exec(url);
  if (!m) return null;
  return new URL(`http://localhost:${m[1]}${m[2]}`).href;
}

/** The engine's duration format: `12s`, `3m05s`, `1h02m`. */
export function formatDuration(/** @type {number} */ ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** @param {unknown} v */
function str(v) {
  return typeof v === "string" ? v : "";
}

/** @param {unknown} v */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * One session's line, as the server's text writes it.
 *
 * @param {Record<string, unknown>} s
 */
export function sessionLine(s) {
  const tool = str(s.tool) || "nothing yet";
  const forMs = num(s.forMs);
  const what =
    s.state === "idle" ? `idle ${formatDuration(forMs)} after ${tool}` : `${s.state === "stuck" ? "STUCK in" : "running"} ${tool} for ${formatDuration(forMs)}`;
  const role = str(s.role);
  return `${str(s.session)}${role ? ` (${role})` : ""}: ${what}`;
}

/**
 * The pane's element tree. `els` is what `$.ui.resolve(e)` returns; only Box,
 * Text and Link are used, which every app that draws a pane has. Nothing here
 * takes typed input.
 *
 * @param {{ Box: Function, Text: Function, Link: Function }} els
 * @param {{ kind: string, at?: number, data?: any, text?: string, liveUrl?: string | null, error?: string }} view
 */
export function renderPane(els, view) {
  const { Box, Text, Link } = els;
  const line = (/** @type {string} */ text, /** @type {Record<string, unknown>} */ style = {}) => Text({ ...style, wrap: "truncate-end", children: [text] });
  const dim = (/** @type {string} */ text) => line(text, { dimColor: true });
  const live = (/** @type {unknown} */ url, /** @type {string} */ note) => {
    const href = linkHref(url);
    if (href) return Box({ flexDirection: "column", children: [Link({ href, label: "Open the live view" }), dim(String(url))] });
    return dim(note || "The live view starts with the first scout_attach.");
  };
  /** @type {unknown[]} */
  const rows = [];

  if (view.kind === "loading") rows.push(dim("Asking the SceneScout server how the run stands…"));
  else if (view.kind === "error") rows.push(line(view.error ?? "", { color: "red" }));
  else if (view.kind === "text") {
    const first = str(view.text).split("\n")[0];
    rows.push(live(view.liveUrl, first.startsWith("Live view: ") ? first.slice("Live view: ".length) : "The server did not send its address."));
    for (const l of str(view.text).split("\n").slice(1)) rows.push(line(l));
  } else if (view.kind === "data") {
    const d = view.data;
    rows.push(live(d.liveUrl, str(d.liveNote)));
    const sessions = Array.isArray(d.sessions) ? d.sessions.filter(isRecord) : [];
    rows.push(line(sessions.length ? `Sessions (${sessions.length})` : "No session is attached.", { bold: true }));
    for (const s of sessions) {
      rows.push(line(sessionLine(s), s.state === "stuck" ? { color: "red" } : {}));
      if (str(s.task)) rows.push(dim(`  task: ${str(s.task)}`));
      if (str(s.objective)) rows.push(dim(`  objective: ${str(s.objective)}`));
    }
    if (isRecord(d.findings)) {
      const f = d.findings;
      rows.push(
        Box({
          flexDirection: "row",
          columnGap: 1,
          children: [
            Text({ bold: true, children: [`Open findings ${num(f.open)}:`] }),
            Text({ color: "red", children: [`${num(f.high)} high`] }),
            Text({ color: "yellow", children: [`${num(f.medium)} medium`] }),
            Text({ children: [`${num(f.low)} low`] }),
            Text({ dimColor: true, children: [`· ${num(f.thisRun)} this run`] }),
          ],
        }),
      );
      const extra = [num(f.worthALook) ? `${num(f.worthALook)} worth a look` : "", num(f.resolved) ? `${num(f.resolved)} resolved` : ""].filter(Boolean);
      if (extra.length) rows.push(dim(extra.join(" · ")));
    }
    if (isRecord(d.coverage)) {
      const c = d.coverage;
      const routes = num(c.routesTotal) > 0 ? `routes ${num(c.routesVisited)}/${num(c.routesTotal)} · ` : "";
      rows.push(line(`Coverage: ${routes}${num(c.states)} states · ${num(c.elementsExercised)}/${num(c.elementsTotal)} elements exercised`));
    }
  }
  if (typeof view.at === "number") rows.push(dim(`Updated ${new Date(view.at).toLocaleTimeString()} · every ${POLL_MS / 1000}s · Esc closes`));
  return Box({ flexDirection: "column", children: rows });
}

/**
 * What `/scenescout-pane` prints where nothing draws (the VS Code chat panel,
 * `claude -p`): the server's own text, which starts with the live view's
 * address.
 *
 * @param {{ kind: string, text?: string, error?: string }} view
 */
export function fallbackText(view) {
  if (view.kind === "error") return str(view.error);
  return str(view.text) || "The SceneScout server has not answered yet.";
}
