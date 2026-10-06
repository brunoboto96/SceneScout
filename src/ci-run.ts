/**
 * Runs `scenescout ci`: starts the SceneScout MCP server as a child process,
 * attaches it to the app, lets a model drive the scout_* tools until it is
 * done or a cap ends the run (with --lanes, several conversations with the
 * model at once, one per part of the app, each in its own session), then has
 * the report written and writes the CI files. The rules (options, caps, redaction, which tools, the files) are in
 * engine/ci.ts and the message shapes in engine/provider.ts; this file only
 * moves bytes between the model, the server and the disk.
 *
 * The server runs in its own process, over the same stdio protocol every
 * coding agent uses, rather than in this one: the model then gets exactly the
 * tools, schemas, watchdog and write policy an agent gets, and the server,
 * which holds module-wide state, needs no second way to start. Its
 * environment has no API key in it (childEnv).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  DEDUP_JUDGE_CAPABILITY,
  durationText,
  JUDGE_CALL_MS,
  JUDGE_MAX_OUTPUT_TOKENS,
  JUDGE_SYSTEM,
  JUDGE_TOOL,
  judgeKickoffOf,
  samplingResultOf,
  type Ask,
} from "./engine/dedup.js";
import { CAPTURE_MARGIN, parseCaptureResult, rebaseUrl, SHOT_FILES, SHOTS_DIRNAME, type CaptureInfo, type CaptureOutcome } from "./engine/capture.js";
import {
  addUsage,
  attachFailure,
  budgetSpend,
  wallLeftMs,
  guardToolArgs,
  CAPTURE_TOOLS,
  childEnv,
  ciCaptureKickoff,
  ciCaptureSystemPrompt,
  CI_DIRNAME,
  ciExitCode,
  ciKickoff,
  ciSarif,
  ciSummaryJson,
  ciSummaryMarkdown,
  ciSystemPrompt,
  ciToolArgs,
  ciTools,
  describeStop,
  findingsThisRun,
  newBudget,
  NO_USAGE,
  readFindings,
  redactKeys,
  settleTurn,
  takeTurn,
  toolResultText,
  usageLine,
  type Budget,
  type CiLanes,
  type CiOptions,
  type CiResult,
  type CiSchedule,
  type LaneResult,
  type JudgeCalls,
  type ResolvedProvider,
  type Spend,
  type StopReason,
  type ToolSpec,
} from "./engine/ci.js";
import {
  ciLaneKickoff,
  ciLaneSystemPrompt,
  crawlFoundNothing,
  crawlNotes,
  LANE_TOOLS,
  mergeLaneStops,
  PLAN_CRAWL_ROUNDS,
  planCiLanes,
  plannedRoutes,
  PLANNER_SESSION,
  type CiLane,
  type LanePlan,
} from "./engine/ci-lanes.js";
import { resolveTimeLimits } from "./engine/limits.js";
import { MEMORY_DIRNAME, readSchedulesOnDisk, recordScheduleOnDisk, writeSelfIgnore, type Finding } from "./engine/memory.js";
import { earlierChoices, scheduleOrder, seedLine, startsOf, type ScheduleInput } from "./engine/schedule.js";
import { sarifFilesFor } from "./engine/sarif.js";
import { decodePng, diffImages, encodePng } from "./engine/png.js";
import {
  AnthropicConversation,
  backoffMs,
  errorMessage,
  MalformedReply,
  OpenAIConversation,
  retryable,
  retryAfterMs,
  type Conversation,
  type ConversationOptions,
  type ModelTurn,
  type ToolOutcome,
} from "./engine/provider.js";
import { loadPlaybook } from "./playbook.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** From dist/ or, under tsx, from src/: the package root is one up either way. */
const packageRoot = path.resolve(here, "..");
const serverPath = path.join(packageRoot, "dist", "mcp-server.js");

/** The longest one attempt at a model call may take. An attempt that runs longer, with wall time left, is retried like a server error. */
export const MODEL_CALL_MS = 180_000;
/** Retries of one model call after its first attempt. */
export const MAX_RETRIES = 3;
/**
 * The whole of what happens after the exploration ends: writing the report
 * (a second, forced attempt when the level's contract is unmet) and closing
 * the browser share this one budget, so a run ends at most this long after
 * its time cap, plus the few seconds the files take.
 */
export const FINISH_MS = 180_000;
/** Attaching before the exploration, which counts towards the time cap. */
const ATTACH_MS = 120_000;
/** Tool calls run from one model reply; any beyond are answered as not run. Bounds what one turn can spend. Set here only. */
export const MAX_TOOL_CALLS_PER_TURN = 16;

/** What the loop needs from a model: its next turn, and somewhere to put tool results. */
export interface ModelClient {
  /** `wallLeftMs`: the time left before the run's time cap. */
  next(wallLeftMs: number): Promise<ModelTurn>;
  addResults(results: readonly ToolOutcome[]): void;
}

/** A model call failed for good: after its retries, or on a status no retry can change (a refused key, a bad request, a redirect). */
export class ProviderError extends Error {}
/** The time cap arrived during a model call, its retries or the wait between them. */
export class OutOfTime extends Error {}

type Fetch = typeof fetch;

const attempts = (n: number): string => `${n} attempt${n === 1 ? "" : "s"}`;

/** Whether a thrown fetch error is a refused redirect (undici reports it as a TypeError whose cause says so). */
function isRedirectError(err: unknown): boolean {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  return [err, cause].some((e) => e instanceof Error && /redirect/i.test(e.message));
}

/** The real client: one conversation, one key, bounded retries with backoff and jitter. */
export class HttpModelClient implements ModelClient {
  constructor(
    private readonly conversation: Conversation,
    private readonly key: string,
    private readonly deps: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => number; attemptMs?: number } = {},
  ) {}

  async next(wallLeftMs: number): Promise<ModelTurn> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const attemptMs = this.deps.attemptMs ?? MODEL_CALL_MS;
    const wallDeadline = now() + wallLeftMs;
    let last = "";
    let made = 0;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const left = wallDeadline - now();
      if (left <= 0) throw new OutOfTime(`the time cap was reached${made > 0 ? ` after ${attempts(made)} (${last})` : ""}`);
      const req = this.conversation.request(this.key);
      let status = 0;
      let body = "";
      let retryAfter: number | undefined;
      made += 1;
      try {
        const res = await (this.deps.fetch ?? fetch)(req.url, {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify(req.body),
          // Never followed: a redirect would carry the request, and a key sent
          // as x-api-key (which fetch does not strip across origins) with it.
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(attemptMs, left)),
        });
        status = res.status;
        body = await res.text();
        retryAfter = retryAfterMs(res.headers.get("retry-after"), now());
      } catch (err) {
        if (isRedirectError(err)) throw new ProviderError("the API answered with a redirect, which is not followed");
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (timedOut && wallDeadline - now() <= 0) throw new OutOfTime(`the time cap was reached during a model call (${attempts(made)})`);
        last = timedOut
          ? `the model call took longer than ${Math.round(attemptMs / 1000)}s`
          : `the request failed (${err instanceof Error ? err.message : String(err)})`;
      }
      if (status >= 300 && status < 400) throw new ProviderError(`HTTP ${status}: the API answered with a redirect, which is not followed`);
      if (status >= 200 && status < 300) {
        try {
          return this.conversation.accept(JSON.parse(body));
        } catch (err) {
          // A reply that is not what the API promises is retried like a server error, never run.
          last = err instanceof MalformedReply ? `a malformed reply: ${err.message}` : "a reply that is not JSON";
        }
      } else if (status !== 0) {
        last = errorMessage(status, body);
        if (!retryable(status)) throw new ProviderError(last);
      }
      if (attempt < MAX_RETRIES) {
        const wait = backoffMs(attempt + 1, this.deps.random ?? Math.random, { retryAfterMs: retryAfter });
        // Waiting past the time cap would only end the run there: end it now, as a cap and not a failure.
        if (now() + wait >= wallDeadline) throw new OutOfTime(`the time cap was reached after ${attempts(made)} (${last})`);
        await sleep(wait);
      }
    }
    throw new ProviderError(`${last} (after ${attempts(made)})`);
  }

  addResults(results: readonly ToolOutcome[]): void {
    this.conversation.addResults(results);
  }
}

/** One conversation with the provider `resolved` names. */
function conversationFor(resolved: ResolvedProvider, o: ConversationOptions, kickoff: string): Conversation {
  return resolved.provider === "anthropic" ? new AnthropicConversation(o, kickoff) : new OpenAIConversation(o, kickoff);
}

export function httpClient(resolved: ResolvedProvider, key: string, system: string, tools: readonly ToolSpec[], kickoff: string): ModelClient {
  const o = { baseUrl: resolved.baseUrl, model: resolved.model, effort: resolved.effort, system, tools };
  return new HttpModelClient(conversationFor(resolved, o, kickoff), key);
}

/**
 * The dedup judge's model call over HTTP: one short conversation per pair, at
 * `resolved`'s effort, with its output capped and every attempt and retry
 * inside `callMs`. Used by `scenescout ci` (the run's provider and model at
 * the judge's effort) and by the MCP server when a key is in its environment.
 */
export function httpJudgeAsk(
  resolved: ResolvedProvider,
  key: string,
  deps: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; callMs?: number } = {},
): Ask {
  return async (system, tools, kickoff, limitMs) => {
    const ms = Math.min(deps.callMs ?? JUDGE_CALL_MS, limitMs ?? Infinity);
    const o = { baseUrl: resolved.baseUrl, model: resolved.model, effort: resolved.effort, system, tools, maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS };
    try {
      return await new HttpModelClient(conversationFor(resolved, o, kickoff), key, { fetch: deps.fetch, sleep: deps.sleep, attemptMs: ms }).next(ms);
    } catch (err) {
      // The "time cap" here is the judge call's own limit, not the run's: say which.
      if (err instanceof OutOfTime) throw new Error(err.message.replace(/^the time cap was reached/, `no answer within ${durationText(ms)}`));
      throw err;
    }
  };
}

/**
 * The client's answer to the server's dedup judge (a sampling request): the
 * question goes to the run's model through `ask`, under this side's own
 * JUDGE_SYSTEM and JUDGE_TOOL, and the answer goes back as the tool call. Its
 * tokens are added to the run's usage, so the caps count them, and no call
 * runs past the time cap: one asked after it is refused, and one asked before
 * it gets only the time left. A request that is not the judge's question is
 * refused; a failed call is reported to the server, whose judge then leaves
 * the rule's decision and logs it.
 */
export function judgeHandler(o: {
  ask: Ask;
  model: string;
  spend: Spend;
  caps: CiOptions["caps"];
  calls: JudgeCalls;
  secrets?: readonly string[];
  now?: () => number;
}) {
  const now = o.now ?? Date.now;
  return async (request: { params: unknown }) => {
    o.calls.calls += 1;
    const question = judgeKickoffOf(request.params);
    if (!question.ok) {
      o.calls.failed += 1;
      throw new McpError(ErrorCode.InvalidRequest, `this client answers only the dedup judge's question: ${question.error}`);
    }
    const left = wallLeftMs(o.spend, o.caps, now());
    if (left <= 0) {
      o.calls.failed += 1;
      throw new McpError(ErrorCode.InternalError, "the run's time cap was reached, so the judge was not asked");
    }
    const started = now();
    try {
      const turn = await o.ask(JUDGE_SYSTEM, [JUDGE_TOOL], question.kickoff, Math.min(JUDGE_CALL_MS, left));
      o.spend.usage = addUsage(o.spend.usage, turn.usage);
      o.calls.usage = addUsage(o.calls.usage, turn.usage);
      return samplingResultOf(turn, o.model);
    } catch (err) {
      o.calls.failed += 1;
      throw new McpError(ErrorCode.InternalError, redactKeys(err instanceof Error ? err.message : String(err), o.secrets ?? []));
    } finally {
      o.calls.ms += now() - started;
    }
  };
}

/**
 * The run's MCP client. With a judge handler it declares sampling with tools
 * and DEDUP_JUDGE_CAPABILITY, and answers the server's dedup judge with it;
 * without one it declares nothing, and the server dedups by the rule.
 */
export function ciClient(judge?: ReturnType<typeof judgeHandler>): Client {
  const client = new Client(
    { name: "scenescout-ci", version: "1" },
    judge ? { capabilities: { sampling: { tools: {} }, experimental: { [DEDUP_JUDGE_CAPABILITY]: {} } } } : undefined,
  );
  if (judge) client.setRequestHandler(CreateMessageRequestSchema, judge);
  return client;
}

/** The MCP server, from the model's side: call a tool by name and get its text back. */
export interface ToolHost {
  tools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** A connected client as the loop's tool host. */
export function toolHost(client: Client): ToolHost {
  return {
    tools: async () => (await client.listTools()).tools,
    call: async (name, args, timeoutMs) => {
      const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      return { text: toolResultText(r.content), isError: r.isError === true };
    },
    close: async () => {
      await client.close();
    },
  };
}

async function startServer(log: (line: string) => void, judge?: ReturnType<typeof judgeHandler>): Promise<ToolHost> {
  if (!fs.existsSync(serverPath)) throw new Error(`${serverPath} is missing: run \`npm run build\` first`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: childEnv(process.env), stderr: "pipe" });
  transport.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) log(`  [server] ${line}`);
  });
  const client = ciClient(judge);
  await client.connect(transport);
  return toolHost(client);
}

function readMemoryFindings(projectDir: string): Finding[] {
  try {
    return readFindings(JSON.parse(fs.readFileSync(path.join(projectDir, MEMORY_DIRNAME, "memory.json"), "utf8")));
  } catch {
    // No memory yet (a first run), or one that does not parse: nothing earlier to tell this run's findings from.
    return [];
  }
}

export interface LoopOutcome {
  stop: StopReason;
  stopDetail?: string;
  spend: Spend;
  /** What the model said when it ended the run, if it did. */
  finalText?: string;
}

/**
 * The agent loop. Before each model call a turn is taken from the budget, or
 * the cap that refuses it ends the loop; the call runs with at most the time
 * that is left; each tool call it asks for is run in order, on the loop's one
 * session, and none runs past the time cap: a call reached after it is
 * answered as not run, as is any beyond MAX_TOOL_CALLS_PER_TURN. A call the
 * loop cannot run (a tool it was not given, arguments that are not JSON, a
 * scan of another directory) goes back to the model as an error result, so a
 * malformed reply costs a turn, never the run.
 */
export async function agentLoop(o: {
  client: ModelClient;
  host: Pick<ToolHost, "call">;
  tools: readonly ToolSpec[];
  caps: CiOptions["caps"];
  log: (line: string) => void;
  now?: () => number;
  startedAt?: number;
  /** The run's project directory: the only one scout_scan may read. */
  projectDir: string;
  /** Told of every tool call that ran, with the arguments it ran with. */
  onResult?: (name: string, args: Record<string, unknown>, result: { text: string; isError: boolean }) => void;
  /**
   * Where the loop's turns come from: the run's budget, which every lane of a
   * run split into lanes shares. Absent, the loop has one of its own, from
   * `caps` and `startedAt`.
   */
  budget?: Budget;
  /** A lane's session: every call to a tool that takes `session` is sent to it. Absent, calls go to the default session. */
  session?: { name: string; tools: ReadonlySet<string> };
}): Promise<LoopOutcome> {
  const now = o.now ?? Date.now;
  const budget = o.budget ?? newBudget(o.caps, o.startedAt ?? now());
  // This loop's own turns and tokens; the budget holds every loop's.
  const spend: Spend = { turns: 0, usage: { ...NO_USAGE }, startedAt: budget.startedAt };
  const timeLeft = (): number => wallLeftMs(spend, budget.caps, now());
  const allowed = new Set(o.tools.map((t) => t.name));
  for (;;) {
    const cap = takeTurn(budget, now());
    if (cap) return { stop: cap, spend };
    let turn: ModelTurn;
    try {
      turn = await o.client.next(timeLeft());
    } catch (err) {
      settleTurn(budget);
      if (err instanceof OutOfTime) return { stop: "time", spend };
      return { stop: "provider-error", stopDetail: err instanceof Error ? err.message : String(err), spend };
    }
    settleTurn(budget, turn.usage);
    spend.turns += 1;
    spend.usage = addUsage(spend.usage, turn.usage);
    if (turn.resume) continue;
    if (turn.calls.length === 0) {
      const said = turn.text.trim();
      if (said) o.log(`  model: ${said.slice(0, 600)}`);
      return { stop: "done", ...(turn.note ? { stopDetail: turn.note } : {}), spend, ...(said ? { finalText: said.slice(0, 600) } : {}) };
    }
    o.log(
      `  turn ${spend.turns}: ${turn.calls.map((c) => c.name || "(unnamed)").join(", ")} — ${(spend.usage.input + spend.usage.output).toLocaleString("en-US")} tokens so far`,
    );
    const results: ToolOutcome[] = [];
    for (const [i, call] of turn.calls.entries()) {
      if (i >= MAX_TOOL_CALLS_PER_TURN) {
        results.push({ id: call.id, isError: true, text: `${call.name} was not run: at most ${MAX_TOOL_CALLS_PER_TURN} tool calls are run from one reply.` });
        continue;
      }
      if (!allowed.has(call.name)) {
        results.push({ id: call.id, isError: true, text: `There is no tool named "${call.name}" in this run. The tools are: ${[...allowed].join(", ")}.` });
        continue;
      }
      if (call.argsError) {
        results.push({ id: call.id, isError: true, text: `${call.name} was not run: ${call.argsError}. Send the arguments as one JSON object.` });
        continue;
      }
      const args = ciToolArgs(call.input);
      const guarded = args.ok ? guardToolArgs(call.name, args.args, o.projectDir) : args;
      if (!guarded.ok) {
        results.push({ id: call.id, isError: true, text: `${call.name} was not run: ${guarded.error}.` });
        continue;
      }
      const left = timeLeft();
      if (left <= 0) {
        results.push({ id: call.id, isError: true, text: `${call.name} was not run: the time cap was reached.` });
        continue;
      }
      const sent = o.session && o.session.tools.has(call.name) ? { ...guarded.args, session: o.session.name } : guarded.args;
      try {
        const r = await o.host.call(call.name, sent, Math.min(600_000, left));
        results.push({ id: call.id, isError: r.isError, text: r.text });
        o.onResult?.(call.name, sent, r);
      } catch (err) {
        results.push({ id: call.id, isError: true, text: `${call.name} failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    o.client.addResults(results);
  }
}

/**
 * After the model has picked and captured the element: copy its picture into
 * the run's output, and for a comparison capture the same element (by its
 * key, not a ref the model chose) on the same page of the base URL, in a
 * session of its own, then diff the two. Only the engine takes pictures, and
 * the file names are fixed (SHOT_FILES).
 */
export async function captureShots(o: {
  host: ToolHost;
  options: CiOptions;
  captured: CaptureInfo | null;
  finalText?: string;
  outDir: string;
  timeLeft: () => number;
  log: (line: string) => void;
}): Promise<CaptureOutcome> {
  const what = o.options.show ?? "";
  const shots = path.join(o.outDir, SHOTS_DIRNAME);
  if (!o.captured) return { what, status: "not-found", ...(o.finalText ? { detail: o.finalText.slice(0, 300) } : {}) };
  const pathOf = (url: string): string => {
    try {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  };
  let previewPng: Buffer;
  try {
    previewPng = fs.readFileSync(o.captured.file);
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, SHOT_FILES.preview), previewPng);
  } catch (err) {
    return { what, status: "failed", detail: `the picture could not be kept: ${err instanceof Error ? err.message : String(err)}` };
  }
  const outcome: CaptureOutcome = {
    what,
    status: "captured",
    preview: {
      file: `${SHOTS_DIRNAME}/${SHOT_FILES.preview}`,
      key: o.captured.key,
      label: o.captured.label,
      path: pathOf(o.captured.url),
      width: o.captured.width,
      height: o.captured.height,
    },
  };
  o.log(`Captured ${o.captured.label || o.captured.key} on ${o.captured.url}.`);
  if (!o.options.compareUrl) return outcome;
  try {
    const target = rebaseUrl(o.captured.url, o.options.url, o.options.compareUrl);
    if (!target) return { ...outcome, detail: `the page it is on (${pathOf(o.captured.url)}) has no place on the base URL, so it was not compared` };
    const attached = await o.host.call(
      "scout_attach",
      {
        url: target,
        projectPath: o.options.projectDir,
        mode: o.options.mode,
        session: "base",
        objective: "CI run: capture the same element on the base URL",
        ...(o.options.browser ? { browser: o.options.browser } : {}),
      },
      Math.min(ATTACH_MS, o.timeLeft()),
    );
    if (attached.isError || /^ERROR:/.test(attached.text))
      return { ...outcome, detail: `the base URL could not be opened: ${attached.text.replace(/^ERROR:\s*/, "").slice(0, 200)}` };
    const base = await o.host.call("scout_capture", { key: o.captured.key, name: "base", margin: CAPTURE_MARGIN, session: "base" }, o.timeLeft());
    const baseInfo = base.isError ? null : parseCaptureResult(base.text);
    if (!baseInfo) return { ...outcome, detail: `the same element was not captured on the base URL: ${base.text.replace(/^ERROR:\s*/, "").slice(0, 200)}` };
    try {
      const basePng = fs.readFileSync(baseInfo.file);
      fs.writeFileSync(path.join(shots, SHOT_FILES.base), basePng);
      const diff = diffImages(decodePng(basePng), decodePng(previewPng));
      fs.writeFileSync(path.join(shots, SHOT_FILES.diff), encodePng(diff.image));
      o.log(`Compared with ${target}: ${diff.percent}% of pixels changed${diff.sizeChanged ? ", and the size changed" : ""}.`);
      return {
        ...outcome,
        base: { file: `${SHOTS_DIRNAME}/${SHOT_FILES.base}`, path: pathOf(baseInfo.url), width: baseInfo.width, height: baseInfo.height },
        diff: {
          file: `${SHOTS_DIRNAME}/${SHOT_FILES.diff}`,
          changedPixels: diff.changed,
          totalPixels: diff.total,
          percent: diff.percent,
          sizeChanged: diff.sizeChanged,
          box: diff.box,
        },
      };
    } catch (err) {
      return { ...outcome, detail: `the two pictures could not be compared: ${err instanceof Error ? err.message : String(err)}` };
    }
  } catch (err) {
    // A slow or failing base must not cost the preview's picture, nor turn the reply into an exploration's.
    return { ...outcome, detail: `the base URL could not be captured: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Whether a listed tool takes `session`: a lane's calls to it are sent to the lane's own. */
function takesSession(t: { inputSchema?: unknown }): boolean {
  const props = (t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return !!props && "session" in props;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A run split into lanes (--lanes): plan, then run every lane at once, then
 * fold what they did. The plan is a snapshot and a crawl from the planner's
 * session (no model call: only their time counts), the crawl repeated while it
 * finds routes, and the split brief.ts makes of them. Each lane attaches its
 * own session on the run's target URL, as the planner did (the engine resolves
 * every path against the URL a session attached with), opens its first route,
 * runs the agent loop there with its own conversation, draws its turns from
 * the run's one budget, and is closed when it ends. Their findings are already
 * one: every session files into the project's one memory, whose dedup folds a
 * defect two lanes filed. `outcome` is absent when there was nothing to split,
 * and the run explores in one loop instead.
 */
/**
 * The planning crawl a run split into lanes, or a seeded run, starts with: a
 * snapshot from the planner's session (attaching harvests no links; a snapshot
 * of the page it landed on does), then a crawl repeated while it finds routes,
 * up to PLAN_CRAWL_ROUNDS. No model call: only its time counts.
 */
async function planningCrawl(o: {
  host: ToolHost;
  log: (line: string) => void;
  timeLeft: () => number;
}): Promise<{ notes: Map<string, string[]>; planningFailed?: string }> {
  // What went wrong while planning, so a plan left with nothing to split says why rather than blaming the app.
  let planningFailed: string | undefined;
  /** One planner call: its text, or undefined after saying why it failed. */
  const plannerCall = async (tool: string, maxMs: number, what: string): Promise<string | undefined> => {
    try {
      const r = await o.host.call(tool, { session: PLANNER_SESSION }, Math.min(maxMs, o.timeLeft()));
      if (r.isError) throw new Error(r.text.replace(/^ERROR:\s*/, ""));
      return r.text;
    } catch (err) {
      planningFailed = `the planning ${what} failed: ${messageOf(err).slice(0, 300)}`;
      o.log(`Planning: ${planningFailed}.`);
      return undefined;
    }
  };
  if (o.timeLeft() > 0) await plannerCall("scout_snapshot", 120_000, "snapshot");
  const notes = new Map<string, string[]>();
  for (let round = 0; round < PLAN_CRAWL_ROUNDS && o.timeLeft() > 0; round += 1) {
    const text = await plannerCall("scout_crawl", 600_000, "crawl");
    if (text === undefined) break;
    const known = notes.size;
    for (const [route, lines] of crawlNotes(text)) if (!notes.has(route)) notes.set(route, lines);
    if (crawlFoundNothing(text) || notes.size === known) break;
  }
  return { notes, ...(planningFailed ? { planningFailed } : {}) };
}

async function exploreInLanes(o: {
  host: ToolHost;
  listed: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>;
  options: CiOptions;
  makeClient: (system: string, tools: readonly ToolSpec[], kickoff: string) => ModelClient;
  log: (line: string) => void;
  now: () => number;
  /** The run's budget: the lanes take their turns from it, beside whatever the dedup judge adds. */
  budget: Budget;
  attachArgs: (a: { url: string; objective: string; task: string; session: string }) => Record<string, unknown>;
  attachMs: number;
  /** What the planning crawl found. */
  planned: { notes: Map<string, string[]>; planningFailed?: string };
  /** A seeded run's schedule. */
  schedule?: ScheduleInput;
}): Promise<{ lanes: CiLanes; outcome?: LoopOutcome; plan: LanePlan }> {
  const { host, options, log, now, budget } = o;
  const timeLeft = (): number => wallLeftMs(budgetSpend(budget), options.caps, now());

  const plan = planCiLanes({
    target: options.url,
    notes: o.planned.notes,
    count: options.lanes,
    focus: options.focus,
    mode: options.mode,
    ...(o.planned.planningFailed ? { planningFailed: o.planned.planningFailed } : {}),
    ...(o.schedule ? { schedule: o.schedule } : {}),
  });
  if (plan.oneLoop) {
    log(`Lanes: ${plan.oneLoop}. Exploring in one loop.`);
    return { lanes: { asked: options.lanes, sessions: [], oneLoop: plan.oneLoop }, plan };
  }
  log(
    `Lanes: ${plan.lanes.length} of ${options.lanes} asked, sharing the caps: ` +
      plan.lanes.map((l) => `${l.session} (${l.modules.join(", ")}; ${l.routes.length} route(s))`).join("; "),
  );

  // ── run ──
  const tools = ciTools(o.listed, LANE_TOOLS);
  const sessionTools = new Set(o.listed.filter(takesSession).map((t) => t.name));
  const system = ciLaneSystemPrompt(loadPlaybook(packageRoot), options);

  const runLane = async (lane: CiLane): Promise<LaneResult> => {
    const say = (line: string): void => log(line.replace(/^(\s*)/, `$1[${lane.session}] `));
    const result: LaneResult = {
      session: lane.session,
      modules: lane.modules,
      routes: lane.routes.length,
      attached: false,
      stop: "could-not-start",
      turns: 0,
      usage: { ...NO_USAGE },
    };
    let attached = false;
    try {
      if (timeLeft() <= 0) {
        say("the time cap was reached before it attached.");
        return { ...result, stop: "time", stopDetail: "the time cap was reached before it attached" };
      }
      const r = await host
        .call(
          "scout_attach",
          o.attachArgs({ session: lane.session, url: options.url, objective: lane.objective, task: `Starting lane ${lane.session}` }),
          Math.min(o.attachMs, timeLeft()),
        )
        .catch((err: unknown) => ({ text: `ERROR: ${messageOf(err)}`, isError: true }));
      const failed = attachFailure(r);
      if (failed !== null) {
        say(`could not attach: ${failed.slice(0, 300)}`);
        return { ...result, stopDetail: failed.slice(0, 300) };
      }
      attached = true;
      // Its own first route, by its full URL. A landing that does not open costs the lane nothing but the detour: it starts from the target.
      let on = options.url;
      if (lane.url !== options.url && timeLeft() > 0) {
        const opened = await host
          .call(
            "scout_navigate",
            { session: lane.session, target: lane.url, task: `Opening lane ${lane.session}'s first route` },
            Math.min(o.attachMs, timeLeft()),
          )
          .catch((err: unknown) => ({ text: `ERROR: ${messageOf(err)}`, isError: true }));
        // With several sessions live the server puts a "[session …]" line first; the verdict is on the line after it.
        const said = opened.text.replace(/^\[session [^\]\n]*\]\n/, "");
        if (opened.isError || /^(ERROR|REFUSED):/.test(said))
          say(`could not open ${lane.landing} (${said.replace(/^ERROR:\s*/, "").slice(0, 200)}); starting from the target instead.`);
        else on = lane.url;
      }
      say(`attached on ${new URL(on).pathname}, owning ${lane.modules.join(", ")}.`);
      return await exploreLane(lane, on, say, { ...result, attached: true });
    } catch (err) {
      // Not a cap and not the model's API: the lane itself broke. Reported as the lane's, and the run's (mergeLaneStops), never dropped.
      const why = `the lane failed: ${messageOf(err).slice(0, 300)}`;
      say(why);
      return { ...result, attached, stop: "could-not-start", stopDetail: why };
    }
  };

  const exploreLane = async (lane: CiLane, on: string, say: (line: string) => void, result: LaneResult): Promise<LaneResult> => {
    const outcome = await agentLoop({
      client: o.makeClient(
        system,
        tools,
        ciLaneKickoff({
          lane: { ...lane, url: on },
          laneCount: plan.lanes.length,
          url: options.url,
          projectDir: options.projectDir,
          mode: options.mode,
          level: options.level,
          focus: options.focus,
          caps: options.caps,
          seeded: !!o.schedule,
        }),
      ),
      host,
      tools,
      caps: options.caps,
      budget,
      log: say,
      now,
      projectDir: options.projectDir,
      session: { name: lane.session, tools: sessionTools },
    });
    say(`ended: ${outcome.stop === "done" ? "the model finished the lane" : describeStop(outcome.stop, options.caps, outcome.stopDetail)}.`);
    // Closed as soon as it is done, so a lane that finished early holds no browser while the others work.
    // Past the time cap nothing more runs here: the run's own close, within FINISH_MS, collects it.
    if (timeLeft() > 0)
      await host
        .call("scout_close", { session: lane.session }, Math.min(30_000, timeLeft()))
        .catch((err: unknown) => say(`closing its browser failed: ${messageOf(err)}`));
    return {
      ...result,
      stop: outcome.stop,
      ...(outcome.stopDetail ? { stopDetail: outcome.stopDetail } : {}),
      turns: outcome.spend.turns,
      usage: outcome.spend.usage,
    };
  };

  // ── merge ──
  // Settled, not raced: every lane is waited out before the run moves on. runLane reports its own failures, so none rejects.
  const settled = await Promise.allSettled(plan.lanes.map(runLane));
  const broken = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (broken) throw new Error(`a lane failed outside its own handling: ${messageOf(broken.reason)}`);
  const sessions = settled.map((s) => (s as PromiseFulfilledResult<LaneResult>).value);
  const merged = mergeLaneStops(sessions);
  return {
    plan,
    lanes: { asked: options.lanes, sessions },
    outcome: { stop: merged.stop, ...(merged.stopDetail ? { stopDetail: merged.stopDetail } : {}), spend: budgetSpend(budget) },
  };
}

export interface CiRunResult {
  result: CiResult;
  exitCode: number;
  written: string[];
}

/**
 * The whole run. `makeClient` is how the model is reached: the HTTP client in
 * the CLI, a scripted one in the tests. It is called once per conversation:
 * once, or once per lane. Everything logged or written passes through the key
 * redaction first.
 */
export async function runCi(
  options: CiOptions,
  resolved: ResolvedProvider,
  deps: {
    makeClient: (system: string, tools: readonly ToolSpec[], kickoff: string) => ModelClient;
    /**
     * The dedup judge's model call (httpJudgeAsk in the CLI). With `--dedup
     * judge` and no judge given, the rule decides and the log says so.
     */
    judge?: Ask;
    /** The effort `judge` asks at, for the summary. */
    judgeEffort?: string;
    log?: (line: string) => void;
    secrets?: readonly string[];
    version: string;
    now?: () => number;
    /** How the MCP server is reached: started in a child process, unless a test hands in another. */
    startHost?: (log: (line: string) => void, judge?: ReturnType<typeof judgeHandler>) => Promise<ToolHost>;
  },
): Promise<CiRunResult> {
  const secrets = deps.secrets ?? [];
  const log = (line: string): void => (deps.log ?? (() => {}))(redactKeys(line, secrets));
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const outDir = options.outDir ?? path.join(options.projectDir, MEMORY_DIRNAME, CI_DIRNAME);
  const before = readMemoryFindings(options.projectDir);
  // Pictures an earlier run left in the same output are not this run's: they must never be uploaded as its.
  fs.rmSync(path.join(outDir, SHOTS_DIRNAME), { recursive: true, force: true });
  // One budget for the run: every loop (one, or each lane) takes its turns from it, and the dedup judge's calls add their tokens, which the caps count.
  const budget = newBudget(options.caps, startedAt);
  // A run asked to show an element files no findings, so it has nothing to deduplicate.
  const wantsJudge = options.dedup === "judge" && !options.show;
  if (wantsJudge && !deps.judge) log("No model was given for the dedup judge; the rule decides duplicates.");
  const judgeAsk = wantsJudge ? deps.judge : undefined;
  const judgeCalls: JudgeCalls = { calls: 0, failed: 0, usage: { ...NO_USAGE }, ms: 0 };
  let outcome: LoopOutcome = { stop: "could-not-start", spend: budgetSpend(budget) };
  let contractMet = false;
  let reportWritten = false;
  let capture: CaptureOutcome | undefined;
  let lanes: CiLanes | undefined;
  let runSchedule: CiSchedule | undefined;
  let host: ToolHost | null = null;
  // Set when the exploration ends (or never starts): the report and the close share FINISH_MS from then.
  let finishBy = 0;
  const finishLeft = (): number => Math.max(1_000, finishBy - now());
  try {
    // The page-load limit may be longer than the usual attach budget; the attach gets that limit and a minute to launch.
    const attachMs = Math.max(ATTACH_MS, resolveTimeLimits(options, process.env).navMs + 60_000);
    // One judge handler for the run's client: it answers the server's dedup questions and adds their tokens to the run's budget.
    const judge = judgeAsk
      ? judgeHandler({ ask: judgeAsk, model: resolved.model, spend: budget, caps: options.caps, calls: judgeCalls, secrets, now })
      : undefined;
    host = await (deps.startHost ?? startServer)(log, judge);
    // What every session of the run attaches with: the planner's here, and each lane's when the run is split.
    const attachArgs = (a: { url: string; objective: string; task: string; session?: string }): Record<string, unknown> => ({
      url: a.url,
      projectPath: options.projectDir,
      mode: options.mode,
      // Named either way, so a SCENESCOUT_DEDUP in the job's environment never decides for the option. Every session alike: they share one memory.
      dedup: judgeAsk ? "judge" : "rule",
      objective: a.objective.slice(0, 300),
      task: a.task,
      ...(a.session ? { session: a.session } : {}),
      ...(options.storageStatePath ? { storageStatePath: options.storageStatePath } : {}),
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.actionTimeoutMs !== undefined ? { actionTimeoutMs: options.actionTimeoutMs } : {}),
      ...(options.navTimeoutMs !== undefined ? { navTimeoutMs: options.navTimeoutMs } : {}),
    });
    const attached = await host.call(
      "scout_attach",
      attachArgs({
        url: options.url,
        objective: `CI run: explore at level ${options.level}${options.focus ? `, focusing on ${options.focus}` : ""}`,
        task: "Starting the CI run",
      }),
      Math.min(attachMs, options.caps.wallMs),
    );
    const failed = attachFailure(attached);
    if (failed !== null) {
      outcome = { ...outcome, stopDetail: failed.slice(0, 400) };
    } else {
      log(`Attached to ${options.url} in ${options.mode} mode.`);
      const listed = await host.tools();
      const toolHost = host;
      let captured: CaptureInfo | null = null;
      // A run split into lanes, or a seeded one, crawls first: the lanes are split, and a seeded run's routes ordered, from what it finds.
      const timeLeft = (): number => wallLeftMs(budgetSpend(budget), options.caps, now());
      const plans = !options.show && (options.lanes > 1 || options.seed);
      const planned = plans ? await planningCrawl({ host, log, timeLeft }) : undefined;
      // Seeded: the order the history and the seed give (schedule.ts). A memory that cannot be read gives no history, said in the log.
      let schedule: ScheduleInput | undefined;
      if (options.seed && planned) {
        let history: ReturnType<typeof readSchedulesOnDisk> = [];
        try {
          history = readSchedulesOnDisk(options.projectDir);
        } catch (err) {
          log(`Seed: the project's memory could not be read for earlier seeded runs (${messageOf(err)}), so none is moved to the back.`);
        }
        schedule = { seed: options.seed.value, earlier: earlierChoices(history, "routes", options.seed.value), exclusion: options.seedExclusion };
        log(seedLine(options.seed, options.seedExclusion, "--seed"));
      }
      let order: string[] | undefined;
      const oneLoop = (): Promise<LoopOutcome> => {
        const tools = ciTools(listed, options.show ? CAPTURE_TOOLS : undefined);
        const system = options.show ? ciCaptureSystemPrompt() : ciSystemPrompt(loadPlaybook(packageRoot), options);
        if (schedule && planned) order = scheduleOrder(plannedRoutes(options.url, planned.notes), schedule);
        const kickoff = options.show ? ciCaptureKickoff({ url: options.url, show: options.show }) : ciKickoff({ ...options, ...(order ? { order } : {}) });
        return agentLoop({
          client: deps.makeClient(system, tools, kickoff),
          host: toolHost,
          tools,
          caps: options.caps,
          log,
          now,
          budget,
          projectDir: options.projectDir,
          onResult: (name, _args, r) => {
            if (name === "scout_capture" && !r.isError) captured = parseCaptureResult(r.text) ?? captured;
          },
        });
      };
      let lanePlan: LanePlan | undefined;
      if (options.lanes > 1 && !options.show && planned) {
        const split = await exploreInLanes({
          host,
          listed,
          options,
          makeClient: deps.makeClient,
          log,
          now,
          budget,
          attachArgs,
          attachMs,
          planned,
          ...(schedule ? { schedule } : {}),
        });
        lanes = split.lanes;
        lanePlan = split.plan;
        outcome = split.outcome ?? (await oneLoop());
      } else {
        outcome = await oneLoop();
      }
      if (options.seed && planned) {
        const orders = lanePlan && lanePlan.lanes.length > 0 ? lanePlan.lanes.map((l) => l.routes) : order ? [order] : [];
        runSchedule = {
          seed: options.seed,
          exclusion: options.seedExclusion,
          routes: plannedRoutes(options.url, planned.notes).length,
          starts: startsOf(orders),
        };
        // Recorded once the exploration has run, so the next seeded run moves these to the back. Never fatal: the run is still reported.
        if (runSchedule.starts.length > 0) {
          try {
            recordScheduleOnDisk(options.projectDir, {
              seed: options.seed.value,
              // The real clock, as the server's: the report lists schedules recorded since its store opened.
              at: new Date().toISOString(),
              source: "ci",
              exclusion: options.seedExclusion,
              routes: runSchedule.starts,
            });
          } catch (err) {
            runSchedule.notRecorded = messageOf(err).slice(0, 300);
            log(`Seed: the schedule could not be recorded in the project's memory: ${runSchedule.notRecorded}`);
          }
        }
      }
      log(`Run ended: ${describeStop(outcome.stop, options.caps, outcome.stopDetail)}.`);
      finishBy = now() + FINISH_MS;
      if (options.show) {
        // A run asked to show an element writes pictures, not a report: it did not explore.
        capture = await captureShots({ host, options, captured, finalText: outcome.finalText, outDir, timeLeft: finishLeft, log });
      } else {
        // The report is written whatever ended the run. A forced report still prints its gaps.
        // From the planner's session by name: a lane attaching made itself the server's default.
        let report = await host.call("scout_report", { level: options.level, session: PLANNER_SESSION }, finishLeft());
        contractMet = !report.isError && !/NOT GENERATED/.test(report.text);
        if (!contractMet && !report.isError)
          report = await host.call("scout_report", { level: options.level, force: true, session: PLANNER_SESSION }, finishLeft());
        reportWritten = !report.isError && !/^ERROR:/.test(report.text) && fs.existsSync(path.join(options.projectDir, MEMORY_DIRNAME, "report.md"));
        if (!reportWritten) log(`The report could not be generated: ${report.text.slice(0, 400)}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (outcome.stop === "could-not-start") outcome = { ...outcome, stopDetail: message };
    else log(`The run could not finish cleanly: ${message}`);
  } finally {
    if (host) {
      if (finishBy === 0) finishBy = now() + FINISH_MS;
      await host
        .call("scout_close", { all: true }, finishLeft())
        .catch((err: unknown) => log(`Closing the browser failed: ${err instanceof Error ? err.message : String(err)}`));
      await host.close().catch(() => {});
    }
  }

  const endedAt = now();
  const result: CiResult = {
    url: options.url,
    provider: resolved.provider,
    model: resolved.model,
    effort: resolved.effort,
    mode: options.mode,
    level: options.level,
    caps: options.caps,
    ...(options.price ? { price: options.price } : {}),
    stop: outcome.stop,
    ...(outcome.stopDetail ? { stopDetail: outcome.stopDetail } : {}),
    contractMet,
    // The run's, not the last loop's: every lane's turns, and the judge's tokens.
    spend: budgetSpend(budget),
    endedAt,
    findings: findingsThisRun(before, readMemoryFindings(options.projectDir)),
    ...(capture ? { capture } : {}),
    ...(lanes ? { lanes } : {}),
    ...(runSchedule ? { schedule: runSchedule } : {}),
    ...(options.show
      ? {}
      : {
          dedup: judgeAsk ? { by: "judge" as const, ...(deps.judgeEffort ? { effort: deps.judgeEffort } : {}), ...judgeCalls } : { by: "rule" as const },
        }),
  };
  const written: string[] = [];
  try {
    if (!options.outDir) writeSelfIgnore(path.dirname(outDir));
    fs.mkdirSync(outDir, { recursive: true });
    const write = (name: string, content: string): void => {
      fs.writeFileSync(path.join(outDir, name), redactKeys(content, secrets));
      written.push(name);
    };
    if (reportWritten) {
      write("report.md", fs.readFileSync(path.join(options.projectDir, MEMORY_DIRNAME, "report.md"), "utf8"));
      const html = path.join(options.projectDir, MEMORY_DIRNAME, "report.html");
      if (fs.existsSync(html)) write("report.html", fs.readFileSync(html, "utf8"));
    }
    const summary = ciSummaryMarkdown(result, secrets);
    write("summary.md", summary);
    write("ci.json", JSON.stringify(ciSummaryJson(result, deps.version, secrets), null, 2) + "\n");
    const { anchor, warning } = sarifFilesFor({
      option: options.sarifFileAnchor,
      env: process.env,
      projectDir: options.projectDir,
      exists: (p) => fs.existsSync(p),
    });
    if (warning) log(warning);
    write("ci.sarif", JSON.stringify(ciSarif(result, deps.version, secrets, anchor), null, 2) + "\n");
    // A capture run's outcome is its pictures and ci.json: it wrote no report by design.
    if (options.show) reportWritten = true;
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, redactKeys(summary, secrets));
  } catch (err) {
    log(`Could not write the results to ${outDir}: ${err instanceof Error ? err.message : String(err)}`);
    reportWritten = false;
  }
  log(`Usage: ${usageLine(result.spend, result.model, endedAt, result.price)}`);
  return { result, exitCode: ciExitCode(result.stop, reportWritten), written };
}
