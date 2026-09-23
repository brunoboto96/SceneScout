#!/usr/bin/env node
/**
 * SceneScout MCP server (stdio).
 *
 * Exposes deterministic browser-exploration tools — Playwright actions, state
 * memory, oracles, findings, report — to any MCP client. No LLM calls happen
 * here: the client (e.g. Claude Code on a subscription) is the brain.
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
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BrowserEngine } from "./engine/browser.js";
import { reapOrphanBrowsers } from "./engine/reaper.js";
import { FINDING_CATEGORIES, MemoryStore, redactSecrets } from "./engine/memory.js";
import { LANE_NAME_MAX, laneReportInstruction, parseLaneReport, summarizeLaneReport } from "./engine/lane.js";
import { MAX_UNFILED_NAMED, unfiledDefects } from "./engine/calibration.js";
import { SessionQueue, withWatchdog } from "./engine/dispatch.js";
import { FIXTURE_KINDS, type FixtureKind } from "./engine/fixtures.js";
import {
  feedForSession,
  LIVE_ENV,
  writeStatusFile,
  type FindingFrames as FindingEvidence,
  type ReportFile,
  LIVE_TOKEN_FILE,
  liveEngines,
  liveTokenFileName,
  pidAlive,
  statusFileName,
  LiveServer,
  StatusBoard,
  type LiveProvider,
  type SessionStatus,
} from "./engine/live.js";
import { formatBriefs, MAX_LANES, planLanes } from "./engine/brief.js";
import { computeGaps, formatRouteCoverage, generateReport, replayDocument, reportEvidence, type ReportExtras } from "./engine/report.js";
import { describeVerdict, formatWorklist, unknownIds, VERDICTS, verifyWorklist, type Verdict } from "./engine/verify.js";
import { RECORD_MAX_FRAMES, resolveFrame } from "./engine/replay.js";
import { describePace, normalizePace } from "./engine/settle.js";
import { needsTask, taskRefusal, TASK_MAX } from "./engine/task.js";
import { EXPLORE_PROMPT_ARGUMENTS, explorePrompt, loadPlaybook, PLAYBOOK_PROMPT, PLAYBOOK_TOOL, SERVER_INSTRUCTIONS } from "./playbook.js";
import { formatScan, scanProject } from "./scan.js";

/** Live sessions: each name owns an independent BrowserEngine (browser + auth). */
const engines = new Map<string, BrowserEngine>();
/**
 * One MemoryStore per project, shared by every session attached to it:
 * findings and coverage from all roles merge, and concurrent engines never
 * race each other's memory.json writes (MemoryStore's own writes are
 * synchronous, so Node's single-threaded execution already serializes them).
 */
const memories = new Map<string, MemoryStore>();
/** Convenience default: which session a tool call targets when it omits `session`. */
let activeName = "default";
/**
 * Whether the operator CHOSE the current default (via scout_session) rather than
 * it drifting there because that session attached last. Only the drifting case
 * is worth warning about; nagging after a deliberate choice trains the reader
 * to ignore the warning, and scout_session's own description recommends exactly
 * that workflow for sequential single-role stretches.
 */
let activeNameIsExplicit = false;

function engineFor(session: string): BrowserEngine {
  let e = engines.get(session);
  if (!e) {
    e = new BrowserEngine();
    e.sessionKey = session;
    engines.set(session, e);
  }
  return e;
}

const PKG_VERSION = ((): string => {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = new McpServer({ name: "scenescout", version: PKG_VERSION }, { instructions: SERVER_INSTRUCTIONS });

/** Wide enough for text AND image results, so no handler needs a cast. */
type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

function text(t: string, session: string): ToolResult {
  const eng = engines.get(session);
  const prefix = engines.size > 1 ? `[session ${session}${eng ? ` · ${eng.role}` : ""}]\n` : "";
  return { content: [{ type: "text", text: prefix + t }] };
}

function errorText(err: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

/** One entry per live session: what status.json and the live view both read. */
const board = new StatusBoard();
/** The session whose call wrote status last. The top-level fields of status.json describe it, as they always have. */
let lastWriter: SessionStatus | null = null;
let live: LiveServer | null = null;
let liveAddress: { port: number; token: string } | null = null;
/** Set while the server is starting and kept afterwards, so every caller awaits the same start. */
let liveStart: Promise<void> | null = null;
/** Project directories holding this process's token file, so shutdown can take it back. */
const liveDirs = new Set<string>();
/** Token writes in flight, so shutdown waits for them instead of racing a file that appears after the rm. */
const liveTokenWrites = new Map<string, Promise<void>>();
let liveTokenWarned = false;
/** Why the live view could not start, when it could not: told to the agent and written to status.json. */
let liveError: string | null = null;

/**
 * The last run's report, kept after its sessions close. The engines are gone
 * by then, so this is the only way the live view can still show what the run
 * found — which is the moment somebody most wants to read it.
 */
let lastRun: { markdown: string; at: string; dir: string; evidence: FindingEvidence[]; replay: string } | null = null;

/** Render the report for a session that is about to close, so the live view keeps it. */
function keepReport(eng: BrowserEngine): void {
  if (!eng.memory) return;
  // The markdown is the record and is kept first. The frames and the one-page
  // version are extras, and building them in the same attempt meant a failure
  // in either threw the report away with them — leaving a finished run with
  // findings in it telling the viewer there was nothing to report.
  try {
    const { markdown } = generateReport(eng.memory, eng.oracleLog.all, reportExtras(eng), { write: false });
    lastRun = { markdown: redactSecrets(markdown), at: new Date().toISOString(), dir: eng.memory.dir, evidence: [], replay: "" };
  } catch (err) {
    console.error(`[scenescout] the report for ${eng.sessionKey} could not be kept: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  try {
    lastRun.evidence = reportEvidence(eng.memory);
    lastRun.replay = replayDocument(eng.memory, lastRun.markdown, PKG_VERSION);
  } catch (err) {
    console.error(
      `[scenescout] the one-page version of this run could not be built: ${err instanceof Error ? err.message : String(err)}; the report itself is unaffected`,
    );
  }
}

/** Where this run's report belongs, and whether the agent has written it there yet. */
function reportFile(dir: string | undefined): ReportFile | undefined {
  if (!dir) return undefined;
  const file = path.join(dir, "report.md");
  try {
    return { path: file, written: fs.existsSync(file) };
  } catch {
    return { path: file, written: false };
  }
}

const liveProvider: LiveProvider = {
  snapshot: () => ({
    pid: process.pid,
    version: PKG_VERSION,
    at: new Date().toISOString(),
    sessions: board.list(),
    report: reportFile(engines.values().next().value?.memory?.dir ?? lastRun?.dir),
  }),
  // The engine holds no reasoning — it never sees one — so the feed is what the
  // session DID: the action log, which is the same trail a finding's repro uses.
  activity: (session, limit) => feedForSession(engines.get(session)?.memory?.actionLog ?? [], session, limit, redactSecrets),
  // The same document scout_report writes at the end, rendered now and not
  // written: what the run has found so far, its scores and its gap ledger.
  // Findings and coverage are project-wide; the route, audit and mode figures
  // are the session's that wrote status last, so in a multi-session run they
  // can shift between polls.
  report: () => {
    const eng = (lastWriter && engines.get(lastWriter.session)) ?? engines.values().next().value;
    if (!eng?.memory) return lastRun ? { markdown: lastRun.markdown, at: lastRun.at, evidence: lastRun.evidence } : null;
    const { markdown } = generateReport(eng.memory, eng.oracleLog.all, reportExtras(eng), { write: false });
    return { markdown: redactSecrets(markdown), at: new Date().toISOString(), evidence: reportEvidence(eng.memory) };
  },
  /**
   * The whole run as one page, served at its own address. The live view sends
   * a finished run here: the address then IS the report, so refreshing works
   * and there is nothing to lose by closing a panel.
   */
  replay: () => {
    const eng = (lastWriter && engines.get(lastWriter.session)) ?? engines.values().next().value;
    if (!eng?.memory) return lastRun?.replay || null;
    try {
      const { markdown } = generateReport(eng.memory, eng.oracleLog.all, reportExtras(eng), { write: false });
      return replayDocument(eng.memory, redactSecrets(markdown), PKG_VERSION);
    } catch (err) {
      // This address is one people refresh and bookmark, so a throw here would
      // hand them a blank page. Say so, and fall back to the last rendering.
      console.error(`[scenescout] the run's page could not be rendered: ${err instanceof Error ? err.message : String(err)}`);
      return lastRun?.replay || null;
    }
  },
  /**
   * A recorded frame, read from the run's own recordings directory. The path
   * comes from a viewer, so it is resolved and then required to still be
   * inside that directory: nothing else in the project is reachable this way.
   */
  frame: async (relPath) => {
    // Sessions may hold different project directories, so the frame belongs to
    // the session its own path names — not to whichever engine happens to be
    // first. Falling back keeps a finished run's frames reachable.
    const named = relPath.replace(/^recordings[\\/]/, "").split("/")[0];
    const dir = engines.get(named)?.memory?.dir ?? engines.values().next().value?.memory?.dir ?? lastRun?.dir;
    if (!dir) return null;
    const file = resolveFrame(path.join(dir, "recordings"), relPath);
    if (!file) return null;
    try {
      return await fs.promises.readFile(file);
    } catch (err) {
      // A viewer can ask for anything, so a missing file is ordinary. A frame
      // that exists and cannot be read is not, and would otherwise present as
      // "that frame does not exist".
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[scenescout] a recorded frame could not be read (${file}): ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  },
  // Both go around the session queue on purpose: a viewer must never wait
  // behind the agent's calls, and a session that is stuck is the one most
  // worth looking at.
  screenshot: async (session) => (await engines.get(session)?.liveShot()) ?? null,
  startStream: async (session, onFrame, onEnd) => (await engines.get(session)?.startScreencast(onFrame, onEnd)) ?? null,
};

/** What the report needs to know beyond memory: the one place it is built, so the live view and scout_report cannot drift apart. */
function reportExtras(eng: BrowserEngine): ReportExtras {
  const unvisited = eng.unvisitedKnownRoutes();
  const all = eng.allKnownRoutes();
  return {
    routesVisited: all.length - unvisited.length,
    routesTotal: all.length,
    designAudits: eng.memory?.auditsThisRun ?? eng.designAuditCount,
    createdResources: eng.createdResources,
    unvisitedRoutes: unvisited,
    mode: eng.mode,
    policyAttributed: eng.oracleLog.policyAttributed,
    version: PKG_VERSION,
    attachedSessions: [...engines.keys()],
  };
}

/** Hand the live view's token to `scenescout watch` through a file only the owner can read. */
function publishLiveToken(dir: string): void {
  if (!liveAddress || liveDirs.has(dir) || liveTokenWrites.has(dir)) return;
  // Named for this process: two engines on one project would otherwise hand
  // `watch` one token for two ports, and whichever wrote last would win.
  const file = path.join(dir, liveTokenFileName(process.pid));
  const write = fs.promises
    .writeFile(file, liveAddress.token, { mode: 0o600 })
    // The shared name stays too, for a `watch` from before per-pid files.
    .then(() => fs.promises.writeFile(path.join(dir, LIVE_TOKEN_FILE), liveAddress!.token, { mode: 0o600 }))
    // `mode` applies only when the file is created; a leftover one keeps its old bits.
    .then(() => fs.promises.chmod(file, 0o600))
    .then(() => {
      liveDirs.add(dir);
    })
    .catch((err: unknown) => {
      // A file with the wrong bits, or none: either way nothing to take back later.
      void fs.promises.rm(file, { force: true }).catch(() => {});
      if (!liveTokenWarned)
        console.error(`[scenescout] could not write the live view's token file in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      liveTokenWarned = true;
    })
    .finally(() => liveTokenWrites.delete(dir));
  liveTokenWrites.set(dir, write);
}

/**
 * Started with the first attach rather than at boot: a server nobody attaches
 * to should not open a port. Never rejects — observability is best-effort, and
 * a port that will not open must not cost the run anything.
 */
async function ensureLive(dir: string): Promise<void> {
  if (process.env[LIVE_ENV] === "off") return;
  if (liveAddress) return publishLiveToken(dir);
  liveStart ??= startLiveServer();
  await liveStart;
  if (!liveAddress) return;
  publishLiveToken(dir);
  // The port is new, so a reader polling status.json needs it rewritten.
  flushStatus(dir);
}

function startLiveServer(): Promise<void> {
  const starting = new LiveServer(liveProvider);
  return starting
    .start()
    .then((address) => {
      live = starting;
      liveAddress = address;
      liveError = null;
    })
    .catch((err: unknown) => {
      // Say why, once, and let a later attach try again.
      const reason = err instanceof Error ? err.message : String(err);
      if (liveError !== reason) console.error(`[scenescout] the live view could not start: ${reason}`);
      liveError = reason;
      liveStart = null;
    });
}

/**
 * The line that hands the live view to the person running the agent. The
 * address holds the token, and a tool result lands in the client's transcript;
 * that is accepted (ADR 7) because the address answers on this machine only.
 */
function liveLine(): string {
  if (!liveAddress) return liveError ? `\nLive view unavailable: ${liveError}` : "";
  return (
    `\nLive view: http://127.0.0.1:${liveAddress.port}/${liveAddress.token}/ — give this address to the user so they can watch every session ` +
    `(current tool, page thumbnail, optional live stream). It opens on this machine only and cannot act on the run.`
  );
}

function flushStatus(dir: string): void {
  // Fire-and-forget: status is best-effort observability on every tool call's
  // hot path and must never add blocking filesystem latency. The writer
  // queues writes per directory and lands each by rename, so a reader never
  // sees a torn file.
  void writeStatusFile(
    dir,
    JSON.stringify(
      {
        pid: process.pid,
        phase: lastWriter?.phase ?? "idle",
        tool: lastWriter?.tool ?? "",
        session: lastWriter?.session ?? "",
        role: lastWriter?.role ?? "anonymous",
        sessions: [...engines.keys()],
        url: lastWriter?.url ?? "",
        at: new Date().toISOString(),
        // Everything above describes one session. This is all of them.
        detail: board.list(),
        ...(liveAddress ? { live: { port: liveAddress.port } } : liveError ? { live: { error: liveError } } : {}),
      },
      null,
      2,
    ),
  );
}

/**
 * Live status for the tested project (`scenescout status <project>` or any
 * supervising layer reads this): what every session is doing right now.
 * Best-effort — observability must never break the tool call itself.
 */
function writeStatus(session: string, phase: "running" | "idle", tool: string, budgetMs?: number): void {
  const eng = engines.get(session);
  const dir = eng?.memory?.dir;
  if (!eng || !dir) return;
  // status.json is a poll target that gets pasted into bug reports.
  const { objective, task, ...described } = eng.liveDescription;
  lastWriter = board.update(session, {
    role: eng.role,
    phase,
    tool,
    url: redactSecrets(eng.currentUrl),
    ...(budgetMs ? { budgetMs } : {}),
    ...described,
    ...(objective ? { objective: redactSecrets(objective) } : {}),
    ...(task ? { task: redactSecrets(task) } : {}),
  });
  void ensureLive(dir);
  flushStatus(dir);
}

/** The watchdog's timeout answer — a diagnosable result, not a hang. */
function watchdogTimeout(label: string, ms: number): ToolResult {
  return errorText(
    new Error(
      `${label} timed out after ${Math.round(ms / 1000)}s — the browser may be wedged (stuck navigation, dialog, or hung renderer). ` +
        `The operation may still complete in the background; if subsequent calls misbehave, scout_attach again to reset the session (orphaned browser processes are reaped automatically).`,
    ),
  );
}

/**
 * Per-SESSION serialization: a single browser's ref table/fingerprint is
 * shared mutable state, so two calls against the SAME session must never
 * interleave. Two calls against DIFFERENT sessions have no shared state
 * (each BrowserEngine is independent) and run genuinely concurrently — this is
 * what makes `scout_click({session:"admin"})` and `scout_click({session:"qa"})`
 * issued in one turn actually execute in parallel instead of queueing behind
 * each other. The queue itself lives in engine/dispatch.ts, where it is tested.
 */
const sessionQueue = new SessionQueue();

function serializedPerSession<A>(
  label: string,
  fn: (args: A, session: string) => Promise<ToolResult>,
  timeoutMs = 60_000,
): (args: A & { session?: string; task?: string; objective?: string }) => Promise<ToolResult> {
  return (args: A & { session?: string; task?: string; objective?: string }) => {
    const session = args.session ?? activeName;
    // Every acting tool passes through here, so the task is required in one
    // place rather than eight. A call that states one sets it for the batch;
    // a call that acts with none standing is told what to pass. `objective`
    // is the name this parameter had in 2.0 and still works.
    const eng = engines.get(session);
    if (eng) {
      const stated = args.task ?? args.objective;
      if (stated !== undefined) eng.setTask(stated);
      if (needsTask(label) && !eng.hasTask) return Promise.resolve(text(taskRefusal(label), session));
    }
    const exec = async (): Promise<ToolResult> => {
      writeStatus(session, "running", label, timeoutMs);
      try {
        const out = await withWatchdog(label, fn(args, session), timeoutMs, watchdogTimeout);
        // `activeName` is process-global and every scout_attach moves it. With
        // several sessions live — the multi-role runs this tool encourages —
        // an omitted `session` silently binds to whichever browser attached
        // most recently, which may belong to another agent entirely. Say so
        // rather than letting the call look deliberate.
        if (!args.session && engines.size > 1 && !activeNameIsExplicit) {
          out.content.push({
            type: "text" as const,
            text:
              `\n⚠ AMBIGUOUS SESSION — ${engines.size} sessions are live and this call named none, so it ran against '${session}' ` +
              `(whichever attached most recently). Pass session:"…" explicitly; the default is not stable while other sessions are attaching.`,
          });
        }
        return out;
      } finally {
        writeStatus(session, "idle", label);
      }
    };
    return sessionQueue.run(session, exec);
  };
}

/** Control-plane tools (scout_scan/scout_session/scout_close-all) don't target one browser — their own tiny chain keeps them off session queues without racing each other. */
let controlChain: Promise<unknown> = Promise.resolve();
function serializedControl<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>): (...args: A) => Promise<ToolResult> {
  return (...args: A) => {
    const run = controlChain.then(
      () => fn(...args),
      () => fn(...args),
    );
    controlChain = run.catch(() => {});
    return run;
  };
}

const sessionParam = z
  .string()
  .max(40)
  .optional()
  .describe(
    "Target this session directly instead of the active one — pass it explicitly when dispatching to MULTIPLE sessions in one turn (e.g. two scout_click calls with different `session`), which then run CONCURRENTLY rather than queueing. Omit for single-session sequential use.",
  );

/**
 * What the session is DOING right now. Required by the tools that act
 * (task.ts) unless one is already standing; shown to whoever is watching the
 * run, under the session's objective.
 */
const taskParam = z
  .string()
  .max(TASK_MAX)
  .optional()
  .describe(
    "What you are DOING right now, in a few words: the action, not the acceptance criteria. " +
      '"Filtering the documents register by status", "Filling the deviation form with invalid dates", "Signing in as QA_Team" — ' +
      'NOT "§2.4 filtering narrows the set and the filter is reflected in the URL", which is what you are CHECKING, not what you are doing. ' +
      'Naming the item you are on is fine ("§2.4: filtering the documents register"); keep the rest to what a colleague would see over your shoulder. ' +
      "It stays set until you pass a different one, so a batch costs a few words, not one per call. " +
      "Required on the tools that act unless a journey or an earlier call already set one.",
  );

/** The name `task` had in 2.0. Still accepted, so a caller written against that release keeps working. */
const legacyObjectiveParam = z.string().max(TASK_MAX).optional().describe("Old name for `task` (2.0). Prefer `task`.");

// The method, for every client that has no skill loader. It is read per call,
// not cached: a source checkout's skill file can change under a running server.
server.registerTool(
  PLAYBOOK_TOOL,
  {
    description:
      "Return the SceneScout testing method: setup order, write modes, how to explore, what counts as done, how to report. " +
      "Call this ONCE before the first scout_attach in a conversation, then follow it. " +
      "If this client offers a SceneScout skill, load that instead — it is the same text, so never read both. Takes no input and touches no browser.",
    // No inputSchema on purpose: with one, a call that carries no `arguments` field is rejected as invalid.
  },
  async () => {
    try {
      return { content: [{ type: "text" as const, text: loadPlaybook(PACKAGE_ROOT) }] };
    } catch (err) {
      return errorText(err);
    }
  },
);

// The same method as a prompt, for clients that list server prompts as commands.
// Registered on the protocol server directly: the SDK's prompt helper rejects a
// request that carries no `arguments` object, which is exactly what a client
// sends when the person typed none, and every argument here is optional.
server.server.registerCapabilities({ prompts: {} });
server.server.setRequestHandler(ListPromptsRequestSchema, () => ({
  prompts: [
    {
      name: PLAYBOOK_PROMPT,
      title: "Explore a web app with SceneScout",
      description: "Start an exploratory test session: loads the SceneScout method and states the target.",
      arguments: EXPLORE_PROMPT_ARGUMENTS,
    },
  ],
}));
server.server.setRequestHandler(GetPromptRequestSchema, (request) => {
  if (request.params.name !== PLAYBOOK_PROMPT) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
  let message: string;
  try {
    message = explorePrompt(loadPlaybook(PACKAGE_ROOT), request.params.arguments);
  } catch (err) {
    throw new McpError(ErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
  }
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text: message } }] };
});

// The lane report: how a parallel agent hands its results back to the planner
// as typed decisions. One tool for both halves, so the instruction a lane is
// given and the parser its reply meets are the same code.
// Splitting the app between lanes: the other half of the parallel protocol.
// scout_lane_report is how a lane hands its answers back; this is what the
// planner hands it in the first place.
server.registerTool(
  "scout_lane_brief",
  {
    description:
      "For a run split across parallel agents (lanes). Divides the app's known routes between N lanes and returns each lane's session name, the `objective` to attach it with, and the routes it owns — whole modules per lane, balanced by route count, so no two lanes audit the same area and none is left unopened. Call it after the first crawl, when route knowledge is complete. Touches no browser; pass the briefs to your lane agents, then use scout_lane_report for what they hand back.",
    inputSchema: {
      lanes: z.number().int().min(1).max(MAX_LANES).describe(`How many lanes to split across (1–${MAX_LANES})`),
      goal: z.string().max(200).optional().describe("What the whole run is for; each lane's objective is written against it"),
      routes: z.array(z.string()).max(500).optional().describe("Routes to split. Omit to split every route this project knows about."),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_lane_brief", async ({ lanes, goal, routes }: { lanes: number; goal?: string; routes?: string[] }, session) => {
    try {
      const eng = engineFor(session);
      const all = routes && routes.length > 0 ? routes : eng.allKnownRoutes();
      return text(formatBriefs(planLanes(all, lanes, { goal, mode: eng.mode, role: eng.role }), { goal, mode: eng.mode, role: eng.role }), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_lane_report",
  {
    description:
      "For a run split across parallel agents (lanes). Without `reply`: returns the paragraph to put in a lane's prompt, telling it to hand back ONE typed JSON object (verdicts, severities and categories from closed sets, a calibrated confidence per decision, routes covered, what blocked it). " +
      "With `reply`: parses what the lane handed back and returns the one-line fold (defects, highs, unsure, mean confidence, routes) or the reason it was refused, to relay to the lane once. Touches no browser.",
    inputSchema: {
      lane: z.string().min(1).max(LANE_NAME_MAX).describe("The lane's name, as used in its session"),
      reply: z.string().optional().describe("The text the lane handed back; omit to get the instruction instead"),
    },
  },
  async ({ lane, reply }: { lane: string; reply?: string }) => {
    try {
      if (reply === undefined) return { content: [{ type: "text" as const, text: laneReportInstruction(lane) }] };
      const parsed = parseLaneReport(reply, lane);
      if (!parsed.ok) {
        return {
          content: [
            { type: "text" as const, text: `Lane report REFUSED: ${parsed.reason}. Ask the lane once for the corrected object; do not re-judge its prose.` },
          ],
        };
      }
      // Keep what the lane decided, so the confidence it stated can be checked
      // against what the run goes on to file. Best-effort: a lane report is
      // still accepted if this project has no memory open yet, because the
      // planner's fold must not depend on where the report was written.
      // ONLY the lane's own session. Falling back to any engine with memory
      // open put one project's decisions into another project's store whenever
      // two sessions were attached to different apps — and the lane having
      // already closed makes that the ordinary case, not an edge one.
      const owner = engines.get(lane)?.memory;
      const at = new Date().toISOString();
      // Marks the moment the lane's browser stopped being needed, so the pace
      // section can tell a lane still reporting from one waiting to be closed.
      owner?.logAction({ action: "lane-report", url: engines.get(lane)?.currentUrl ?? "", session: lane });
      const kept = owner
        ? owner.addLaneDecisions(
            lane,
            parsed.report.decisions.map((d) => ({ ...d, lane, at })),
          )
        : 0;
      // Say when nothing was kept. Every lane closing its session before the
      // planner folds its report is the order the method describes, and it
      // leaves no memory to write to — reporting a bare "accepted" while the
      // skill promises the decisions are kept is the kind of silence that
      // makes a later calibration section look wrong rather than absent.
      const note =
        kept > 0
          ? ` (${kept} decision(s) kept for calibration)`
          : ` (nothing kept for calibration, and no check that its defects were filed — session ${JSON.stringify(lane)} is not attached here, so there is no project memory to write to or read. Fold a lane report before closing that lane's session.)`;
      // Follow-through: a defect judged and never filed never reaches the
      // report. Checked against every finding on the lane's project, so one
      // the planner or another lane filed counts. Only that project's: the
      // same reason decisions are kept only there.
      const unfiled = owner ? unfiledDefects(parsed.report.decisions, owner.findings) : [];
      const followUp =
        unfiled.length > 0
          ? `\n⚠ ${unfiled.length} judged defect(s) have no finding with matching evidence yet:\n` +
            unfiled
              .slice(0, MAX_UNFILED_NAMED)
              .map((u) => `  · ${u}`)
              .join("\n") +
            (unfiled.length > MAX_UNFILED_NAMED ? `\n  … +${unfiled.length - MAX_UNFILED_NAMED} more` : "") +
            `\nFile each with scout_finding (the same evidence), or confirm which finding already covers it, before closing the lane's session. A judged defect that is never filed is not in the report.`
          : "";
      const around = parsed.aroundIgnored ? `\n(The text around the report's JSON block was discarded unread.)` : "";
      return { content: [{ type: "text" as const, text: `Lane report accepted — ${summarizeLaneReport(parsed.report)}${note}${around}${followUp}` }] };
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "scout_scan",
  {
    description:
      "Scan a project directory to discover the frontend workspace, framework, routes, dev command, Playwright auth storage states, and testid conventions. Run this first.",
    inputSchema: { projectPath: z.string().describe("Absolute path to the project root") },
  },
  serializedControl(async ({ projectPath }: { projectPath: string }) => {
    try {
      return text(formatScan(scanProject(projectPath)), activeName);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_attach",
  {
    description:
      "Launch a browser and attach to a running web app. First attach in this conversation and you have read neither the SceneScout skill nor scout_playbook? Call scout_playbook before this. Write policy is enforced at the NETWORK layer: mode='observe' blocks EVERY request that is not a GET (login and token refresh excepted) — choose it for a target that holds real data, where even an ordinary form submission would create a record; mode='read-only' (default) blocks destructive-labeled elements AND all PUT/PATCH/DELETE + destructive POSTs, but lets ordinary form POSTs through; mode='safe-write' allows creating data and permits updates/deletes ONLY on resources this session created (use when the user wants create/edit flows tested); mode='destructive' allows everything — ONLY when the user explicitly confirmed a disposable/seeded environment. Pass a Playwright storage-state JSON to explore as an authenticated role. Pass `session` to keep MULTIPLE roles alive at once (one browser each, genuinely concurrent) for collaboration testing — target each directly with every tool's `session` param, or use scout_session to set which one is the default; coverage and findings merge into one project memory.",
    inputSchema: {
      url: z.string().describe("Base URL of the running app, e.g. http://localhost:3000"),
      projectPath: z.string().describe("Absolute path to the project (memory + report live in .scenescout/ here)"),
      storageStatePath: z.string().optional().describe("Optional Playwright storage-state JSON path for authenticated exploration"),
      mode: z
        .enum(["observe", "read-only", "safe-write", "destructive"])
        .default("read-only")
        .describe("Write policy (see tool description). Never choose 'destructive' yourself — user opt-in only."),
      headed: z.boolean().default(false).describe("Show the browser window"),
      browser: z
        .enum(["chromium", "firefox", "webkit"])
        .optional()
        .describe(
          "Browser to drive. Default: the SCENESCOUT_BROWSER environment variable, else chromium. firefox and webkit must be downloaded first (scenescout install --browser-only --browsers firefox). Use them for a cross-browser pass; stay on chromium otherwise.",
        ),
      viewportWidth: z.number().int().min(320).max(3840).optional().describe("Viewport width (default 1280); use e.g. 390 for a mobile pass"),
      viewportHeight: z.number().int().min(480).max(2400).optional().describe("Viewport height (default 900)"),
      objective: z
        .string()
        .max(300)
        .optional()
        .describe(
          'This session\'s objective: the whole remit you were given, in one sentence ("Admin lane: §2 registers, §7 plan gating", ' +
            '"Approve and reject orders as a manager"). It sits above the task, which is what the session is doing at any moment. ' +
            "Shown to whoever is watching the run; worth setting whenever more than one session is live.",
        ),
      task: z
        .string()
        .max(300)
        .optional()
        .describe(
          "What this session is doing right now, shown under its objective from the moment it appears, e.g. Signing in and taking stock. Passed alone it is read as the 2.0 spelling of `objective`. Defaults to a placeholder so a fresh card never reads as idle.",
        ),
      paceMs: z
        .number()
        .int()
        .min(0)
        .max(60000)
        .optional()
        .describe(
          "A floor between actions, in milliseconds, for when a person is watching and needs to keep up — following a flow, taking notes, demonstrating. Default 0: as fast as the page allows, which is what a run wants otherwise. Changeable mid-run with scout_session {paceMs}.",
        ),
      record: z
        .boolean()
        .default(false)
        .describe(
          "Keep a frame of the page after every action, under .scenescout/recordings/, and show it beside that step in report.html. " +
            "Off by default: a recording is pictures of the app under test sitting in the project folder. Turn it on for QA work, where the run is evidence and not only a report.",
        ),
      session: z
        .string()
        .max(40)
        .optional()
        .describe(
          "Session name for multi-role runs (e.g. 'admin', 'qa'). Creates/replaces that session's browser and makes it the default. Default: 'default'.",
        ),
    },
  },
  serializedControl(
    async ({
      url,
      projectPath,
      storageStatePath,
      mode,
      headed,
      browser,
      viewportWidth,
      viewportHeight,
      objective,
      task,
      record,
      paceMs,
      session,
    }: {
      url: string;
      projectPath: string;
      storageStatePath?: string;
      mode?: "observe" | "read-only" | "safe-write" | "destructive";
      headed?: boolean;
      browser?: "chromium" | "firefox" | "webkit";
      viewportWidth?: number;
      viewportHeight?: number;
      objective?: string;
      task?: string;
      record?: boolean;
      paceMs?: number;
      session?: string;
    }) => {
      try {
        const target = session ?? activeName;
        if (session) {
          activeName = session;
          activeNameIsExplicit = false;
        }
        const eng = engineFor(target);
        // Key by the RESOLVED, symlink-free path. Keyed by the raw string,
        // "/p" and "/p/" — or a symlink, or a case-variant on a
        // case-insensitive filesystem — built two MemoryStore instances over
        // one file inside a single process. Each held its own snapshot and
        // flushed it wholesale, so the second one to write silently erased the
        // first one's findings, with no second process involved.
        // The directory must EXIST before realpath can resolve it, and on a
        // first attach it does not — MemoryStore's constructor is what creates
        // it. Resolving before that threw, fell back to the raw string, and the
        // next attach then resolved successfully to a different key: two stores
        // over one file, which is the exact bug this keying prevents. (On macOS
        // any path under /tmp hits this, since /tmp is a symlink to /private/tmp.)
        fs.mkdirSync(path.resolve(projectPath), { recursive: true });
        let storeKey: string;
        try {
          storeKey = fs.realpathSync(path.resolve(projectPath));
        } catch {
          storeKey = path.resolve(projectPath);
        }
        let store = memories.get(storeKey);
        if (!store) {
          store = new MemoryStore(projectPath);
          memories.set(storeKey, store);
        }
        // Cross-process conflict detection: another live SceneScout attached
        // to the same project shares .scenescout memory files with this one.
        let conflictNote = "";
        try {
          const statusPath = path.join(projectPath, ".scenescout", "status.json");
          if (fs.existsSync(statusPath)) {
            const st = JSON.parse(fs.readFileSync(statusPath, "utf8")) as { pid?: number };
            if (st.pid && st.pid !== process.pid) {
              let alive = false;
              try {
                process.kill(st.pid, 0);
                alive = true;
              } catch {
                /* stale */
              }
              if (alive)
                conflictNote =
                  `\nNote: another SceneScout process (pid ${st.pid}) is also attached to this project. ` +
                  `Findings and coverage from both are merged on write, so neither loses work; ` +
                  `named sessions in ONE server (scout_attach {session: "…"}) are still preferred, since only they share safe-write ownership.`;
            }
          }
        } catch {
          /* conflict detection is best-effort */
        }
        // Moving this session to another project leaves its old one; if it was
        // the last session there, that run is over. Re-attaching to the SAME
        // project is the same run, and keeps what the run has learned.
        const previous = eng.memory;
        if (previous && previous !== store && ![...engines.values()].some((e) => e !== eng && e.memory === previous)) previous.endRun();
        const viewport = viewportWidth && viewportHeight ? { width: viewportWidth, height: viewportHeight } : undefined;
        const out = await eng.attach({
          url,
          projectDir: projectPath,
          storageStatePath,
          mode,
          headed,
          browser,
          viewport,
          // `task` is what this was called in 2.0, where it named the session's
          // whole remit. Alone it still means that. Given BESIDE an objective it
          // means what it means everywhere else — what this session is doing
          // right now — so the card says something from the moment it appears.
          objective: objective ?? task,
          paceMs,
          task: objective ? task : undefined,
          record,
          memoryStore: store,
        });
        eng.role = storageStatePath ? path.basename(storageStatePath).replace(/\.json$/i, "") : "anonymous";
        // Put the session on the board now, so the live view shows it before its
        // first tool call. liveLine() needs the port, so the server is awaited
        // here rather than started in the background by writeStatus.
        if (eng.memory?.dir) {
          await ensureLive(eng.memory.dir);
          writeStatus(target, "idle", "scout_attach");
        }
        // Recording writes pictures of the app under test into the project, so
        // a run doing it says where they go rather than leaving the person to
        // find a folder of screenshots later.
        const recordNote =
          record && eng.memory?.dir
            ? `\n\n📸 RECORDING: a frame of the page after each action, under ${path.join(eng.memory.dir, "recordings", target)}/ (at most ${RECORD_MAX_FRAMES}). scout_report writes them into report.html beside report.md.`
            : "";
        return text(out + conflictNote + recordNote + describePace(eng.pace) + (engines.size > 1 ? `\n${sessionLines()}` : "") + liveLine(), target);
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

function sessionLines(): string {
  const lines = ["Live sessions:"];
  for (const [name, eng] of engines) {
    lines.push(
      `  ${name === activeName ? "▶" : " "} ${name} — ${eng.role} · ${eng.mode}${eng.attached ? ` · ${eng.currentUrl || eng.baseUrl}` : " · (closed)"}`,
    );
  }
  return lines.join("\n");
}

server.registerTool(
  "scout_session",
  {
    description:
      "List live sessions, or set which one is the DEFAULT (used by any tool call that omits `session`). Prefer passing `session` directly on each tool call for multi-role work — that's what lets concurrent dispatch happen; scout_session is for sequential convenience (skip repeating `session` on every call) and for checking what's live. Both browsers stay live and authenticated regardless of which is default — re-snapshot a session after a break to see what changed while it was away.",
    inputSchema: {
      name: z.string().max(40).optional().describe("Session to make the default; omit to list sessions"),
      // Every other session-aware tool spells this `session`. Accepting both
      // costs nothing and removes a guaranteed first-try rejection, since all
      // schemas are additionalProperties:false and reject the near-miss hard.
      session: z.string().max(40).optional().describe("Alias for `name`."),
      paceMs: z
        .number()
        .int()
        .min(0)
        .max(60000)
        .optional()
        .describe(
          "Change how fast this session acts, mid-run: a floor between actions in milliseconds, for when a person is watching and needs to keep up. 0 restores full speed. With `name`, applies to that session; without, to every live session — which is what 'slow everything down so I can follow' means.",
        ),
    },
  },
  serializedControl(async ({ name, session, paceMs }: { name?: string; session?: string; paceMs?: number }) => {
    try {
      name = name ?? session;
      // A pace with no session named is meant for the whole run: somebody is
      // watching and wants to keep up with all of it, not one lane.
      if (paceMs !== undefined && !name) {
        const applied = [...engines.values()].map((e) => e.setPace(paceMs));
        const at = applied[0] ?? normalizePace(paceMs);
        return text(
          (at > 0
            ? `Every live session now waits at least ${at} ms between actions, so a person can follow along.`
            : `Every live session is back to full speed: as fast as its page allows.`) + `\n${sessionLines()}`,
          activeName,
        );
      }
      if (paceMs !== undefined && name) {
        if (!engines.has(name))
          return text(`No session named "${name}" yet — create it with scout_attach { session: "${name}", … }.\n${sessionLines()}`, activeName);
        const at = engines.get(name)!.setPace(paceMs);
        return text((at > 0 ? `${name} now waits at least ${at} ms between actions.` : `${name} is back to full speed.`) + `\n${sessionLines()}`, activeName);
      }
      if (!name) return text(sessionLines() + liveLine(), activeName);
      if (!engines.has(name)) {
        return text(`No session named "${name}" yet — create it with scout_attach { session: "${name}", … }.\n${sessionLines()}`, activeName);
      }
      activeName = name;
      activeNameIsExplicit = true;
      const eng = engines.get(name)!;
      return text(
        `Default session → ${name} (${eng.role}, ${eng.mode}) · ${eng.attached ? `currently at ${eng.currentUrl}` : "browser not attached"}.\nTake scout_snapshot to see where this role left off (the page may have changed while another role was working).`,
        name,
      );
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_snapshot",
  {
    description:
      "Capture the current page state: URL, state fingerprint, interactable elements with refs (e1, e2, …), geometry issues, coverage, and oracle violations since the last action. Re-snapshotting the same route returns a DIFF (refs stay stable). Cheap — prefer this over screenshots.",
    inputSchema: {
      full: z.boolean().default(false).describe("Force a full element list instead of a diff"),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_snapshot", async ({ full }: { full?: boolean }, session) => {
    try {
      return text(await engineFor(session).snapshot(full), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_crawl",
  {
    description:
      "Engine-side route sweep in ONE call: visits each path (default: all known routes not yet visited), records states into coverage memory, and returns a per-route health summary (HTTP status, element count, oracle violations, dead-ends, auth-redirects). Navigation-only — safe in read-only mode. Use this FIRST for broad coverage; explore interactively only where it flags problems or where journeys matter.",
    inputSchema: {
      paths: z.array(z.string()).max(150).optional().describe("Paths to visit, e.g. ['/orders','/settings']. Omit to crawl all unvisited known routes."),
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_crawl",
    async ({ paths }: { paths?: string[] }, session) => {
      try {
        return text(await engineFor(session).crawl(paths), session);
      } catch (err) {
        return errorText(err);
      }
    },
    600_000,
  ),
);

server.registerTool(
  "scout_run_plan",
  {
    description:
      "Execute up to 20 actions in ONE call — use for mechanical sequences (fill a form, walk a wizard) so each step doesn't cost a round-trip. Targets resolve at execution time by semantic locator: 'testid=…', 'text=…', or 'label=…' (never snapshot refs). An `upload` step attaches a file as scout_upload does (target required — the file input or the control that opens its chooser; value = a fixture kind or a project-relative path). The plan ABORTS at the first NEW oracle violation, policy refusal, or failed step, returning a transcript of how far it got; repeats of already-reported violations do not abort (they stay logged for the report).",
    inputSchema: {
      steps: z
        .array(
          z.object({
            action: z.enum(["navigate", "click", "type", "select", "press", "hover", "scroll", "upload"]),
            target: z
              .string()
              .optional()
              .describe(
                "testid=…, text=…, label=… (or a path for navigate; 'top'/'bottom'/±px for scroll; for upload: the file input or the control that opens its chooser)",
              ),
            value: z
              .string()
              .optional()
              .describe(
                "Text to type / option to select / key to press / for upload: a fixture kind (pdf, png, txt, csv, json — blank infers from accept) or a project-relative file path",
              ),
            pressEnter: z.boolean().optional().describe("For type: press Enter after filling"),
            replace: z.boolean().optional().describe("For type: clear the field first instead of appending to existing content"),
          }),
        )
        .min(1)
        .max(20),
      task: taskParam,
      objective: legacyObjectiveParam,
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_run_plan",
    async ({ steps }: { steps: Parameters<BrowserEngine["runPlan"]>[0] }, session) => {
      try {
        return text(await engineFor(session).runPlan(steps), session);
      } catch (err) {
        return errorText(err);
      }
    },
    240_000,
  ),
);

server.registerTool(
  "scout_click",
  {
    description:
      "Click an element by its ref from the latest scout_snapshot. Returns the outcome plus any oracle violations triggered. clicks=2 (or 3) probes IMPATIENT-USER behaviour: a rapid multi-click that fires the same state-changing request twice means the control is not guarded against double submission (button stays enabled, endpoint not idempotent) — use it on every important submit/create button once; the result says explicitly whether duplicates fired.",
    inputSchema: {
      ref: z.string().describe("Element ref, e.g. e12"),
      clicks: z.number().int().min(1).max(3).default(1).describe("1 = normal; 2-3 = rapid repeated clicks (double-submit probe)"),
      task: taskParam,
      objective: legacyObjectiveParam,
      session: sessionParam,
    },
  },
  serializedPerSession("scout_click", async ({ ref, clicks }: { ref: string; clicks?: number }, session) => {
    try {
      return text(await engineFor(session).click(ref, clicks ?? 1), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_type",
  {
    description:
      "Type into a text input/textarea/composer by ref, the way a real user does: if the field already holds content (e.g. an @-mention chip a menu click inserted), the text is APPENDED at the end — preserving that content — and the result reports what was already there (a separating space is added only at a word-to-word boundary). Pass replace=true to clear the field first (correcting a previous entry); an empty textValue always clears. Appending fires input events but not keydown, so keydown-driven triggers (slash/mention menus) will not react to appended text. Use for both valid values and boundary/fuzz values (empty, very long, unicode, script tags).",
    inputSchema: {
      ref: z.string().describe("Element ref, e.g. e12"),
      textValue: z.string().optional().describe("Text to type"),
      // A `type` step inside scout_run_plan spells this `value`, as does scout_select.
      // One vocabulary for "the text going in", whichever tool takes it.
      value: z.string().optional().describe("Alias for `textValue`."),
      pressEnter: z.boolean().default(false).describe("Press Enter after typing"),
      replace: z.boolean().default(false).describe("Clear the field before typing instead of appending to existing content"),
      task: taskParam,
      objective: legacyObjectiveParam,
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_type",
    async (
      { ref, textValue, value, pressEnter, replace }: { ref: string; textValue?: string; value?: string; pressEnter?: boolean; replace?: boolean },
      session,
    ) => {
      try {
        // An explicitly empty string is meaningful here (it clears the field),
        // so fall back on `undefined` rather than on falsiness — and reject a
        // call that named neither. Defaulting to "" turned a malformed call
        // into a silent field-wipe reported as success.
        if (textValue === undefined && value === undefined) {
          return text(`Pass the text to type: scout_type { ref, textValue: "…" }. Pass "" explicitly to clear the field.`, session);
        }
        const toType = textValue ?? value ?? "";
        return text(await engineFor(session).type(ref, toType, pressEnter, replace), session);
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

server.registerTool(
  "scout_upload",
  {
    description:
      "Attach a file to an upload control the way a user does. `ref` is either a visible <input type=file> (snapshots list these with role `file`) or the button/label/dropzone that opens the file chooser — the chooser is intercepted and answered, which is how the hidden input behind a styled 'Choose file' control is reached. Omit `ref` to target the page's only file input, hidden or not (snapshots disclose hidden ones on a FILE INPUTS line). Nothing needs to exist on disk: a small VALID fixture (real PDF/PNG structure) is generated in memory, its kind inferred from the input's accept attribute or chosen with `fixture`; `filePath` uploads a real file but must live inside the attached project (fenced like navigation is fenced to the origin); `name` overrides the filename for boundary tests (wrong extension vs accept, very long, unicode). The result names the input, how the file reached it, flags a file that violates accept (a mismatch the app then accepts is a validation finding), warns if the app cleared the input after selection, and says whether a state-changing request fired on selection — if none did, click the form's submit, or check the next snapshot for a client-side rejection.",
    inputSchema: {
      ref: z
        .string()
        .optional()
        .describe("Element ref of the file input OR of the control that opens the file chooser; omit when the page has exactly one file input"),
      filePath: z
        .string()
        .optional()
        .describe("A real file to upload — absolute or relative to the project; must be inside the attached project. Exclusive with fixture."),
      fixture: z
        .enum(FIXTURE_KINDS)
        .optional()
        .describe("Generated fixture kind; default: inferred from the input's accept attribute (pdf when there is none, or none we can generate)"),
      name: z.string().min(1).max(512).optional().describe("Filename override (default scenescout-fixture.<kind>, or the disk file's own name)"),
      task: taskParam,
      objective: legacyObjectiveParam,
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_upload",
    async ({ ref, filePath, fixture, name }: { ref?: string; filePath?: string; fixture?: FixtureKind; name?: string }, session) => {
      try {
        return text(await engineFor(session).upload({ ref, filePath, fixture, name }), session);
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

server.registerTool(
  "scout_hover",
  {
    description:
      "Hover an element by ref like a user pausing the pointer on it, and report what it reveals: tooltips/popovers (diffed against pre-hover state), any other new page text that appeared (labelled as possibly unrelated on busy pages), the title attribute, and aria-describedby text — each item truncated to 300 chars. Hovering does not count as exercising the element. Use on badges, icons, truncated text, and error indicators BEFORE concluding an element 'does nothing' — hover-gated UI is invisible to snapshots and clicks.",
    inputSchema: { ref: z.string().describe("Element ref, e.g. e12"), session: sessionParam },
  },
  serializedPerSession("scout_hover", async ({ ref }: { ref: string }, session) => {
    try {
      return text(await engineFor(session).hover(ref), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_select",
  {
    description: "Select an option in a <select> by ref.",
    inputSchema: {
      ref: z.string(),
      value: z.string().describe("Option value or label"),
      task: taskParam,
      objective: legacyObjectiveParam,
      session: sessionParam,
    },
  },
  serializedPerSession("scout_select", async ({ ref, value }: { ref: string; value: string }, session) => {
    try {
      return text(await engineFor(session).select(ref, value), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_navigate",
  {
    description: "Navigate to a URL or a path relative to the attached base URL (e.g. '/orders'). Also supports 'back' via scout_back.",
    inputSchema: {
      target: z.string().describe("Absolute URL or path like /settings"),
      task: taskParam,
      objective: legacyObjectiveParam,
      session: sessionParam,
    },
  },
  serializedPerSession("scout_navigate", async ({ target }: { target: string }, session) => {
    try {
      return text(await engineFor(session).navigate(target), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_request",
  {
    description:
      "Call the app's own API as this session, with the UI bypassed — the check that turns a hidden or disabled control into a proven refusal. A button that is not shown proves nothing; the same action refused by the server does. The fetch runs IN the page, so it carries the session's cookies and replays the Authorization header the app itself last sent, and it passes through the same interception the write policy is enforced on: in safe-write a mutation on a record this session did not create is refused here exactly as it would be for a click, and that refusal is the engine's safety net, not a finding. Returns the status line, the timing, the headers that decide whether two responses are truly identical (content-type, location, www-authenticate, retry-after, cache-control), and the body. Unlike a shell call, every request is recorded in the run's trail and its signature is what a finding should quote. Paths are fenced to the attached origin: use another session to reach another host.",
    inputSchema: {
      path: z.string().min(1).max(2000).describe("Path on the attached origin, e.g. /api/things/12, or a full URL on that same origin"),
      method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).optional().describe("Default GET"),
      body: z.string().max(20000).optional().describe("Request body, sent as application/json unless a content-type header is given"),
      headers: z
        .record(z.string().max(2000))
        .optional()
        .describe("Extra headers. One given here wins over the app's own, which is how a session tests a different or absent credential."),
      task: taskParam,
      objective: legacyObjectiveParam,
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_request",
    async (args: { path: string; method?: string; body?: string; headers?: Record<string, string>; session?: string }, session) => {
      try {
        return text(await engineFor(session).apiRequest({ method: args.method, path: args.path, body: args.body, headers: args.headers }), session);
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

server.registerTool(
  "scout_back",
  {
    description: "Go back in browser history (tests back-button resilience).",
    inputSchema: { task: taskParam, objective: legacyObjectiveParam, session: sessionParam },
  },
  serializedPerSession("scout_back", async (_args: { session?: string }, session) => {
    try {
      return text(await engineFor(session).goBack(), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_scroll",
  {
    description:
      "Scroll like a user — real apps hide their bugs below the fold. Reports the resulting position (px and %), and explicitly flags SCROLL LOCKED: scrollable content exists but the page will not move (the classic leaked modal scroll-lock that silently cuts users off from everything below the fold — snapshots also detect this passively as an OVERLAY line). Without `target` it scrolls the page, falling back to the largest scrollable pane on app-shell layouts. Pass `target` to scroll ONE region instead (a sidebar nav, a dialog body, a table pane): the page-level pick is the LARGEST scroll port, so a smaller region beside it never moves and its content looks truncated when it is only scrolled away — never call a nav item missing without scrolling its own container first. Use before judging a long page: the design audit measures at the current scroll position, so scroll + re-snapshot/re-audit deep sections; scroll also triggers lazy-loaded content whose failures then surface as oracle violations.",
    inputSchema: {
      to: z.enum(["top", "bottom"]).optional().describe("Jump to an edge"),
      by: z.number().int().min(-20000).max(20000).optional().describe("Scroll by px instead (positive = down). Default 600 when neither given."),
      target: z
        .string()
        .optional()
        .describe('Scroll ONE region instead of the page: "testid=…", "text=…" or "label=…". Scrolls that element\'s nearest scrollable ancestor.'),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_scroll", async ({ to, by, target }: { to?: "top" | "bottom"; by?: number; target?: string }, session) => {
    try {
      return text(await engineFor(session).scroll(to, by, target), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_press",
  {
    description: "Press a keyboard key (e.g. Escape, Tab, Enter) — useful for closing modals and testing keyboard navigation.",
    inputSchema: { key: z.string(), task: taskParam, objective: legacyObjectiveParam, session: sessionParam },
  },
  serializedPerSession("scout_press", async ({ key }: { key: string }, session) => {
    try {
      return text(await engineFor(session).press(key), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_design_audit",
  {
    description:
      "Computed-style design audit of the current page — a design connoisseur's read WITHOUT screenshots. Measurable defects (⚠): WCAG contrast, tiny targets, clipped text, aspect-distorted images, horizontal overflow, missing keyboard-focus indicators (sampled with real Tab presses). Craft suggestions (→): line measure and line-height rhythm, spacing-scale adherence, typography entropy, palette discipline (gray census, accent hue families, pure-#000 body text), elevation/control consistency, heading structure, indistinguishable links, and AI-slop tells (gradient text, glassmorphism, side-stripe borders, neon glows, violet gradients, identical card grids). Ends with a SYSTEM SUMMARY of design-system coherence. Run once per representative page; the → tier is improvement feedback — file genuine opportunities as ux-polish findings with the concrete numbers, not just defects.",
    inputSchema: { session: sessionParam },
  },
  serializedPerSession("scout_design_audit", async (_args: { session?: string }, session) => {
    try {
      return text(await engineFor(session).designAudit(), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_journey",
  {
    description:
      "Measure how EASY a real task is, not just whether it works — the question pass/fail e2e suites never answer. Wrap one user goal: scout_journey {action:'start', goal:'Create an order'}, perform it the way a first-time user would (navigate by CLICKING through the UI, not by jumping to a known deep URL — a shortcut invalidates the measurement), then scout_journey {action:'end', completed:true|false}. Returns interaction cost (clicks, navigations, distinct screens, elapsed), the actual path taken, and friction signals: BACKTRACKS (returning to a screen already left — the clearest sign the next step wasn't discoverable), screen count, and over-interaction. Run it on each module's primary journey; an abandoned journey is a high-severity finding.",
    inputSchema: {
      action: z.enum(["start", "end"]).describe("'start' before attempting the task, 'end' when done or blocked"),
      goal: z.string().optional().describe("For start: the user-facing task, e.g. 'Create an order and assign it'"),
      completed: z.boolean().default(true).describe("For end: did the user actually achieve the goal? false is a strong finding."),
      note: z.string().optional().describe("For end: what made it hard or easy, in one line"),
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_journey",
    async ({ action, goal, completed, note }: { action: "start" | "end"; goal?: string; completed?: boolean; note?: string }, session) => {
      try {
        const eng = engineFor(session);
        if (action === "start") {
          if (!goal) throw new Error("scout_journey {action:'start'} needs a goal.");
          return text(eng.startJourney(goal), session);
        }
        return text(eng.endJourney(completed ?? true, note), session);
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

server.registerTool(
  "scout_note",
  {
    description:
      "Cumulative WRITTEN knowledge about the tested app — .scenescout/ASSUMPTIONS.md, in prose a human can read and correct. memory.json stores coverage; this stores UNDERSTANDING, so every run starts smarter than the last. READ it at the start of every session ({action:'read'}). ADD durable learnings as you go ({action:'add', section, note}): what the app is for (app-model), who each role is and what they're FOR — infer the persona from what the role can see and do, e.g. 'qa-role = reviewer: approves orders, cannot administer' (roles), UI patterns the app follows (conventions), rules discovered the hard way like 'an order can only ship once approved' (constraints), fragile areas worth re-testing every run (risks), domain terms (glossary), and how to get the app testable at all — the command that regenerates an expired login state, what has to be running (setup), which the engine reads back to you the next time a storage state has expired. Notes are dated, attributed to the acting role, and deduplicated. Do NOT record session-specific facts (ids, counts) — only durable knowledge.",
    inputSchema: {
      action: z.enum(["read", "add"]).describe("'read' the accumulated knowledge, or 'add' one durable learning"),
      section: z
        .enum(["app-model", "roles", "conventions", "constraints", "risks", "glossary", "setup"])
        .optional()
        .describe("For add: which knowledge section this belongs to"),
      note: z.string().max(500).optional().describe("For add: the learning, one or two sentences, written for a future reader with no context"),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_note", async ({ action, section, note }: { action: "read" | "add"; section?: string; note?: string }, session) => {
    try {
      const eng = engineFor(session);
      if (!eng.memory) throw new Error("Not attached — knowledge lives in the project's .scenescout/.");
      if (action === "read") return text(eng.memory.readAssumptions(), session);
      if (!section || !note) throw new Error("scout_note {action:'add'} needs section and note.");
      const added = eng.memory.addAssumption(section, note, eng.role);
      return text(
        added
          ? `Noted under "${section}". ASSUMPTIONS.md grows with every run — future sessions will start knowing this.`
          : `Already known (duplicate note) — not added.`,
        session,
      );
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_screenshot",
  {
    description:
      "Take a JPEG screenshot of the current viewport. LAST RESORT: geometry issues are in scout_snapshot and style/contrast/spacing issues are in scout_design_audit — images that failed to load are listed in scout_snapshot under BROKEN IMAGES — use a screenshot only for pixel-native content (a canvas, visual gestalt) that computed data cannot capture.",
    inputSchema: { session: sessionParam },
  },
  serializedPerSession("scout_screenshot", async (_args: { session?: string }, session) => {
    try {
      const { base64, mimeType } = await engineFor(session).screenshot();
      return { content: [{ type: "image", data: base64, mimeType }] };
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_finding",
  {
    description:
      "Record a structured finding (bug, UX issue, or improvement). Deduplicates across runs; automatically captures the recent action trace as the repro. Use for anything worth reporting: crashes, oracle violations you confirmed, dead ends, confusing UX, permission leaks, missing testids — and design-audit improvement opportunities (ux-polish) with their concrete measurements.",
    inputSchema: {
      severity: z.enum(["high", "medium", "low"]),
      category: z.enum(FINDING_CATEGORIES).describe("Pick the closest — use 'other' only when nothing fits"),
      title: z.string().describe("One-line summary of the defect"),
      detail: z.string().describe("What happened, what was expected, and the evidence"),
      evidence: z
        .string()
        .optional()
        .describe(
          "Canonical machine signature for dedup, e.g. 'GET /api/reports/dashboard 403' or 'widget dashboard-summary-widget shows 0'. Same bug re-found later should produce the same string.",
        ),
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_finding",
    async (
      {
        severity,
        category,
        title,
        detail,
        evidence,
      }: {
        severity: "high" | "medium" | "low";
        category: string;
        title: string;
        detail: string;
        evidence?: string;
      },
      session,
    ) => {
      try {
        const eng = engineFor(session);
        if (!eng.memory) throw new Error("Not attached — findings need an active session.");
        const [finding, isNew] = eng.memory.addFinding({
          severity,
          category: category as Parameters<typeof eng.memory.addFinding>[0]["category"],
          title,
          detail,
          evidence,
          url: eng.currentUrl,
          state: eng.currentState || "(unknown)",
          session: eng.sessionKey,
        });
        return text(
          isNew
            ? `Finding recorded: [${finding.severity}] ${finding.title} (id ${finding.id})`
            : finding.regressedAt
              ? `⟳ REOPENED as a REGRESSION: finding ${finding.id} was previously resolved but the evidence reproduces again (seen in ${finding.runs} runs). Worth calling out to the user.`
              : `Not recorded as new: merged into existing finding ${finding.id} — [${finding.severity}] ${finding.title}${finding.evidence ? ` (evidence: ${finding.evidence.slice(0, 160)})` : " (no evidence)"}, seen in ${finding.runs} runs. If yours is a different bug, file it again with evidence naming the request that failed for you (method and path): two findings are kept apart when both name requests and none is shared.`,
          session,
        );
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

server.registerTool(
  "scout_coverage",
  {
    description:
      "Show exploration coverage: states visited across all runs and which elements remain unexercised. Use to decide where to explore next and when the level's budget is satisfied.",
    inputSchema: { session: sessionParam },
  },
  serializedPerSession("scout_coverage", async (_args: { session?: string }, session) => {
    try {
      const eng = engineFor(session);
      if (!eng.memory) throw new Error("Not attached.");
      const cov = eng.memory.coverage();
      const unvisited = eng.unvisitedKnownRoutes();
      const lines = [
        ...(eng.memory.lastSaveError
          ? [
              `⚠ MEMORY WRITE FAILING: ${eng.memory.lastSaveError} — coverage/findings since the last successful write are NOT persisted to disk. If this doesn't clear on its own, check the project directory still exists and is writable.`,
            ]
          : []),
        `States known: ${cov.states} · Elements exercised: ${cov.elementsExercised}/${cov.elementsTotal}`,
        formatRouteCoverage(eng.allKnownRoutes(), unvisited),
        `Unexercised elements by route:`,
        ...cov.unexercised.slice(0, 25).map((u) => `  ${u.state}: ${u.keys.slice(0, 6).join(", ")}${u.keys.length > 6 ? ` … +${u.keys.length - 6}` : ""}`),
      ];
      return text(lines.join("\n"), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_report",
  {
    description:
      "Generate the final markdown report — findings, page quality scores (worst first), role capability matrix, oracle rollup, and the GAP LEDGER (an explicit list of what was NOT tested). Writes the full document to .scenescout/report.md and returns a bounded SUMMARY (full reports exceed client token limits). Gates by level: 'minimal' needs all routes visited + ≥1 design audit; 'medium' additionally needs several routes audited; 'extensive' REFUSES while the gap ledger is non-empty — that refusal is the completeness guarantee: an extensive report only generates when nothing known is left untested. force=true overrides (only when the user capped the budget).",
    inputSchema: {
      force: z.boolean().default(false).describe("Generate even though gates are unmet (only when the user capped the budget)"),
      level: z
        .enum(["minimal", "medium", "extensive"])
        .default("medium")
        .describe("Which completion contract to enforce — match the level the run was asked for"),
      history: z
        .enum(["index", "full"])
        .default("index")
        .describe(
          "How much of the history to print. 'index' lists findings from earlier runs, and resolved ones, as a row each: id, severity, age, title. 'full' prints every one in full as before — on one project that was 1.75 MB against 113 KB, nearly half of it findings already fixed. Use 'full' when handing the document to someone who has no access to the memory.",
        ),
      session: sessionParam,
    },
  },
  serializedPerSession(
    "scout_report",
    async ({ force, level, history }: { force?: boolean; level?: "minimal" | "medium" | "extensive"; history?: "index" | "full" }, session) => {
      try {
        const eng = engineFor(session);
        if (!eng.memory) throw new Error("Not attached.");
        const unvisited = eng.unvisitedKnownRoutes();
        const gates: string[] = [];
        if (unvisited.length > 0) {
          gates.push(
            `${unvisited.length} known route(s) never visited:\n` +
              unvisited
                .slice(0, 30)
                .map((r) => `  ${r}`)
                .join("\n") +
              (unvisited.length > 30 ? `\n  … +${unvisited.length - 30} more` : "") +
              `\n→ Run scout_crawl (no args) to cover them in one call.`,
          );
        }
        // Counted across every session on this project, not just the one
        // asking: in a parallel run the lanes audit and the planner reports.
        const auditsThisRun = eng.memory.auditsThisRun;
        if (auditsThisRun === 0) {
          gates.push(
            `No scout_design_audit was run in this run, by any session — run it on at least one representative page (visual/a11y coverage is part of every level).`,
          );
        }
        const lvl = level ?? "medium";
        const auditedRoutes = Object.values(eng.memory.routeFacts).filter((f) => f.audited).length;
        const visitedCount = new Set(Object.values(eng.memory.states).map((st) => st.route)).size;
        if (lvl !== "minimal") {
          const needed = Math.min(3, Math.max(1, Math.ceil(visitedCount / 10)));
          if (auditedRoutes < needed) {
            gates.push(
              `Level '${lvl}' needs design audits on ≥${needed} distinct routes (have ${auditedRoutes}) — audit the representative pages (dashboard, a form, a detail view, a table).`,
            );
          }
        }
        const all = eng.allKnownRoutes();
        const gapList = computeGaps(eng.memory, {
          routesVisited: all.length - unvisited.length,
          routesTotal: all.length,
          designAudits: auditsThisRun,
          unvisitedRoutes: unvisited,
          mode: eng.mode,
        });
        if (lvl === "extensive" && gapList.length > 0) {
          gates.push(
            `Level 'extensive' claims completeness, so it refuses while the GAP LEDGER is non-empty:\n` +
              (eng.mode === "observe"
                ? `(observe mode blocks every form submission, so the unsubmitted-forms gap cannot be closed in this mode: report at level 'medium', which discloses it.)\n`
                : "") +
              gapList.map((g) => `  ⚠ ${g}`).join("\n") +
              `\nClose the gaps (or report at level 'medium', which discloses them instead).`,
          );
        }
        if (gates.length > 0 && !force) {
          return text(
            `NOT GENERATED — the '${lvl}' completion contract is unmet:\n\n${gates.join("\n\n")}\n\n` +
              `Then call scout_report again. Pass force=true ONLY if the user explicitly capped the budget.`,
            session,
          );
        }
        const { path: p, summary } = generateReport(eng.memory, eng.oracleLog.all, {
          history,
          routesVisited: all.length - unvisited.length,
          routesTotal: all.length,
          designAudits: auditsThisRun,
          createdResources: eng.createdResources,
          unvisitedRoutes: unvisited,
          mode: eng.mode,
          policyAttributed: eng.oracleLog.policyAttributed,
          // Which sessions are still open decides whether a quiet one is holding a browser, and how long its trailing idle runs.
          attachedSessions: [...engines.keys()],
        });
        void p;
        return text(summary, session);
      } catch (err) {
        return errorText(err);
      }
    },
  ),
);

server.registerTool(
  "scout_resolve",
  {
    description:
      "Mark a finding as resolved (by its id, shown when recorded and in the report). Resolved findings move to the report's green ✅ Resolved section, and reopen automatically as flagged REGRESSIONS if re-found later. Use when the user says a bug is fixed, or when re-testing shows the evidence no longer reproduces.",
    inputSchema: {
      findingId: z.string().optional().describe("Finding id, e.g. a1b2c3d4e5"),
      // scout_finding prints "(id a1b2c3d4e5)" and the report renders "**Id:**",
      // so `id` is the name a caller reaches for first — and every schema here
      // is additionalProperties:false, so the near-miss was a hard rejection.
      id: z.string().optional().describe("Alias for `findingId`."),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_resolve", async ({ findingId, id }: { findingId?: string; id?: string }, session) => {
    try {
      const eng = engineFor(session);
      if (!eng.memory) throw new Error("Not attached.");
      const wanted = findingId ?? id;
      if (!wanted) return text(`Pass the finding id: scout_resolve { id: "a1b2c3d4e5" }.`, session);
      const f = eng.memory.resolveFinding(wanted);
      return text(f ? `Resolved: [${f.severity}] ${f.title}` : `No finding with id ${wanted}.`, session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_verify",
  {
    description:
      'Re-test findings earlier runs left open. With no arguments, returns the open findings in the order to re-test them — worst route first, grouped so a route is walked once — each with its evidence and repro steps. Pass ids to narrow it to specific findings. After re-testing one, call again with id and verdict to record what you saw: "gone" resolves it, "present" stamps it confirmed so the report stops calling it unverified, "changed" keeps it open and says the behaviour differs. Use after a fix wave, or at the start of a run against an app this project has tested before.',
    inputSchema: {
      id: z.string().optional().describe("The finding being verified. Omit to get the worklist."),
      verdict: z.enum(VERDICTS).optional().describe('What the re-test found: "gone", "present" or "changed". Requires id.'),
      note: z.string().max(500).optional().describe("What you saw, in a sentence. Shown in the report beside the verdict."),
      ids: z.array(z.string()).max(50).optional().describe("Narrow the worklist to these finding ids."),
      session: sessionParam,
    },
  },
  serializedPerSession("scout_verify", async ({ id, verdict, note, ids }: { id?: string; verdict?: Verdict; note?: string; ids?: string[] }, session) => {
    try {
      const eng = engineFor(session);
      if (!eng.memory) throw new Error("Not attached.");
      if (verdict && !id) return text(`Pass the finding the verdict is about: scout_verify { id: "a1b2c3d4e5", verdict: "${verdict}" }.`, session);
      if (id && !verdict) {
        return text(`Pass what the re-test found: scout_verify { id: "${id}", verdict: "gone" | "present" | "changed" }.`, session);
      }
      if (id && verdict) {
        const f = eng.memory.verifyFinding(id, verdict, note);
        if (!f) return text(`No finding with id ${id}.`, session);
        return text(describeVerdict(f, verdict, note), session);
      }
      const findings = eng.memory.findings;
      const missing = ids && ids.length > 0 ? unknownIds(findings, ids) : [];
      return text(formatWorklist(verifyWorklist(findings, ids), missing), session);
    } catch (err) {
      return errorText(err);
    }
  }),
);

server.registerTool(
  "scout_close",
  {
    description:
      "Close a session's browser (memory persists on disk). Default: the DEFAULT session. Pass session to close a specific one, or all=true to close every live session at the end of a multi-role run.",
    inputSchema: {
      session: z.string().max(40).optional().describe("Session to close (default: the default session)"),
      all: z.boolean().default(false).describe("Close every live session"),
    },
  },
  serializedControl(async ({ session, all }: { session?: string; all?: boolean }) => {
    try {
      if (all) {
        const names = [...engines.keys()];
        // Closes are independent per-browser — run them in parallel so N wedged
        // sessions cost one 8s teardown cap total, not N of them.
        const dirs = new Set<string>();
        for (const e of engines.values()) if (e.memory?.dir) dirs.add(e.memory.dir);
        for (const e of engines.values()) keepReport(e);
        for (const name of engines.keys()) live?.dropSession(name);
        const stores = new Set([...engines.values()].map((e) => e.memory).filter((m) => m !== null && m !== undefined));
        await Promise.allSettled([...engines.values()].map((e) => e.close()));
        engines.clear();
        for (const store of stores) store.endRun();
        sessionQueue.clear();
        board.clear();
        lastWriter = null;
        for (const dir of dirs) flushStatus(dir);
        return text(`All sessions closed (${names.join(", ") || "none were live"}). Memory and reports remain in .scenescout/.`, activeName);
      }
      const name = session ?? activeName;
      const eng = engines.get(name);
      if (!eng) return text(`No live session "${name}".`, name);
      keepReport(eng);
      live?.dropSession(name);
      await eng.close();
      const saveError = eng.memory?.lastSaveError;
      engines.delete(name);
      // The last session on this project ends its run.
      if (eng.memory && ![...engines.values()].some((e) => e.memory === eng.memory)) eng.memory.endRun();
      sessionQueue.forget(name);
      board.remove(name);
      if (lastWriter?.session === name) lastWriter = null;
      if (eng.memory?.dir) flushStatus(eng.memory.dir);
      if (activeName === name) activeName = engines.keys().next().value ?? "default";
      return text(
        `Session "${name}" closed. Memory and report remain in .scenescout/.` +
          (engines.size > 0 ? ` Default session → ${activeName}.` : "") +
          (saveError ? `\n⚠ The final memory write failed (${saveError}) — some coverage/findings from this session may not have been persisted to disk.` : ""),
        activeName,
      );
    } catch (err) {
      return errorText(err);
    }
  }),
);

async function main(): Promise<void> {
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
  await Promise.allSettled([live?.stop(), ...[...engines.values()].map((e) => e.close())]);
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
