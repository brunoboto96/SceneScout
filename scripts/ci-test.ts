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
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { asCrlf, asLf, joinPath, readText, samePlace } from "./checkout.ts";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CI_ACTION_ONLY_INPUTS, ciArgs, ciOutDirFor, ciSummaryOutputs, ciVerdict, hasCiCommand } from "../action/ci-action.mjs";
import {
  agentLoop,
  captureShots,
  ciClient,
  httpClient,
  HttpModelClient,
  httpJudgeAsk,
  judgeHandler,
  MAX_RETRIES,
  MAX_TOOL_CALLS_PER_TURN,
  OutOfTime,
  ProviderError,
  runCi,
  toolHost,
  type JudgeCalls,
  type ModelClient,
  type ToolHost,
} from "../src/ci-run.ts";
import { LANE_RULES, MAX_LANES } from "../src/engine/brief.ts";
import {
  ciLaneKickoff,
  ciLaneSystemPrompt,
  crawlFoundNothing,
  crawlNotes,
  LANE_TOOLS,
  laneSessions,
  mergeLaneStops,
  planCiLanes,
  PLANNER_SESSION,
} from "../src/engine/ci-lanes.ts";
import {
  clientAnswersJudge,
  DedupJudge,
  JUDGE_CALL_MS,
  JUDGE_MAX_OUTPUT_TOKENS,
  JUDGE_SYSTEM,
  JUDGE_TOOL,
  judgeSamplingParams,
  samplingAsk,
} from "../src/engine/dedup.ts";
import {
  CAPTURE_MARGIN,
  captureClip,
  capturedName,
  captureFileName,
  captureResultText,
  describePicture,
  EVIDENCE_LIMITS,
  evidenceFrame,
  evidenceSettings,
  findingPicturePath,
  isCiEnv,
  parseCaptureResult,
  readFindingPicture,
  rebaseUrl,
  recordChoice,
  returnsInline,
} from "../src/engine/capture.ts";
import { decodePng, diffImages, encodePng, encodePngCompact, fitPicture, FIT_MIN_SIDE, isPng, shrinkImage, type RgbaImage } from "../src/engine/png.ts";
import {
  CAPTURE_TOOLS,
  CI_CAPTURE_NAME,
  ciCaptureKickoff,
  ciCaptureSystemPrompt,
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
  attachFailure,
  DEFAULT_CAPS,
  dedupModeFromEnv,
  detectProvider,
  judgeEffort,
  judgeKeyConfig,
  estimateCost,
  findingsThisRun,
  MAX_CI_LANES,
  newBudget,
  NO_USAGE,
  parseCiArgs,
  readFindings,
  REDACTED_KEY,
  resolvePrice,
  redactKeys,
  secretValues,
  settleTurn,
  takeTurn,
  toolResultText,
  usageLine,
  wallLeftMs,
  type Caps,
  type CiResult,
  type StopReason,
  type Spend,
  type ToolSpec,
  type Usage,
} from "../src/engine/ci.ts";
import { MemoryStore, type Finding } from "../src/engine/memory.ts";
import {
  appendRows,
  compareVersions,
  decideRun,
  parseResults,
  parseRunSummary,
  renderTable,
  replaceTable,
  resultRow,
  TABLE_END,
  TABLE_START,
  type CiResultRow,
} from "./bench/ci-results.ts";
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

test("options: the defaults are the agreed caps, read-only, medium, and the dedup judge", () => {
  const p = parseCiArgs(["http://127.0.0.1:3000"], "/work");
  assert.ok(p.ok);
  assert.deepEqual(p.options, {
    url: "http://127.0.0.1:3000/",
    projectDir: "/work",
    caps: { turns: 80, tokens: 3_000_000, wallMs: 20 * 60_000 },
    lanes: 2,
    mode: "read-only",
    level: "medium",
    dedup: "judge",
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
      "--lanes=3",
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
      "--dedup",
      "rule",
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
    lanes: 3,
    price: { input: 0.5, cachedInput: 0.05, output: 2 },
    mode: "safe-write",
    level: "medium",
    focus: "the order form",
    storageStatePath: "/work/auth/user.json",
    browser: "webkit",
    dedup: "rule",
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
  assert.match(bad([u, "--dedup=model"]), /--dedup must be one of rule, judge/);
  assert.match(bad([u, "--lanes=0"]), /--lanes must be a whole number from 1 to 8/);
  assert.match(bad([u, "--lanes=9"]), /--lanes must be a whole number from 1 to 8/);
  assert.match(bad([u, "--lanes=2.5"]), /--lanes must be a whole number/);
});

test("lanes: shared caps need a turn per lane, and a run that shows one element takes none", () => {
  const u = "http://127.0.0.1:3000";
  const parse = (args: string[]) => parseCiArgs([u, ...args], "/work");
  const four = parse(["--lanes", "4"]);
  assert.ok(four.ok && four.options.lanes === 4 && four.options.caps.turns === 80, "the caps are not multiplied by the lanes");
  const short = parse(["--lanes=4", "--max-turns=3"]);
  assert.ok(!short.ok && /--lanes 4 needs --max-turns of at least 4/.test(short.error), JSON.stringify(short));
  assert.ok(parse(["--lanes=4", "--max-turns=4"]).ok, "exactly one turn each is allowed");
  const show = parse(["--lanes=2", "--show", "the Save button"]);
  assert.ok(!show.ok && /--show explores nothing/.test(show.error), JSON.stringify(show));
  const oneLane = parse(["--lanes=1", "--show", "the Save button"]);
  assert.ok(oneLane.ok && oneLane.options.lanes === 1, "one lane is the single loop, which a capture is");
  const showDefault = parse(["--show", "the Save button"]);
  assert.ok(showDefault.ok && showDefault.options.lanes === 1, "without --lanes, a capture runs as the single loop rather than failing on the default split");
  const oneTurn = parse(["--max-turns=1"]);
  assert.ok(oneTurn.ok && oneTurn.options.lanes === 1, "without --lanes, the default split never asks for more lanes than turns");
  const defaultSplit = parse([]);
  assert.ok(defaultSplit.ok && defaultSplit.options.lanes === 2, "the default is two lanes");
  assert.equal(MAX_CI_LANES, MAX_LANES, "the bound is scout_lane_brief's, since the split is the same");
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
  assert.deepEqual(openai.resolved, { provider: "openai", model: "gpt-6-luna", effort: "low", baseUrl: "https://api.openai.com/v1" });
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

test("the server's environment has no key in it, no live view, and opens nothing in a browser unless the user set it", () => {
  const env = childEnv({ OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY, PATH: "/bin", HOME: "/h" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", SCENESCOUT_LIVE: "off", SCENESCOUT_OPEN: "none", SCENESCOUT_EVIDENCE: "file" });
  assert.equal(childEnv({ SCENESCOUT_OPEN: "" }).SCENESCOUT_OPEN, "none", "set but empty is unset");
  assert.equal(childEnv({ SCENESCOUT_OPEN: "report" }).SCENESCOUT_OPEN, "report", "a user's setting wins");
  // The loop is text-only, so a finding's picture is kept on file; a job that chose otherwise keeps its choice.
  assert.equal(childEnv({ SCENESCOUT_EVIDENCE: "off" }).SCENESCOUT_EVIDENCE, "off");
  assert.equal(childEnv({ SCENESCOUT_EVIDENCE: " " }).SCENESCOUT_EVIDENCE, "file");
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

test("cost: the default OpenAI model is costed at its published price; the previous default still is", () => {
  const u: Usage = { input: 1_000_000, cachedInput: 500_000, cacheWrite: 0, output: 100_000 };
  assert.deepEqual(resolvePrice("gpt-6-luna"), { input: 0.1, cachedInput: 0.01, output: 0.5 });
  // 500k plain at $0.10/M + 500k cached at $0.01/M + 100k out at $0.50/M = 0.05 + 0.005 + 0.05
  assert.equal(estimateCost("gpt-6-luna", u)!.toFixed(4), "0.1050");
  // The documented bounds at the 1.5M cap: all of it uncached with 60k out, and 80% cached with 20k out.
  assert.equal(estimateCost("gpt-6-luna", { input: 1_500_000, cachedInput: 0, cacheWrite: 0, output: 60_000 })!.toFixed(2), "0.18");
  assert.equal(estimateCost("gpt-6-luna", { input: 1_500_000, cachedInput: 1_200_000, cacheWrite: 0, output: 20_000 })!.toFixed(3), "0.052");
  assert.notEqual(estimateCost("gpt-5.6-luna", u), null, "an explicit --model gpt-5.6-luna is still costed");
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
  // Resolved the way the platform resolves it: on Windows "/work/site" is a path on the current drive.
  const site = path.resolve("/work/site");
  assert.deepEqual(guardToolArgs("scout_scan", {}, "/work/site"), { ok: true, args: { projectPath: site } });
  assert.deepEqual(guardToolArgs("scout_scan", { projectPath: `${site}${path.sep}` }, "/work/site"), { ok: true, args: { projectPath: site } });
  assert.deepEqual(guardToolArgs("scout_scan", { projectPath: "." }, "/work/site"), { ok: true, args: { projectPath: site } });
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
    /80 model turns, 3,000,000 tokens and 20 minutes/,
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
  assert.deepEqual(h.seen, [{ name: "scout_scan", args: { projectPath: path.resolve("/work") } }]);
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

// ── lanes: the split, the shared caps, the merge ────────────────────────────

/** What a planner's scout_crawl prints, in the engine's own format: route lines, then the problem list, then coverage. */
const CRAWL_TEXT = [
  "CRAWL of 6 route(s):",
  "/orders — 200 · 14 el · 2 no-testid",
  "/orders/new — 200 · 9 el",
  "/stock — 500 · 3 el · 1⚠",
  "/reports — LOAD FAILED",
  "/settings — 200 · 0 el · DEAD-END",
  "/elsewhere — SKIPPED (off-origin)",
  "",
  "PROBLEM ROUTES (3):",
  "/stock",
  "    console-error: Failed to load resource: the server responded with a status of 500",
  "/reports: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/reports",
  "/settings → dead end",
  "",
  "Routes visited: 6/7 — still unvisited: /reports",
  "Take scout_snapshot to inspect the current page, or navigate into a problem route.",
].join("\n");
const TARGET = "http://127.0.0.1:3000/";

test("lanes: the planning crawl's routes, each with what the crawl said about it", () => {
  const notes = crawlNotes(CRAWL_TEXT);
  assert.deepEqual([...notes.keys()], ["/orders", "/orders/new", "/stock", "/reports", "/settings"], "an off-origin path is not the app's");
  assert.deepEqual(notes.get("/stock"), [
    "/stock — 500 · 3 el · 1⚠",
    "/stock",
    "    console-error: Failed to load resource: the server responded with a status of 500",
  ]);
  assert.deepEqual(notes.get("/reports"), ["/reports — LOAD FAILED", "/reports: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/reports"]);
  assert.deepEqual(notes.get("/settings"), ["/settings — 200 · 0 el · DEAD-END", "/settings → dead end"]);
  // The contrast: a healthy route carries its own line and nothing from the problem list.
  assert.deepEqual(notes.get("/orders"), ["/orders — 200 · 14 el · 2 no-testid"]);
  assert.equal(crawlNotes("All crawled routes healthy.").size, 0);

  assert.equal(crawlFoundNothing(CRAWL_TEXT), false);
  assert.equal(crawlFoundNothing("Nothing to crawl: every known route has been visited. Use scout_coverage for remaining unexercised elements."), true);
  assert.equal(crawlFoundNothing("Nothing new to crawl. 1 route(s) failed to load earlier in this session and are still unvisited: /reports."), true);
  assert.equal(crawlFoundNothing("[session default · anonymous]\nNo routes to crawl yet: no scanned or link-discovered routes."), true);
});

test("lanes: the split is brief.ts's — whole modules per lane, every route once, sessions of their own on the target's origin", () => {
  const plan = planCiLanes({ target: TARGET, notes: crawlNotes(CRAWL_TEXT), count: 2, mode: "read-only", focus: "the order form" });
  assert.equal(plan.oneLoop, undefined);
  assert.equal(plan.lanes.length, 2);
  const routes = plan.lanes.flatMap((l) => l.routes).sort();
  assert.deepEqual(routes, ["/", "/orders", "/orders/new", "/reports", "/settings", "/stock"], "the page the run attached on is a route too");
  const modules = plan.lanes.flatMap((l) => l.modules);
  assert.equal(new Set(modules).size, modules.length, "no module is in two lanes");
  assert.deepEqual(
    plan.lanes.map((l) => [l.session, l.url]),
    [
      ["orders+1", "http://127.0.0.1:3000/orders"],
      ["lane-2+2", "http://127.0.0.1:3000/"],
    ],
  );
  assert.ok(
    plan.lanes.every((l) => l.session !== PLANNER_SESSION),
    "no lane is the planner's session",
  );
  // A route written like a host stays a path on the target's origin.
  const odd = planCiLanes({
    target: TARGET,
    notes: crawlNotes("CRAWL of 2 route(s):\n//elsewhere.example/x — 200 · 1 el\n/orders — 200 · 1 el"),
    count: 3,
    mode: "read-only",
  });
  assert.ok(odd.lanes.length >= 2 && odd.lanes.every((l) => new URL(l.url).origin === "http://127.0.0.1:3000"), JSON.stringify(odd.lanes.map((l) => l.url)));
  assert.match(plan.lanes[0].objective, /^Own \/orders and \/settings — the order form$/);
  // Each lane is handed what the crawl saw on its own routes, and only those.
  assert.ok(plan.lanes[1].crawl.some((l) => /^\/stock — 500/.test(l)) && plan.lanes[1].crawl.some((l) => /console-error/.test(l)));
  assert.ok(!plan.lanes[0].crawl.some((l) => /stock|reports/.test(l)), plan.lanes[0].crawl.join("\n"));

  // Nothing to split: one lane asked, or every route in one module (the target is under /orders here).
  assert.match(planCiLanes({ target: TARGET, notes: crawlNotes(CRAWL_TEXT), count: 1, mode: "read-only" }).oneLoop ?? "", /one lane was asked for/);
  const oneModule = planCiLanes({
    target: "http://127.0.0.1:3000/orders",
    notes: crawlNotes("CRAWL of 1 route(s):\n/orders/2 — 200 · 3 el"),
    count: 4,
    mode: "read-only",
  });
  assert.deepEqual(oneModule.lanes, []);
  assert.match(oneModule.oneLoop ?? "", /found 2 route\(s\), all in one module \(\/orders\)/);
  // A planning crawl that failed is the reason given, not the app; one that found routes before failing is planned on.
  const failed = planCiLanes({ target: TARGET, notes: new Map(), count: 2, mode: "read-only", planningFailed: "the planning crawl failed: timed out" });
  assert.equal(failed.oneLoop, "the planning crawl failed: timed out, so there was nothing to split");
  assert.equal(
    planCiLanes({ target: TARGET, notes: crawlNotes(CRAWL_TEXT), count: 2, mode: "read-only", planningFailed: "the planning crawl failed: timed out" }).lanes
      .length,
    2,
  );
});

test("lanes: a lane's session name is its own, never the planner's or another lane's, and at most 40 characters", () => {
  assert.deepEqual(laneSessions(["orders", "orders", "default", "stock"]), ["orders", "orders-2", "default-3", "stock"]);
  const long = "x".repeat(40);
  const named = laneSessions([long, long]);
  assert.equal(named[0], long);
  assert.ok(named[1] !== long && named[1].length <= 40 && named[1].endsWith("-2"), named[1]);
});

test("lanes: the caps are the run's — a turn is taken before its call, given back when the call fails, and spent once it returns", () => {
  const b = newBudget({ turns: 3, tokens: 1000, wallMs: 60_000 }, 0);
  for (let i = 0; i < 3; i++) assert.equal(takeTurn(b, 0), null);
  assert.equal(takeTurn(b, 0), "turns", "three calls under way hold all three turns before any has returned");
  settleTurn(b); // one call failed: not counted, and its turn goes back
  assert.deepEqual([b.turns, b.inFlight], [0, 2]);
  assert.equal(takeTurn(b, 0), null);
  for (let i = 0; i < 3; i++) settleTurn(b, use(400));
  assert.deepEqual([b.turns, b.inFlight, b.usage.input], [3, 0, 1200]);
  assert.equal(takeTurn(b, 0), "tokens", "1,200 of 1,000 tokens: the token cap is checked before the turn cap, as capReached does");
  assert.equal(takeTurn(newBudget({ turns: 3, tokens: 1000, wallMs: 60_000 }, 0), 60_000), "time");
  assert.throws(
    () => settleTurn(newBudget({ turns: 3, tokens: 1000, wallMs: 60_000 }, 0), use(1)),
    /settleTurn without a turn taken/,
    "a settle nobody took a turn for is a bug, not a turn",
  );
});

test("lanes: loops drawing on one budget make the run's turns between them, not each", async () => {
  const caps: Caps = { turns: 5, tokens: 10_000_000, wallMs: 3_600_000 };
  const budget = newBudget(caps, Date.now());
  const forever = () => new Scripted([{ text: "", calls: [call("x", "scout_crawl")], usage: use(1) }]);
  const [a, b] = await Promise.all(
    [forever(), forever()].map((client) => agentLoop({ client, host: host(), tools: LOOP_TOOLS, caps, budget, log: () => {}, projectDir: "/work" })),
  );
  assert.equal(a.spend.turns + b.spend.turns, 5, "five turns between the two loops, as one loop would get");
  assert.ok(a.spend.turns >= 2 && b.spend.turns >= 2, `both loops had turns: ${a.spend.turns} and ${b.spend.turns}`);
  assert.deepEqual([a.stop, b.stop], ["turns", "turns"]);
  assert.deepEqual([budget.turns, budget.usage.input, budget.inFlight], [5, 5, 0]);
});

test("lanes: a lane's calls go to its own session, whatever the model names; a tool that takes no session gets none", async () => {
  const h = host();
  const tools = [...LOOP_TOOLS, { name: "scout_scan", description: "", parameters: { type: "object", properties: {} } }];
  const model = new Scripted([
    { text: "", calls: [call("a", "scout_snapshot", { session: "default" }), call("b", "scout_scan", {}), call("c", "scout_crawl")], usage: use(1) },
    { text: "done", calls: [], usage: use(1) },
  ]);
  await agentLoop({
    client: model,
    host: h,
    tools,
    caps: BIG,
    log: () => {},
    projectDir: "/work",
    session: { name: "orders", tools: new Set(["scout_snapshot", "scout_crawl"]) },
  });
  assert.deepEqual(h.seen, [
    { name: "scout_snapshot", args: { session: "orders" } },
    { name: "scout_scan", args: { projectPath: path.resolve("/work") } },
    { name: "scout_crawl", args: { session: "orders" } },
  ]);
});

test("lanes: every lane gets the same method and rules, and a first message of its own", () => {
  const sys = ciLaneSystemPrompt("THE METHOD", { mode: "read-only", level: "medium" });
  assert.ok(sys.startsWith("THE METHOD\n\n---"));
  for (const rule of LANE_RULES) assert.ok(sys.includes(`- ${rule}`), `the lane prompt drops a lane rule: ${rule.slice(0, 50)}`);
  assert.match(sys, /scout_playbook and scout_report are not available/);
  assert.match(sys, /The run writes one report for every lane once all are done/);
  assert.deepEqual(
    [...LANE_TOOLS],
    CI_TOOLS.filter((t) => t !== "scout_report"),
    "a lane has every exploring tool but the report",
  );
  const plan = planCiLanes({ target: TARGET, notes: crawlNotes(CRAWL_TEXT), count: 2, mode: "read-only" });
  const kick = (i: number) =>
    ciLaneKickoff({ lane: plan.lanes[i], laneCount: 2, url: TARGET, projectDir: "/work", mode: "read-only", level: "medium", caps: DEFAULT_CAPS });
  assert.match(kick(0), /as lane "orders\+1", one of 2 running at once/);
  assert.match(kick(0), /Your routes \(3\): \/orders, \/orders\/new, \/settings/);
  assert.match(kick(0), /Budget: the run's 80 model turns, 3,000,000 tokens and 20 minutes are shared by the 2 lanes: plan on about 40 turns/);
  assert.match(kick(1), /What the planning crawl saw on your routes:\n {2}\/reports — LOAD FAILED/);
  assert.doesNotMatch(kick(0), /\/stock/, "a lane is not told about another lane's routes");
});

test("lanes: how the lanes' endings become the run's", () => {
  const lane = (session: string, stop: StopReason, attached = true, stopDetail?: string) => ({
    session,
    stop,
    attached,
    ...(stopDetail ? { stopDetail } : {}),
  });
  const cases: Array<[ReturnType<typeof lane>[], { stop: StopReason; stopDetail?: string }]> = [
    [[lane("a", "done"), lane("b", "done")], { stop: "done" }],
    [[lane("a", "done"), lane("b", "turns")], { stop: "turns" }],
    [[lane("a", "turns"), lane("b", "time")], { stop: "time" }],
    [[lane("a", "tokens"), lane("b", "turns")], { stop: "tokens" }],
    // A provider failure in any lane is what the workflow must fix.
    [[lane("a", "done"), lane("b", "provider-error", true, "HTTP 401: bad key")], { stop: "provider-error", stopDetail: "lane b: HTTP 401: bad key" }],
    // A lane that could not attach does not change how the others ended, but is named.
    [[lane("a", "done"), lane("b", "could-not-start", false, "net::ERR")], { stop: "done", stopDetail: "1 of 2 lanes could not attach: b" }],
    [[lane("a", "turns"), lane("b", "could-not-start", false)], { stop: "turns", stopDetail: "1 of 2 lanes could not attach: b" }],
    // A lane that broke after attaching: the run could not finish, whatever the others did.
    [
      [lane("a", "done"), lane("b", "could-not-start", true, "the lane failed: boom")],
      { stop: "could-not-start", stopDetail: "lane b: the lane failed: boom" },
    ],
    [
      [lane("a", "could-not-start", false, "net::ERR"), lane("b", "could-not-start", false)],
      { stop: "could-not-start", stopDetail: "no lane could attach (a: net::ERR)" },
    ],
    [[lane("a", "time", false), lane("b", "time", false)], { stop: "time" }],
    // The time cap left one lane no time to attach: a cap ended part of the exploration.
    [[lane("a", "done"), lane("b", "time", false)], { stop: "time" }],
  ];
  for (const [lanes, expected] of cases) assert.deepEqual(mergeLaneStops(lanes), expected, JSON.stringify(lanes));
});

/**
 * A stand-in for the MCP server with no browser: sessions that attach and
 * close, a planner's crawl, findings filed into the project's real memory
 * store (so its dedup is the one a run gets), and a report file. As in the
 * server, a call that names no session goes to whichever attached last.
 */
function standInServer(
  projectDir: string,
  o: {
    crawl: string;
    failAttach?: (url: string, session: string) => boolean;
    failNavigate?: (url: string) => boolean;
    /** What a successful scout_navigate returns, when a test needs it to say more than the URL. */
    navigateText?: (url: string, session: string) => string;
    onCrawl?: () => void;
  },
) {
  fs.mkdirSync(projectDir, { recursive: true });
  const store = new MemoryStore(projectDir);
  const calls: Array<{ name: string; session: string; args: Record<string, unknown> }> = [];
  let active = PLANNER_SESSION;
  let crawled = false;
  const withSession = [
    "scout_attach",
    "scout_close",
    "scout_crawl",
    "scout_snapshot",
    "scout_navigate",
    "scout_click",
    "scout_finding",
    "scout_coverage",
    "scout_report",
  ];
  const listed = [...withSession, "scout_scan"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: withSession.includes(name) ? { session: { type: "string" } } : { projectPath: { type: "string" } } },
  }));
  const host: ToolHost = {
    tools: async () => listed,
    call: async (name, args) => {
      const session = typeof args.session === "string" ? args.session : active;
      calls.push({ name, session, args });
      switch (name) {
        case "scout_attach":
          if (o.failAttach?.(String(args.url), session)) return { text: "ERROR: page.goto: net::ERR_CONNECTION_REFUSED", isError: true };
          if (typeof args.session === "string") active = args.session;
          return { text: `Attached ${session} on ${String(args.url)}`, isError: false };
        case "scout_navigate":
          if (o.failNavigate?.(String(args.target))) return { text: "ERROR: page.goto: net::ERR_ABORTED", isError: true };
          return { text: o.navigateText?.(String(args.target), session) ?? `URL: ${String(args.target)}`, isError: false };
        case "scout_crawl": {
          const first = !crawled;
          crawled = true;
          o.onCrawl?.();
          return { text: first ? o.crawl : "Nothing to crawl: every known route has been visited.", isError: false };
        }
        case "scout_finding": {
          const [f, isNew] = store.addFinding({
            severity: args.severity as Finding["severity"],
            category: args.category as Finding["category"],
            title: String(args.title),
            detail: String(args.detail ?? ""),
            ...(typeof args.evidence === "string" ? { evidence: args.evidence } : {}),
            url: `http://127.0.0.1:3000/${session}`,
            state: session,
            session,
          });
          return { text: isNew ? `Finding recorded: ${f.title} (id ${f.id})` : `Not recorded as new: merged into existing finding ${f.id}`, isError: false };
        }
        case "scout_report":
          fs.writeFileSync(path.join(projectDir, ".scenescout", "report.md"), `# SceneScout Report\n\nWritten from ${session}.\n`);
          return { text: `Report written from ${session}.`, isError: false };
        default:
          return { text: `${name} ran in ${session}`, isError: false };
      }
    },
    close: async () => {},
  };
  return { host, calls };
}

/** runCi with no browser and no network, and nothing appended to a real job summary. */
async function runStandIn(
  args: string[],
  projectDir: string,
  server: ReturnType<typeof standInServer>,
  makeClient: (system: string, tools: readonly ToolSpec[], kickoff: string) => ModelClient,
  secrets: readonly string[] = [],
) {
  const parsed = parseCiArgs([TARGET, "--project", projectDir, ...args], projectDir);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_STEP_SUMMARY;
  try {
    const resolved = { provider: "openai" as const, model: "gpt-6-luna", effort: "low", baseUrl: "https://api.invalid/v1" };
    const lines: string[] = [];
    const run = await runCi(parsed.options, resolved, {
      makeClient,
      version: "0.0.0-test",
      secrets,
      startHost: async () => server.host,
      log: (l) => lines.push(l),
    });
    const out = path.join(projectDir, ".scenescout", "ci");
    return {
      ...run,
      lines,
      json: JSON.parse(fs.readFileSync(path.join(out, "ci.json"), "utf8")),
      summary: fs.readFileSync(path.join(out, "summary.md"), "utf8"),
    };
  } finally {
    if (summary !== undefined) process.env.GITHUB_STEP_SUMMARY = summary;
  }
}

const laneOf = (kickoff: string): string | undefined => /as lane "([^"]+)"/.exec(kickoff)?.[1];

test("lanes: a run split in two plans, runs both lanes at once on their own sessions, and folds them into one report", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-"));
  try {
    const server = standInServer(dir, { crawl: CRAWL_TEXT });
    const systems = new Set<string>();
    const kickoffs: string[] = [];
    const makeClient = (system: string, tools: readonly ToolSpec[], kickoff: string): ModelClient => {
      systems.add(system);
      kickoffs.push(kickoff);
      assert.ok(!tools.some((t) => t.name === "scout_report"), "a lane is not given the report");
      const lane = laneOf(kickoff) ?? "?";
      // Both lanes meet the same failing endpoint, and each has one defect of its own.
      return new Scripted([
        {
          text: "",
          calls: [
            call("s", "scout_snapshot"),
            call("f", "scout_finding", {
              severity: "high",
              category: "http-error",
              title: `Saving fails on ${lane}`,
              detail: "d",
              evidence: "POST /api/things 500",
            }),
          ],
          usage: use(100),
        },
        {
          text: "",
          calls: [call("g", "scout_finding", { severity: "low", category: "a11y", title: `A field on ${lane} has no label`, detail: "d" })],
          usage: use(100),
        },
        { text: `Lane ${lane} is done.`, calls: [], usage: use(100) },
      ]);
    };
    const run = await runStandIn(["--lanes", "2"], dir, server, makeClient);
    assert.deepEqual([run.result.stop, run.exitCode], ["done", 0], run.lines.join("\n"));
    assert.equal(systems.size, 1, "every lane gets the same system prompt, so the provider caches it once");
    assert.deepEqual(kickoffs.map(laneOf).sort(), ["lane-2+2", "orders+1"]);

    const calls = server.calls;
    const at = (pred: (c: (typeof calls)[number]) => boolean) => calls.findIndex(pred);
    const crawl = at((c) => c.name === "scout_crawl" && c.session === PLANNER_SESSION);
    const laneAttaches = calls.filter((c) => c.name === "scout_attach" && c.session !== PLANNER_SESSION);
    assert.ok(crawl >= 0 && crawl < at((c) => c.name === "scout_attach" && c.session !== PLANNER_SESSION), "the planner crawls before any lane attaches");
    const snapshot = at((c) => c.name === "scout_snapshot" && c.session === PLANNER_SESSION);
    assert.ok(snapshot >= 0 && snapshot < crawl, "and snapshots first: attaching harvests no links, so a first crawl would find nothing to visit");
    // Every lane attaches on the target, as the planner did: the engine resolves a session's paths against the URL it attached with.
    assert.deepEqual(laneAttaches.map((c) => [c.session, c.args.url, c.args.mode]).sort(), [
      ["lane-2+2", TARGET, "read-only"],
      ["orders+1", TARGET, "read-only"],
    ]);
    // Then the run opens each lane's first route by its full URL; the lane whose first route is the target stays put.
    assert.deepEqual(
      calls.filter((c) => c.name === "scout_navigate").map((c) => [c.session, c.args.target]),
      [["orders+1", "http://127.0.0.1:3000/orders"]],
    );
    for (const lane of ["orders+1", "lane-2+2"]) {
      const theirs = calls.filter((c) => ["scout_snapshot", "scout_finding"].includes(c.name) && c.args.session === lane);
      assert.equal(theirs.length, 3, `${lane}'s snapshot and findings all went to its own session`);
    }
    // The report: once, from the planner's session named outright (a lane attaching last made itself the default), after every lane closed.
    const reports = calls.filter((c) => c.name === "scout_report");
    assert.deepEqual(
      reports.map((c) => c.session),
      [PLANNER_SESSION],
    );
    const report = at((c) => c.name === "scout_report");
    for (const lane of ["orders+1", "lane-2+2"])
      assert.ok(at((c) => c.name === "scout_close" && c.args.session === lane) < report, `${lane} closed before the report`);
    assert.equal(calls.at(-1)?.name, "scout_close");
    assert.equal(calls.at(-1)?.args.all, true);

    // The merge: the failing endpoint both lanes filed is one finding; each lane's own defect is its own.
    const titles = (run.json.findings as Array<{ title: string; category: string }>).map((f) => f.category).sort();
    assert.deepEqual(titles, ["a11y", "a11y", "http-error"], JSON.stringify(run.json.findings));
    assert.deepEqual(run.json.counts, { high: 1, medium: 0, low: 2, worthALook: 0 });
    assert.equal(run.json.usage.turns, 6, "three turns in each lane");
    assert.deepEqual(
      {
        asked: run.json.lanes.asked,
        planned: run.json.lanes.planned,
        ran: run.json.lanes.ran,
        sessions: run.json.lanes.sessions.map((l: { session: string; turns: number; stop: string }) => [l.session, l.turns, l.stop]),
      },
      {
        asked: 2,
        planned: 2,
        ran: 2,
        sessions: [
          ["orders+1", 3, "done"],
          ["lane-2+2", 3, "done"],
        ],
      },
    );
    assert.match(run.summary, /\| Lanes \| 2 of 2 asked ran at once, sharing the caps below \|/);
    assert.match(run.summary, /\| orders\+1 \| \/orders, \/settings \| 3 \| 3 \| 300 \| done \|/);
    assert.ok(fs.readFileSync(path.join(dir, ".scenescout", "ci", "report.md"), "utf8").includes(`Written from ${PLANNER_SESSION}.`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes: under runCi the lanes share the turn cap, and a lane whose first route will not open starts from the target", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-cap-"));
  try {
    const server = standInServer(dir, { crawl: CRAWL_TEXT, failNavigate: (url) => url.endsWith("/orders") });
    const forever = (): ModelClient => new Scripted([{ text: "", calls: [call("x", "scout_snapshot")], usage: use(10) }]);
    const run = await runStandIn(["--lanes", "2", "--max-turns", "7", "--storage-state", "auth/user.json"], dir, server, () => forever());
    assert.deepEqual([run.result.stop, run.result.spend.turns, run.exitCode], ["turns", 7, 0], "seven turns between the lanes, not seven each");
    // Every lane signs in, and is held to the write mode, exactly as the run's own session was.
    for (const a of server.calls.filter((c) => c.name === "scout_attach"))
      assert.deepEqual([a.args.storageStatePath, a.args.mode], [`${dir}/auth/user.json`, "read-only"], String(a.session));
    const sessions = run.json.lanes.sessions as Array<{ session: string; turns: number; attached: boolean }>;
    assert.equal(
      sessions.reduce((k, l) => k + l.turns, 0),
      7,
    );
    assert.ok(
      run.lines.some((l) => /\[orders\+1\] could not open \/orders \(page\.goto: net::ERR_ABORTED\); starting from the target instead/.test(l)),
      "its first route did not open, so it started from the target, and the log says why",
    );
    assert.ok(run.lines.some((l) => /\[orders\+1\] attached on \/, owning/.test(l)));
    assert.ok(sessions.every((l) => l.attached));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes: with nothing to split the run explores in one loop, and says why", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-one-"));
  try {
    const server = standInServer(dir, { crawl: "CRAWL of 0 route(s):\n\nAll crawled routes healthy." });
    const kickoffs: string[] = [];
    const run = await runStandIn(["--lanes", "4"], dir, server, (_system, tools, kickoff) => {
      kickoffs.push(kickoff);
      assert.ok(
        tools.some((t) => t.name === "scout_report"),
        "the one loop writes its report as ever",
      );
      return new Scripted([{ text: "Done.", calls: [], usage: use(1) }]);
    });
    assert.equal(kickoffs.length, 1);
    assert.equal(laneOf(kickoffs[0]), undefined, "the ordinary kickoff, not a lane's");
    assert.match(run.json.lanes.oneLoop, /found 1 route\(s\), all in one module \(\/\)/);
    assert.equal(run.json.lanes.ran, 0);
    assert.match(run.summary, /\| Lanes \| 4 asked; explored in one loop: the planning crawl found 1 route/);
    assert.ok(!server.calls.some((c) => c.name === "scout_attach" && c.session !== PLANNER_SESSION), "no lane attached");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes: a first route the server refuses leaves the lane on the target; a page that merely shows an error line does not", async () => {
  const opened = async (navigateText: (url: string, session: string) => string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-open-"));
    try {
      const server = standInServer(dir, { crawl: CRAWL_TEXT, navigateText });
      const run = await runStandIn(["--lanes", "2"], dir, server, () => new Scripted([{ text: "Done.", calls: [], usage: use(1) }]));
      return run.lines.find((l) => l.startsWith("[orders+1] attached on")) ?? "";
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  // Refused, after the line the server puts first when several sessions are live.
  assert.match(await opened((url, session) => `[session ${session} · anonymous]\nREFUSED: ${url} is outside the attached origin`), /attached on \/, owning/);
  // The contrast: the same first line, then a page that happens to have a line reading "ERROR: …".
  assert.match(
    await opened((url, session) => `[session ${session} · anonymous]\nURL: ${url}\nERROR: shown by the page itself`),
    /attached on \/orders, owning/,
  );
});

test("lanes: a lane that cannot attach is named, and the others' run stands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-noattach-"));
  try {
    const server = standInServer(dir, { crawl: CRAWL_TEXT, failAttach: (_url, session) => session === "orders+1" });
    const run = await runStandIn(["--lanes", "2"], dir, server, () => new Scripted([{ text: "Done.", calls: [], usage: use(1) }]));
    assert.deepEqual([run.result.stop, run.exitCode], ["done", 0], "a lane that never started does not fail the run");
    assert.equal(run.result.stopDetail, "1 of 2 lanes could not attach: orders+1");
    assert.deepEqual([run.json.lanes.planned, run.json.lanes.ran], [2, 1], "a lane that never attached is not counted as run");
    assert.deepEqual(
      run.json.lanes.sessions.map((l: { session: string; attached: boolean; stop: string; detail?: string }) => [l.session, l.attached, l.stop, l.detail]),
      [
        ["orders+1", false, "could-not-start", "page.goto: net::ERR_CONNECTION_REFUSED"],
        ["lane-2+2", true, "done", undefined],
      ],
    );
    assert.match(run.summary, /\| Lanes \| 1 of 2 asked ran at once, sharing the caps below; 1 could not attach \|/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes: a planning crawl that uses up the time cap leaves every lane unstarted, and the run ends at the cap with its report", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-slowplan-"));
  try {
    let clock = 1_000_000;
    const server = standInServer(dir, { crawl: CRAWL_TEXT, onCrawl: () => (clock += 3 * 60_000) });
    const parsed = parseCiArgs([TARGET, "--project", dir, "--lanes", "2", "--max-minutes", "2"], dir);
    assert.ok(parsed.ok);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    let models = 0;
    let run: Awaited<ReturnType<typeof runCi>>;
    try {
      run = await runCi(
        parsed.options,
        { provider: "openai", model: "gpt-6-luna", effort: "low", baseUrl: "https://api.invalid/v1" },
        {
          makeClient: () => {
            models += 1;
            return new Scripted([{ text: "Done.", calls: [], usage: use(1) }]);
          },
          version: "0.0.0-test",
          now: () => clock,
          startHost: async () => server.host,
        },
      );
    } finally {
      if (summary !== undefined) process.env.GITHUB_STEP_SUMMARY = summary;
    }
    assert.deepEqual([run.result.stop, run.exitCode, models], ["time", 0, 0], "the cap ended it, not a failure, and no model was called");
    assert.ok(!server.calls.some((c) => c.name === "scout_attach" && c.session !== PLANNER_SESSION), "no lane attached");
    assert.ok(
      run.result.lanes?.sessions.every((l) => !l.attached && l.stop === "time"),
      JSON.stringify(run.result.lanes),
    );
    assert.ok(run.written.includes("report.md"), "the report is written whatever ended the run");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attach: an error result or a sign-in the app no longer accepts is a failure, an ordinary attach is not", () => {
  assert.equal(attachFailure({ text: "ERROR: page.goto: net::ERR_CONNECTION_REFUSED", isError: true }), "page.goto: net::ERR_CONNECTION_REFUSED");
  assert.equal(attachFailure({ text: "ERROR: something", isError: false }), "something");
  assert.equal(
    attachFailure({ text: "[session orders · admin]\nAttached.\n⚠ AUTH FAILED: the saved session was refused", isError: false }),
    "⚠ AUTH FAILED: the saved session was refused",
  );
  // The contrast: an attach whose page mentions an error is still an attach.
  assert.equal(attachFailure({ text: "Attached to http://127.0.0.1:3000/ — the page says ERROR: none", isError: false }), null);
});

test("lanes: a lane that fails outright is waited out with the others, and the run says it could not finish", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-broken-"));
  try {
    const server = standInServer(dir, { crawl: CRAWL_TEXT });
    // The healthy lane takes a while: a run that raced its lanes would move on, and close everything, before it was done.
    const slow = (): ModelClient => {
      let n = 0;
      return {
        next: async () => {
          await new Promise((r) => setTimeout(r, 30));
          n += 1;
          return n < 4 ? { text: "", calls: [call(`s${n}`, "scout_snapshot")], usage: use(1) } : { text: "Done.", calls: [], usage: use(1) };
        },
        addResults: () => {},
      };
    };
    const run = await runStandIn(["--lanes", "2"], dir, server, (_system, _tools, kickoff) => {
      if (laneOf(kickoff) === "orders+1") throw new Error("the client could not be built");
      return slow();
    });
    assert.deepEqual([run.result.stop, run.exitCode], ["could-not-start", 2], "a lane that broke is a run that could not finish");
    assert.equal(run.result.stopDetail, "lane orders+1: the lane failed: the client could not be built");
    assert.equal(
      server.calls.filter((c) => c.name === "scout_snapshot" && c.session === "lane-2+2").length,
      3,
      "the healthy lane finished before the run moved on",
    );
    assert.deepEqual(server.calls.at(-1)?.args, { all: true }, "and nothing ran after the run closed its sessions");
    // What the healthy lane spent and found is kept: its turns, the lane table and the report.
    assert.equal(run.json.usage.turns, 4);
    assert.deepEqual(
      run.json.lanes.sessions.map((l: { session: string; attached: boolean; stop: string }) => [l.session, l.attached, l.stop]),
      [
        ["orders+1", true, "could-not-start"],
        ["lane-2+2", true, "done"],
      ],
    );
    assert.ok(run.written.includes("report.md"), run.written.join());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes: past the time cap a finished lane is left to the run's own close", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-late-"));
  try {
    const server = standInServer(dir, { crawl: CRAWL_TEXT });
    let clock = 1_000_000;
    // Every model call takes a minute: two minutes in, the time cap ends both lanes.
    const minute = (): ModelClient =>
      new Scripted([
        () => {
          clock += 60_000;
          return { text: "", calls: [call("s", "scout_snapshot")], usage: use(1) };
        },
      ]);
    const parsed = parseCiArgs([TARGET, "--project", dir, "--lanes", "2", "--max-minutes", "2"], dir);
    assert.ok(parsed.ok);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    let run;
    try {
      run = await runCi(
        parsed.options,
        { provider: "openai", model: "gpt-6-luna", effort: "low", baseUrl: "https://api.invalid/v1" },
        {
          makeClient: () => minute(),
          version: "0.0.0-test",
          now: () => clock,
          startHost: async () => server.host,
        },
      );
    } finally {
      if (summary !== undefined) process.env.GITHUB_STEP_SUMMARY = summary;
    }
    assert.equal(run.result.stop, "time");
    const closes = server.calls.filter((c) => c.name === "scout_close").map((c) => c.args);
    assert.deepEqual(closes, [{ all: true }], "no lane's own close ran after the cap; the run's close, within its finishing budget, collected them");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes: driven over HTTP by the stand-in model API, each lane holds its own conversation and their shared finding is filed once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-lanes-http-"));
  const key = "fake-lanes-key-0123456789abcdef";
  const api = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-model-api.mjs"), "0"], {
    env: { ...process.env, EXPECTED_KEY: key },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the stand-in API did not start")), 10_000);
      api.stdout!.on("data", (chunk: Buffer) => {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/v1)/.exec(chunk.toString());
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      api.on("exit", (code) => reject(new Error(`the stand-in API exited with ${code}`)));
    });
    const server = standInServer(dir, { crawl: CRAWL_TEXT });
    const resolved = { provider: "openai" as const, model: "gpt-6-luna", effort: "low", baseUrl: base };
    const run = await runStandIn(["--lanes", "2"], dir, server, (system, tools, kickoff) => httpClient(resolved, key, system, tools, kickoff), [key]);
    assert.deepEqual([run.result.stop, run.exitCode], ["done", 0], run.lines.join("\n"));
    assert.equal(run.json.usage.turns, 4, "two turns in each lane's own conversation");
    for (const lane of ["orders+1", "lane-2+2"])
      assert.deepEqual(
        server.calls.filter((c) => c.args.session === lane && ["scout_crawl", "scout_finding"].includes(c.name)).map((c) => c.name),
        ["scout_crawl", "scout_finding"],
        lane,
      );
    const findings = run.json.findings as Array<{ title: string }>;
    assert.deepEqual(
      findings.map((f) => f.title),
      ["The stand-in model's finding, filed by every lane"],
      "both lanes filed it; the run reports it once",
    );
    const written = fs.readdirSync(path.join(dir, ".scenescout", "ci")).map((f) => fs.readFileSync(path.join(dir, ".scenescout", "ci", f), "utf8"));
    assert.ok(!written.some((t) => t.includes(key)) && !run.lines.some((l) => l.includes(key)), "the key the API echoes is in no file and no line");
  } finally {
    api.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  // Code scanning keeps only results located in a repository file: the anchor, with the page beside it.
  assert.deepEqual(results[0].locations[0].physicalLocation.artifactLocation, { uri: "package.json" });
  assert.deepEqual(results[0].locations[0].logicalLocations, [{ kind: "resource", name: "/things?x=1", fullyQualifiedName: "/things?x=1" }]);
  assert.equal(results[0].properties.route, "/things?x=1");
  assert.match(results[0].message.text, / — on \/things\?x=1$/);
  const anchored = ciSarif(RESULT(), "9.9.9", [], ".github/workflows/explore.yml") as any;
  assert.equal(anchored.runs[0].results[1].locations[0].physicalLocation.artifactLocation.uri, ".github/workflows/explore.yml");
  assert.deepEqual(
    anchored.runs[0].results.map((r: any) => r.partialFingerprints),
    results.map((r: any) => r.partialFingerprints),
    "the anchor moves the location, never the alert's identity",
  );
  assert.ok(!JSON.stringify(sarif).includes(OPENAI_KEY));
  assert.equal(sarif.runs[0].invocations[0].executionSuccessful, true);
  assert.equal(sarif.runs[0].originalUriBaseIds, undefined, "no location is relative to the app any more");
  assert.equal(sarif.runs[0].properties.app, "http://127.0.0.1:3000");
  assert.equal((ciSarif(RESULT({ stop: "provider-error" }), "9.9.9") as any).runs[0].invocations[0].executionSuccessful, false);
});

test("--sarif-file-anchor: a file relative to the repository root, never outside it", () => {
  const parse = (v: string) => parseCiArgs(["http://127.0.0.1:3000", `--sarif-file-anchor=${v}`], "/work");
  const ok = parse("./.github/workflows/explore.yml");
  assert.ok(ok.ok && ok.options.sarifFileAnchor === ".github/workflows/explore.yml");
  for (const bad of ["/etc/passwd", "../outside.md", "docs/"]) {
    const r = parse(bad);
    assert.ok(!r.ok && /--sarif-file-anchor/.test(r.error), bad);
  }
  const absent = parseCiArgs(["http://127.0.0.1:3000"], "/work");
  assert.ok(absent.ok && absent.options.sarifFileAnchor === undefined);
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

test("action and help: every default they state is the CLI's", () => {
  const d = parseCiArgs(["http://127.0.0.1:3000"], "/work");
  assert.ok(d.ok);
  const stated = (input: string) => /Empty means (\d+)/.exec((action.inputs as Record<string, { description: string }>)[input].description)?.[1];
  assert.equal(stated("max-turns"), String(d.options.caps.turns));
  assert.equal(stated("max-tokens"), String(d.options.caps.tokens));
  assert.equal(stated("max-minutes"), String(d.options.caps.wallMs / 60_000));
  assert.equal(stated("lanes"), String(d.options.lanes));
  // From the ci entry on: the first run's entry above it has a --max-minutes of its own.
  const cliText = fs.readFileSync(path.join(REPO, "src", "cli.ts"), "utf8");
  const help = cliText.slice(cliText.indexOf("--max-turns N (default"));
  const inHelp = (option: string) => new RegExp(`--${option} N \\(default (\\d+)`).exec(help)?.[1];
  assert.equal(inHelp("max-turns"), String(d.options.caps.turns), "the CLI's help");
  assert.equal(inHelp("max-tokens"), String(d.options.caps.tokens), "the CLI's help");
  assert.equal(inHelp("max-minutes"), String(d.options.caps.wallMs / 60_000), "the CLI's help");
  assert.equal(inHelp("lanes"), String(d.options.lanes), "the CLI's help");
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
  // The same action split into lanes, against the same stand-in, checked for its merged finding.
  const lanes = job.steps!.find((s) => s.uses === "./ci" && s.with?.lanes !== undefined);
  assert.ok(lanes && Number(lanes.with?.lanes) >= 2, "the job also runs the action split into lanes");
  assert.equal(lanes.with?.["base-url"], step.with?.["base-url"], "the lanes run uses the stand-in API too");
  const checked = job.steps!.find((s) => /\$\{\{ steps\.lanes\.outputs\.low \}\}/.test(JSON.stringify(s)));
  assert.ok(checked && /test "\$LOW" = 1/.test(checked.run ?? ""), "the finding every lane filed is counted once");
});

test("the suite runs on Windows for every pull request", () => {
  const workflow = parseYaml(readText(path.join(REPO, ".github", "workflows", "test.yml"))) as Record<string, any>;
  assert.ok("pull_request" in workflow.on, "test.yml does not run on pull_request");
  const pull = workflow.on.pull_request;
  const filters = pull && typeof pull === "object" ? pull : {};
  assert.equal(filters.paths, undefined, "a paths filter would skip some pull requests");
  assert.equal(filters["paths-ignore"], undefined, "a paths-ignore filter would skip some pull requests");
  const cells = workflow.jobs.suite.strategy.matrix.include as Array<{ os: string; node: number }>;
  assert.ok(
    cells.some((c) => c.os === "windows-latest"),
    "the suite matrix has no windows-latest cell",
  );
  const suites = (workflow.jobs.suite.steps as Array<{ name?: string; run?: string; if?: string }>).find((s) => s.name === "All suites");
  assert.equal(suites?.run, "npm test");
  assert.equal(suites?.if, undefined, "the suites step must run on the Windows cell too");
  const needs = workflow.jobs.test.needs as string[];
  assert.ok(needs.includes("suite"), "the required test check does not wait for the suite, so a Windows failure would not fail it");
});

test("the same lines compare equal as LF and as CRLF, and one different line does not", () => {
  const lines = "alpha\nbeta\n";
  const crlf = asCrlf(lines);
  assert.equal(crlf, "alpha\r\nbeta\r\n");
  assert.equal(asCrlf(crlf), crlf, "CRLF passed through asCrlf must not gain a second CR");
  assert.equal(asLf(crlf), lines);
  assert.equal(asLf("alpha\rbeta\r\n"), lines);
  assert.notEqual(asLf(asCrlf("alpha\ngamma\n")), lines);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-"));
  try {
    const file = path.join(dir, "note.txt");
    fs.writeFileSync(file, crlf);
    assert.equal(readText(file), lines);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the same place matches with either separator and, on Windows, either case", () => {
  assert.equal(joinPath("win32", "C:\\work", "app", "file.txt"), "C:\\work\\app\\file.txt");
  assert.equal(joinPath("posix", "/work", "app", "file.txt"), "/work/app/file.txt");
  assert.equal(samePlace("win32", "C:\\Work\\App", "c:/work/app"), true);
  assert.equal(samePlace("win32", "C:\\Work\\App\\", "c:/work/app"), true);
  assert.equal(samePlace("posix", "/Work/App", "/work/app"), false);
  assert.equal(samePlace("posix", "/work/app/", "/work/app"), true);
  assert.equal(samePlace("win32", "C:\\work\\app", "C:\\work\\other"), false);
  assert.equal(samePlace("posix", "/work/app", "/work/other"), false);
});

type WorkflowStep = { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type WorkflowJob = {
  permissions?: Record<string, string>;
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  secrets?: Record<string, string>;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
};
const readWorkflow = (name: string) => parseYaml(fs.readFileSync(path.join(REPO, ".github", "workflows", name), "utf8")) as Record<string, any>;
/** Where a model's key is named, as `secrets.OPENAI_API_KEY` or `secrets.ANTHROPIC_API_KEY`. */
const NAMES_A_KEY = /secrets\.(OPENAI|ANTHROPIC)_API_KEY/;

test("benchmark workflow: started by hand or called, reads the repository and nothing more, and uploads what bench reads", () => {
  const wf = readWorkflow("ci-benchmark.yml");
  assert.deepEqual(Object.keys(wf.on).sort(), ["workflow_call", "workflow_dispatch"], "never pull_request or pull_request_target: the job holds the key");
  assert.deepEqual(wf.permissions, { contents: "read" });
  // A caller passes a key only if it has one: neither is required, so a repository with one provider can still call it.
  assert.deepEqual(wf.on.workflow_call.secrets, { OPENAI_API_KEY: { required: false }, ANTHROPIC_API_KEY: { required: false } });
  assert.equal(wf.on.workflow_dispatch.inputs.provider.default, "openai");
  assert.equal(wf.on.workflow_call.inputs.provider.default, "openai");
  const jobs = Object.values(wf.jobs as Record<string, WorkflowJob>);
  for (const job of jobs) assert.equal(job.permissions, undefined, "no job widens the permissions");
  for (const job of jobs) assert.ok(!NAMES_A_KEY.test(JSON.stringify(job.env ?? {})), "no key in a job's env: only the steps that need it");
  const steps = jobs.flatMap((j) => j.steps ?? []);
  const run = steps.find((s) => s.uses === "./ci");
  assert.ok(run, "it runs the ci action from this commit");
  assert.equal(run.with?.cli, "dist/cli.js");
  assert.equal(run.with?.provider, "${{ inputs.provider }}");
  // The run's caps and its lanes are inputs of both triggers, passed to the action's inputs of the same name; empty keeps the CLI's default.
  for (const cap of ["max-turns", "max-tokens", "lanes"]) {
    assert.ok(cap in action.inputs, `the ci action has no ${cap} input`);
    assert.equal(run.with?.[cap], `\${{ inputs.${cap} }}`);
    for (const trigger of ["workflow_dispatch", "workflow_call"]) assert.equal(wf.on[trigger].inputs[cap]?.default, "", `${trigger} ${cap}`);
  }
  // Each key reaches the run only when its provider was chosen, and only from the secret, through env.
  assert.equal(run.env?.OPENAI_API_KEY, "${{ inputs.provider == 'openai' && secrets.OPENAI_API_KEY || '' }}");
  assert.equal(run.env?.ANTHROPIC_API_KEY, "${{ inputs.provider == 'anthropic' && secrets.ANTHROPIC_API_KEY || '' }}");
  const upload = steps.findIndex((s) => /^actions\/upload-artifact@/.test(s.uses ?? ""));
  const keyCheck = steps.findIndex((s) => /for key in "\$OPENAI_API_KEY" "\$ANTHROPIC_API_KEY"/.test(s.run ?? "") && /grep -rlF -- "\$key"/.test(s.run ?? ""));
  assert.ok(keyCheck >= 0 && upload > keyCheck, "the key check looks for both keys, before the upload");
  assert.deepEqual(steps[keyCheck].env && { o: steps[keyCheck].env!.OPENAI_API_KEY, a: steps[keyCheck].env!.ANTHROPIC_API_KEY }, {
    o: run.env?.OPENAI_API_KEY,
    a: run.env?.ANTHROPIC_API_KEY,
  });
  // An empty key would match every file: the check skips it rather than failing every run.
  assert.match(steps[keyCheck].run!, /\[ -n "\$key" \] \|\| continue/);
  const withKey = steps.filter((s) => NAMES_A_KEY.test(JSON.stringify(s)));
  assert.deepEqual(withKey, [run, steps[keyCheck]], "the key is in the run and the check, and nowhere else");
  assert.equal(steps[upload].with?.path, "${{ steps.app.outputs.project }}", "the project directory itself, so it unpacks to <dir>/.scenescout/memory.json");
  assert.equal(String(steps[upload].with?.["include-hidden-files"]), "true");
  for (const s of steps) assert.ok(!/^\s*(npm run bench|npx tsx scripts\/bench|git (commit|push))/m.test(s.run ?? ""), "it scores and commits nothing");
  // A caller chooses the ref, so the weekly run can run a release tag: it is checked before anything is checked out.
  const checkout = steps.findIndex((s) => /^actions\/checkout@/.test(s.uses ?? ""));
  assert.equal(steps[checkout].with?.ref, "${{ inputs.ref }}");
  const guard = steps.findIndex((s) => s.env?.REF === "${{ inputs.ref }}");
  assert.ok(guard >= 0 && guard < checkout, "the ref is validated before the checkout");
  const accepts = (ref: string) => spawnSync("bash", ["-eo", "pipefail", "-c", steps[guard].run!], { env: { PATH: process.env.PATH, REF: ref } }).status === 0;
  for (const ref of ["", "v3.13.0", "main", "0123456789abcdef0123456789abcdef01234567"]) assert.ok(accepts(ref), `refuses ${JSON.stringify(ref)}`);
  for (const ref of ["refs/pull/1/merge", "feature/x", "v3.13", "v3.13.0-rc.1", "main2", "0123456", "v3.13.0; echo hi"])
    assert.ok(!accepts(ref), `accepts ${ref}`);
  // No actions cache in a job that checks out a ref an input chose: a later run on main would restore what it saved.
  for (const s of steps) {
    assert.ok(!/^actions\/cache/.test(s.uses ?? ""), s.uses);
    if (/^actions\/setup-node@/.test(s.uses ?? "")) assert.equal(s.with?.cache, undefined, "setup-node caches nothing here");
  }
  assert.equal(String(run.with?.cache), "false", "the ci action keeps the browser out of the cache");
});

test("ci action: cache false skips both the restore and the save of the browser", () => {
  const steps = action.runs.steps as Array<{ name?: string; if?: string; uses?: string }>;
  assert.equal(action.inputs.cache.default, "true");
  const cacheSteps = steps.filter((s) => /^actions\/cache\//.test(s.uses ?? ""));
  assert.equal(cacheSteps.length, 2);
  for (const s of cacheSteps) assert.match(s.if ?? "", /inputs\.cache == 'true'/, s.name);
});

test("weekly benchmark: scheduled or dispatched, and the key and the write token never meet in one job", () => {
  const wf = readWorkflow("bench-weekly.yml");
  assert.deepEqual(Object.keys(wf.on).sort(), ["schedule", "workflow_dispatch"], "never pull_request or pull_request_target");
  assert.equal(wf.on.schedule.length, 1);
  assert.match(wf.on.schedule[0].cron, /^\d+ \d+ \* \* \d$/, "weekly");
  const inputs = wf.on.workflow_dispatch.inputs;
  assert.equal(inputs.force.type, "boolean");
  assert.equal(inputs.force.default, false);
  assert.equal(inputs.provider.default, "openai", "the default provider, unless dispatched otherwise");
  assert.deepEqual(wf.permissions, {}, "every job asks for what it needs");
  const jobs = wf.jobs as Record<string, WorkflowJob>;
  assert.deepEqual(Object.keys(jobs), ["decide", "bench", "record", "test-results-pr"]);
  assert.deepEqual(jobs.decide.permissions, { contents: "read", "pull-requests": "read" });
  assert.deepEqual(jobs.bench.permissions, { contents: "read" }, "the job that calls the model can only read");
  assert.deepEqual(jobs.record.permissions, { contents: "write", "pull-requests": "write" });
  assert.deepEqual(jobs["test-results-pr"].permissions, { actions: "write" });

  // The key: only the bench job names it, and only the chosen provider's.
  for (const [name, job] of Object.entries(jobs))
    assert.equal(NAMES_A_KEY.test(JSON.stringify(job)), name === "bench", `${name} ${name === "bench" ? "passes" : "names"} a key`);
  assert.equal(jobs.bench.uses, "./.github/workflows/ci-benchmark.yml", "the same run as the manual benchmark, not a copy");
  assert.deepEqual(jobs.bench.secrets, {
    OPENAI_API_KEY: "${{ needs.decide.outputs.provider == 'openai' && secrets.OPENAI_API_KEY || '' }}",
    ANTHROPIC_API_KEY: "${{ needs.decide.outputs.provider == 'anthropic' && secrets.ANTHROPIC_API_KEY || '' }}",
  });
  assert.equal(jobs.bench.with?.ref, "${{ needs.decide.outputs.tag }}", "it runs the release, not whatever main holds");
  assert.equal(jobs.bench.with?.provider, "${{ needs.decide.outputs.provider }}");
  assert.equal(jobs.bench.if, "needs.decide.outputs.run == 'true'", "nothing runs unless decide says a release came out, or it was forced");
  assert.ok(!NAMES_A_KEY.test(JSON.stringify(jobs.record)) && !/secrets\./.test(JSON.stringify(jobs.record)), "the job that can push holds no secret");

  const record = jobs.record.steps!.map((s) => s.run ?? "").join("\n");
  const decide = jobs.decide.steps!.find((s) => /bench:ci -- decide/.test(s.run ?? ""));
  assert.ok(decide, "decide asks ci-record whether to run");
  assert.match(decide.run!, /open_prs=\$\(gh pr list --state open --label benchmark --json number --jq length\)/, "an open results pull request is counted");
  assert.match(decide.run!, /--open-prs "\$open_prs" --release-has-ci "\$has_ci"/);
  assert.match(decide.run!, /git cat-file -e "\$TAG:ci\/action\.yml"/, "whether the release has the ci action to run");
  // One app failing must not discard the other's paid run.
  assert.equal(jobs.record.if, "always() && needs.decide.outputs.run == 'true'");
  const download = jobs.record.steps!.find((s) => /^actions\/download-artifact@/.test(s.uses ?? "")) as WorkflowStep & { "continue-on-error"?: boolean };
  assert.equal(download["continue-on-error"], true, "a failed app uploads nothing, and that alone does not stop the other being recorded");
  assert.match(
    record,
    /if \[ ! -s "\$dir\/\.scenescout\/ci\/ci\.json" \]; then[\s\S]*run failed; nothing recorded for it\." >> "\$GITHUB_STEP_SUMMARY"[\s\S]*continue/,
  );
  assert.match(record, /if \[ "\$recorded" -eq 0 \]; then [^\n]*exit 1; fi/, "nothing to record at all fails the job");
  // A pipe hides a failing command unless pipefail is on: every script runs under bash, which sets it.
  for (const [name, job] of Object.entries(jobs))
    for (const st of job.steps ?? [])
      if (st.run && st.run !== "npm ci --ignore-scripts") assert.equal((st as { shell?: string }).shell, "bash", `${name}: ${st.run.slice(0, 60)}`);
  assert.ok(
    jobs.decide.steps!.findIndex((s) => /labels\/benchmark/.test(s.run ?? "")) >= 0,
    "the label the pull request needs is checked before any model call",
  );
  assert.match(record, /npm run -s bench -- "\$dir" --app "\$app" --json "\$card"/, "each app scored against its own key");
  assert.match(record, /npm run -s bench -- --archive "\$dir" --app "\$app"/, "each run archived, so it can be re-scored");
  assert.match(record, /bench:ci -- record --app "\$app"/);
  assert.match(
    record,
    /git push --force-with-lease="refs\/heads\/\$BRANCH:\$lease" origin "HEAD:refs\/heads\/\$BRANCH"/,
    "a branch of its own, never main, which a re-run can replace",
  );
  assert.match(record, /lease=\$\(git ls-remote origin "refs\/heads\/\$BRANCH" \| cut -f1\)/, "leased on what an earlier attempt left, or on its absence");
  assert.match(
    record,
    /gh pr list --state open --head "\$BRANCH"[\s\S]*exit 0[\s\S]*gh pr create/,
    "a re-run reuses the pull request an earlier attempt opened",
  );
  assert.equal(jobs.record.steps!.find((s) => s.env?.BRANCH)?.env?.BRANCH, "bench/ci-results-${{ github.run_id }}", "the run id names the branch");
  assert.ok(!/git push[^\n]*\bmain\b/.test(record), "never pushes to main");
  assert.match(record, /gh pr create --base main --head "\$BRANCH" --label benchmark/);
  for (const job of Object.values(jobs))
    for (const s of job.steps ?? []) assert.ok(!/\$\{\{\s*(inputs|needs)\./.test(s.run ?? ""), `no input is pasted into a script: ${s.run}`);
  for (const job of [jobs.decide, jobs.record]) assert.ok(job.steps!.some((s) => s.run === "npm ci --ignore-scripts"));
});

test("dedup benchmark workflow: dispatched only, reads the repository, and the key is in the one step that calls the model", () => {
  const wf = readWorkflow("dedup-bench.yml");
  assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"], "never pull_request, pull_request_target or a schedule: the job holds the key");
  assert.deepEqual(wf.permissions, { contents: "read" });
  const inputs = wf.on.workflow_dispatch.inputs;
  assert.equal(inputs.efforts.default, "none,low");
  assert.deepEqual(inputs.provider.options, ["openai"]);
  assert.equal(inputs.provider.default, "openai");
  const jobs = Object.values(wf.jobs as Record<string, WorkflowJob>);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job.permissions, undefined, "the job does not widen the permissions");
  assert.ok(!NAMES_A_KEY.test(JSON.stringify(job.env ?? {})), "no key in the job's env");
  const steps = job.steps ?? [];
  const judge = steps.find((s) =>
    /npm run -s dedup-bench -- --judge --efforts "\$EFFORTS" --provider "\$PROVIDER" --pairs "\$OUT\/pairs\.jsonl" \$\{SINCE:\+--since "\$SINCE"\}/.test(
      s.run ?? "",
    ),
  );
  assert.ok(judge, "it runs the judge at the dispatched efforts");
  assert.deepEqual(
    steps.filter((s) => NAMES_A_KEY.test(JSON.stringify(s))),
    [judge],
    "the key is in the step that calls the model, and nowhere else",
  );
  assert.equal(judge.env?.OPENAI_API_KEY, "${{ inputs.provider == 'openai' && secrets.OPENAI_API_KEY || '' }}");
  assert.equal(judge.env?.EFFORTS, "${{ inputs.efforts }}", "inputs reach the script through env");
  for (const s of steps) assert.ok(!/\$\{\{\s*inputs\./.test(s.run ?? ""), `no input is pasted into a script: ${s.run}`);
  assert.equal((judge as { shell?: string }).shell, "bash", "pipefail, so a failing benchmark is not hidden by tee");
  assert.match(judge.run!, /if \[ -z "\$OPENAI_API_KEY" \]; then [^\n]*exit 1; fi/, "a missing key fails, rather than scoring the rule alone");
  assert.match(judge.run!, />> "\$GITHUB_STEP_SUMMARY"/, "the scorecard goes to the job summary");
  // The key check comes before the scorecard is written anywhere that leaves the runner.
  assert.ok(judge.run!.indexOf('grep -qF -- "$OPENAI_API_KEY" "$OUT/scorecard.txt" "$OUT/pairs.jsonl"') >= 0, "both files are checked for the key");
  assert.ok(judge.run!.indexOf('grep -qF -- "$OPENAI_API_KEY"') < judge.run!.indexOf("GITHUB_STEP_SUMMARY"));
  const accepts = (efforts: string) =>
    spawnSync("bash", ["-eo", "pipefail", "-c", judge.run!.split("\n")[0]], { env: { PATH: process.env.PATH, EFFORTS: efforts } }).status === 0;
  for (const e of ["none,low", "low", "none,low,medium"]) assert.ok(accepts(e), `refuses ${e}`);
  assert.equal(inputs.since.default, "", "every archived run unless a date is given");
  assert.equal(judge.env?.SINCE, "${{ inputs.since }}");
  const acceptsSince = (since: string) =>
    spawnSync("bash", ["-eo", "pipefail", "-c", judge.run!.split("\n")[1]], { env: { PATH: process.env.PATH, SINCE: since } }).status === 0;
  for (const d of ["", "2026-10-03"]) assert.ok(acceptsSince(d), `refuses since=${JSON.stringify(d)}`);
  for (const d of ["2026-10", "x; curl evil", "2026-10-03 --judge"]) assert.ok(!acceptsSince(d), `accepts since=${JSON.stringify(d)}`);
  for (const e of ["", "none, low", "low;echo hi", "$(id)", "low,"]) assert.ok(!accepts(e), `accepts ${JSON.stringify(e)}`);
  const upload = steps.findIndex((s) => /^actions\/upload-artifact@[0-9a-f]{40}$/.test((s.uses ?? "").split(" ")[0]));
  assert.ok(upload > steps.indexOf(judge), "the scorecard is uploaded, after the key check, by an action pinned by commit");
  assert.deepEqual(
    String(steps[upload].with?.path).trim().split("\n"),
    ["${{ runner.temp }}/dedup-bench/scorecard.txt", "${{ runner.temp }}/dedup-bench/pairs.jsonl"],
    "the scorecard and the per-pair lines",
  );
  // A refused key does not stop the script: each failed call falls back to the rule and is counted, and it exits 0.
  const answered = steps.findIndex((s) => /grep -q 'not run \('[^\n]*exit 1; fi/.test(s.run ?? ""));
  assert.ok(answered > upload, "a judge that did not answer fails the run, after the scorecard is kept");
  const gate = (card: string) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dedup-card-")), "scorecard.txt");
    fs.writeFileSync(file, card);
    return spawnSync("bash", ["-eo", "pipefail", "-c", steps[answered].run!], { env: { PATH: process.env.PATH, CARD: file } }).status;
  };
  const rule = "[demo] sample: 100 pairs\n  rule: 100 judged (21 same in the key), 0 unsure, 0 failed; accuracy 81.0%, Brier 0.190\n";
  assert.equal(gate(rule + "\n[demo] judge openai m effort none: 98 judged (21 same in the key), 0 unsure, 2 failed; accuracy 90.0%, Brier 0.080\n"), 0);
  assert.equal(gate(rule + "\nJudge at effort low: not run (--provider openai needs OPENAI_API_KEY set in the environment).\n"), 1);
  assert.equal(gate(rule + "\n[demo] judge openai m effort none: 0 judged (0 same in the key), 0 unsure, 100 failed; fewer than 8 judged, no figures\n"), 1);
  assert.ok(
    steps.some((s) => s.run === "npm ci --ignore-scripts"),
    "no dependency's install script runs beside the key",
  );
  for (const s of steps) {
    assert.ok(!/^actions\/cache/.test(s.uses ?? ""), s.uses);
    if (/^actions\/setup-node@/.test(s.uses ?? "")) assert.equal(s.with?.cache, undefined, "setup-node caches nothing here");
    assert.ok(!/git (commit|push)/.test(s.run ?? ""), "it commits nothing");
  }
});

test("weekly benchmark: every check it dispatches on the results branch accepts that branch, and wave hold accepts no other", () => {
  const jobs = readWorkflow("bench-weekly.yml").jobs as Record<string, WorkflowJob>;
  const script = jobs["test-results-pr"].steps!.map((s) => s.run ?? "").join("\n");
  const dispatched = [...script.matchAll(/gh workflow run (\S+) --ref "\$BRANCH"/g)].map((m) => m[1]);
  assert.deepEqual(dispatched.sort(), ["test.yml", "wave-hold.yml"], "the required checks: test and wave hold");
  /** Runs every script a dispatched run of this workflow runs, on this branch, and returns their exit codes. */
  const onDispatch = (file: string, ref: string): number[] => {
    const wf = readWorkflow(file);
    assert.ok("workflow_dispatch" in wf.on, `${file} cannot be dispatched`);
    const steps = Object.values(wf.jobs as Record<string, WorkflowJob>).flatMap((j) => (j.steps ?? []) as Array<WorkflowStep & { if?: string }>);
    return steps
      .filter((st) => st.run && /workflow_dispatch/.test(st.if ?? "") && /github\.ref_name/.test(JSON.stringify(st.env ?? {})))
      .map((st) => spawnSync("bash", ["-eo", "pipefail", "-c", st.run!], { env: { PATH: process.env.PATH, REF: ref }, encoding: "utf8" }).status ?? -1);
  };
  const results = "bench/ci-results-123456789";
  for (const file of dispatched) for (const status of onDispatch(file, results)) assert.equal(status, 0, `${file} refuses ${results}`);
  assert.deepEqual(onDispatch("wave-hold.yml", results), [0], "wave hold's dispatch rule was run");
  assert.deepEqual(onDispatch("wave-hold.yml", "changeset-release/main"), [0]);
  // Narrow: any other branch still fails, so a dispatch cannot put a passing wave hold on a held pull request.
  for (const other of ["feature/x", "bench/ci-results-", "bench/ci-results-12/x", "bench/ci-results-abc", "x/bench/ci-results-1"])
    assert.deepEqual(onDispatch("wave-hold.yml", other), [1], other);
});

// ── the weekly benchmark's record ───────────────────────────────────────────

const ROW = (over: Partial<CiResultRow> = {}): CiResultRow => ({
  date: "2026-01-05",
  app: "demo",
  version: "1.2.0",
  commit: "abcdef1",
  source: "scheduled",
  provider: "openai",
  model: "some-model-1",
  effort: "low",
  dedup: "rule",
  key: "0123456789",
  recall: { found: 5, expected: 13 },
  precision: { correct: 7, labelled: 8, low: "70%", high: "90%" },
  brier: null,
  stop: "done",
  turns: 36,
  tokens: { input: 741_675, cachedInput: 716_628, output: 2_190 },
  seconds: 70,
  costUsd: 0.01076598,
  archive: "ci-demo-1-2-0-1",
  ...over,
});

test("versions: compared by number, and anything but a plain X.Y.Z refused", () => {
  const cases: Array<[string, string, number]> = [
    ["1.2.0", "1.2.0", 0],
    ["v1.2.0", "1.2.0", 0],
    ["1.10.0", "1.9.9", 1],
    ["2.0.0", "10.0.0", -1],
    ["1.2.1", "1.2.0", 1],
  ];
  for (const [a, b, sign] of cases) assert.equal(Math.sign(compareVersions(a, b)), sign, `${a} vs ${b}`);
  assert.throws(() => compareVersions("latest", "1.0.0"), /Not a version/);
  assert.throws(() => compareVersions("1.0", "1.0.0"), /Not a version/);
  // The release tag is checked as vX.Y.Z before this; a prerelease is refused here too, not ordered.
  assert.throws(() => compareVersions("1.3.0-rc.1", "1.3.0"), /Not a version/);
});

test("weekly decision: runs only when a release came out since the schedule last benchmarked it with this provider, or when forced", () => {
  // Every record here is made by the test, not read from bench/ci-results.json: a scheduled row the weekly workflow
  // appends there can turn the verdict for its release, and for every earlier one, from run to skip.
  const rows = [
    ROW({ version: "1.1.0", date: "2025-12-01", archive: "a" }),
    ROW({ version: "1.2.0", date: "2026-01-05", archive: "b" }),
    // Another provider's newer row does not count for this one.
    ROW({ version: "1.4.0", provider: "anthropic", date: "2026-02-02", archive: "c" }),
    // Row order does not decide which is newest.
    ROW({ version: "1.0.0", date: "2026-03-01", archive: "d" }),
    // Neither a dispatched run (another model or effort, perhaps) nor a manual one (of a commit no release holds) stands in for the schedule.
    ROW({ version: "1.3.0", source: "dispatched", effort: "high", date: "2026-03-02", archive: "e" }),
    ROW({ version: "1.3.0", source: "manual", date: "2026-03-03", archive: "f" }),
  ];
  // Records unlike the one above: empty, with no scheduled row, and with versions that sort differently as text.
  // A case names one, or uses the one above.
  const records = {
    empty: [],
    // Runs taken by hand and dispatched runs, of 1.2.0 to 1.3.1, and none on the schedule.
    unscheduled: [
      ROW({ version: "1.2.0", source: "manual", archive: "g" }),
      ROW({ version: "1.3.0", source: "manual", archive: "h" }),
      ROW({ version: "1.3.0", source: "dispatched", effort: "high", archive: "i" }),
      ROW({ version: "1.3.1", source: "dispatched", archive: "j" }),
    ],
    "1.9.0": [ROW({ version: "1.9.0", archive: "k" })],
    "1.10.0 and 1.9.0": [ROW({ version: "1.10.0", archive: "l" }), ROW({ version: "1.9.0", archive: "m" })],
  };
  const base = { force: false, openResultsPrs: 0, releaseHasCi: true };
  const cases: Array<{
    record?: keyof typeof records;
    latest: string;
    provider: string;
    force?: boolean;
    openResultsPrs?: number;
    releaseHasCi?: boolean;
    run: boolean;
    reason: RegExp;
  }> = [
    {
      latest: "1.2.0",
      provider: "openai",
      run: false,
      reason: /No SceneScout release since v1\.2\.0, benchmarked with openai on 2026-01-05 \(latest release: v1\.2\.0\)/,
    },
    { latest: "v1.2.0", provider: "openai", run: false, reason: /No SceneScout release/ },
    { latest: "1.2.1", provider: "openai", run: true, reason: /v1\.2\.1 was released since v1\.2\.0 was benchmarked with openai on 2026-01-05/ },
    // Only a dispatched and a manual row hold 1.3.0: the scheduled run of it has not been made.
    { latest: "1.3.0", provider: "openai", run: true, reason: /v1\.3\.0 was released since v1\.2\.0/ },
    // Older than what was recorded (a release withdrawn, say): nothing new to measure.
    { latest: "1.1.5", provider: "openai", run: false, reason: /No SceneScout release since v1\.2\.0/ },
    { latest: "1.4.0", provider: "anthropic", run: false, reason: /since v1\.4\.0, benchmarked with anthropic/ },
    { latest: "1.2.0", provider: "someother", run: true, reason: /Nothing benchmarked on schedule with someother yet/ },
    { latest: "1.2.0", provider: "openai", force: true, run: true, reason: /Forced/ },
    // An unmerged results pull request: main's record is behind, and running would pay for the same release again.
    { latest: "1.3.0", provider: "openai", openResultsPrs: 1, run: false, reason: /1 results pull request\(s\) labelled benchmark are still open/ },
    { latest: "1.3.0", provider: "openai", openResultsPrs: 2, force: true, run: true, reason: /Forced/ },
    // A release from before scenescout ci: nothing to run, forced or not.
    { latest: "1.3.0", provider: "openai", releaseHasCi: false, run: false, reason: /v1\.3\.0 predates scenescout ci/ },
    { latest: "1.3.0", provider: "openai", releaseHasCi: false, force: true, run: false, reason: /predates scenescout ci/ },
    // Nothing recorded yet: the schedule's first run.
    { record: "empty", latest: "1.0.0", provider: "openai", run: true, reason: /Nothing benchmarked on schedule with openai yet: benchmarking v1\.0\.0/ },
    { record: "empty", latest: "1.0.0", provider: "openai", force: true, run: true, reason: /Forced/ },
    // Runs taken by hand or dispatched, of the latest release or a later version, never make the schedule skip it.
    { record: "unscheduled", latest: "1.3.0", provider: "openai", run: true, reason: /Nothing benchmarked on schedule with openai yet: benchmarking v1\.3\.0/ },
    { record: "unscheduled", latest: "1.3.1", provider: "openai", run: true, reason: /Nothing benchmarked on schedule with openai yet/ },
    // The schedule's first results pull request still open: main's record has no scheduled row yet, and the run still skips.
    {
      record: "unscheduled",
      latest: "1.3.1",
      provider: "openai",
      openResultsPrs: 1,
      run: false,
      reason: /1 results pull request\(s\) labelled benchmark are still open/,
    },
    // Versions compare as numbers, not text: 1.10.0 is newer than 1.9.0.
    { record: "1.9.0", latest: "1.10.0", provider: "openai", run: true, reason: /v1\.10\.0 was released since v1\.9\.0/ },
    { record: "1.10.0 and 1.9.0", latest: "1.10.0", provider: "openai", run: false, reason: /No SceneScout release since v1\.10\.0/ },
  ];
  for (const c of cases) {
    const d = decideRun({ ...base, ...c, rows: c.record ? records[c.record] : rows });
    assert.equal(d.run, c.run, JSON.stringify(c));
    assert.match(d.reason, c.reason, JSON.stringify(c));
  }
  assert.throws(() => decideRun({ ...base, latest: "", rows, provider: "openai" }), /Not a version/, "a release that is not a version fails the job");
  assert.throws(() => decideRun({ ...base, latest: "nightly", rows, provider: "openai", force: true }), /Not a version/, "even when forced");
  assert.throws(() => decideRun({ ...base, latest: "1.3.0", rows, provider: "openai", openResultsPrs: -1 }), /openResultsPrs/);
});

const CI_JSON = {
  tool: "scenescout",
  command: "ci",
  version: "1.2.0",
  provider: "openai",
  model: "some-model-1",
  effort: "low",
  stop: { reason: "turns", text: "stopped at the turn cap (40 model calls)" },
  usage: { turns: 40, inputTokens: 885_574, cachedInputTokens: 858_517, cacheWriteTokens: 0, outputTokens: 3_152, seconds: 98, estimatedCostUsd: 0.01286687 },
  dedup: { by: "judge", effort: "none", calls: 3, failed: 0, inputTokens: 900, outputTokens: 75, seconds: 1.2 },
};
const CARD = {
  key: "0123456789",
  expected: 13,
  found: ["a", "b", "c"],
  correct: 3,
  falsePositives: [{}],
  unknown: [{}],
  ambiguous: [],
  findings: 6,
  contextual: [{}],
  worthALook: [],
  calibration: null,
};

test("result row: what the run reported about itself, and how the key scored it", () => {
  const row = resultRow({
    app: "holdout",
    source: "dispatched",
    date: "2026-01-12",
    commit: "abcdef0123456789",
    archive: "ci-holdout-1-2-0-7",
    run: parseRunSummary(CI_JSON),
    card: CARD as never,
  });
  assert.deepEqual(row, {
    date: "2026-01-12",
    app: "holdout",
    version: "1.2.0",
    commit: "abcdef0",
    source: "dispatched",
    provider: "openai",
    model: "some-model-1",
    effort: "low",
    dedup: "judge",
    key: "0123456789",
    recall: { found: 3, expected: 13 },
    // 3 right of 4 labelled; of the 5 scored (6 less the contextual one), 3 are right at worst and 4 at best.
    precision: { correct: 3, labelled: 4, low: "60%", high: "80%" },
    brier: null,
    stop: "turns",
    turns: 40,
    tokens: { input: 885_574, cachedInput: 858_517, output: 3_152 },
    seconds: 98,
    costUsd: 0.01286687,
    archive: "ci-holdout-1-2-0-7",
  });
  // Brier only when the run judged something; a price the CLI did not know is null, not zero.
  const judged = resultRow({
    app: "demo",
    source: "scheduled",
    date: "2026-01-12",
    commit: "abcdef0",
    archive: "x",
    run: parseRunSummary({ ...CI_JSON, usage: { ...CI_JSON.usage, estimatedCostUsd: null } }),
    card: { ...CARD, calibration: { brier: 0.125, judged: 4 } } as never,
  });
  assert.equal(judged.brier, 0.125);
  assert.equal(judged.costUsd, null);
  assert.equal(
    resultRow({
      app: "demo",
      source: "manual",
      date: "2026-01-12",
      commit: "abcdef0",
      archive: "x",
      run: parseRunSummary(CI_JSON),
      card: { ...CARD, calibration: { brier: 0, judged: 0 } } as never,
    }).brier,
    null,
  );

  const base = { app: "demo", source: "scheduled", date: "2026-01-12", commit: "abcdef0", archive: "x", run: parseRunSummary(CI_JSON), card: CARD as never };
  assert.throws(() => resultRow({ ...base, app: "other" }), /app must be one of demo, holdout/);
  assert.throws(() => resultRow({ ...base, source: "cron" }), /source must be one of manual, scheduled, dispatched/);
  assert.throws(() => resultRow({ ...base, date: "12/01/2026" }), /date must be YYYY-MM-DD/);
  assert.throws(() => resultRow({ ...base, commit: "main" }), /commit must be a commit hash/);
  assert.throws(() => resultRow({ ...base, archive: "Run 1" }), /archive must be a run name/);
  assert.throws(() => parseRunSummary({ ...CI_JSON, usage: undefined }), /no usage or stop/);
  assert.throws(() => parseRunSummary({ ...CI_JSON, model: "" }), /model must be a non-empty string/);
  assert.throws(() => parseRunSummary({ ...CI_JSON, usage: { ...CI_JSON.usage, turns: -1 } }), /usage.turns must be a whole number/);
  assert.throws(() => parseRunSummary({ ...CI_JSON, usage: { ...CI_JSON.usage, estimatedCostUsd: "cheap" } }), /estimatedCostUsd/);
  assert.throws(() => resultRow({ ...base, run: parseRunSummary({ ...CI_JSON, version: "dev" }) }), /Not a version/);
  // How the run deduplicated is the run's own record: a ci.json from before the judge has none, and deduplicated by the rule.
  const { dedup: _judged, ...beforeJudge } = CI_JSON;
  assert.equal(resultRow({ ...base, run: parseRunSummary(beforeJudge) }).dedup, "rule");
  assert.equal(resultRow({ ...base, run: parseRunSummary({ ...CI_JSON, dedup: { by: "rule" } }) }).dedup, "rule");
  assert.throws(() => parseRunSummary({ ...CI_JSON, dedup: { by: "model" } }), /dedup.by must be one of rule, judge, not "model"/);
  assert.throws(() => parseRunSummary({ ...CI_JSON, dedup: "judge" }), /dedup.by must be one of rule, judge/);
});

test("result row: a run that asked for lanes records how many it asked for and ran, and the table says so beside the model", () => {
  const row = (lanes: unknown) =>
    resultRow({
      app: "demo",
      source: "manual",
      date: "2026-01-12",
      commit: "abcdef0",
      archive: "x",
      run: parseRunSummary({ ...CI_JSON, lanes }),
      card: CARD as never,
    });
  assert.deepEqual(row({ asked: 4, planned: 4, ran: 4, sessions: [] }).lanes, { asked: 4, planned: 4, ran: 4 });
  assert.deepEqual(row({ asked: 4, planned: 0, ran: 0, oneLoop: "nothing to split", sessions: [] }).lanes, { asked: 4, planned: 0, ran: 0, oneLoop: true });
  assert.equal(row(undefined).lanes, undefined, "a single loop's row is as it was");
  assert.equal(row({ asked: 1, planned: 0, ran: 0 }).lanes, undefined, "one lane asked is the single loop");
  assert.throws(() => row({ asked: "four", planned: 4, ran: 4 }), /lanes\.asked must be a whole number/);
  assert.throws(() => row({ asked: 4, ran: 4 }), /lanes\.planned must be a whole number/);
  assert.throws(() => row(4), /lanes is 4, not an object/);
  const cell = (lanes?: CiResultRow["lanes"]) =>
    renderTable([ROW(lanes ? { lanes } : {})])
      .split("\n")[2]
      .split(" | ")[4];
  assert.equal(cell(), "openai · some-model-1 · low");
  assert.equal(cell({ asked: 4, planned: 4, ran: 4 }), "openai · some-model-1 · low · 4 lanes");
  assert.equal(cell({ asked: 4, planned: 3, ran: 3 }), "openai · some-model-1 · low · 3 lanes of 4 asked", "the app split into fewer");
  assert.equal(cell({ asked: 4, planned: 4, ran: 3 }), "openai · some-model-1 · low · 3 lanes, 1 could not attach", "not the same as a smaller split");
  assert.equal(cell({ asked: 4, planned: 0, ran: 0, oneLoop: true }), "openai · some-model-1 · low · 4 lanes asked, one loop ran");
  assert.equal(cell({ asked: 4, planned: 4, ran: 0 }), "openai · some-model-1 · low · 4 lanes asked, none ran", "not a loop that never ran");
});

test("results file: rows are appended in order and a recorded run is never replaced", () => {
  const one = appendRows({ rows: [] }, [ROW({ archive: "a" })]);
  const two = appendRows(one, [ROW({ archive: "b" }), ROW({ archive: "c" })]);
  assert.deepEqual(
    two.rows.map((r) => r.archive),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    one.rows.map((r) => r.archive),
    ["a"],
    "the input is not changed",
  );
  assert.throws(() => appendRows(two, [ROW({ archive: "b", version: "9.9.9" })]), /b is already recorded/);
  assert.throws(() => appendRows(one, [ROW({ archive: "d" }), ROW({ archive: "d" })]), /d is already recorded/);
  assert.deepEqual(parseResults({ rows: [ROW()] }).rows, [ROW()]);
  assert.throws(() => parseResults({ rows: [{}] }), /row 0 is not a result row/);
  // A row that does not say how it deduplicated could be read beside a row of the other mode as one configuration.
  const { dedup: _mode, ...unmarked } = ROW({ archive: "unmarked" });
  assert.throws(() => parseResults({ rows: [ROW(), unmarked] }), /row 1 \(unmarked\) has dedup undefined, not one of rule, judge/);
  assert.throws(() => parseResults({ rows: [ROW({ dedup: "model" as never })] }), /has dedup "model"/);
  assert.equal(parseResults({ rows: [ROW({ dedup: "judge" })] }).rows[0].dedup, "judge");
  assert.throws(() => parseResults([]), /rows array/);
});

test("results table: one line per row, and it replaces only what is between its markers", () => {
  const table = renderTable([
    ROW(),
    ROW({ archive: "b", brier: 0.1234, costUsd: null, seconds: 45, precision: { correct: 3, labelled: 3, low: "100%", high: "100%" } }),
  ]);
  const lines = table.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(
    lines[2],
    "| 2026-01-05 | demo | 1.2.0 | scheduled | openai · some-model-1 · low | rule | 0123456789 | 5/13 | 7/8 (70%–90%) | — | done | 36 | 741,675 (716,628) / 2,190 | 1m 10s | $0.011 |",
  );
  assert.match(lines[0], /\| Provider · model · effort \| Dedup \| Key \|/);
  assert.match(renderTable([ROW({ dedup: "judge" })]).split("\n")[2], /\| openai · some-model-1 · low \| judge \| 0123456789 \|/);
  assert.match(lines[3], /\| 3\/3 \(100%\) \| 0\.123 \| done \| 36 \| .* \| 45s \| — \|$/);
  for (const l of lines) assert.equal(l.split("|").length, lines[0].split("|").length, "every line has the header's columns");

  const doc = `intro\n\n${TABLE_START}\nold table\n${TABLE_END}\n\nafter\n`;
  assert.equal(replaceTable(doc, "NEW"), `intro\n\n${TABLE_START}\n\nNEW\n\n${TABLE_END}\n\nafter\n`);
  assert.equal(replaceTable(replaceTable(doc, "NEW"), "NEW"), replaceTable(doc, "NEW"), "idempotent");
  assert.throws(() => replaceTable("no markers", "x"), /markers exactly once/);
  assert.throws(() => replaceTable(`${TABLE_END}\n${TABLE_START}`, "x"), /in that order/);
  assert.throws(() => replaceTable(`${TABLE_START}${TABLE_START}${TABLE_END}`, "x"), /exactly once/);
  // A CRLF checkout (git on Windows): the same result in the document's own endings, and so equal to itself when current.
  const crlf = doc.replace(/\n/g, "\r\n");
  assert.equal(replaceTable(crlf, "NEW\nROW"), replaceTable(doc, "NEW\nROW").replace(/\n/g, "\r\n"));
  assert.equal(replaceTable(replaceTable(crlf, "NEW"), "NEW"), replaceTable(crlf, "NEW"));
  assert.ok(!/[^\r]\n/.test(replaceTable(crlf, "NEW\nROW")), "no bare LF in a CRLF document");
});

test("results: docs/benchmark.md shows exactly what bench/ci-results.json records, and each row has its archive", () => {
  const results = parseResults(JSON.parse(fs.readFileSync(path.join(REPO, "bench", "ci-results.json"), "utf8")));
  const doc = fs.readFileSync(path.join(REPO, "docs", "benchmark.md"), "utf8");
  assert.equal(doc, replaceTable(doc, renderTable(results.rows)), "regenerate it with npm run bench:ci -- render");
  for (const r of results.rows) {
    const archive = path.join(REPO, "bench", "runs", `${r.archive}.json`);
    assert.ok(fs.existsSync(archive), `${r.archive} has no archive in bench/runs`);
    assert.equal((JSON.parse(fs.readFileSync(archive, "utf8")) as { app?: string }).app, r.app, `${r.archive} is archived as another app's run`);
  }
  // Every run of a version from before the model judge (3.14.1 and earlier) deduplicated by the rule alone, and says so.
  const beforeJudge = results.rows.filter((r) => compareVersions(r.version, "3.14.1") <= 0);
  assert.ok(beforeJudge.length >= 9, "the rows recorded before the judge are still there");
  assert.deepEqual(
    beforeJudge.filter((r) => r.dedup !== "rule").map((r) => r.archive),
    [],
  );
  // The two runs taken by hand before the workflow existed are the first rows.
  assert.deepEqual(
    results.rows
      .slice(0, 2)
      .map((r) => [r.archive, r.source, r.version, r.effort, `${r.recall.found}/${r.recall.expected}`, `${r.precision.correct}/${r.precision.labelled}`]),
    [
      ["ci-run-1", "manual", "3.12.0", "low", "5/13", "7/8"],
      ["ci-run-2", "manual", "3.12.0", "medium", "3/13", "3/3"],
    ],
  );
});

test("summary: a backslash and a pipe in a cell cannot break the table's columns", () => {
  const rows: Array<[string, string]> = [
    ["plain", "plain"],
    ["a|b", "a\\|b"],
    ["ends with \\", "ends with \\\\"],
    // Unescaped, the backslash would turn the pipe's escape into a literal backslash and the pipe back into a column.
    ["a\\|b", "a\\\\\\|b"],
    ["C:\\dir|x\ny", "C:\\\\dir\\|x y"],
    // A lone carriage return is a line break too.
    ["x\ry", "x y"],
  ];
  for (const [title, expected] of rows) {
    const md = ciSummaryMarkdown(RESULT({ findings: [finding({ title })] }));
    const row = md.split("\n").find((l) => l.startsWith("| high |"))!;
    assert.equal(row, `| high | functional | ${expected} | /things?x=1 |`, JSON.stringify(title));
    // Every unescaped pipe is a column border: always five, whatever the title holds.
    assert.equal(row.replace(/\\\\/g, "").replace(/\\\|/g, "").split("|").length - 1, 5, JSON.stringify(title));
  }
});

// ── showing an element: --show, --compare-url, the capture, the diff ───────

test("show: --show takes a few words, --compare-url needs --show and an http(s) URL without credentials", () => {
  const ok = parseCiArgs(["https://pr-7.preview.example.com", "--show", "the  Save\u0007 button", "--compare-url=https://www.example.com/app/"], "/work");
  assert.ok(ok.ok);
  assert.equal(ok.options.show, "the Save button", "whitespace collapsed, control characters out: it is a line of the prompt");
  assert.equal(ok.options.compareUrl, "https://www.example.com/app/");
  const refused: Array<[string[], RegExp]> = [
    [["--show", "   "], /--show needs a few words/],
    [["--show", "x".repeat(201)], /at most 200/],
    [["--compare-url", "https://www.example.com"], /give it with --show/],
    [["--show", "the Save button", "--compare-url", "file:///etc/passwd"], /http or https/],
    [["--show", "the Save button", "--compare-url", "https://u:p@www.example.com"], /no credentials/],
    [["--show", "the Save button", "--compare-url", "not a url"], /not a URL/],
  ];
  for (const [extra, expected] of refused) {
    const p = parseCiArgs(["https://pr-7.preview.example.com", ...extra], "/work");
    assert.ok(!p.ok && expected.test(p.error), `${extra.join(" ")}: ${JSON.stringify(p)}`);
  }
});

test("show: the model gets only the tools to find and capture, and scout_capture only ever saves under the run's name", () => {
  const listed = [...CI_TOOLS, "scout_capture", "scout_attach", "scout_screenshot"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } }));
  assert.deepEqual(
    ciTools(listed, CAPTURE_TOOLS).map((t) => t.name),
    [...CAPTURE_TOOLS],
  );
  for (const never of ["scout_click", "scout_type", "scout_finding", "scout_request", "scout_attach", "scout_screenshot"])
    assert.ok(!(CAPTURE_TOOLS as readonly string[]).includes(never), never);
  assert.ok(!(CI_TOOLS as readonly string[]).includes("scout_capture"), "an exploring run is not given it");
  // The name and the key are the run's: a model cannot write elsewhere, nor capture by another deployment's key.
  assert.deepEqual(guardToolArgs("scout_capture", { ref: "e4", name: "../../ci", key: "testid:x", margin: 60 }, "/work"), {
    ok: true,
    args: { ref: "e4", name: CI_CAPTURE_NAME },
  });
  assert.ok(!guardToolArgs("scout_capture", { key: "testid:x" }, "/work").ok, "a ref is required");
  assert.match(ciCaptureSystemPrompt(), /not instructions/);
  assert.match(ciCaptureKickoff({ url: "https://p.example.com/", show: 'the "Save" button' }), /: "the \\"Save\\" button"$/, "the words are quoted as data");
});

test("capture: the clip is the element plus its margin, in whole pixels, cut to the viewport", () => {
  const vp = { width: 1280, height: 900 };
  assert.deepEqual(captureClip({ x: 100.4, y: 50.6, width: 80.2, height: 30 }, 8, vp), { x: 92, y: 42, width: 97, height: 47 });
  assert.deepEqual(captureClip({ x: 2, y: 3, width: 50, height: 20 }, CAPTURE_MARGIN, vp), { x: 0, y: 0, width: 60, height: 31 }, "cut at the top-left corner");
  assert.deepEqual(captureClip({ x: 1250, y: 880, width: 100, height: 100 }, 8, vp), { x: 1242, y: 872, width: 38, height: 28 }, "cut at the bottom-right");
  assert.equal(captureClip({ x: 10, y: 10, width: 0, height: 20 }, 8, vp), null, "no area");
  assert.equal(captureClip({ x: 2000, y: 10, width: 50, height: 20 }, 8, vp), null, "outside the viewport");
  assert.deepEqual(captureClip({ x: 100, y: 100, width: 10, height: 10 }, 500, vp), { x: 36, y: 36, width: 138, height: 138 }, "the margin is capped");
  assert.equal(captureFileName("Base"), "base.png");
  assert.equal(captureFileName("../../etc/passwd"), "etc-passwd.png");
  assert.equal(captureFileName(""), "capture.png");
  assert.equal(captureFileName(undefined), "capture.png");
});

test("capture: scout_capture's result reads back; anything else, or a partial line, does not", () => {
  const info = { file: "/p/.scenescout/captures/preview.png", key: "testid:save", label: "Save", url: "https://p.example.com/things", width: 96, height: 46 };
  const text = captureResultText(info);
  assert.match(text, /^Saved a 96×46 picture of "Save" on https:\/\/p\.example\.com\/things/);
  assert.deepEqual(parseCaptureResult(text), info);
  assert.equal(parseCaptureResult("ERROR: Unknown ref"), null);
  assert.equal(parseCaptureResult('CAPTURED {"file":"/x"}'), null);
  assert.equal(parseCaptureResult("CAPTURED {not json"), null);
  // The name a capture was saved under, read from its path as each OS writes it.
  const names: Array<[string, string | null]> = [
    ["/work/site/.scenescout/captures/preview.png", "preview"],
    ["D:\\a\\work\\site\\.scenescout\\captures\\preview.png", "preview"],
    ["D:/a/work/site/.scenescout/captures/base.png", "base"],
    ["\\\\server\\share\\.scenescout\\captures\\preview.png", "preview"],
    ["/work/site/.scenescout/captures/../escape.png", null],
    ["C:\\site\\.scenescout\\escape.png", null],
    ["/work/site/.scenescout/captures/Preview.PNG", null],
    ["preview.png", null],
    ["", null],
  ];
  for (const [file, expected] of names) assert.equal(capturedName(file), expected, file);
});

test("capture: a page of the preview maps to the same page of the base URL", () => {
  const rows: Array<[string, string, string, string | null]> = [
    ["https://pr-7.preview.example.com/", "https://pr-7.preview.example.com/", "https://www.example.com/", "https://www.example.com/"],
    [
      "https://pr-7.preview.example.com/things/4?tab=a",
      "https://pr-7.preview.example.com/",
      "https://www.example.com/",
      "https://www.example.com/things/4?tab=a",
    ],
    // Roots with a path: the page's path below the root carries over.
    ["https://h.example.com/pr-7/settings", "https://h.example.com/pr-7/", "https://h.example.com/main/", "https://h.example.com/main/settings"],
    [
      "http://127.0.0.1:5/capture/after/button.html",
      "http://127.0.0.1:5/capture/after/button.html",
      "http://127.0.0.1:5/capture/before/",
      "http://127.0.0.1:5/capture/before/",
    ],
    [
      "http://127.0.0.1:5/capture/after/other.html",
      "http://127.0.0.1:5/capture/after/button.html",
      "http://127.0.0.1:5/capture/before/",
      "http://127.0.0.1:5/capture/before/other.html",
    ],
    // Outside the root's directory: the same path on the base's origin.
    ["https://h.example.com/help", "https://h.example.com/pr-7/", "https://www.example.com/app/", "https://www.example.com/help"],
    ["https://elsewhere.example.com/", "https://pr-7.preview.example.com/", "https://www.example.com/", null],
    ["not a url", "https://pr-7.preview.example.com/", "https://www.example.com/", null],
  ];
  for (const [page, from, to, expected] of rows) assert.equal(rebaseUrl(page, from, to), expected, page);
});

/** A picture of one colour, with an optional rectangle of another. */
function picture(width: number, height: number, fill: number[], rect?: { x: number; y: number; w: number; h: number; rgba: number[] }): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inRect = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      data.set(inRect ? rect!.rgba : fill, (y * width + x) * 4);
    }
  return { width, height, data };
}

/** A PNG of RGB rows, each written with the given filter, as a browser's encoder may: decodePng must undo all five. */
function filteredRgbPng(img: RgbaImage, filters: number[]): Buffer {
  const bpp = 3;
  const stride = img.width * bpp;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < img.height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < img.width; x++) row.set(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3), x * bpp);
    rows.push(row);
  }
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const raw: number[] = [];
  for (let y = 0; y < img.height; y++) {
    const f = filters[y % filters.length];
    raw.push(f);
    for (let i = 0; i < stride; i++) {
      const cur = rows[y][i];
      const left = i >= bpp ? rows[y][i - bpp] : 0;
      const up = y > 0 ? rows[y - 1][i] : 0;
      const upLeft = y > 0 && i >= bpp ? rows[y - 1][i - bpp] : 0;
      const pred = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][f];
      raw.push((cur - pred + 256) & 0xff);
    }
  }
  const crcOf = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcOf(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("png: what is written reads back the same; every row filter is undone; what is not a readable PNG is refused", () => {
  const img = picture(7, 5, [10, 20, 30, 255], { x: 2, y: 1, w: 3, h: 2, rgba: [200, 100, 50, 128] });
  const png = encodePng(img);
  assert.ok(isPng(png));
  assert.deepEqual(decodePng(png), img);
  // An RGB PNG with every filter type, as browsers write them.
  const opaque = picture(9, 6, [5, 250, 90, 255], { x: 3, y: 2, w: 4, h: 3, rgba: [255, 0, 0, 255] });
  for (let i = 0; i < opaque.data.length; i += 4) opaque.data[i] = (i * 7) & 0xff; // some variation for the predictors to work on
  assert.deepEqual(decodePng(filteredRgbPng(opaque, [0, 1, 2, 3, 4])), opaque);
  // The 1×1 fixture the test app serves, written by another encoder.
  const pixel = decodePng(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test-app", "pixel.png")));
  assert.deepEqual([pixel.width, pixel.height, pixel.data.length], [1, 1, 4]);
  assert.throws(() => decodePng(Buffer.from("GIF89a")), /not a PNG/);
  const broken = Buffer.from(png);
  broken[broken.length - 20] ^= 0xff;
  assert.throws(() => decodePng(broken), /checksum|cut short/);
  // A 1×1 header over pixel data that inflates to a megabyte: refused at the header's size, not inflated whole.
  const bomb = filteredRgbPng(picture(1, 1, [0, 0, 0, 255]), [0]);
  const idatAt = bomb.indexOf("IDAT") - 4;
  const idatLength = bomb.readUInt32BE(idatAt);
  const big = zlib.deflateSync(Buffer.alloc(1_000_000));
  const body = Buffer.concat([Buffer.from("IDAT", "latin1"), big]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(big.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body), 0);
  const inflated = Buffer.concat([bomb.subarray(0, idatAt), len, body, crc, bomb.subarray(idatAt + 12 + idatLength)]);
  assert.throws(() => decodePng(inflated), /does not inflate to the size its header gives/);
});

test("diff: identical pictures change 0%, one changed region its share, and a size change is reported and counted", () => {
  const before = picture(20, 10, [240, 240, 240, 255]);
  const same = diffImages(before, picture(20, 10, [240, 240, 240, 255]));
  assert.deepEqual([same.changed, same.percent, same.sizeChanged, same.box], [0, 0, false, null]);
  // A difference under the threshold is not a change: colour rounded one step differently.
  assert.equal(diffImages(before, picture(20, 10, [243, 240, 238, 255])).changed, 0);

  const after = picture(20, 10, [240, 240, 240, 255], { x: 4, y: 2, w: 5, h: 4, rgba: [30, 90, 200, 255] });
  const d = diffImages(before, after);
  assert.equal(d.changed, 20);
  assert.equal(d.total, 200);
  assert.equal(d.percent, 10);
  assert.deepEqual(d.box, { x: 4, y: 2, width: 5, height: 4 });
  const at = (x: number, y: number) => [...d.image.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)];
  assert.deepEqual(at(5, 3), [255, 0, 80, 255], "a changed pixel is highlighted");
  assert.notDeepEqual(at(0, 0), [255, 0, 80, 255], "an unchanged one is not");
  // The diff picture is a PNG like any other.
  assert.deepEqual(decodePng(encodePng(d.image)), d.image);

  // Grown by 2 columns: the pictures are laid over each other from the top-left, and the new columns are changes.
  const grown = diffImages(before, picture(22, 10, [240, 240, 240, 255]));
  assert.equal(grown.sizeChanged, true);
  assert.deepEqual([grown.before, grown.after, grown.width, grown.height], [{ width: 20, height: 10 }, { width: 22, height: 10 }, 22, 10]);
  assert.equal(grown.changed, 20);
  assert.deepEqual(grown.box, { x: 20, y: 0, width: 2, height: 10 });
  assert.equal(
    diffImages(picture(1000, 1000, [0, 0, 0, 255]), picture(1000, 1000, [0, 0, 0, 255], { x: 0, y: 0, w: 1, h: 1, rgba: [255, 255, 255, 255] })).percent,
    0.01,
    "one pixel in a million is not 0%",
  );
});

test("summary: a capture run's summary and ci.json say what was shown and what changed, and the words stay redacted", () => {
  const capture = {
    what: `the Save button ${OPENAI_KEY}`,
    status: "captured" as const,
    preview: { file: "shots/preview.png", key: "testid:save", label: "Save", path: "/things", width: 96, height: 46 },
    base: { file: "shots/base.png", path: "/things", width: 90, height: 46 },
    diff: { file: "shots/diff.png", changedPixels: 441, totalPixels: 4416, percent: 9.99, sizeChanged: true, box: { x: 0, y: 0, width: 96, height: 46 } },
  };
  const md = ciSummaryMarkdown(RESULT({ capture }), [OPENAI_KEY]);
  assert.match(md, /9\.99% of pixels changed, and the element's size changed: shots\/diff\.png/);
  assert.ok(!md.includes(OPENAI_KEY));
  const json = ciSummaryJson(RESULT({ capture }), "9.9.9", [OPENAI_KEY]) as { capture: typeof capture };
  assert.equal(json.capture.diff.percent, 9.99);
  assert.ok(!JSON.stringify(json).includes(OPENAI_KEY));
  assert.ok(!("capture" in (ciSummaryJson(RESULT(), "9.9.9") as object)), "an exploring run has no capture");
});

test("loop: every tool call that ran is reported with the arguments it ran with", async () => {
  const seen: string[] = [];
  const model: ModelClient = {
    turns: 0,
    async next() {
      return (this as { turns: number }).turns++ === 0
        ? { text: "", calls: [{ id: "1", name: "scout_capture", input: { ref: "e2", name: "../x" } }], usage: NO_USAGE }
        : { text: "Captured the Save button.", calls: [], usage: NO_USAGE };
    },
    addResults() {},
  } as ModelClient & { turns: number };
  const out = await agentLoop({
    client: model,
    host: { call: async (name, args) => ({ text: `${name} ${JSON.stringify(args)}`, isError: false }) },
    tools: [{ name: "scout_capture", description: "", parameters: {} }],
    caps: DEFAULT_CAPS,
    log: () => {},
    projectDir: "/work",
    onResult: (name, args, r) => seen.push(`${name} ${JSON.stringify(args)} ${r.isError}`),
  });
  assert.deepEqual(seen, [`scout_capture {"ref":"e2","name":"${CI_CAPTURE_NAME}"} false`]);
  assert.equal(out.finalText, "Captured the Save button.");
});

test("compare: a base that throws keeps the preview's picture and records why, and the result is still a capture", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenescout-ci-capture-"));
  const file = path.join(dir, "preview-src.png");
  fs.writeFileSync(file, encodePng(picture(4, 3, [1, 2, 3, 255])));
  const opts = parseCiArgs(["https://pr-7.preview.example.com/", "--show", "the Save button", "--compare-url", "https://www.example.com/"], dir);
  assert.ok(opts.ok);
  const host = {
    tools: async () => [],
    // The MCP client rejects on a timeout rather than returning isError.
    call: async (name: string): Promise<{ text: string; isError: boolean }> => {
      throw new Error(`${name} timed out`);
    },
    close: async () => {},
  };
  const outcome = await captureShots({
    host,
    options: opts.options,
    captured: { file, key: "tid:save", label: "Save", url: "https://pr-7.preview.example.com/things", width: 4, height: 3 },
    outDir: dir,
    timeLeft: () => 5_000,
    log: () => {},
  });
  assert.equal(outcome.status, "captured");
  assert.equal(outcome.preview?.file, "shots/preview.png");
  assert.ok(fs.existsSync(path.join(dir, "shots", "preview.png")), "the preview's picture is kept");
  assert.match(outcome.detail ?? "", /the base URL could not be captured: scout_attach timed out/);
  assert.equal(outcome.base, undefined);
});

// ── finding dedup: the model judge ──────────────────────────────────────────

test("dedup: the judge asks at the lowest effort each API takes; the server's mode and key come from its environment", () => {
  assert.equal(judgeEffort("openai"), "none");
  assert.equal(judgeEffort("anthropic"), "low", "the Messages API has no none");
  assert.equal(dedupModeFromEnv({}), "rule", "the MCP server judges only when told to");
  assert.equal(dedupModeFromEnv({ SCENESCOUT_DEDUP: " judge " }), "judge");
  assert.throws(() => dedupModeFromEnv({ SCENESCOUT_DEDUP: "model" }), /SCENESCOUT_DEDUP must be one of rule, judge, not "model"/);

  const one = judgeKeyConfig({ OPENAI_API_KEY: OPENAI_KEY });
  assert.ok(one.ok);
  assert.deepEqual(one.resolved, { provider: "openai", model: "gpt-6-luna", effort: "none", baseUrl: "https://api.openai.com/v1" });
  assert.equal(one.key, OPENAI_KEY);
  const both = { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY };
  const ambiguous = judgeKeyConfig(both);
  assert.ok(!ambiguous.ok && /both .* are set: set SCENESCOUT_DEDUP_PROVIDER/.test(ambiguous.error));
  const named = judgeKeyConfig({ ...both, SCENESCOUT_DEDUP_PROVIDER: "anthropic" });
  assert.ok(named.ok && named.resolved.provider === "anthropic" && named.resolved.effort === "low" && named.key === ANTHROPIC_KEY);
  const none = judgeKeyConfig({});
  assert.ok(!none.ok && /needs ANTHROPIC_API_KEY or OPENAI_API_KEY in the server's environment/.test(none.error));
  const missing = judgeKeyConfig({ OPENAI_API_KEY: OPENAI_KEY, SCENESCOUT_DEDUP_PROVIDER: "anthropic" });
  assert.ok(!missing.ok && /SCENESCOUT_DEDUP_PROVIDER=anthropic needs ANTHROPIC_API_KEY/.test(missing.error));
  assert.throws(() => judgeKeyConfig({ OPENAI_API_KEY: OPENAI_KEY, SCENESCOUT_DEDUP_PROVIDER: "gemini" }), /must be one of anthropic, openai/);
  for (const r of [one, ambiguous, named, none, missing]) assert.ok(!(r.ok ? "" : r.error).includes(OPENAI_KEY), "no message carries a key");
});

test("dedup: the summary and ci.json say how findings were deduplicated and what the judge's calls cost", () => {
  const judged = RESULT({
    dedup: { by: "judge", effort: "none", calls: 4, failed: 1, usage: { input: 1_200, cachedInput: 0, cacheWrite: 0, output: 100 }, ms: 3_400 },
  });
  const md = ciSummaryMarkdown(judged);
  assert.match(
    md,
    /\| Finding dedup \| the rule, then the model judge at effort none for filings it kept apart: 4 call\(s\), 1 without an answer \(the rule decided those\), 1,300 tokens \(in the usage below\), 3\.4s \|/,
  );
  assert.deepEqual((ciSummaryJson(judged, "9.9.9") as { dedup: unknown }).dedup, {
    by: "judge",
    effort: "none",
    calls: 4,
    failed: 1,
    inputTokens: 1_200,
    outputTokens: 100,
    seconds: 3.4,
  });
  const ruled = RESULT({ dedup: { by: "rule" } });
  assert.match(ciSummaryMarkdown(ruled), /\| Finding dedup \| the rule alone \|/);
  assert.deepEqual((ciSummaryJson(ruled, "9.9.9") as { dedup: unknown }).dedup, { by: "rule" });
  assert.ok(!/Finding dedup/.test(ciSummaryMarkdown(RESULT())), "a capture run files nothing and says nothing about dedup");
});

/** Two filings on one page that the store's rule keeps apart: no evidence, nothing quoted, titles too unalike. */
const SAVE_FILING = { severity: "medium", category: "ux-confusing", title: "The save button gives no feedback", detail: "Pressed it; nothing changed." };
const SILENT_FILING = { severity: "high", category: "ux-confusing", title: "Clicking save shows nothing", detail: "No toast, no spinner." };
const QUIET_FILING = { severity: "low", category: "ux-confusing", title: "Pressing save does nothing visible", detail: "Same page." };

/** The judge's stand-in API: the Responses API's shape, a judge_pair call, and the usage a real call reports. */
const judgeAnswers =
  (verdict: string, confidence: number) =>
  (body: { tools: Array<{ name: string }> }): { status: number; body: unknown } =>
    body.tools.some((t) => t.name === "judge_pair")
      ? {
          status: 200,
          body: {
            status: "completed",
            output: [{ type: "function_call", call_id: "j1", name: "judge_pair", arguments: JSON.stringify({ verdict, confidence }) }],
            usage: { input_tokens: 300, input_tokens_details: { cached_tokens: 0 }, output_tokens: 25 },
          },
        }
      : { status: 400, body: { error: { message: "only the judge calls this API in the test" } } };

/**
 * A CI run's dedup, end to end with no browser: the loop and a scripted model
 * file findings through the run's own MCP client (ciClient, judgeHandler and
 * httpJudgeAsk against a stand-in API) into a server whose store files them as
 * the MCP server does (fileFinding), its judge asking through the client by
 * sampling, as the MCP server's does when the client declares
 * DEDUP_JUDGE_CAPABILITY. Only the transport is in memory instead of stdio.
 */
async function judgedRun(o: {
  filings: Array<Record<string, unknown>>;
  judge: boolean;
  api: (body: any) => { status: number; body: unknown };
  after?: (server: McpServer) => Promise<void>;
}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ci-dedup-"));
  const store = new MemoryStore(project);
  const server = new McpServer({ name: "test-server", version: "1" });
  server.registerTool(
    "scout_finding",
    {
      description: "File a finding",
      inputSchema: {
        severity: z.enum(["high", "medium", "low"]),
        category: z.string(),
        title: z.string(),
        detail: z.string(),
        evidence: z.string().optional(),
      },
    },
    async (args) => {
      const filed = await store.fileFinding({ ...args, url: "http://app.test/orders", state: "/orders#s1" });
      const said = filed.isNew
        ? `recorded ${filed.finding.id}`
        : `merged into ${filed.finding.id}${filed.judged ? ` by the judge at ${filed.judged.pSame}` : ""}`;
      return { content: [{ type: "text" as const, text: said }] };
    },
  );
  const requests: any[] = [];
  const api = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const r = o.api(body);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // The run's budget: the loop takes its turns from it, and the judge's calls add their tokens to it, as runCi has them do.
  const spend = newBudget(BIG, Date.now());
  const calls: JudgeCalls = { calls: 0, failed: 0, usage: { ...NO_USAGE }, ms: 0 };
  const resolved = { provider: "openai" as const, model: "gpt-6-luna", effort: "none", baseUrl: "http://model.test/v1" };
  const ask = httpJudgeAsk(resolved, OPENAI_KEY, { fetch: api, sleep: async () => {} });
  const client = ciClient(o.judge ? judgeHandler({ ask, model: resolved.model, spend, caps: BIG, calls, secrets: [OPENAI_KEY] }) : undefined);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const logs: string[] = [];
  // What the MCP server does on attach with dedup "judge" (configureDedup, planDedup): ask through the client when it says it answers.
  if (clientAnswersJudge(server.server.getClientCapabilities()))
    store.dedupJudge = new DedupJudge(
      samplingAsk((params, options) => server.server.createMessage(params, options)),
      { label: "the CI run's model", log: (l) => logs.push(l) },
    );
  const model = new Scripted([
    ...o.filings.map((f, i) => ({ text: "", calls: [call(`f${i}`, "scout_finding", f)], usage: use(100) })),
    { text: "Done.", calls: [], usage: use(10) },
  ]);
  const tools: ToolSpec[] = [{ name: "scout_finding", description: "", parameters: { type: "object", properties: {} } }];
  try {
    const out = await agentLoop({ client: model, host: toolHost(client), tools, caps: BIG, log: () => {}, projectDir: project, budget: spend });
    await o.after?.(server);
    return { out, run: spend, findings: store.findings.map((f) => ({ ...f })), logs, requests, calls, results: model.received.flat() };
  } finally {
    await client.close();
    store.flush();
    fs.rmSync(project, { recursive: true, force: true });
  }
}

test("dedup end to end: two near-duplicate findings the rule keeps apart are merged by the judge, and its tokens count in the run's usage", async () => {
  // The contrast first: the same two filings with the rule alone stay two findings, and no model is asked.
  const ruled = await judgedRun({ filings: [SAVE_FILING, SILENT_FILING], judge: false, api: judgeAnswers("same", 0.92) });
  assert.equal(ruled.findings.length, 2);
  assert.equal(ruled.requests.length, 0);

  const judged = await judgedRun({ filings: [SAVE_FILING, SILENT_FILING], judge: true, api: judgeAnswers("same", 0.92) });
  assert.equal(judged.out.stop, "done");
  assert.equal(judged.findings.length, 1, JSON.stringify(judged.findings.map((f) => f.title)));
  const [kept] = judged.findings;
  assert.equal(kept.title, SAVE_FILING.title);
  assert.equal(kept.runs, 1, "both filings were in one run, which counts once; the merge itself is kept in judgedMerges");
  assert.deepEqual(
    kept.judgedMerges?.map((m) => [m.title, m.severity, m.pSame]),
    [[SILENT_FILING.title, "high", 0.92]],
  );
  assert.match(judged.results[1].text, /merged into .* by the judge at 0\.92/);
  // One call: the run's model, at effort none, offered only judge_pair, shown both findings and the page.
  assert.equal(judged.requests.length, 1);
  const [req] = judged.requests;
  assert.equal(req.reasoning.effort, "none");
  assert.equal(req.max_output_tokens, JUDGE_MAX_OUTPUT_TOKENS);
  assert.deepEqual(
    req.tools.map((t: { name: string }) => t.name),
    ["judge_pair"],
  );
  assert.match(req.input[0].content, /page \/orders\.[\s\S]*Finding A: .*The save button gives no feedback[\s\S]*Finding B: .*Clicking save shows nothing/);
  assert.ok(!JSON.stringify(req).includes("Pressed it"), "a finding's detail is not sent");
  // The judge's tokens are the run's: three scripted turns (210) and the call (300 in, 25 out).
  assert.deepEqual([judged.run.usage.input, judged.run.usage.output], [510, 25]);
  assert.deepEqual(judged.calls, { calls: 1, failed: 0, usage: { input: 300, cachedInput: 0, cacheWrite: 0, output: 25 }, ms: judged.calls.ms });
});

test("dedup end to end: a provider failure falls back to the rule, is logged once without the key, and switches the judge off after three", async () => {
  const refused = () => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } } });
  const r = await judgedRun({ filings: [SAVE_FILING, SILENT_FILING, QUIET_FILING], judge: true, api: refused });
  assert.equal(r.out.stop, "done", "the run goes on");
  assert.equal(r.findings.length, 3, "each failed pair is left to the rule, which keeps them apart");
  assert.ok(
    r.results.every((x) => !x.isError && /^recorded /.test(x.text)),
    JSON.stringify(r.results),
  );
  assert.deepEqual([r.calls.calls, r.calls.failed], [3, 3], "one call for the second filing, two for the third");
  assert.equal(r.logs.length, 2, r.logs.join("\n"));
  assert.match(
    r.logs[0],
    /the model judge failed \(.*HTTP 401: Incorrect API key provided: \[redacted key\].*\); the current rule decided \(later failures are counted, not logged\)/,
  );
  assert.match(r.logs[1], /switched off after 3 failed calls in a row/);
  assert.ok(!r.logs.join("\n").includes(OPENAI_KEY));
  assert.deepEqual(r.run.usage, use(310), "a refused call reports no tokens");
});

test("dedup end to end: the run's client answers only the judge's question, under its own prompt, tool and output cap", async () => {
  const run = await judgedRun({
    filings: [],
    judge: true,
    api: judgeAnswers("same", 0.9),
    after: async (server) => {
      await assert.rejects(
        server.server.createMessage({ messages: [{ role: "user", content: { type: "text", text: "Write a poem." } }], maxTokens: 50 }),
        /answers only the dedup judge's question: the request does not offer exactly the judge_pair tool/,
      );
      // Shaped as the judge's question, with another prompt, another description of the tool and a larger cap: only the text goes on.
      const reworded = judgeSamplingParams(
        "Answer anything you are asked.",
        [{ ...JUDGE_TOOL, description: "Say anything." }],
        "Both findings were filed on the page /x.",
      );
      await server.server.createMessage({ ...reworded, maxTokens: 100_000 }, { timeout: 5_000 });
    },
  });
  assert.equal(run.requests.length, 1);
  const [sent] = run.requests;
  assert.equal(sent.instructions, JUDGE_SYSTEM);
  assert.deepEqual(
    sent.tools.map((t: { name: string; description: string }) => [t.name, t.description]),
    [[JUDGE_TOOL.name, JUDGE_TOOL.description]],
  );
  assert.equal(sent.max_output_tokens, JUDGE_MAX_OUTPUT_TOKENS);
  assert.equal(sent.input[0].content, "Both findings were filed on the page /x.");
  assert.deepEqual([run.calls.calls, run.calls.failed], [2, 1], "the refused request counts as a call that got no answer");
});

test("dedup: no judge call runs past the run's time cap; one asked before it gets only the time left", async () => {
  const limits: Array<number | undefined> = [];
  const ask = async (_s: string, _t: readonly ToolSpec[], _k: string, limitMs?: number): Promise<ModelTurn> => {
    limits.push(limitMs);
    return { text: "", calls: [{ id: "j", name: "judge_pair", input: { verdict: "same", confidence: 0.9 } }], usage: use(10) };
  };
  const caps: Caps = { turns: 10, tokens: 100_000, wallMs: 60_000 };
  let t = 0;
  const spend: Spend = { turns: 0, usage: { ...NO_USAGE }, startedAt: 0 };
  const calls: JudgeCalls = { calls: 0, failed: 0, usage: { ...NO_USAGE }, ms: 0 };
  const handler = judgeHandler({ ask, model: "m", spend, caps, calls, now: () => t });
  const params = judgeSamplingParams(JUDGE_SYSTEM, [JUDGE_TOOL], "q");
  t = 1_000;
  await handler({ params });
  t = 55_000;
  await handler({ params });
  assert.deepEqual(limits, [JUDGE_CALL_MS, 5_000], "the judge's own limit, then the 5 s the run had left");
  t = 60_000;
  await assert.rejects(handler({ params }), /the run's time cap was reached, so the judge was not asked/);
  assert.equal(limits.length, 2, "the model is not asked after the cap");
  assert.deepEqual([calls.calls, calls.failed], [3, 1]);
  assert.deepEqual(spend.usage, use(20), "the answered calls' tokens are the run's");
});

test("dedup: a judge call that outlasts its limit fails as the judge's limit, not the run's time cap", async () => {
  // A request that never answers. A real one holds its socket open, which keeps the process running until the abort;
  // AbortSignal.timeout's timer does not (it is unref'd), so the stand-in holds a timer of its own until then.
  const hung = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      const socket = setTimeout(() => {}, 60_000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(socket);
        reject(init.signal!.reason);
      });
    })) as typeof fetch;
  const ask = httpJudgeAsk({ provider: "openai", model: "m", effort: "none", baseUrl: "http://model.test/v1" }, OPENAI_KEY, { fetch: hung, callMs: 50 });
  await assert.rejects(ask("s", [], "q"), (err: Error) => /^no answer within 50ms/.test(err.message) && !(err instanceof OutOfTime));
});

// ── a finding's picture ─────────────────────────────────────────────────────

test("evidence: inline for interactive use, on file in CI; the option, then the environment, decide first", () => {
  const rows: Array<[string, Parameters<typeof evidenceSettings>[0], Record<string, string>, string, string]> = [
    ["interactive", undefined, {}, "inline", "default (interactive)"],
    ["CI=true", undefined, { CI: "true" }, "file", "default (CI)"],
    ["CI=1", undefined, { CI: "1" }, "file", "default (CI)"],
    ["GitHub Actions", undefined, { GITHUB_ACTIONS: "true" }, "file", "default (CI)"],
    ["CI=false is not CI", undefined, { CI: "false" }, "inline", "default (interactive)"],
    ["CI=0 is not CI", undefined, { CI: "0" }, "inline", "default (interactive)"],
    ["the environment over the CI default", undefined, { CI: "true", SCENESCOUT_EVIDENCE: "inline" }, "inline", "environment"],
    ["the environment, any case", undefined, { SCENESCOUT_EVIDENCE: " OFF " }, "off", "environment"],
    ["the option over the environment", "file", { SCENESCOUT_EVIDENCE: "off" }, "file", "option"],
    ["the option in CI", "inline", { CI: "true" }, "inline", "option"],
  ];
  for (const [label, asked, env, mode, source] of rows) {
    const got = evidenceSettings(asked, env);
    assert.equal(got.mode, mode, label);
    assert.equal(got.source, source, label);
  }
  assert.throws(() => evidenceSettings(undefined, { SCENESCOUT_EVIDENCE: "always" }), /SCENESCOUT_EVIDENCE must be one of inline, file, off \(got "always"\)/);
  assert.equal(isCiEnv({}), false);
  assert.equal(isCiEnv({ CI: "" }), false);
});

test("evidence: the size bounds default, read from the environment within their limits, and refuse anything else", () => {
  const d = evidenceSettings(undefined, {});
  assert.deepEqual(
    { maxPx: d.maxPx, maxBytes: d.maxBytes, inlineMax: d.inlineMax },
    { maxPx: EVIDENCE_LIMITS.maxPx.default, maxBytes: EVIDENCE_LIMITS.maxKb.default * 1024, inlineMax: EVIDENCE_LIMITS.inline.default },
  );
  const set = evidenceSettings("file", { SCENESCOUT_EVIDENCE_MAX_PX: "400", SCENESCOUT_EVIDENCE_MAX_KB: "64", SCENESCOUT_EVIDENCE_INLINE: "0" });
  assert.deepEqual({ maxPx: set.maxPx, maxBytes: set.maxBytes, inlineMax: set.inlineMax }, { maxPx: 400, maxBytes: 64 * 1024, inlineMax: 0 });
  for (const [name, value] of [
    ["SCENESCOUT_EVIDENCE_MAX_PX", "100"],
    ["SCENESCOUT_EVIDENCE_MAX_PX", "800px"],
    ["SCENESCOUT_EVIDENCE_MAX_KB", "99999"],
    ["SCENESCOUT_EVIDENCE_MAX_KB", "-1"],
    ["SCENESCOUT_EVIDENCE_INLINE", "1e3"],
  ])
    assert.throws(() => evidenceSettings(undefined, { [name]: value }), new RegExp(`^Error: ${name} must be a whole number`), `${name}=${value}`);
});

test("record: the option, then SCENESCOUT_RECORD, else off in every kind of run", () => {
  assert.equal(recordChoice(undefined, {}), false);
  assert.equal(recordChoice(undefined, { CI: "true" }), false);
  assert.equal(recordChoice(undefined, { SCENESCOUT_RECORD: "on" }), true);
  assert.equal(recordChoice(undefined, { SCENESCOUT_RECORD: "TRUE" }), true);
  assert.equal(recordChoice(undefined, { SCENESCOUT_RECORD: "off" }), false);
  assert.equal(recordChoice(false, { SCENESCOUT_RECORD: "on" }), false, "the option wins");
  assert.equal(recordChoice(true, {}), true);
  assert.throws(() => recordChoice(undefined, { SCENESCOUT_RECORD: "sometimes" }), /SCENESCOUT_RECORD must be on or off/);
});

test("evidence: when a picture is taken, and what it frames", () => {
  const base = { mode: "inline" as const, pageOpen: true, isNew: true, hasPicture: false, regressed: false };
  assert.deepEqual(evidenceFrame({ ...base, ref: "e7" }), { take: true, frame: "element", ref: "e7" });
  assert.deepEqual(evidenceFrame(base), { take: true, frame: "viewport" }, "no element named: the viewport");
  assert.deepEqual(evidenceFrame({ ...base, ref: "  " }), { take: true, frame: "viewport" }, "a blank ref names nothing");
  assert.deepEqual(evidenceFrame({ ...base, mode: "file", ref: "e7" }), { take: true, frame: "element", ref: "e7" }, "on file only is still taken");
  assert.equal(evidenceFrame({ ...base, mode: "off" }).take, false);
  assert.equal(evidenceFrame({ ...base, pageOpen: false }).take, false);
  // A merge into a finding that has its picture keeps that one; one with none gets this one.
  const merged = { ...base, isNew: false };
  assert.deepEqual(evidenceFrame({ ...merged, hasPicture: true }), { take: false, why: "the finding it merged into already has its picture" });
  assert.deepEqual(evidenceFrame({ ...merged, hasPicture: false }), { take: true, frame: "viewport" });
  // A regression is new evidence that it is back: the picture is replaced.
  assert.deepEqual(evidenceFrame({ ...merged, hasPicture: true, regressed: true, ref: "e2" }), { take: true, frame: "element", ref: "e2" });
});

test("evidence: a session returns pictures inline up to its count, then keeps them on file only", () => {
  assert.equal(returnsInline("inline", 0, 10), true);
  assert.equal(returnsInline("inline", 9, 10), true);
  assert.equal(returnsInline("inline", 10, 10), false);
  assert.equal(returnsInline("inline", 0, 0), false, "a count of 0 returns none");
  assert.equal(returnsInline("file", 0, 10), false);
  assert.equal(returnsInline("off", 0, 10), false);
});

test("evidence: a picture's path is under the session's recordings, and nothing from the agent reaches it raw", () => {
  assert.equal(findingPicturePath("default", "a1b2c3d4e5"), "recordings/default/finding-a1b2c3d4e5.png");
  assert.equal(findingPicturePath("../../etc", "a1b2"), "recordings/etc/finding-a1b2.png");
  assert.equal(findingPicturePath("", "../x"), "recordings/session/finding-finding.png");
  // What memory.json holds: `picture`, a plain path relative to .scenescout/, read back only when it is one of these
  // paths, and `pictureShot`, what it shows, which may be missing without losing the path.
  const shot = { width: 300, height: 120, frame: "element", label: "Save", at: "2026-01-01T00:00:00Z" };
  const ok = { picture: "recordings/default/finding-a1b2.png", pictureShot: shot };
  assert.deepEqual(readFindingPicture(ok), { file: ok.picture, ...shot });
  assert.equal(readFindingPicture({ ...ok, picture: "../memory.json" }), null);
  assert.equal(readFindingPicture({ ...ok, picture: "recordings/default/0001-click.jpg" }), null, "a frame is not a finding's picture");
  assert.equal(readFindingPicture({ ...ok, picture: { file: ok.picture } }), null, "an object is not a path");
  assert.equal(readFindingPicture({}), null);
  assert.deepEqual(readFindingPicture({ picture: ok.picture }), { file: ok.picture }, "no shot: the path still stands");
  assert.deepEqual(readFindingPicture({ ...ok, pictureShot: { ...shot, frame: "page" } }), { file: ok.picture });
  assert.deepEqual(readFindingPicture({ ...ok, pictureShot: { ...shot, width: "300" } }), { file: ok.picture });
  assert.equal(describePicture(readFindingPicture(ok)!), '300×120, "Save" and around it');
  assert.equal(describePicture({ file: ok.picture }), "what the page showed");
  assert.equal(describePicture({ ...shot, frame: "viewport", label: undefined }), "300×120, the page as it was");
});

test("png: the compact encoding reads back exactly, three channels when opaque and four when not", () => {
  const opaque = picture(37, 21, [250, 250, 250, 255], { x: 5, y: 4, w: 12, h: 6, rgba: [20, 90, 200, 255] });
  const back = decodePng(encodePngCompact(opaque));
  assert.deepEqual([back.width, back.height], [37, 21]);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(opaque.data));
  assert.equal(encodePngCompact(opaque)[25], 2, "RGB");
  const clear = picture(9, 9, [0, 0, 0, 0], { x: 2, y: 2, w: 3, h: 3, rgba: [255, 0, 0, 128] });
  assert.deepEqual(Buffer.from(decodePng(encodePngCompact(clear)).data), Buffer.from(clear.data));
  assert.equal(encodePngCompact(clear)[25], 6, "RGBA");
  assert.ok(encodePngCompact(opaque).length < encodePng(opaque).length, "smaller than the diff's encoding");
});

test("png: shrinking averages what each pixel covers and never enlarges", () => {
  // Black and white columns, two wide: halved, each output pixel is one of each, so grey.
  const stripes = picture(8, 2, [255, 255, 255, 255]);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) if (x % 4 < 2) stripes.data.set([0, 0, 0, 255], (y * 8 + x) * 4);
  const half = shrinkImage(stripes, 4, 1);
  assert.deepEqual([half.width, half.height], [4, 1]);
  assert.deepEqual([...half.data.subarray(0, 4)], [0, 0, 0, 255]);
  const quarter = shrinkImage(stripes, 2, 1);
  assert.deepEqual([...quarter.data.subarray(0, 4)], [128, 128, 128, 255], "a thin line fades, it does not vanish");
  assert.equal(shrinkImage(stripes, 16, 4), stripes, "never enlarged");
});

/** A noisy picture, which compresses badly, as a busy page does. */
function noisy(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  // mulberry32: a fixed sequence with no pattern deflate can use.
  let seed = 7;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  for (let i = 0; i < data.length; i += 4) {
    const v = next();
    data[i] = v & 0xff;
    data[i + 1] = (v >>> 8) & 0xff;
    data[i + 2] = (v >>> 16) & 0xff;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

test("png: a picture is fitted to its longer side, then to its bytes, or refused when nothing readable fits", () => {
  const plain = picture(1280, 720, [240, 240, 240, 255], { x: 100, y: 100, w: 300, h: 40, rgba: [10, 10, 10, 255] });
  const sided = fitPicture(plain, 800, 200 * 1024);
  assert.ok(sided);
  assert.deepEqual([sided.width, sided.height, sided.shrunk], [800, 450, true], "the longer side to 800, the shape kept");
  const small = fitPicture(picture(300, 100, [1, 2, 3, 255]), 800, 200 * 1024);
  assert.deepEqual([small?.width, small?.height, small?.shrunk], [300, 100, false], "a picture inside the bounds is kept at its size");
  const tall = fitPicture(picture(200, 1000, [9, 9, 9, 255]), 500, 200 * 1024);
  assert.deepEqual([tall?.width, tall?.height], [100, 500], "the longer side is the height");
  // Noise does not compress: the bytes bound shrinks it further, and the result is within it.
  const busy = noisy(600, 400);
  const fitted = fitPicture(busy, 800, 64 * 1024);
  assert.ok(fitted && fitted.png.length <= 64 * 1024 && fitted.width < 600 && fitted.shrunk, `fitted to the bytes: ${fitted?.png.length}`);
  assert.ok(Math.max(fitted.width, fitted.height) >= FIT_MIN_SIDE);
  assert.ok(isPng(fitted.png) && decodePng(fitted.png).width === fitted.width);
  // Nothing at the smallest readable size fits in 1 KB of noise: none, rather than a smudge.
  assert.equal(fitPicture(busy, 800, 1024), null);
});
