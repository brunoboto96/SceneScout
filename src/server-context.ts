/**
 * The MCP server's shared state and helpers: the live sessions, the server object the tools register on,
 * the status board and live view, the per-session queue and watchdog, and the parameters several tools share.
 * The tools themselves are in src/tools/, one module per area; mcp-server.ts registers them and runs the server.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BrowserEngine } from "./engine/browser.js";
import { MemoryStore, redactSecrets } from "./engine/memory.js";
import { redactKeys, secretValues } from "./engine/ci.js";
import { LaneLedger } from "./engine/lane.js";
import { CallWork, SessionQueue, watchdogCap, withWatchdog } from "./engine/dispatch.js";
import {
  feedForSession,
  LIVE_ENV,
  writeLiveToken,
  writeStatusFile,
  type FindingFrames as FindingEvidence,
  type ReportFile,
  liveTokenFileName,
  LiveServer,
  StatusBoard,
  type LiveProvider,
  type SessionStatus,
} from "./engine/live.js";
import { liveViewUrl } from "./engine/status-pane.js";
import { OPEN_ENV, openInBrowser, type OpenDecision } from "./engine/open.js";
import { LOGIN_WINDOW_MAX_MS, type PendingLogin } from "./login-run.js";
import { LoginWindows } from "./engine/signed-in.js";
import { generateReport, replayDocument, reportEvidence, type ReportExtras } from "./engine/report.js";
import { watchdogFor } from "./engine/limits.js";
import { ProjectDirs, resolveFrame, splitProjectFrame } from "./engine/replay.js";
import { needsTask, taskRefusal, TASK_MAX } from "./engine/task.js";
import { SERVER_INSTRUCTIONS } from "./playbook.js";
import { type EvidenceSettings } from "./engine/capture.js";

/** Live sessions: each name owns an independent BrowserEngine (browser + auth). */
export const engines = new Map<string, BrowserEngine>();

/**
 * One MemoryStore per project, shared by every session attached to it:
 * findings and coverage from all roles merge, and concurrent engines never
 * race each other's memory.json writes (MemoryStore's own writes are
 * synchronous, so Node's single-threaded execution already serializes them).
 */
export const memories = new Map<string, MemoryStore>();

/** Convenience default: which session a tool call targets when it omits `session`. */
export let activeName = "default";

/**
 * Whether the operator CHOSE the current default (via scout_session) rather than
 * it drifting there because that session attached last. Only the drifting case
 * is worth warning about; nagging after a deliberate choice trains the reader
 * to ignore the warning, and scout_session's own description recommends exactly
 * that workflow for sequential single-role stretches.
 */
let activeNameIsExplicit = false;

export function engineFor(session: string): BrowserEngine {
  let e = engines.get(session);
  if (!e) {
    e = new BrowserEngine();
    e.sessionKey = session;
    engines.set(session, e);
  }
  return e;
}

export const PKG_VERSION = ((): string => {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const server = new McpServer({ name: "scenescout", version: PKG_VERSION }, { instructions: SERVER_INSTRUCTIONS });

/** Wide enough for text AND image results, so no handler needs a cast. */
type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

export function text(t: string, session: string): ToolResult {
  const eng = engines.get(session);
  const prefix = engines.size > 1 ? `[session ${session}${eng ? ` · ${eng.role}` : ""}]\n` : "";
  return { content: [{ type: "text", text: prefix + t }] };
}

export function errorText(err: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

/** One entry per live session: what status.json and the live view both read. */
export const board = new StatusBoard();

/** The session whose call wrote status last. The top-level fields of status.json describe it, as they always have. */
export let lastWriter: SessionStatus | null = null;

export let live: LiveServer | null = null;

export let liveAddress: { port: number; token: string } | null = null;

/** Set while the server is starting and kept afterwards, so every caller awaits the same start. */
let liveStart: Promise<void> | null = null;

/** Project directories holding this process's token file, so shutdown can take it back. */
export const liveDirs = new Set<string>();

/** Token writes in flight, so shutdown waits for them instead of racing a file that appears after the rm. */
export const liveTokenWrites = new Map<string, Promise<void>>();

let liveTokenWarned = false;

/** Why the live view could not start, when it could not: told to the agent and written to status.json. */
export let liveError: string | null = null;

/**
 * The last run's report, kept after its sessions close. The engines are gone
 * by then, so this is the only way the live view can still show what the run
 * found — which is the moment somebody most wants to read it.
 */
let lastRun: { markdown: string; at: string; dir: string; evidence: FindingEvidence[]; replay: string } | null = null;

/** Every project folder a run page or the board's report has been rendered from, so their pictures resolve against it later (#457, #463). */
const pageProjects = new ProjectDirs();

/** Render the report for a session that is about to close, so the live view keeps it. */
export function keepReport(eng: BrowserEngine): void {
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
    pageProjects.remember(eng.memory.dir);
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

/** The address a report's frames start with: keyed by project, and the folder is remembered so the key resolves (#463). */
function framePrefixFor(dir: string): string {
  return `record/${pageProjects.remember(dir)}/`;
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
    if (!eng?.memory)
      return lastRun ? { markdown: lastRun.markdown, at: lastRun.at, evidence: lastRun.evidence, framePrefix: framePrefixFor(lastRun.dir) } : null;
    const { markdown } = generateReport(eng.memory, eng.oracleLog.all, reportExtras(eng), { write: false });
    return {
      markdown: redactSecrets(markdown),
      at: new Date().toISOString(),
      evidence: reportEvidence(eng.memory),
      framePrefix: framePrefixFor(eng.memory.dir),
    };
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
      pageProjects.remember(eng.memory.dir);
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
  frame: async (address) => {
    // A run page names the project it was rendered from, so its pictures load
    // after a session attaches to another folder. The live board's own frames
    // carry no project: they belong to the session their path names, and
    // falling back keeps a finished run's frames reachable.
    const { key, rest: relPath } = splitProjectFrame(address);
    let dir: string | undefined;
    if (key) dir = pageProjects.dir(key);
    else {
      const named = relPath.replace(/^recordings[\\/]/, "").split("/")[0];
      dir = engines.get(named)?.memory?.dir ?? engines.values().next().value?.memory?.dir ?? lastRun?.dir;
    }
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
    knownRoutes: all,
    mode: eng.mode,
    trustedEmbeds: [...eng.trustedEmbeds],
    readPosts: eng.readPosts.map((e) => e.entry),
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
  // The shared name is written too, for a `watch` from before per-pid files.
  const write = writeLiveToken(dir, process.pid, liveAddress.token)
    .then(() => {
      liveDirs.add(dir);
    })
    .catch((err: unknown) => {
      // Whatever was written before the failure is taken back: nothing is left to remove at shutdown.
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
export async function ensureLive(dir: string): Promise<void> {
  if (process.env[LIVE_ENV] === "off") return;
  if (liveAddress) return publishLiveToken(dir);
  liveStart ??= startLiveServer();
  await liveStart;
  if (!liveAddress) return;
  publishLiveToken(dir);
  // The port is new, so a reader polling status.json needs it rewritten.
  void flushStatus(dir);
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
export function liveLine(): string {
  if (!liveAddress) return liveError ? `\nLive view unavailable: ${liveError}` : "";
  return (
    `\nLive view: ${liveViewUrl(liveAddress.port, liveAddress.token)} — give this address to the user so they can watch every session ` +
    `(current tool, page thumbnail, optional live stream). It opens on this machine only and cannot act on the run.`
  );
}

/** What each session's attach decided to open (engine/open.ts). scout_report reads it for the report. */
export const openDecisions = new Map<string, OpenDecision>();

/** The live view is one address for every session, so it is opened once per server. */
export let liveOpened = false;

/** Whether a result has named the setting that turns opening off; named once. */
let openSettingNamed = false;

/** Whether an attach has said why the live view was not opened; said once. */
export let openWhySaid = false;

/** Open a target in the default browser and say so in a line for the tool result; a failure is said, never thrown. */
export function openForUser(what: string, target: string): string {
  const outcome = openInBrowser(target, {
    platform: process.platform,
    spawn: (command, args, options) => spawn(command, args, options),
    onError: (why) => logLine(`could not open ${what}: ${why}`),
  });
  if (!outcome.ok) return `\nCould not open ${what}: ${outcome.why}.`;
  if (openSettingNamed) return `\nOpened ${what} in the default browser.`;
  openSettingNamed = true;
  return `\nOpened ${what} in the default browser (${OPEN_ENV}=none, or scout_attach {open: "none"}, turns this off).`;
}

function flushStatus(dir: string): Promise<void> {
  // Not awaited on a tool call's hot path: status is best-effort observability
  // and must never add blocking filesystem latency there. The writer queues
  // writes per directory and lands each by rename, so a reader never sees a
  // torn file. scout_close awaits it through settleProjectWrites.
  return writeStatusFile(
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

/** The latest ensureLive per project, so a close can wait for the token and status writes it starts. */
const liveStarts = new Map<string, Promise<void>>();

/**
 * Everything the server has started writing into a project, landed: the live
 * view's start (it writes the token file and rewrites status once its port is
 * known), the token file, then this status write, queued behind any earlier
 * one. scout_close awaits it, so once a close has answered nothing more is
 * written into the project, which may then be removed. None of these reject.
 */
export async function settleProjectWrites(dir: string): Promise<void> {
  await liveStarts.get(dir);
  liveStarts.delete(dir);
  await liveTokenWrites.get(dir);
  await flushStatus(dir);
}

/**
 * Live status for the tested project (`scenescout status <project>` or any
 * supervising layer reads this): what every session is doing right now.
 * Best-effort — observability must never break the tool call itself.
 */
export function writeStatus(session: string, phase: "running" | "idle", tool: string, budgetMs?: number): void {
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
  liveStarts.set(dir, ensureLive(dir));
  void flushStatus(dir);
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
export const sessionQueue = new SessionQueue();

/** Every call's work until it settles, so a close can wait for what a watchdog let run on (engine/dispatch.ts). */
export const callWork = new CallWork();

/** How long a close waits for that work once the browser is gone; anything page-bound has failed well before this. */
export const CLOSE_WORK_WAIT_MS = 10_000;

/**
 * Write the save that work finishing during a close's wait scheduled. The engine's own close has already flushed;
 * this catches what came after it. A failure is recorded where the close reports it, as the engine's flush does.
 */
export function flushAfterClose(eng: BrowserEngine): void {
  try {
    eng.memory?.flushPending();
  } catch (err) {
    if (eng.memory) eng.memory.lastSaveError = err instanceof Error ? err.message : String(err);
  }
}

/** What a close says when work it waited for was still running at the end of the wait. */
export function stillRunningNote(count: number): string {
  if (count === 0) return "";
  return `\n⚠ ${count} tool call${count === 1 ? " was" : "s were"} still running ${CLOSE_WORK_WAIT_MS / 1000} s after the browser closed, so ${count === 1 ? "it" : "they"} may still write into .scenescout/.`;
}

/** SCENESCOUT_WATCHDOG_MS caps every tool's watchdog. Read once, at start, and a bad value stops the server here. */
const WATCHDOG_CAP_MS = watchdogCap(process.env.SCENESCOUT_WATCHDOG_MS);

export function serializedPerSession<A>(
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
      // A session that raised its time limits gets its watchdog raised by as much (limits.ts).
      const current = engines.get(session);
      const raised = current ? watchdogFor(timeoutMs, current.timeLimits) : timeoutMs;
      const watchdogMs = Math.min(raised, WATCHDOG_CAP_MS ?? raised);
      writeStatus(session, "running", label, watchdogMs);
      try {
        const work = fn(args, session);
        callWork.track(session, work);
        const out = await withWatchdog(label, work, watchdogMs, watchdogTimeout);
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

/** What the SDK hands a tool handler beside its arguments that the server uses: the client's progress token, and a way to notify it. */
export type RequestExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
};

export const requestExtra = new AsyncLocalStorage<RequestExtra | undefined>();

function asRequestExtra(value: unknown): RequestExtra | undefined {
  return value && typeof (value as RequestExtra).sendNotification === "function" ? (value as RequestExtra) : undefined;
}

/** Control-plane tools (scout_scan/scout_session/scout_close-all) don't target one browser — their own tiny chain keeps them off session queues without racing each other. */
let controlChain: Promise<unknown> = Promise.resolve();

export function serializedControl<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>): (...args: A) => Promise<ToolResult> {
  return (...args: A) => {
    // The SDK passes the request's extra (progress token, notifications) after the arguments; it is kept for the call, as requestExtra.
    const call = (): Promise<ToolResult> => requestExtra.run(asRequestExtra(args[1]), () => fn(...args));
    const run = controlChain.then(call, call);
    // The caller gets `run` and its error; the chain only needs to know the call has finished, so a failure must not block the next control call.
    controlChain = run.catch(() => {});
    return run;
  };
}

export const sessionParam = z
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
export const taskParam = z
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
export const legacyObjectiveParam = z.string().max(TASK_MAX).optional().describe("Old name for `task` (2.0). Prefer `task`.");

// Which sessions scout_lane_brief and scout_lane_report have named as lanes, and whose report was
// folded, so scout_close can refuse to drop a lane's decisions.
export const laneLedger = new LaneLedger();

/** Keys in this process's environment, and anything shaped like one, taken out of a line before it is shown. */
export const withoutKeys = (text: string): string => redactKeys(text, secretValues(process.env));

/** A line for the operator, on stderr. */
export function logLine(line: string): void {
  console.error(withoutKeys(`[scenescout] ${line}`));
}

/** Each session's finding-picture settings from its last attach, and how many pictures its results have carried since. */
export const evidenceFor = new WeakMap<BrowserEngine, EvidenceSettings & { shown: number }>();

// Signing in from the conversation: a window the person signs in in, watched
// in the background, so a call need not last as long as the person takes and
// a second call picks up the same window. One per project and role.
export const pendingLogins = new LoginWindows<PendingLogin>(LOGIN_WINDOW_MAX_MS);

// Assignments from the tool modules: an imported binding is read-only, so each
// variable above that a tool sets has its setter here, one per variable.
export function setActiveName(name: string): void {
  activeName = name;
}
export function setActiveNameIsExplicit(explicit: boolean): void {
  activeNameIsExplicit = explicit;
}
export function setLastWriter(status: SessionStatus | null): void {
  lastWriter = status;
}
export function setLiveOpened(opened: boolean): void {
  liveOpened = opened;
}
export function setOpenWhySaid(said: boolean): void {
  openWhySaid = said;
}
