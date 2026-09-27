/**
 * The two model APIs a CI run can use, as message shapes: what each request
 * carries and how each reply is read into one provider-neutral turn. Pure: the
 * network is src/ci-run.ts's, so everything here is table-tested with recorded
 * replies and no key.
 *
 *   anthropic  the Messages API (POST {base}/messages)
 *   openai     the Responses API with function calling (POST {base}/responses),
 *              which any endpoint implementing it can serve via --base-url
 *
 * Both conversations are append-only: what the model returned goes back
 * exactly as it came (thinking blocks, reasoning items), which is what both
 * APIs require to continue a turn and what keeps the prompt-cache prefix whole.
 */
import type { ToolSpec, Usage } from "./ci.js";

export interface ToolCall {
  /** The provider's id for the call, echoed back with its result. */
  id: string;
  name: string;
  /** The parsed arguments, or undefined when `argsError` says why they could not be read. */
  input?: unknown;
  argsError?: string;
}

export interface ModelTurn {
  text: string;
  calls: ToolCall[];
  usage: Usage;
  /** The model paused mid-turn and asks to be called again with nothing added (the Messages API's pause_turn). */
  resume?: boolean;
  /** Why the model ended without the run's say-so: a refusal, an output cut at its length limit. */
  note?: string;
}

export interface ToolOutcome {
  id: string;
  text: string;
  isError: boolean;
}

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Raised for a reply that is not what the API promises: retried like a server error, never run as tool calls. */
export class MalformedReply extends Error {}

/** One conversation with one provider: build the next request, read its reply, add tool results. */
export interface Conversation {
  request(key: string): HttpRequest;
  accept(reply: unknown): ModelTurn;
  addResults(results: readonly ToolOutcome[]): void;
}

/** The most output one model call may produce. Large enough for a plan of steps; small enough that one reply cannot spend the budget. */
export const MAX_OUTPUT_TOKENS = 16_000;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function parseArgs(raw: unknown): { input?: unknown; argsError?: string } {
  if (raw === undefined || raw === null || raw === "") return { input: {} };
  if (typeof raw !== "string") return { input: raw };
  try {
    return { input: JSON.parse(raw) };
  } catch (err) {
    return { argsError: `the arguments were not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}

// ── Anthropic Messages API ──────────────────────────────────────────────────

export class AnthropicConversation implements Conversation {
  readonly messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  constructor(
    private readonly o: { baseUrl: string; model: string; effort: string; system: string; tools: readonly ToolSpec[] },
    kickoff: string,
  ) {
    this.messages.push({ role: "user", content: kickoff });
  }

  request(key: string): HttpRequest {
    return {
      url: `${this.o.baseUrl}/messages`,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: {
        model: this.o.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // The method and the tools are the same on every call: cached once, read back at a tenth of the price.
        system: [{ type: "text", text: this.o.system, cache_control: { type: "ephemeral" } }],
        tools: this.o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        // And the growing conversation: the top-level breakpoint moves to its last block on every call.
        cache_control: { type: "ephemeral" },
        output_config: { effort: this.o.effort },
        // No tool_choice: parallel tool use stays on (it is only off under disable_parallel_tool_use).
        messages: this.messages,
      },
    };
  }

  accept(reply: unknown): ModelTurn {
    const r = obj(reply);
    if (!r || !Array.isArray(r.content)) throw new MalformedReply("the reply has no content list");
    const content = r.content as unknown[];
    const u = obj(r.usage) ?? {};
    const cached = num(u.cache_read_input_tokens);
    const written = num(u.cache_creation_input_tokens);
    const usage: Usage = { input: num(u.input_tokens) + cached + written, cachedInput: cached, cacheWrite: written, output: num(u.output_tokens) };
    // Kept as returned, thinking blocks included: the API requires them back unchanged.
    this.messages.push({ role: "assistant", content });
    const text = content
      .map(obj)
      .filter((b) => b?.type === "text")
      .map((b) => String(b!.text ?? ""))
      .join("\n");
    const calls: ToolCall[] = content
      .map(obj)
      .filter((b) => b?.type === "tool_use")
      .map((b, i) => ({
        id: typeof b!.id === "string" ? b!.id : `call_${i}`,
        name: typeof b!.name === "string" ? b!.name : "",
        ...(obj(b!.input) || b!.input === undefined ? { input: b!.input ?? {} } : parseArgs(b!.input)),
      }));
    const stop = r.stop_reason;
    if (stop === "pause_turn") return { text, calls: [], usage, resume: true };
    const note =
      stop === "refusal"
        ? "the model declined to continue"
        : stop === "max_tokens" && calls.length === 0
          ? "the model's reply was cut at its output limit"
          : undefined;
    return { text, calls, usage, ...(note ? { note } : {}) };
  }

  addResults(results: readonly ToolOutcome[]): void {
    // Every result in one user message: splitting them teaches the model to stop calling tools in parallel.
    this.messages.push({
      role: "user",
      content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.text, ...(r.isError ? { is_error: true } : {}) })),
    });
  }
}

// ── OpenAI Responses API ────────────────────────────────────────────────────

export class OpenAIConversation implements Conversation {
  readonly input: unknown[] = [];
  constructor(
    private readonly o: { baseUrl: string; model: string; effort: string; system: string; tools: readonly ToolSpec[] },
    kickoff: string,
  ) {
    this.input.push({ role: "user", content: kickoff });
  }

  request(key: string): HttpRequest {
    return {
      url: `${this.o.baseUrl}/responses`,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: {
        model: this.o.model,
        instructions: this.o.system,
        input: this.input,
        tools: this.o.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        // Several independent calls in one reply, each answered by its own
        // function_call_output: a run's turn cap then buys more than one action a turn.
        parallel_tool_calls: true,
        reasoning: { effort: this.o.effort },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        // Stateless: nothing of the tested app is kept on the provider's side
        // between calls, and the reasoning comes back encrypted so it can be
        // handed back with the rest of the turn.
        store: false,
        include: ["reasoning.encrypted_content"],
      },
    };
  }

  accept(reply: unknown): ModelTurn {
    const r = obj(reply);
    if (!r || !Array.isArray(r.output)) throw new MalformedReply("the reply has no output list");
    if (obj(r.error)) throw new MalformedReply(`the reply carries an error: ${String(obj(r.error)!.message ?? "unknown")}`);
    const output = r.output as unknown[];
    const u = obj(r.usage) ?? {};
    const usage: Usage = {
      input: num(u.input_tokens),
      cachedInput: num(obj(u.input_tokens_details)?.cached_tokens),
      cacheWrite: 0,
      output: num(u.output_tokens),
    };
    // Every item goes back as it came: reasoning items and function calls must precede their outputs.
    this.input.push(...output);
    const items = output.map(obj);
    const text = items
      .filter((i) => i?.type === "message" && Array.isArray(i.content))
      .flatMap((i) => (i!.content as unknown[]).map(obj))
      .filter((c) => c?.type === "output_text")
      .map((c) => String(c!.text ?? ""))
      .join("\n");
    const calls: ToolCall[] = items
      .filter((i) => i?.type === "function_call")
      .map((i, k) => ({
        id: typeof i!.call_id === "string" ? i!.call_id : `call_${k}`,
        name: typeof i!.name === "string" ? i!.name : "",
        ...parseArgs(i!.arguments),
      }));
    const incomplete = r.status === "incomplete" ? String(obj(r.incomplete_details)?.reason ?? "incomplete") : undefined;
    const refused = items.some((i) => i?.type === "message" && Array.isArray(i.content) && (i.content as unknown[]).some((c) => obj(c)?.type === "refusal"));
    const note = refused ? "the model declined to continue" : incomplete && calls.length === 0 ? `the model's reply was cut short (${incomplete})` : undefined;
    return { text, calls, usage, ...(note ? { note } : {}) };
  }

  addResults(results: readonly ToolOutcome[]): void {
    for (const r of results) this.input.push({ type: "function_call_output", call_id: r.id, output: r.isError ? `ERROR: ${r.text}` : r.text });
  }
}

// ── retries ─────────────────────────────────────────────────────────────────

/** A status worth another try: throttling, a timeout, an overloaded or failing server. Never a 4xx the request itself caused. */
export function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Wait before retry `attempt` (1-based): exponential from `baseMs`, capped,
 * with full jitter so several jobs throttled at once do not retry in step. A
 * `retry-after` the server sent is honoured when it is longer, up to the cap.
 */
export function backoffMs(attempt: number, random: () => number, o: { baseMs?: number; capMs?: number; retryAfterMs?: number } = {}): number {
  const base = o.baseMs ?? 1000;
  const cap = o.capMs ?? 30_000;
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  const jittered = Math.floor(exp / 2 + random() * (exp / 2));
  return Math.min(cap, Math.max(jittered, o.retryAfterMs ?? 0));
}

/** A `retry-after` header in milliseconds (seconds or an HTTP date), or undefined. */
export function retryAfterMs(header: string | null | undefined, now: number): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The API's own error message from a failed reply's body, for the log. The caller redacts it. */
export function errorMessage(status: number, body: string): string {
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const e = parsed.error;
    message = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof parsed.message === "string" ? parsed.message : "";
  } catch {
    message = body.slice(0, 200);
  }
  return `HTTP ${status}${message ? `: ${message.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
}
