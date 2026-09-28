/**
 * `scenescout ci` end to end, with no real model and no network: a scripted
 * model drives the real MCP server and browser against the test app, and the
 * CLI is run against a fake API server on this machine that answers the way
 * each provider's API does. Checks the tool round trips, the report written
 * on an early stop and on a start that fails, the provider rule, that the
 * key never reaches the output, and a run asked to show or compare one element
 * (--show, --compare-url) against two deployments of one page that differ in
 * one button's colours.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCi, type ModelClient } from "../../dist/ci-run.js";
import { parseCiArgs, type ResolvedProvider } from "../../dist/engine/ci.js";
import { capturedName, parseCaptureResult } from "../../dist/engine/capture.js";
import { decodePng } from "../../dist/engine/png.js";
import type { ModelTurn, ToolOutcome } from "../../dist/engine/provider.js";
import { check, type SmokeContext } from "./harness.ts";

export const title = "ci (unattended run)";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");
// Invented; nothing shaped like a real service's key.
const KEY = "fake-ci-key-0123456789abcdefghij";
const RESOLVED: ResolvedProvider = { provider: "openai", model: "gpt-6-luna", effort: "low", baseUrl: "https://api.invalid/v1" };

class Scripted implements ModelClient {
  readonly received: ToolOutcome[][] = [];
  private i = 0;
  constructor(private readonly turns: ModelTurn[]) {}
  async next(): Promise<ModelTurn> {
    return this.turns[Math.min(this.i++, this.turns.length - 1)];
  }
  addResults(results: readonly ToolOutcome[]): void {
    this.received.push([...results]);
  }
}
const usage = { input: 1000, cachedInput: 0, cacheWrite: 0, output: 50 };
const turn = (calls: Array<[string, string, unknown]>, text = ""): ModelTurn => ({
  text,
  calls: calls.map(([id, name, input]) => ({ id, name, input })),
  usage,
});

function options(url: string, projectDir: string, extra: string[] = []) {
  const p = parseCiArgs([url, "--project", projectDir, ...extra], projectDir);
  if (!p.ok) throw new Error(p.error);
  return p.options;
}

const read = (dir: string, name: string): string => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), "utf8") : "");

export async function run({ baseUrl }: SmokeContext): Promise<void> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "scout-ci-"));
  try {
    await roundTrip(baseUrl, path.join(work, "round-trip"));
    await earlyStop(baseUrl, path.join(work, "early-stop"));
    await cannotStart(path.join(work, "cannot-start"));
    await showAndCompare(baseUrl, work);
    await overTheWire(baseUrl, work);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function roundTrip(baseUrl: string, project: string): Promise<void> {
  fs.mkdirSync(project, { recursive: true });
  const model = new Scripted([
    turn([["c1", "scout_crawl", {}]]),
    turn([
      ["c2", "scout_snapshot", {}],
      ["c3", "scout_attach", { url: "http://elsewhere.invalid" }],
    ]),
    turn([["c4", "scout_finding", { severity: "medium", category: "other", title: "Scripted CI finding", detail: "Filed by the scripted model." }]]),
    turn([], "Explored the test app."),
  ]);
  const { result, exitCode, written } = await runCi(options(baseUrl, project), RESOLVED, { makeClient: () => model, version: "0.0.0-test" });
  const out = path.join(project, ".scenescout", "ci");
  check("ci: the scripted run ends when the model says it is done, and exits 0", result.stop === "done" && exitCode === 0, JSON.stringify(result.stop));
  check(
    "ci: each tool call's result goes back to the model, in order",
    model.received.length === 3 &&
      model.received[0][0].id === "c1" &&
      /page2|route/i.test(model.received[0][0].text) &&
      model.received[1].map((r) => r.id).join() === "c2,c3" &&
      !model.received[1][0].isError,
    JSON.stringify(model.received).slice(0, 1500),
  );
  check(
    "ci: a tool the run does not give the model is refused, not run",
    model.received[1][1].isError && /no tool named "scout_attach"/.test(model.received[1][1].text),
  );
  check(
    "ci: all five files are written",
    ["report.md", "report.html", "summary.md", "ci.json", "ci.sarif"].every((f) => written.includes(f)),
    written.join(),
  );
  check("ci: report.md is the ordinary report", read(out, "report.md").startsWith("# SceneScout Report"));
  const json = JSON.parse(read(out, "ci.json") || "{}") as { findings?: Array<{ title: string }>; usage?: { turns: number } };
  check("ci: the finding the model filed is this run's", json.findings?.some((f) => f.title === "Scripted CI finding") === true, JSON.stringify(json.findings));
  check("ci: usage counts every turn", json.usage?.turns === 4, JSON.stringify(json.usage));
  check("ci: the summary says the model finished", /the model finished the run/.test(read(out, "summary.md")));
}

async function earlyStop(baseUrl: string, project: string): Promise<void> {
  fs.mkdirSync(project, { recursive: true });
  const busy = new Scripted([turn([["s", "scout_snapshot", {}]])]);
  const { result, exitCode } = await runCi(options(baseUrl, project, ["--max-turns", "2"]), RESOLVED, { makeClient: () => busy, version: "0.0.0-test" });
  const out = path.join(project, ".scenescout", "ci");
  check(
    "ci: the turn cap ends a run that would not stop, and it still exits 0",
    result.stop === "turns" && result.spend.turns === 2 && exitCode === 0,
    result.stop,
  );
  check(
    "ci: the report is written on an early stop, with the contract marked unmet",
    read(out, "report.md").startsWith("# SceneScout Report") && !result.contractMet,
  );
  check(
    "ci: the summary names the cap that ended the run",
    /stopped at the turn cap \(2 model calls\)/.test(read(out, "summary.md")),
    read(out, "summary.md").slice(0, 400),
  );
}

async function cannotStart(project: string): Promise<void> {
  fs.mkdirSync(project, { recursive: true });
  // A port nothing listens on: attach fails, the model is never called.
  const never = new Scripted([turn([["x", "scout_crawl", {}]])]);
  const { result, exitCode, written } = await runCi(options("http://127.0.0.1:9/", project), RESOLVED, { makeClient: () => never, version: "0.0.0-test" });
  check(
    "ci: an app that does not answer is could-not-start, exit 2, and the model is never called",
    result.stop === "could-not-start" && exitCode === 2 && never.received.length === 0,
    `${result.stop} ${exitCode}`,
  );
  check("ci: it still writes a summary saying so, and no report", written.includes("summary.md") && !written.includes("report.md"), written.join());
}

// ── show and compare ────────────────────────────────────────────────────────

/** A model that snapshots, then captures the button it was told to by its test id's label, as a real one would pick it by its words. */
class Pointing implements ModelClient {
  readonly received: ToolOutcome[][] = [];
  constructor(private readonly label: string) {}
  async next(): Promise<ModelTurn> {
    if (this.received.length === 0) return turn([["s", "scout_snapshot", {}]]);
    if (this.received.length === 1) {
      const ref = new RegExp(`(e\\d+) button "${this.label}"`).exec(this.received[0][0].text)?.[1] ?? "e0";
      // A name and a key the run must ignore: the file's name is the run's, and the key is not the model's to use.
      return turn([["c", "scout_capture", { ref, name: "../../escape", key: "testid:elsewhere" }]]);
    }
    return turn([], `Captured the ${this.label} button.`);
  }
  addResults(results: readonly ToolOutcome[]): void {
    this.received.push([...results]);
  }
}

async function showAndCompare(baseUrl: string, work: string): Promise<void> {
  const after = `${baseUrl}/capture/after/button.html`;
  // The base equivalent of the target URL: the page is the target itself, so it maps to this.
  const before = `${baseUrl}/capture/before/button.html`;
  const compare = async (label: string, project: string) => {
    fs.mkdirSync(project, { recursive: true });
    const model = new Pointing(label);
    const r = await runCi(options(after, project, ["--show", `the ${label} button`, "--compare-url", before]), RESOLVED, {
      makeClient: () => model,
      version: "0.0.0-test",
    });
    return { ...r, model, out: path.join(project, ".scenescout", "ci") };
  };

  const save = await compare("Save", path.join(work, "compare-save"));
  const c = save.result.capture;
  check(
    "compare: the run exits 0 and captures the element on both deployments",
    save.exitCode === 0 && c?.status === "captured" && !!c.base && !!c.diff,
    JSON.stringify(c),
  );
  check(
    "compare: the model's capture ran under the run's own name, not the one it asked for",
    // Read from the structured result, so the path is compared as the OS wrote it.
    !save.model.received[1][0].isError && capturedName(parseCaptureResult(save.model.received[1][0].text)?.file ?? "") === "preview",
    save.model.received[1]?.[0]?.text,
  );
  const shots = path.join(save.out, "shots");
  const files = ["preview.png", "base.png", "diff.png"].map((f) => path.join(shots, f));
  check(
    "compare: the three pictures are written under shots/",
    files.every((f) => fs.existsSync(f)),
    fs.existsSync(shots) ? fs.readdirSync(shots).join() : "no shots/",
  );
  if (files.every((f) => fs.existsSync(f))) {
    const [p, b] = files.slice(0, 2).map((f) => decodePng(fs.readFileSync(f)));
    // A button of about 80×38 CSS pixels plus 8 on each side: a picture of the element, not of the page.
    check(
      "compare: each picture is the element and its margin, not the page",
      p.width > 40 && p.width < 200 && p.height > 30 && p.height < 90,
      `${p.width}×${p.height}`,
    );
    check(
      "compare: the restyled button is the same size on both, and its pixels changed",
      b.width === p.width && b.height === p.height && (c?.diff?.percent ?? 0) > 20,
      JSON.stringify(c?.diff),
    );
  }
  check(
    "compare: ci.json records the capture, and no report is written",
    (() => {
      const json = JSON.parse(read(save.out, "ci.json") || "{}") as { capture?: { diff?: { percent: number } } };
      return (json.capture?.diff?.percent ?? 0) > 0 && !fs.existsSync(path.join(save.out, "report.md"));
    })(),
  );

  const cancel = await compare("Cancel", path.join(work, "compare-cancel"));
  check(
    "compare: the button that did not change reports 0% changed",
    cancel.result.capture?.status === "captured" && cancel.result.capture.diff?.changedPixels === 0 && cancel.result.capture.diff.percent === 0,
    JSON.stringify(cancel.result.capture),
  );

  // show: the preview alone, and a description the model cannot match captures nothing and says so.
  const project = path.join(work, "show-missing");
  fs.mkdirSync(project, { recursive: true });
  const nothing = new Scripted([turn([["s", "scout_snapshot", {}]]), turn([], "No element on the page matches a delete button.")]);
  const missing = await runCi(options(after, project, ["--show", "the delete button"]), RESOLVED, { makeClient: () => nothing, version: "0.0.0-test" });
  check(
    "show: a run that finds nothing to capture still exits 0, with not-found and the model's reason",
    missing.exitCode === 0 && missing.result.capture?.status === "not-found" && /delete button/.test(missing.result.capture.detail ?? ""),
    JSON.stringify(missing.result.capture),
  );
}

// ── the CLI, against a fake API on this machine ────────────────────────────

type Reply = { status: number; body: unknown };
async function fakeApi(
  replies: (req: { path: string; body: any; auth: string }, n: number) => Reply,
): Promise<{ base: string; requests: Array<{ path: string; body: any; auth: string }>; close: () => void }> {
  const requests: Array<{ path: string; body: any; auth: string }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const entry = { path: req.url ?? "", body: raw ? JSON.parse(raw) : null, auth: String(req.headers.authorization ?? req.headers["x-api-key"] ?? "") };
      requests.push(entry);
      const r = replies(entry, requests.length);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, close: () => server.close() };
}

function runCli(args: string[], env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  const clean = { ...process.env };
  delete clean.OPENAI_API_KEY;
  delete clean.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, "ci", ...args],
      { encoding: "utf8", timeout: 300_000, env: { ...clean, GITHUB_STEP_SUMMARY: "", ...env } },
      (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === "number" ? err.code : null) : 0, out: `${stdout}\n${stderr}` }),
    );
  });
}

const filesContaining = (dir: string, needle: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile() && fs.readFileSync(path.join(dir, f), "utf8").includes(needle))
    : [];

async function overTheWire(baseUrl: string, work: string): Promise<void> {
  // OpenAI Responses: one function call, then a message.
  const openai = await fakeApi((_req, n) =>
    n === 1
      ? {
          status: 200,
          body: {
            output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "scout_crawl", arguments: "{}" }],
            usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20 },
          },
        }
      : {
          status: 200,
          body: {
            output: [{ type: "message", content: [{ type: "output_text", text: "Done exploring." }] }],
            usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 800 }, output_tokens: 10 },
          },
        },
  );
  const p1 = path.join(work, "wire-openai");
  fs.mkdirSync(p1);
  try {
    const r = await runCli([baseUrl, "--project", p1, "--base-url", openai.base], { OPENAI_API_KEY: KEY });
    const out = path.join(p1, ".scenescout", "ci");
    check(
      "ci cli (openai): a run over the Responses API exits 0 and writes the report",
      r.status === 0 && read(out, "report.md").startsWith("# SceneScout Report"),
      r.out.slice(-1500),
    );
    const first = openai.requests[0];
    check(
      "ci cli (openai): the key is sent as a bearer token, the request is stateless and carries only the allowed tools",
      first?.path === "/v1/responses" &&
        first.auth === `Bearer ${KEY}` &&
        first.body.store === false &&
        first.body.reasoning?.effort === "low" &&
        first.body.tools.some((t: { name: string }) => t.name === "scout_crawl") &&
        !first.body.tools.some((t: { name: string }) => t.name === "scout_attach"),
      JSON.stringify(first?.body ?? {}).slice(0, 400),
    );
    const second = openai.requests[1];
    check(
      "ci cli (openai): the crawl's result goes back as the function call's output",
      second?.body.input.some(
        (i: { type?: string; call_id?: string; output?: string }) =>
          i.type === "function_call_output" && i.call_id === "call_1" && /route|page/i.test(i.output ?? ""),
      ),
    );
    check("ci cli (openai): the usage line is printed", /2 turn\(s\), 2,100 tokens in \(800 cached\), 30 out/.test(r.out), r.out.slice(-600));
    check("ci cli (openai): the key is nowhere in the output or the files", !r.out.includes(KEY) && filesContaining(out, KEY).length === 0);
  } finally {
    openai.close();
  }

  // A key the API refuses: the error body echoes it, as some APIs do.
  const refusing = await fakeApi(() => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}.` } } }));
  const p2 = path.join(work, "wire-refused");
  fs.mkdirSync(p2);
  try {
    const r = await runCli([baseUrl, "--project", p2, "--base-url", refusing.base], { OPENAI_API_KEY: KEY });
    const out = path.join(p2, ".scenescout", "ci");
    check(
      "ci cli: a refused key ends the run with exit 2 and the API's message",
      r.status === 2 && /HTTP 401: Incorrect API key provided/.test(r.out),
      r.out.slice(-800),
    );
    check("ci cli: a refused key is not retried", refusing.requests.length === 1, String(refusing.requests.length));
    check(
      "ci cli: the echoed key is redacted from the output and every file",
      !r.out.includes(KEY) && filesContaining(out, KEY).length === 0 && /\[redacted key\]/.test(r.out),
    );
  } finally {
    refusing.close();
  }

  // Both keys and no --provider: refused before any request is sent.
  const untouched = await fakeApi(() => ({ status: 500, body: {} }));
  try {
    const r = await runCli([baseUrl, "--project", work, "--base-url", untouched.base], { OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: `${KEY}-2` });
    check(
      "ci cli: with both keys set and no --provider it exits 2 and sends nothing",
      r.status === 2 && /pass --provider/.test(r.out) && untouched.requests.length === 0,
      r.out.slice(-400),
    );
  } finally {
    untouched.close();
  }

  // Anthropic Messages: one tool_use, then end_turn.
  const anthropic = await fakeApi((_req, n) =>
    n === 1
      ? {
          status: 200,
          body: {
            content: [{ type: "tool_use", id: "tu_1", name: "scout_crawl", input: {} }],
            stop_reason: "tool_use",
            usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, output_tokens: 20 },
          },
        }
      : {
          status: 200,
          body: {
            content: [{ type: "text", text: "Done." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 60, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 5 },
          },
        },
  );
  const p3 = path.join(work, "wire-anthropic");
  fs.mkdirSync(p3);
  try {
    const r = await runCli([baseUrl, "--project", p3, "--base-url", anthropic.base, "--provider", "anthropic"], { ANTHROPIC_API_KEY: KEY });
    const second = anthropic.requests[1];
    check(
      "ci cli (anthropic): a run over the Messages API exits 0, with the key as x-api-key and the crawl's result as a tool_result",
      r.status === 0 &&
        anthropic.requests[0]?.path === "/v1/messages" &&
        anthropic.requests[0].auth === KEY &&
        second?.body.messages.at(-1).content[0].type === "tool_result" &&
        second.body.messages.at(-1).content[0].tool_use_id === "tu_1",
      r.out.slice(-1200),
    );
    check(
      "ci cli (anthropic): the key is nowhere in the output or the files",
      !r.out.includes(KEY) && filesContaining(path.join(p3, ".scenescout", "ci"), KEY).length === 0,
    );
  } finally {
    anthropic.close();
  }
}
