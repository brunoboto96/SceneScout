/**
 * Unit tests for `scenescout ci`: its options, which provider a run uses, the
 * caps that end it, the key redaction, the tools the model is given, both
 * APIs' message shapes, retries, the agent loop (driven by a scripted model
 * and a fake tool host, so no browser and no network), the files it writes and
 * its GitHub Action. The run against a real browser is scripts/smoke/ci.ts.
 *
 *   npx tsx --test --test-name-pattern "cap" scripts/ci-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { CI_ACTION_ONLY_INPUTS, ciArgs, ciOutDirFor, ciSummaryOutputs, ciVerdict, hasCiCommand } from "../action/ci-action.mjs";
import { agentLoop, HttpModelClient, MAX_RETRIES, MAX_TOOL_CALLS_PER_TURN, OutOfTime, ProviderError, type ModelClient } from "../src/ci-run.ts";
import {
  guardToolArgs,
  capReached,
  checkBaseUrl,
  childEnv,
  CI_OPTION_NAMES,
  CI_TOOLS,
  ciExitCode,
  ciKickoff,
  ciSarif,
  ciSummaryJson,
  ciSummaryMarkdown,
  ciSystemPrompt,
  ciToolArgs,
  ciTools,
  DEFAULT_CAPS,
  detectProvider,
  estimateCost,
  findingsThisRun,
  NO_USAGE,
  parseCiArgs,
  readFindings,
  REDACTED_KEY,
  resolvePrice,
  redactKeys,
  secretValues,
  toolResultText,
  usageLine,
  wallLeftMs,
  type Caps,
  type CiResult,
  type ToolSpec,
  type Usage,
} from "../src/engine/ci.ts";
import type { Finding } from "../src/engine/memory.ts";
import {
  AnthropicConversation,
  backoffMs,
  errorMessage,
  MalformedReply,
  OpenAIConversation,
  retryable,
  retryAfterMs,
  type ModelTurn,
  type ToolOutcome,
} from "../src/engine/provider.ts";

// Invented values: nothing shaped like a real service's key (hygiene-test refuses those).
const OPENAI_KEY = "fake-openai-key-0123456789abcdef";
const ANTHROPIC_KEY = "fake-anthropic-key-fedcba9876543210";

// ── options ─────────────────────────────────────────────────────────────────

test("options: the defaults are the agreed caps, read-only and medium", () => {
  const p = parseCiArgs(["http://127.0.0.1:3000"], "/work");
  assert.ok(p.ok);
  assert.deepEqual(p.options, {
    url: "http://127.0.0.1:3000/",
    projectDir: "/work",
    caps: { turns: 40, tokens: 1_500_000, wallMs: 20 * 60_000 },
    mode: "read-only",
    level: "medium",
  });
});

test("options: every option is read, in both spellings", () => {
  const p = parseCiArgs(
    [
      "http://127.0.0.1:3000/start",
      "--provider=openai",
      "--model",
      "some-model-1",
      "--effort=high",
      "--base-url",
      "https://llm.example.com/v1/",
      "--max-turns=5",
      "--max-tokens",
      "50000",
      "--max-minutes=3",
      "--price-in=0.5",
      "--price-cached-in",
      "0.05",
      "--price-out=2",
      "--mode=safe-write",
      "--level",
      "medium",
      "--focus=the order form",
      "--storage-state=auth/user.json",
      "--browser=webkit",
      "--project=site",
      "--out=results",
    ],
    "/work",
  );
  assert.ok(p.ok, p.ok ? "" : p.error);
  assert.deepEqual(p.options, {
    url: "http://127.0.0.1:3000/start",
    projectDir: "/work/site",
    outDir: "/work/results",
    provider: "openai",
    model: "some-model-1",
    effort: "high",
    baseUrl: "https://llm.example.com/v1",
    caps: { turns: 5, tokens: 50_000, wallMs: 3 * 60_000 },
    price: { input: 0.5, cachedInput: 0.05, output: 2 },
    mode: "safe-write",
    level: "medium",
    focus: "the order form",
    storageStatePath: "/work/auth/user.json",
    browser: "webkit",
  });
});

test("options: what is refused, and why", () => {
  const bad = (args: string[]): string => {
    const p = parseCiArgs(args, "/work");
    assert.ok(!p.ok, `accepted ${args.join(" ")}`);
    return p.error;
  };
  const u = "http://127.0.0.1:3000";
  assert.match(bad([u, "--mode=destructive"]), /--mode destructive needs --allow-destructive as well/);
  assert.match(bad([u, "--mode=destructive", "--allow-destructive=false"]), /needs --allow-destructive/);
  assert.match(bad([u, "--allow-destructive=yes"]), /--allow-destructive takes no value, or true or false/);
  assert.match(bad([u, "--mode=write"]), /--mode must be one of observe, read-only, safe-write, destructive/);
  assert.match(bad([u, "--api-key=abc"]), /there is no --api-key: the key is read from ANTHROPIC_API_KEY or OPENAI_API_KEY only/);
  assert.match(bad([u, "--max-turns=0"]), /--max-turns must be a whole number from 1 to 500/);
  assert.match(bad([u, "--max-tokens=1.5"]), /--max-tokens must be a whole number/);
  assert.match(bad([u, "--max-minutes=999"]), /--max-minutes must be a whole number from 1 to 360/);
  assert.match(bad([u, "--provider=gemini"]), /--provider must be one of anthropic, openai/);
  assert.match(bad([u, "--provider=anthropic", "--effort=none"]), /--effort must be one of low, medium, high, xhigh, max for anthropic/);
  assert.match(bad([u, "--effort=extreme"]), /--effort must be one of none, low/);
  assert.match(bad([u, "--level=deep"]), /--level must be one of minimal, medium, extensive/);
  assert.match(bad([u, "--base-url=http://llm.example.com/v1"]), /must be https/);
  assert.match(bad(["http://user:pw@127.0.0.1:3000"]), /put no credentials in the URL/);
  assert.match(bad([]), /give exactly one URL/);
  assert.match(bad([u, "--nope=1"]), /unknown option --nope/);
  assert.match(bad([u, "--price-in=-1"]), /--price-in must be US dollars per million tokens, from 0 to 1000/);
  assert.match(bad([u, "--price-out=cheap"]), /--price-out must be/);
  assert.match(bad([u, "--price-cached-in="]), /--price-cached-in must be/);
});

test("destructive: only with --allow-destructive, which alone changes nothing", () => {
  const ok = (args: string[]) => {
    const p = parseCiArgs(args, "/work");
    assert.ok(p.ok, p.ok ? "" : p.error);
    return p.options;
  };
  // Bare, before the URL: the switch takes no value, so the URL is still the URL.
  assert.equal(ok(["--allow-destructive", "http://127.0.0.1:3000", "--mode=destructive"]).mode, "destructive");
  assert.equal(ok(["http://127.0.0.1:3000", "--mode", "destructive", "--allow-destructive=true"]).mode, "destructive");
  assert.equal(ok(["http://127.0.0.1:3000", "--allow-destructive"]).mode, "read-only", "the default mode stays read-only");
});

test("base URL: https anywhere, plain http only to this machine, never with credentials", () => {
  assert.deepEqual(checkBaseUrl("https://llm.example.com/v1/"), { ok: true, url: "https://llm.example.com/v1" });
  assert.ok(checkBaseUrl("http://127.0.0.1:8080/v1").ok);
  assert.ok(checkBaseUrl("http://localhost:8080/v1").ok);
  assert.ok(!checkBaseUrl("http://10.0.0.5/v1").ok);
  assert.ok(!checkBaseUrl("https://u:p@llm.example.com/v1").ok);
  assert.ok(!checkBaseUrl("ftp://llm.example.com").ok);
});

// ── which provider ──────────────────────────────────────────────────────────

test("provider: detected from the one key present; both keys need --provider; a named provider needs its key", () => {
  const detect = (env: Record<string, string>, provider?: "anthropic" | "openai") => detectProvider(env, provider ? { provider } : {});
  const openai = detect({ OPENAI_API_KEY: OPENAI_KEY });
  assert.ok(openai.ok);
  assert.deepEqual(openai.resolved, { provider: "openai", model: "gpt-5.6-luna", effort: "low", baseUrl: "https://api.openai.com/v1" });
  const anthropic = detect({ ANTHROPIC_API_KEY: ANTHROPIC_KEY });
  assert.ok(anthropic.ok);
  assert.deepEqual(anthropic.resolved, { provider: "anthropic", model: "claude-sonnet-5", effort: "low", baseUrl: "https://api.anthropic.com/v1" });

  const both = { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY };
  const ambiguous = detect(both);
  assert.ok(!ambiguous.ok && /both ANTHROPIC_API_KEY and OPENAI_API_KEY are set: pass --provider/.test(ambiguous.error));
  const chosen = detect(both, "anthropic");
  assert.ok(chosen.ok && chosen.resolved.provider === "anthropic");

  const none = detect({});
  assert.ok(!none.ok && /set ANTHROPIC_API_KEY or OPENAI_API_KEY/.test(none.error));
  // A key that is set but blank is not a key.
  const blank = detect({ OPENAI_API_KEY: "   " });
  assert.ok(!blank.ok);
  const missing = detect({ OPENAI_API_KEY: OPENAI_KEY }, "anthropic");
  assert.ok(!missing.ok && /--provider anthropic needs ANTHROPIC_API_KEY/.test(missing.error));
  // "none" is valid only for the API that has it, and the check runs after detection too.
  const noneEffort = detectProvider({ ANTHROPIC_API_KEY: ANTHROPIC_KEY }, { effort: "none" });
  assert.ok(!noneEffort.ok && /for anthropic/.test(noneEffort.error));
  const overridden = detectProvider({ OPENAI_API_KEY: OPENAI_KEY }, { model: "other", effort: "none", baseUrl: "https://llm.example.com/v1" });
  assert.ok(overridden.ok);
  assert.deepEqual(overridden.resolved, { provider: "openai", model: "other", effort: "none", baseUrl: "https://llm.example.com/v1" });
});

test("the server's environment has no key in it, and no live view", () => {
  const env = childEnv({ OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY, PATH: "/bin", HOME: "/h" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", SCENESCOUT_LIVE: "off" });
});

// ── redaction ───────────────────────────────────────────────────────────────

test("redaction: every key value and every key-shaped string goes; ordinary text stays", () => {
  const secrets = secretValues({ OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY, OTHER: "x" });
  assert.deepEqual(secrets.sort(), [ANTHROPIC_KEY, OPENAI_KEY].sort());
  const line = `HTTP 401: Incorrect API key provided: ${OPENAI_KEY}. Also ${ANTHROPIC_KEY} and sk-abcdefghijklmnopqrstuv.`;
  const out = redactKeys(line, secrets);
  assert.ok(!out.includes(OPENAI_KEY) && !out.includes(ANTHROPIC_KEY) && !out.includes("sk-abcdefghijklmnopqrstuv"), out);
  assert.equal(out.split(REDACTED_KEY).length - 1, 3);
  // The contrast: text with no key in it is returned as it was, including a short "sk-" word.
  const plain = "Clicked the task-list button; the sk-1 badge overlaps it.";
  assert.equal(redactKeys(plain, secrets), plain);
  // A key that contains another is removed whole, not half-printed.
  assert.equal(redactKeys("abcdefgh-longer", ["abcdefgh", "abcdefgh-longer"]), REDACTED_KEY);
  // Values too short to be keys are not treated as secrets (they would rewrite ordinary words).
  assert.deepEqual(secretValues({ OPENAI_API_KEY: "short" }), []);
});

// ── caps ────────────────────────────────────────────────────────────────────

test("caps: each ends the run at its limit and not before", () => {
  const caps: Caps = { turns: 3, tokens: 1000, wallMs: 60_000 };
  const spend = (turns: number, tokens: number) => ({ turns, usage: { ...NO_USAGE, input: tokens, output: 0 }, startedAt: 0 });
  assert.equal(capReached(spend(0, 0), caps, 0), null);
  assert.equal(capReached(spend(2, 999), caps, 59_999), null);
  assert.equal(capReached(spend(3, 0), caps, 0), "turns");
  assert.equal(capReached(spend(0, 1000), caps, 0), "tokens");
  assert.equal(capReached(spend(0, 0), caps, 60_000), "time");
  // Output counts towards tokens as much as input.
  assert.equal(capReached({ turns: 0, usage: { ...NO_USAGE, input: 400, output: 600 }, startedAt: 0 }, caps, 0), "tokens");
  // No call gets more than the time left, and past the cap there is none.
  assert.equal(wallLeftMs(spend(0, 0), caps, 50_000), 10_000);
  assert.equal(wallLeftMs(spend(0, 0), caps, 70_000), 0);
});

test("exit code: 0 whenever the run ran and the report is written; findings are not an input", () => {
  for (const r of ["done", "turns", "tokens", "time"] as const) assert.equal(ciExitCode(r, true), 0, r);
  assert.equal(ciExitCode("provider-error", true), 2);
  assert.equal(ciExitCode("could-not-start", false), 2);
  assert.equal(ciExitCode("done", false), 2);
});

test("cost: a given price overrides the table's; an unknown model is costed only when input and output are both given", () => {
  const u: Usage = { input: 1_000_000, cachedInput: 500_000, cacheWrite: 0, output: 100_000 };
  assert.deepEqual(resolvePrice("gpt-5.6-luna"), { input: 0.2, cachedInput: 0.02, output: 1.2 });
  assert.deepEqual(resolvePrice("gpt-5.6-luna", { output: 2 }), { input: 0.2, cachedInput: 0.02, output: 2 });
  assert.deepEqual(
    resolvePrice("claude-sonnet-5", { input: 3 }),
    { input: 3, cachedInput: 0.2, output: 10 },
    "the table's cache-write price goes with its input price",
  );
  assert.equal(resolvePrice("unknown-model", { input: 1 }), null);
  assert.equal(resolvePrice("unknown-model", { cachedInput: 0.1, output: 1 }), null);
  assert.deepEqual(
    resolvePrice("unknown-model", { input: 1, output: 4 }),
    { input: 1, cachedInput: 1, output: 4 },
    "cached input unpriced is charged as input",
  );
  // 500k plain at $1 + 500k cached at $0.10 + 100k out at $4
  assert.equal(estimateCost("unknown-model", u, { input: 1, cachedInput: 0.1, output: 4 })!.toFixed(4), "0.9500");
  assert.match(usageLine({ turns: 1, usage: u, startedAt: 0 }, "unknown-model", 0, { input: 1, cachedInput: 0.1, output: 4 }), /estimated cost \$0\.9500/);
  assert.match(
    usageLine({ turns: 1, usage: u, startedAt: 0 }, "unknown-model", 0, { input: 1 }),
    /cost not estimated \(no price known for unknown-model; --price-in and --price-out give one\)/,
  );
  const json = ciSummaryJson(RESULT({ model: "unknown-model", price: { input: 1, output: 4 } }), "9.9.9") as { usage: { estimatedCostUsd: number | null } };
  assert.equal(typeof json.usage.estimatedCostUsd, "number");
  assert.match(ciSummaryMarkdown(RESULT({ model: "unknown-model", price: { input: 1, output: 4 } })), /estimated cost \$/);
  assert.match(ciSummaryMarkdown(RESULT({ model: "unknown-model" })), /cost not estimated/);
});

test("cost: estimated from the published price, cached input at its own rate; an unknown model is not guessed", () => {
  const u: Usage = { input: 1_000_000, cachedInput: 500_000, cacheWrite: 0, output: 100_000 };
  // 500k plain at $0.20/M + 500k cached at $0.02/M + 100k out at $1.20/M
  assert.equal(estimateCost("gpt-5.6-luna", u)!.toFixed(4), (0.1 + 0.01 + 0.12).toFixed(4));
  assert.equal(estimateCost("unknown-model", u), null);
  assert.match(
    usageLine({ turns: 2, usage: u, startedAt: 0 }, "unknown-model", 65_000),
    /2 turn\(s\), 1,000,000 tokens in \(500,000 cached\), 100,000 out, 1m 5s, cost not estimated/,
  );
});

// ── tools ───────────────────────────────────────────────────────────────────

const LISTED = [
  { name: "scout_attach", description: "attach", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  {
    name: "scout_click",
    description: "click",
    inputSchema: { $schema: "x", type: "object", properties: { ref: { type: "string" }, session: { type: "string" } }, required: ["ref", "session"] },
  },
  { name: "scout_crawl", description: "crawl", inputSchema: { type: "object", properties: { session: { type: "string" } } } },
  { name: "scout_screenshot", description: "shot", inputSchema: { type: "object", properties: {} } },
  { name: "scout_new_tool", description: "not yet decided", inputSchema: { type: "object", properties: {} } },
];

test("tools: only the allowlist, in a fixed order, with no session and no $schema", () => {
  const tools = ciTools(LISTED);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["scout_crawl", "scout_click"],
  );
  assert.deepEqual(tools[1].parameters, { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] });
  assert.deepEqual(tools[0].parameters, { type: "object", properties: {} });
  for (const never of ["scout_attach", "scout_close", "scout_session", "scout_playbook", "scout_screenshot", "scout_lane_brief", "scout_lane_report"])
    assert.ok(!(CI_TOOLS as readonly string[]).includes(never), never);
  assert.deepEqual(ciToolArgs({ ref: "e1", session: "other" }), { ok: true, args: { ref: "e1" } });
  assert.deepEqual(ciToolArgs(undefined), { ok: true, args: {} });
  assert.ok(!ciToolArgs("ref=e1").ok);
  assert.ok(!ciToolArgs([1]).ok);
});

test("scout_scan reads only the run's own project directory", () => {
  assert.deepEqual(guardToolArgs("scout_scan", {}, "/work/site"), { ok: true, args: { projectPath: "/work/site" } });
  assert.deepEqual(guardToolArgs("scout_scan", { projectPath: "/work/site/" }, "/work/site"), { ok: true, args: { projectPath: "/work/site" } });
  assert.deepEqual(guardToolArgs("scout_scan", { projectPath: "." }, "/work/site"), { ok: true, args: { projectPath: "/work/site" } });
  for (const elsewhere of ["/", "/home/u", "/work", "../other", "/work/site/sub", 42])
    assert.match(
      (guardToolArgs("scout_scan", { projectPath: elsewhere }, "/work/site") as { error: string }).error,
      /only this run's project directory, \/work\/site/,
      String(elsewhere),
    );
  // Other tools' arguments pass as they are, a projectPath included.
  assert.deepEqual(guardToolArgs("scout_note", { projectPath: "/" }, "/work/site"), { ok: true, args: { projectPath: "/" } });
});

test("tool results: text only, images named, the length bounded", () => {
  assert.equal(toolResultText([{ type: "text", text: "a" }, { type: "image" }]), "a\n[image omitted: this run is text-only]");
  assert.equal(toolResultText([]), "(no output)");
  const long = toolResultText([{ type: "text", text: "x".repeat(50) }], 20);
  assert.ok(long.startsWith("x".repeat(20)) && /30 more characters cut/.test(long));
});

test("prompt: the method, then the CI rules; the kickoff names the target, level, mode and budget", () => {
  const system = ciSystemPrompt("THE METHOD", { mode: "observe", level: "medium" });
  assert.ok(system.startsWith("THE METHOD"));
  assert.match(system, /already attached to the target in observe mode/);
  assert.match(system, /never ask a question/);
  assert.match(system, /scout_report \{level: "medium"\}/);
  const kickoff = ciKickoff({ url: "http://127.0.0.1:3000/", projectDir: "/work", mode: "observe", level: "medium", caps: DEFAULT_CAPS, focus: "orders" });
  for (const part of [
    /Target: http:\/\/127\.0\.0\.1:3000\//,
    /\/work/,
    /Level: medium/,
    /Write mode: observe/,
    /Focus: orders/,
    /40 model turns, 1,500,000 tokens and 20 minutes/,
  ])
    assert.match(kickoff, part);
});

// ── the two APIs ────────────────────────────────────────────────────────────

const TOOLS: ToolSpec[] = [{ name: "scout_crawl", description: "crawl", parameters: { type: "object", properties: {} } }];
const O = { baseUrl: "https://api.example.com/v1", model: "m", effort: "low", system: "SYSTEM", tools: TOOLS };

test("anthropic: the request caches the method, carries effort and tools; a reply's tool calls and usage are read", () => {
  const c = new AnthropicConversation(O, "KICKOFF");
  const req = c.request(ANTHROPIC_KEY);
  assert.equal(req.url, "https://api.example.com/v1/messages");
  assert.equal(req.headers["x-api-key"], ANTHROPIC_KEY);
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  const body = req.body as Record<string, any>;
  assert.deepEqual(body.system, [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(body.tools, [{ name: "scout_crawl", description: "crawl", input_schema: { type: "object", properties: {} } }]);
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.deepEqual(body.messages, [{ role: "user", content: "KICKOFF" }]);
  const content = [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: "Crawling first." },
    { type: "tool_use", id: "tu_1", name: "scout_crawl", input: {} },
  ];
  const turn = c.accept({
    content,
    stop_reason: "tool_use",
    usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 20 },
  });
  assert.deepEqual(turn, {
    text: "Crawling first.",
    calls: [{ id: "tu_1", name: "scout_crawl", input: {} }],
    usage: { input: 1050, cachedInput: 900, cacheWrite: 50, output: 20 },
  });
  // The assistant turn goes back as it came, thinking block included; every result in one user message.
  c.addResults([
    { id: "tu_1", text: "ok", isError: false },
    { id: "tu_2", text: "bad", isError: true },
  ]);
  assert.deepEqual(c.messages.slice(1), [
    { role: "assistant", content },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
        { type: "tool_result", tool_use_id: "tu_2", content: "bad", is_error: true },
      ],
    },
  ]);
});

test("anthropic: a pause resumes, a refusal and a cut reply end with a note, a reply with no content is malformed", () => {
  const c = new AnthropicConversation(O, "K");
  assert.equal(c.accept({ content: [], stop_reason: "pause_turn", usage: {} }).resume, true);
  assert.match(c.accept({ content: [], stop_reason: "refusal" }).note ?? "", /declined/);
  assert.match(c.accept({ content: [{ type: "text", text: "…" }], stop_reason: "max_tokens" }).note ?? "", /cut/);
  const before = c.messages.length;
  assert.throws(() => c.accept({ error: { message: "x" } }), MalformedReply);
  assert.equal(c.messages.length, before, "a malformed reply is not added to the conversation");
});

test("openai: the request is stateless, with encrypted reasoning, effort and function tools; items go back verbatim", () => {
  const c = new OpenAIConversation(O, "KICKOFF");
  const req = c.request(OPENAI_KEY);
  assert.equal(req.url, "https://api.example.com/v1/responses");
  assert.equal(req.headers.authorization, `Bearer ${OPENAI_KEY}`);
  const body = req.body as Record<string, any>;
  assert.equal(body.instructions, "SYSTEM");
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.deepEqual(body.tools, [
    { type: "function", name: "scout_crawl", description: "crawl", parameters: { type: "object", properties: {} }, strict: false },
  ]);
  const output = [
    { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "scout_crawl", arguments: "{}" },
    { type: "function_call", id: "fc_2", call_id: "call_2", name: "scout_click", arguments: "{ref: e1" },
  ];
  const turn = c.accept({ output, status: "completed", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 30 } });
  assert.equal(turn.calls.length, 2);
  assert.deepEqual(turn.calls[0], { id: "call_1", name: "scout_crawl", input: {} });
  assert.equal(turn.calls[1].input, undefined);
  assert.match(turn.calls[1].argsError ?? "", /not valid JSON/);
  assert.deepEqual(turn.usage, { input: 1000, cachedInput: 800, cacheWrite: 0, output: 30 });
  c.addResults([
    { id: "call_1", text: "crawled", isError: false },
    { id: "call_2", text: "not run", isError: true },
  ]);
  assert.deepEqual(c.input, [
    { role: "user", content: "KICKOFF" },
    ...output,
    { type: "function_call_output", call_id: "call_1", output: "crawled" },
    { type: "function_call_output", call_id: "call_2", output: "ERROR: not run" },
  ]);
});

test("openai: a message ends the turn, a refusal or a cut reply says so, a reply with no output list is malformed", () => {
  const c = new OpenAIConversation(O, "K");
  const done = c.accept({ output: [{ type: "message", content: [{ type: "output_text", text: "All done." }] }], usage: {} });
  assert.deepEqual(done, { text: "All done.", calls: [], usage: NO_USAGE });
  assert.match(c.accept({ output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }).note ?? "", /declined/);
  assert.match(c.accept({ output: [], status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }).note ?? "", /max_output_tokens/);
  assert.throws(() => c.accept({ choices: [] }), MalformedReply);
  assert.throws(() => c.accept({ output: [], error: { message: "boom" } }), MalformedReply);
});

test("retries: only statuses a retry can change, with capped, jittered, growing waits that honour retry-after", () => {
  for (const s of [408, 409, 429, 500, 502, 503, 529]) assert.ok(retryable(s), String(s));
  for (const s of [400, 401, 403, 404, 422]) assert.ok(!retryable(s), String(s));
  assert.equal(
    backoffMs(1, () => 0),
    500,
  );
  assert.equal(
    backoffMs(1, () => 1),
    1000,
  );
  assert.equal(
    backoffMs(3, () => 1),
    4000,
  );
  assert.equal(
    backoffMs(20, () => 1),
    30_000,
    "capped",
  );
  assert.equal(
    backoffMs(1, () => 0, { retryAfterMs: 7000 }),
    7000,
  );
  assert.equal(
    backoffMs(1, () => 0, { retryAfterMs: 999_999 }),
    30_000,
    "a long retry-after is capped too",
  );
  assert.equal(retryAfterMs("3", 0), 3000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4000), 6000);
  assert.equal(retryAfterMs("soon", 0), undefined);
  assert.equal(errorMessage(401, JSON.stringify({ error: { message: "Invalid key" } })), "HTTP 401: Invalid key");
  assert.equal(errorMessage(502, "<html>bad gateway</html>"), "HTTP 502: <html>bad gateway</html>");
});

// ── the HTTP client, with a fake fetch ──────────────────────────────────────

function fakeFetch(replies: Array<{ status: number; body: unknown; headers?: Record<string, string> } | Error>): { fetch: typeof fetch; calls: number } {
  const state = { calls: 0 } as { fetch: typeof fetch; calls: number };
  state.fetch = (async () => {
    const r = replies[Math.min(state.calls, replies.length - 1)];
    state.calls += 1;
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return state;
}
const OK_REPLY = { output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 5, output_tokens: 1 } };

test("http client: a throttled call is retried after the wait, and succeeds", async () => {
  const f = fakeFetch([
    { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "2" } },
    { status: 200, body: OK_REPLY },
  ]);
  const waits: number[] = [];
  const client = new HttpModelClient(new OpenAIConversation(O, "K"), OPENAI_KEY, { fetch: f.fetch, sleep: async (ms) => void waits.push(ms), random: () => 0 });
  const turn = await client.next(60_000);
  assert.equal(turn.text, "done");
  assert.equal(f.calls, 2);
  assert.deepEqual(waits, [2000]);
});

test("http client: a refused key fails at once, with the API's message; retries are bounded", async () => {
  const refused = fakeFetch([{ status: 401, body: { error: { message: "Incorrect API key provided" } } }]);
  const c1 = new HttpModelClient(new OpenAIConversation(O, "K"), OPENAI_KEY, { fetch: refused.fetch, sleep: async () => {} });
  await assert.rejects(c1.next(60_000), (e: unknown) => e instanceof ProviderError && /HTTP 401: Incorrect API key/.test(e.message));
  assert.equal(refused.calls, 1);

  const down = fakeFetch([{ status: 503, body: "unavailable" }]);
  const c2 = new HttpModelClient(new OpenAIConversation(O, "K"), OPENAI_KEY, { fetch: down.fetch, sleep: async () => {}, random: () => 0 });
  await assert.rejects(c2.next(600_000), (e: unknown) => e instanceof ProviderError && /after 4 attempts/.test(e.message));
  assert.equal(down.calls, MAX_RETRIES + 1);
});

test("http client: a malformed 200 is retried, never run; a network error too", async () => {
  const f = fakeFetch([
    { status: 200, body: "not json" },
    new TypeError("fetch failed"),
    { status: 200, body: { nothing: true } },
    { status: 200, body: OK_REPLY },
  ]);
  const client = new HttpModelClient(new OpenAIConversation(O, "K"), OPENAI_KEY, { fetch: f.fetch, sleep: async () => {}, random: () => 0 });
  assert.equal((await client.next(600_000)).text, "done");
  assert.equal(f.calls, 4);
});

test("http client: a redirect is never followed, and the key is sent once", async () => {
  const inits: RequestInit[] = [];
  const redirecting = (async (_url: string, init: RequestInit) => {
    inits.push(init);
    return new Response("", { status: 307, headers: { location: `https://elsewhere.example/steal?k=${ANTHROPIC_KEY}` } });
  }) as unknown as typeof fetch;
  const client = new HttpModelClient(new AnthropicConversation(O, "K"), ANTHROPIC_KEY, { fetch: redirecting, sleep: async () => {} });
  await assert.rejects(
    client.next(600_000),
    (e: unknown) => e instanceof ProviderError && /^HTTP 307: the API answered with a redirect/.test(e.message) && !e.message.includes("elsewhere"),
  );
  assert.equal(inits.length, 1, "the key is sent exactly once");
  assert.equal(inits[0].redirect, "error");
  // fetch itself refusing the redirect (what undici does with redirect: "error") ends the same way.
  const refused = (async () => {
    throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
  }) as unknown as typeof fetch;
  await assert.rejects(new HttpModelClient(new OpenAIConversation(O, "K"), OPENAI_KEY, { fetch: refused }).next(600_000), ProviderError);
});

test("http client: an attempt slower than its limit is retried while wall time remains", async () => {
  let n = 0;
  const slowThenOk = (async () => {
    n += 1;
    if (n === 1) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    return new Response(JSON.stringify(OK_REPLY), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new HttpModelClient(new OpenAIConversation(O, "K"), OPENAI_KEY, { fetch: slowThenOk, sleep: async () => {}, random: () => 0 });
  assert.equal((await client.next(600_000)).text, "done");
  assert.equal(n, 2);
});

test("http client: wall time running out in a backoff is the time cap, naming the attempts made", async () => {
  let clock = 0;
  const f = fakeFetch([{ status: 503, body: "unavailable" }]);
  const client = new HttpModelClient(new OpenAIConversation(O, "K"), OPENAI_KEY, {
    fetch: f.fetch,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    random: () => 1,
  });
  // Waits of 1s then 2s: the second would end at 3s, past a 2.5s cap.
  await assert.rejects(client.next(2_500), (e: unknown) => e instanceof OutOfTime && /after 2 attempts/.test(e.message));
  assert.equal(f.calls, 2);
  const out = await agentLoop({
    client: new HttpModelClient(new OpenAIConversation(O, "K"), OPENAI_KEY, {
      fetch: fakeFetch([{ status: 503, body: "x" }]).fetch,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      random: () => 1,
    }),
    host: host(),
    tools: LOOP_TOOLS,
    caps: { ...BIG, wallMs: 2_500 },
    log: () => {},
    now: () => clock,
    startedAt: clock,
    projectDir: "/work",
  });
  assert.equal(out.stop, "time");
  assert.equal(ciExitCode(out.stop, true), 0);
});

test("http client: no time left is OutOfTime, not a provider failure", async () => {
  const f = fakeFetch([{ status: 200, body: OK_REPLY }]);
  const client = new HttpModelClient(new OpenAIConversation(O, "K"), OPENAI_KEY, { fetch: f.fetch });
  await assert.rejects(client.next(0), OutOfTime);
  assert.equal(f.calls, 0);
});

// ── the loop, with a scripted model and a fake host ─────────────────────────

/** A model that plays back turns, and records every batch of results it was handed. */
class Scripted implements ModelClient {
  readonly received: ToolOutcome[][] = [];
  calls = 0;
  constructor(private readonly turns: Array<ModelTurn | Error | ((i: number) => ModelTurn)>) {}
  async next(): Promise<ModelTurn> {
    const t = this.turns[Math.min(this.calls, this.turns.length - 1)];
    this.calls += 1;
    if (t instanceof Error) throw t;
    return typeof t === "function" ? t(this.calls) : t;
  }
  addResults(results: readonly ToolOutcome[]): void {
    this.received.push([...results]);
  }
}
const use = (n: number): Usage => ({ input: n, cachedInput: 0, cacheWrite: 0, output: 0 });
const call = (id: string, name: string, input: unknown = {}) => ({ id, name, input });
const host = () => {
  const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    seen,
    call: async (name: string, args: Record<string, unknown>) => {
      seen.push({ name, args });
      if (name === "scout_click") throw new Error("the browser went away");
      return { text: `${name} ran`, isError: false };
    },
  };
};
const BIG: Caps = { turns: 100, tokens: 10_000_000, wallMs: 3_600_000 };
const LOOP_TOOLS: ToolSpec[] = ["scout_crawl", "scout_snapshot", "scout_click"].map((name) => ({
  name,
  description: "",
  parameters: { type: "object", properties: {} },
}));

test("loop: tool calls round-trip, in order, and the model's final reply ends the run", async () => {
  const h = host();
  const model = new Scripted([
    { text: "", calls: [call("a", "scout_crawl"), call("b", "scout_snapshot", { session: "x", full: true })], usage: use(10) },
    { text: "Finished.", calls: [], usage: use(5) },
  ]);
  const out = await agentLoop({ client: model, host: h, tools: LOOP_TOOLS, caps: BIG, log: () => {}, projectDir: "/work" });
  assert.equal(out.stop, "done");
  assert.equal(out.spend.turns, 2);
  assert.equal(out.spend.usage.input, 15);
  assert.deepEqual(h.seen, [
    { name: "scout_crawl", args: {} },
    { name: "scout_snapshot", args: { full: true } },
  ]);
  assert.deepEqual(model.received, [
    [
      { id: "a", isError: false, text: "scout_crawl ran" },
      { id: "b", isError: false, text: "scout_snapshot ran" },
    ],
  ]);
});

test("loop: a malformed reply costs a turn, never the run — each bad call is answered with an error", async () => {
  const h = host();
  const model = new Scripted([
    {
      text: "",
      calls: [
        call("1", "scout_attach", { url: "http://elsewhere.example" }),
        { id: "2", name: "scout_crawl", argsError: "the arguments were not valid JSON" },
        call("3", "scout_crawl", "paths=/a"),
        call("4", "", {}),
        call("5", "scout_click", { ref: "e1" }),
      ],
      usage: use(1),
    },
    { text: "", calls: [], usage: use(1) },
  ]);
  const out = await agentLoop({ client: model, host: h, tools: LOOP_TOOLS, caps: BIG, log: () => {}, projectDir: "/work" });
  assert.equal(out.stop, "done");
  const [results] = model.received;
  assert.deepEqual(
    results.map((r) => r.isError),
    [true, true, true, true, true],
  );
  assert.match(results[0].text, /no tool named "scout_attach"/);
  assert.match(results[1].text, /not valid JSON/);
  assert.match(results[2].text, /must be a JSON object/);
  assert.match(results[4].text, /scout_click failed: the browser went away/);
  assert.deepEqual(
    h.seen.map((s) => s.name),
    ["scout_click"],
    "only the well-formed call reached the server",
  );
});

test("loop: each cap stops it cleanly and names itself", async () => {
  const forever = (u: number) => new Scripted([{ text: "", calls: [call("x", "scout_crawl")], usage: use(u) }]);
  const turns = await agentLoop({ client: forever(1), host: host(), tools: LOOP_TOOLS, caps: { ...BIG, turns: 3 }, log: () => {}, projectDir: "/work" });
  assert.deepEqual([turns.stop, turns.spend.turns], ["turns", 3]);

  const tokens = await agentLoop({ client: forever(400), host: host(), tools: LOOP_TOOLS, caps: { ...BIG, tokens: 1000 }, log: () => {}, projectDir: "/work" });
  assert.deepEqual([tokens.stop, tokens.spend.turns], ["tokens", 3]);

  let clock = 0;
  const ticking = new Scripted([
    () => {
      clock += 25_000;
      return { text: "", calls: [call("x", "scout_crawl")], usage: use(1) };
    },
  ]);
  const time = await agentLoop({
    client: ticking,
    host: host(),
    tools: LOOP_TOOLS,
    caps: { ...BIG, wallMs: 60_000 },
    log: () => {},
    now: () => clock,
    projectDir: "/work",
  });
  assert.deepEqual([time.stop, time.spend.turns], ["time", 3]);

  // The time cap arriving during a model call ends the run the same way.
  const late = await agentLoop({
    client: new Scripted([new OutOfTime("late")]),
    host: host(),
    tools: LOOP_TOOLS,
    caps: BIG,
    log: () => {},
    projectDir: "/work",
  });
  assert.equal(late.stop, "time");
});

test("loop: the time cap reached mid-turn leaves the reply's remaining calls unrun, and no call outlasts it", async () => {
  let clock = 0;
  const timeouts: number[] = [];
  const slowHost = {
    call: async (name: string, _args: Record<string, unknown>, timeoutMs: number) => {
      timeouts.push(timeoutMs);
      clock += 30_000;
      return { text: `${name} ran`, isError: false };
    },
  };
  const model = new Scripted([{ text: "", calls: ["a", "b", "c", "d"].map((id) => call(id, "scout_crawl")), usage: use(1) }]);
  const out = await agentLoop({
    client: model,
    host: slowHost,
    tools: LOOP_TOOLS,
    caps: { ...BIG, wallMs: 70_000 },
    log: () => {},
    now: () => clock,
    projectDir: "/work",
  });
  assert.equal(out.stop, "time");
  assert.deepEqual(timeouts, [70_000, 40_000, 10_000], "each call gets only the time left, with no floor");
  const [results] = model.received;
  assert.deepEqual(
    results.map((r) => [r.id, r.isError]),
    [
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", true],
    ],
  );
  assert.match(results[3].text, /not run: the time cap was reached/);
});

test("loop: at most MAX_TOOL_CALLS_PER_TURN calls run from one reply; the rest are answered as not run", async () => {
  const h = host();
  const many = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 3 }, (_, i) => call(`c${i}`, "scout_crawl"));
  const model = new Scripted([
    { text: "", calls: many, usage: use(1) },
    { text: "", calls: [], usage: use(1) },
  ]);
  await agentLoop({ client: model, host: h, tools: LOOP_TOOLS, caps: BIG, log: () => {}, projectDir: "/work" });
  assert.equal(MAX_TOOL_CALLS_PER_TURN, 16);
  assert.equal(h.seen.length, 16);
  assert.equal(model.received[0].filter((r) => r.isError && /at most 16 tool calls/.test(r.text)).length, 3);
});

test("loop: scout_scan runs on the run's project only", async () => {
  const h = host();
  const tools = [...LOOP_TOOLS, { name: "scout_scan", description: "", parameters: { type: "object", properties: {} } }];
  const model = new Scripted([
    { text: "", calls: [call("s1", "scout_scan", {}), call("s2", "scout_scan", { projectPath: "/etc" })], usage: use(1) },
    { text: "", calls: [], usage: use(1) },
  ]);
  await agentLoop({ client: model, host: h, tools, caps: BIG, log: () => {}, projectDir: "/work" });
  assert.deepEqual(h.seen, [{ name: "scout_scan", args: { projectPath: "/work" } }]);
  assert.match(model.received[0][1].text, /scout_scan was not run: scout_scan may scan only this run's project directory/);
});

test("loop: a provider failure stops the run with its reason, after what was done so far", async () => {
  const model = new Scripted([{ text: "", calls: [call("a", "scout_crawl")], usage: use(3) }, new ProviderError("HTTP 401: bad key")]);
  const out = await agentLoop({ client: model, host: host(), tools: LOOP_TOOLS, caps: BIG, log: () => {}, projectDir: "/work" });
  assert.deepEqual([out.stop, out.stopDetail, out.spend.turns], ["provider-error", "HTTP 401: bad key", 1]);
});

test("loop: a paused turn is resumed without results, and counted", async () => {
  const model = new Scripted([
    { text: "", calls: [], usage: use(1), resume: true },
    { text: "done", calls: [], usage: use(1) },
  ]);
  const out = await agentLoop({ client: model, host: host(), tools: LOOP_TOOLS, caps: BIG, log: () => {}, projectDir: "/work" });
  assert.deepEqual([out.stop, out.spend.turns, model.received.length], ["done", 2, 0]);
});

// ── what a run writes ───────────────────────────────────────────────────────

const finding = (over: Partial<Finding>): Finding => ({
  id: "f1",
  severity: "high",
  category: "functional",
  title: "Save does nothing",
  detail: "",
  url: "http://127.0.0.1:3000/things?x=1",
  state: "s",
  repro: [],
  foundAt: "2026-01-01T00:00:00Z",
  runs: 1,
  ...over,
});

test("findings this run: new ones and ones seen again, never ones only remembered or resolved", () => {
  const before = [finding({ id: "old", runs: 2 }), finding({ id: "seen", runs: 1 })];
  const after = [finding({ id: "old", runs: 2 }), finding({ id: "seen", runs: 2 }), finding({ id: "new" }), finding({ id: "gone", status: "resolved" })];
  assert.deepEqual(
    findingsThisRun(before, after).map((f) => f.id),
    ["seen", "new"],
  );
  assert.deepEqual(readFindings({ findings: [finding({}), { id: 3 }, null, finding({ severity: "urgent" as never })] }).length, 1);
  assert.deepEqual(readFindings("nope"), []);
});

const RESULT = (over: Partial<CiResult> = {}): CiResult => ({
  url: "http://127.0.0.1:3000/",
  provider: "openai",
  model: "gpt-5.6-luna",
  effort: "low",
  mode: "read-only",
  level: "minimal",
  // A fixture, not the defaults: the defaults are spelled out in the options test.
  caps: { turns: 40, tokens: 400_000, wallMs: 20 * 60_000 },
  stop: "tokens",
  contractMet: false,
  spend: { turns: 12, usage: { input: 380_000, cachedInput: 300_000, cacheWrite: 0, output: 21_000 }, startedAt: 0 },
  endedAt: 600_000,
  findings: [
    finding({}),
    finding({ id: "f2", severity: "low", category: "a11y", title: `Field has no label; token ${OPENAI_KEY}` }),
    finding({ id: "f3", severity: "low", category: "visual", title: "Spacing off the grid", tier: "worth_a_look", convention: "a 4px spacing scale" }),
  ],
  ...over,
});

test("summary: says what ended the run and what it spent, lists this run's findings, and prints no key", () => {
  const md = ciSummaryMarkdown(RESULT(), [OPENAI_KEY]);
  assert.match(md, /stopped at the token cap \(400,000 tokens\)\. This run reports; it does not gate\./);
  assert.match(md, /\| Findings this run \| 2 \(1 high, 0 medium, 1 low\), 1 worth a look \|/);
  assert.match(md, /completion contract not met/);
  assert.match(md, /12 turn\(s\), 380,000 tokens in \(300,000 cached\), 21,000 out, 10m 0s, estimated cost \$0\.0472/);
  assert.match(md, /\| high \| functional \| Save does nothing \| \/things\?x=1 \|/);
  assert.match(md, /a defect only if your project uses a 4px spacing scale/);
  assert.ok(!md.includes(OPENAI_KEY));
  const json = JSON.stringify(ciSummaryJson(RESULT(), "9.9.9", [OPENAI_KEY]));
  assert.ok(!json.includes(OPENAI_KEY));
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.stop, { reason: "tokens", text: "stopped at the token cap (400,000 tokens)" });
  assert.deepEqual(parsed.counts, { high: 1, medium: 0, low: 1, worthALook: 1 });
  assert.equal(parsed.usage.estimatedCostUsd.toFixed(4), "0.0472");
});

test("sarif: one result per finding at its severity's level, worth-a-look as a note, fingerprinted by id", () => {
  const sarif = ciSarif(RESULT(), "9.9.9", [OPENAI_KEY]) as any;
  const results = sarif.runs[0].results;
  assert.deepEqual(
    results.map((r: any) => [r.ruleId, r.level]),
    [
      ["finding/functional", "error"],
      ["finding/a11y", "note"],
      ["finding/visual", "note"],
    ],
  );
  assert.equal(results[2].properties.tier, "worth-a-look");
  assert.equal(results[0].locations[0].physicalLocation.artifactLocation.uri, "things?x=1");
  assert.ok(!JSON.stringify(sarif).includes(OPENAI_KEY));
  assert.equal(sarif.runs[0].invocations[0].executionSuccessful, true);
  assert.deepEqual(sarif.runs[0].originalUriBaseIds, { APP: { uri: "http://127.0.0.1:3000/" } }, "locations resolve against the app's origin");
  assert.equal((ciSarif(RESULT({ stop: "provider-error" }), "9.9.9") as any).runs[0].invocations[0].executionSuccessful, false);
});

// ── the GitHub Action (ci/action.yml + action/ci-action.mjs) ─────────────────

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const action = parseYaml(fs.readFileSync(path.join(REPO, "ci", "action.yml"), "utf8")) as Record<string, any>;
const actionInputs = Object.keys(action.inputs as Record<string, unknown>);
const defaultInputs = (): Record<string, string> =>
  Object.fromEntries(Object.entries(action.inputs as Record<string, { default?: string }>).map(([k, v]) => [k, v.default ?? ""]));

test("action: every input that is not the action's own is a `scenescout ci` option, and every option is an input", () => {
  assert.deepEqual(actionInputs.filter((n) => !CI_ACTION_ONLY_INPUTS.includes(n)).sort(), [...CI_OPTION_NAMES].sort());
  assert.deepEqual(
    CI_ACTION_ONLY_INPUTS.filter((n: string) => !actionInputs.includes(n)),
    [],
  );
  for (const secret of ["api-key", "key", "anthropic-api-key", "openai-api-key"]) assert.ok(!actionInputs.includes(secret), `${secret} must never be an input`);
});

test("action: its defaults are the CLI's defaults, and every input reaches the CLI as its option", () => {
  const viaAction = parseCiArgs(ciArgs({ ...defaultInputs(), url: "http://127.0.0.1:3000" }).slice(1), "/work");
  const direct = parseCiArgs(["http://127.0.0.1:3000", "--mode=read-only", "--browser=chromium"], "/work");
  assert.ok(viaAction.ok && direct.ok);
  assert.deepEqual(viaAction.options, direct.options);
  const all = ciArgs({ ...defaultInputs(), url: "http://127.0.0.1:3000", provider: "openai", "max-turns": "5", cli: "dist/cli.js", "upload-sarif": "true" });
  assert.deepEqual(all.slice(0, 2), ["ci", "http://127.0.0.1:3000"]);
  const parsed = parseCiArgs(all.slice(1), "/work");
  assert.ok(parsed.ok && parsed.options.provider === "openai" && parsed.options.caps.turns === 5);
  for (const own of CI_ACTION_ONLY_INPUTS.filter((n: string) => n !== "url")) assert.ok(!all.some((a: string) => a.startsWith(`--${own}`)), own);
  assert.throws(() => ciArgs({ url: " " }), /url input is required/);
  assert.equal(ciOutDirFor({ out: "", project: "site" }, "/work"), path.resolve("/work", "site", ".scenescout", "ci"));
  assert.ok(hasCiCommand(fs.readFileSync(path.join(REPO, "src", "cli.ts"), "utf8")), "the CLI's usage no longer has the line the action looks for");
});

test("action: findings never fail the step; only a run that could not run does", () => {
  assert.deepEqual(ciVerdict({ exitCode: "0", url: "u", error: "" }), { exit: 0, annotation: null });
  const failed = ciVerdict({ exitCode: "2", url: "u", error: "the model's API failed: HTTP 401" });
  assert.equal(failed.exit, 2);
  assert.match(failed.annotation ?? "", /could not run::No report for u: the model's API failed: HTTP 401\. This is a setup problem/);
  assert.equal(ciVerdict({ exitCode: NaN, url: "u", error: "" }).exit, 2);
  assert.deepEqual(ciSummaryOutputs(ciSummaryJson(RESULT(), "9.9.9")), {
    stop: "tokens",
    high: "1",
    medium: "0",
    low: "1",
    "worth-a-look": "1",
    turns: "12",
    tokens: "401000",
    "estimated-cost": String(estimateCost("gpt-5.6-luna", RESULT().spend.usage)),
  });
  assert.equal(ciSummaryOutputs({}), null);
  // Every output the run step sets is declared, and read from that step.
  const declared = action.outputs as Record<string, { value: string }>;
  for (const name of ["exit-code", "stop", "high", "medium", "low", "worth-a-look", "turns", "tokens", "estimated-cost", "report", "summary", "json", "sarif"])
    assert.equal(declared[name]?.value, `\${{ steps.run.outputs.${name} }}`, name);
});

test("action: third-party steps are pinned by commit, and no input is pasted into a script", () => {
  const steps = action.runs.steps as Array<{ uses?: string; run?: string }>;
  for (const s of steps) if (s.uses) assert.match(s.uses, /@[0-9a-f]{40}$/, s.uses);
  for (const s of steps) if (s.run) assert.ok(!/\$\{\{\s*inputs\./.test(s.run), s.run);
});

test("action: this repository runs it against the demo app and a stand-in API, gated by the required check, with no real key", () => {
  const workflow = parseYaml(fs.readFileSync(path.join(REPO, ".github", "workflows", "test.yml"), "utf8")) as Record<string, any>;
  const jobs = workflow.jobs as Record<
    string,
    { needs?: string[]; env?: Record<string, string>; steps?: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }> }
  >;
  const found = Object.entries(jobs).find(([, j]) => j.steps?.some((s) => s.uses === "./ci"));
  assert.ok(found, "no job in test.yml runs the ci action (uses: ./ci)");
  const [name, job] = found;
  assert.ok(jobs.test.needs?.includes(name), `the required "test" job does not need ${name}`);
  const step = job.steps!.find((s) => s.uses === "./ci")!;
  assert.equal(step.with?.cli, "dist/cli.js", "the dogfood runs the CLI built from this commit");
  assert.equal(String(step.with?.["upload-sarif"]), "false", "the demo's findings must never become this repository's code-scanning alerts");
  assert.ok(
    checkBaseUrl(String(step.with?.["base-url"])).ok && /^http:\/\/127\.0\.0\.1:/.test(String(step.with?.["base-url"])),
    "the stand-in API is on this runner",
  );
  const key = job.env?.OPENAI_API_KEY ?? "";
  assert.ok(key.length >= 8 && !/\$\{\{/.test(key), "a dummy key from the job's env, never a secret");
  assert.ok(
    job.steps!.some((s) => /fake-model-api\.mjs/.test(s.run ?? "")),
    "the stand-in API is started",
  );
  assert.ok(
    job.steps!.some((s) => /grep -rF "\$OPENAI_API_KEY"/.test(s.run ?? "")),
    "the job looks for the key in what the run wrote",
  );
});

test("benchmark workflow: started by hand only, reads the repository and nothing more, and uploads what bench reads", () => {
  const wf = parseYaml(fs.readFileSync(path.join(REPO, ".github", "workflows", "ci-benchmark.yml"), "utf8")) as Record<string, any>;
  assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"], "never pull_request or pull_request_target: the job holds the key");
  assert.deepEqual(wf.permissions, { contents: "read" });
  const jobs = Object.values(
    wf.jobs as Record<
      string,
      { permissions?: unknown; steps: Array<{ uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }> }
    >,
  );
  for (const job of jobs) assert.equal(job.permissions, undefined, "no job widens the permissions");
  const steps = jobs.flatMap((j) => j.steps);
  const run = steps.find((s) => s.uses === "./ci");
  assert.ok(run, "it runs the ci action from this commit");
  assert.equal(run.with?.cli, "dist/cli.js");
  assert.equal(run.env?.OPENAI_API_KEY, "${{ secrets.OPENAI_API_KEY }}", "the key comes from the secret, through env");
  const upload = steps.findIndex((s) => /^actions\/upload-artifact@/.test(s.uses ?? ""));
  const keyCheck = steps.findIndex((s) => /grep -rlF -- "\$OPENAI_API_KEY"/.test(s.run ?? ""));
  assert.ok(keyCheck >= 0 && upload > keyCheck, "the key check runs before the upload");
  assert.equal(steps[upload].with?.path, "${{ steps.app.outputs.project }}", "the project directory itself, so it unpacks to <dir>/.scenescout/memory.json");
  assert.equal(String(steps[upload].with?.["include-hidden-files"]), "true");
  for (const s of steps) assert.ok(!/^\s*(npm run bench|npx tsx scripts\/bench|git (commit|push))/m.test(s.run ?? ""), "it scores and commits nothing");
});
