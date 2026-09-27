/**
 * Runs `scenescout ci`: starts the SceneScout MCP server as a child process,
 * attaches it to the app, lets a model drive the scout_* tools until it is
 * done or a cap ends the run, then has the report written and writes the CI
 * files. The rules (options, caps, redaction, which tools, the files) are in
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
import {
  addUsage,
  wallLeftMs,
  guardToolArgs,
  capReached,
  childEnv,
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
  MAX_TOOL_CALLS_PER_TURN,
  NO_USAGE,
  readFindings,
  redactKeys,
  toolResultText,
  usageLine,
  type CiOptions,
  type CiResult,
  type ResolvedProvider,
  type Spend,
  type StopReason,
  type ToolSpec,
} from "./engine/ci.js";
import { MEMORY_DIRNAME, writeSelfIgnore, type Finding } from "./engine/memory.js";
import {
  AnthropicConversation,
  backoffMs,
  errorMessage,
  MalformedReply,
  OpenAIConversation,
  retryable,
  retryAfterMs,
  type Conversation,
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
export { MAX_TOOL_CALLS_PER_TURN };

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

export function httpClient(resolved: ResolvedProvider, key: string, system: string, tools: readonly ToolSpec[], kickoff: string): ModelClient {
  const o = { baseUrl: resolved.baseUrl, model: resolved.model, effort: resolved.effort, system, tools };
  const conversation = resolved.provider === "anthropic" ? new AnthropicConversation(o, kickoff) : new OpenAIConversation(o, kickoff);
  return new HttpModelClient(conversation, key);
}

/** The MCP server, from the model's side: call a tool by name and get its text back. */
export interface ToolHost {
  tools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

async function startServer(log: (line: string) => void): Promise<ToolHost> {
  if (!fs.existsSync(serverPath)) throw new Error(`${serverPath} is missing: run \`npm run build\` first`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: childEnv(process.env), stderr: "pipe" });
  transport.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) log(`  [server] ${line}`);
  });
  const client = new Client({ name: "scenescout-ci", version: "1" });
  await client.connect(transport);
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
}

/**
 * The agent loop. Before each model call the caps are checked; the call runs
 * with at most the time that is left; each tool call it asks for is run in
 * order, on the one session, and none runs past the time cap: a call reached
 * after it is answered as not run, as is any beyond MAX_TOOL_CALLS_PER_TURN.
 * A call the loop cannot run (a tool it was not given, arguments that are not
 * JSON, a scan of another directory) goes back to the model as an error
 * result, so a malformed reply costs a turn, never the run.
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
}): Promise<LoopOutcome> {
  const now = o.now ?? Date.now;
  const spend: Spend = { turns: 0, usage: { ...NO_USAGE }, startedAt: o.startedAt ?? now() };
  const allowed = new Set(o.tools.map((t) => t.name));
  for (;;) {
    const cap = capReached(spend, o.caps, now());
    if (cap) return { stop: cap, spend };
    let turn: ModelTurn;
    try {
      turn = await o.client.next(wallLeftMs(spend, o.caps, now()));
    } catch (err) {
      if (err instanceof OutOfTime) return { stop: "time", spend };
      return { stop: "provider-error", stopDetail: err instanceof Error ? err.message : String(err), spend };
    }
    spend.turns += 1;
    spend.usage = addUsage(spend.usage, turn.usage);
    if (turn.resume) continue;
    if (turn.calls.length === 0) {
      if (turn.text.trim()) o.log(`  model: ${turn.text.trim().slice(0, 600)}`);
      return { stop: "done", ...(turn.note ? { stopDetail: turn.note } : {}), spend };
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
      const left = wallLeftMs(spend, o.caps, now());
      if (left <= 0) {
        results.push({ id: call.id, isError: true, text: `${call.name} was not run: the time cap was reached.` });
        continue;
      }
      try {
        const r = await o.host.call(call.name, guarded.args, Math.min(600_000, left));
        results.push({ id: call.id, isError: r.isError, text: r.text });
      } catch (err) {
        results.push({ id: call.id, isError: true, text: `${call.name} failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    o.client.addResults(results);
  }
}

export interface CiRunResult {
  result: CiResult;
  exitCode: number;
  written: string[];
}

/**
 * The whole run. `makeClient` is how the model is reached: the HTTP client in
 * the CLI, a scripted one in the tests. Everything logged or written passes
 * through the key redaction first.
 */
export async function runCi(
  options: CiOptions,
  resolved: ResolvedProvider,
  deps: {
    makeClient: (system: string, tools: readonly ToolSpec[], kickoff: string) => ModelClient;
    log?: (line: string) => void;
    secrets?: readonly string[];
    version: string;
    now?: () => number;
  },
): Promise<CiRunResult> {
  const secrets = deps.secrets ?? [];
  const log = (line: string): void => (deps.log ?? (() => {}))(redactKeys(line, secrets));
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const outDir = options.outDir ?? path.join(options.projectDir, MEMORY_DIRNAME, CI_DIRNAME);
  const before = readMemoryFindings(options.projectDir);
  let outcome: LoopOutcome = { stop: "could-not-start", spend: { turns: 0, usage: { ...NO_USAGE }, startedAt } };
  let contractMet = false;
  let reportWritten = false;
  let host: ToolHost | null = null;
  // Set when the exploration ends (or never starts): the report and the close share FINISH_MS from then.
  let finishBy = 0;
  const finishLeft = (): number => Math.max(1_000, finishBy - now());
  try {
    host = await startServer(log);
    const attached = await host.call(
      "scout_attach",
      {
        url: options.url,
        projectPath: options.projectDir,
        mode: options.mode,
        objective: `CI run: explore at level ${options.level}${options.focus ? `, focusing on ${options.focus}` : ""}`.slice(0, 300),
        task: "Starting the CI run",
        ...(options.storageStatePath ? { storageStatePath: options.storageStatePath } : {}),
        ...(options.browser ? { browser: options.browser } : {}),
      },
      Math.min(ATTACH_MS, options.caps.wallMs),
    );
    const authFailed = attached.text.split("\n").find((l) => l.startsWith("⚠ AUTH FAILED"));
    if (attached.isError || /^ERROR:/.test(attached.text) || authFailed) {
      outcome = { ...outcome, stopDetail: (authFailed ?? attached.text).replace(/^ERROR:\s*/, "").slice(0, 400) };
    } else {
      log(`Attached to ${options.url} in ${options.mode} mode.`);
      const tools = ciTools(await host.tools());
      const system = ciSystemPrompt(loadPlaybook(packageRoot), options);
      const kickoff = ciKickoff(options);
      outcome = await agentLoop({
        client: deps.makeClient(system, tools, kickoff),
        host,
        tools,
        caps: options.caps,
        log,
        now,
        startedAt,
        projectDir: options.projectDir,
      });
      log(`Run ended: ${describeStop(outcome.stop, options.caps, outcome.stopDetail)}.`);
      finishBy = now() + FINISH_MS;
      // The report is written whatever ended the run. A forced report still prints its gaps.
      let report = await host.call("scout_report", { level: options.level }, finishLeft());
      contractMet = !report.isError && !/NOT GENERATED/.test(report.text);
      if (!contractMet && !report.isError) report = await host.call("scout_report", { level: options.level, force: true }, finishLeft());
      reportWritten = !report.isError && !/^ERROR:/.test(report.text) && fs.existsSync(path.join(options.projectDir, MEMORY_DIRNAME, "report.md"));
      if (!reportWritten) log(`The report could not be generated: ${report.text.slice(0, 400)}`);
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
    spend: outcome.spend,
    endedAt,
    findings: findingsThisRun(before, readMemoryFindings(options.projectDir)),
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
    write("ci.sarif", JSON.stringify(ciSarif(result, deps.version, secrets), null, 2) + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, redactKeys(summary, secrets));
  } catch (err) {
    log(`Could not write the results to ${outDir}: ${err instanceof Error ? err.message : String(err)}`);
    reportWritten = false;
  }
  log(`Usage: ${usageLine(result.spend, result.model, endedAt, result.price)}`);
  return { result, exitCode: ciExitCode(result.stop, reportWritten), written };
}
