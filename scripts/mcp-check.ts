/**
 * MCP wire-up check: spawns the built server over stdio, lists tools, calls
 * scout_scan to prove the protocol layer works end to end, and asserts the SKILL
 * documents every tool the server exposes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { startFixtureServer } from "./smoke/harness.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "mcp-server.js");
const packageRoot = path.join(here, "..");

const EXPECTED_TOOLS = [
  "scout_playbook",
  "scout_lane_report",
  "scout_scan",
  "scout_attach",
  "scout_session",
  "scout_journey",
  "scout_note",
  "scout_snapshot",
  "scout_click",
  "scout_type",
  "scout_upload",
  "scout_hover",
  "scout_select",
  "scout_navigate",
  "scout_back",
  "scout_press",
  "scout_scroll",
  "scout_screenshot",
  "scout_finding",
  "scout_crawl",
  "scout_run_plan",
  "scout_design_audit",
  "scout_resolve",
  "scout_coverage",
  "scout_report",
  "scout_close",
];

type ToolText = { content: Array<{ type: string; text?: string }> };
const textOf = (result: unknown): string => (result as ToolText).content.map((c) => c.text ?? "").join("");
const LIVE_LINE = /Live view: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{16,}\/)/;

function fail(message: string): never {
  console.error(`MCP CHECK FAILED — ${message}`);
  process.exit(1);
}

/**
 * The person running the agent gets the live view's address from the agent:
 * attach has to carry it, and it has to work. Checked over the wire because
 * the hand-off lives in the server, not in the engine the smoke suite drives.
 */
/** Resolves to the project directory, whose token file main() checks is gone once the client has closed the connection. */
async function liveViewCheck(client: Client): Promise<string> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-live-"));
  try {
    const attached = textOf(await client.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, projectPath: projectDir, session: "watched" } }));
    const url = LIVE_LINE.exec(attached)?.[1];
    if (!url) fail(`scout_attach did not hand over a live view address:\n${attached}`);

    const status = (await (await fetch(`${url}api/status`)).json()) as { sessions: Array<{ session: string }> };
    if (!status.sessions.some((s) => s.session === "watched"))
      fail(`the address from scout_attach does not show the attached session: ${JSON.stringify(status)}`);

    const report = (await (await fetch(`${url}api/report`)).json()) as { markdown?: string };
    if (!report.markdown?.startsWith("# SceneScout Report")) fail(`the live view does not render the run's report: ${JSON.stringify(report).slice(0, 200)}`);
    if (fs.existsSync(path.join(projectDir, ".scenescout", "report.md"))) fail("reading the report from the live view wrote it to disk");

    // A tool that acts is refused until the session has said what it is doing,
    // because the live view can only show what the agent states.
    const refused = textOf(await client.callTool({ name: "scout_navigate", arguments: { target: "/page2.html", session: "watched" } }));
    if (!/needs a task/.test(refused)) fail(`scout_navigate acted with no task standing:\n${refused}`);
    const stated = textOf(
      await client.callTool({ name: "scout_navigate", arguments: { target: "/page2.html", session: "watched", task: "Walk the two static pages" } }),
    );
    if (/needs a task/.test(stated)) fail(`scout_navigate refused a task it was given:\n${stated}`);
    const kept = textOf(await client.callTool({ name: "scout_navigate", arguments: { target: "/", session: "watched" } }));
    if (/needs a task/.test(kept)) fail("the task did not stay set for the rest of the batch");
    const showing = (await (await fetch(`${url}api/status`)).json()) as { sessions: Array<{ task?: string }> };
    if (showing.sessions[0]?.task !== "Walk the two static pages") fail(`the live view does not show the task: ${JSON.stringify(showing.sessions[0])}`);
    // Reading the page needs none: orienting is what comes before saying.
    const snapped = textOf(await client.callTool({ name: "scout_snapshot", arguments: { session: "watched" } }));
    if (/needs a task/.test(snapped)) fail("scout_snapshot should not need a task");
    console.log("✓ a tool that acts needs a task, and it reaches the live view");

    const facts = (await (await fetch(`${url}api/status`)).json()) as { report?: { path: string; written: boolean } };
    if (facts.report?.path !== path.join(projectDir, ".scenescout", "report.md"))
      fail(`the live view does not name the report's file: ${JSON.stringify(facts.report)}`);
    if (facts.report.written) fail("the report is reported as written although scout_report was never called");

    const listed = textOf(await client.callTool({ name: "scout_session", arguments: {} }));
    if (LIVE_LINE.exec(listed)?.[1] !== url) fail(`scout_session does not repeat the same address:\n${listed}`);

    const tokenFile = path.join(projectDir, ".scenescout", "live-token");
    const mode = fs.statSync(tokenFile).mode & 0o777;
    if (process.platform !== "win32" && mode !== 0o600) fail(`the token file is readable beyond its owner (mode ${mode.toString(8)})`);
    if (!url.includes(fs.readFileSync(tokenFile, "utf8").trim())) fail("the token file and the address disagree");

    // What `scenescout watch` builds its address from: the port in status.json plus the token file.
    const written = await readStatusWhenWhole<{ live?: { port?: number } }>(projectDir);
    if (written.live?.port !== Number(new URL(url).port)) fail(`status.json does not carry the live view's port: ${JSON.stringify(written.live)}`);
    const cli = path.join(packageRoot, "dist", "cli.js");
    const watched = spawnSync(process.execPath, [cli, "watch", "--no-open", projectDir], { encoding: "utf8" });
    if (!watched.stdout.includes(url)) fail(`scenescout watch does not print the address scout_attach handed over:\n${watched.stdout}${watched.stderr}`);
    const printed = spawnSync(process.execPath, [cli, "status", projectDir], { encoding: "utf8" }).stdout;
    if (!/^\s+watched \(/m.test(printed) || !printed.includes("Live view: scenescout watch"))
      fail(`scenescout status does not describe the session and point at watch:\n${printed}`);

    // The run's end is when somebody wants the report, and the engines are
    // gone by then: the view has to keep serving what the run found.
    await client.callTool({ name: "scout_close", arguments: { all: true } });
    const afterClose = (await (await fetch(`${url}api/report`)).json()) as { markdown?: string };
    if (!afterClose.markdown?.startsWith("# SceneScout Report"))
      fail(`the report is gone once the run's sessions closed: ${JSON.stringify(afterClose).slice(0, 200)}`);
    const emptied = (await (await fetch(`${url}api/status`)).json()) as { sessions: unknown[]; report?: { path: string } };
    if (emptied.sessions.length !== 0) fail("a closed session is still on the board");
    if (!emptied.report?.path) fail("the report's file is no longer named once the run has finished");

    console.log("✓ scout_attach hands over a working live view address, and status/watch read it back");
    console.log("✓ the report outlives the run's sessions, with the path it belongs at");
  } finally {
    fixture.close();
  }
  return projectDir;
}

/**
 * A parallel run over the wire: the planner reports while a lane did the
 * auditing, and a lane's report is folded with what it judged and never filed.
 * Both live in the server (the gate and the fold), not in the engine the smoke
 * suite drives.
 */
async function laneCheck(client: Client): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-lanes-"));
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => textOf(await client.callTool({ name, arguments: args }));
  try {
    for (const session of ["planner", "orders"]) {
      await call("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, session, mode: "read-only", objective: `${session} lane` });
    }
    const early = await call("scout_report", { session: "planner", level: "minimal" });
    if (!/No scout_design_audit was run in this run/.test(early))
      fail(`the gate let a run with no audit through:
${early.slice(0, 400)}`);
    await call("scout_design_audit", { session: "orders" });
    const late = await call("scout_report", { session: "planner", level: "minimal" });
    if (/No scout_design_audit/.test(late))
      fail(`a lane's audit did not count for the planner's report:
${late.slice(0, 400)}`);
    console.log("✓ the report gate counts a design audit from any session in the run");

    const report = (evidence: string): string =>
      JSON.stringify({
        lane: "orders",
        status: "complete",
        decisions: [{ observation: "email-no-label", verdict: "defect", severity: "low", category: "a11y", confidence: 0.8, evidence }],
        routes: ["/"],
        blocked_by: null,
      });
    const unfiled = await call("scout_lane_report", {
      lane: "orders",
      reply: "Here is my report:\n```json\n" + report("input[name=email] has no label") + "\n```\nDone.",
    });
    if (!/Lane report accepted/.test(unfiled) || !/discarded unread/.test(unfiled))
      fail(`prose around one fenced report was not accepted and disclosed:\n${unfiled}`);
    if (!/1 judged defect\(s\) have no finding/.test(unfiled) || !unfiled.includes("email-no-label"))
      fail(`an unfiled defect was not named at the fold:\n${unfiled}`);
    await call("scout_finding", {
      session: "orders",
      severity: "low",
      category: "a11y",
      title: "Email field has no label",
      detail: "The field is announced without a name.",
      evidence: "input[name=email] has no label",
    });
    const filed = await call("scout_lane_report", { lane: "orders", reply: report("input[name=email] has no label") });
    if (/have no finding/.test(filed)) fail(`a filed defect was still reported as unfiled:\n${filed}`);
    console.log("✓ a lane report names what was judged and never filed, and accepts prose around one fenced object");
    await call("scout_close", { all: true });

    // The server keeps one store per project for its whole life. A second run
    // in the same process must not pass the gate on the first run's audit.
    await call("scout_attach", { url: fixture.baseUrl, projectPath: projectDir, session: "second-run", mode: "read-only", objective: "second run" });
    const secondRun = await call("scout_report", { session: "second-run", level: "minimal" });
    if (!/No scout_design_audit was run in this run/.test(secondRun))
      fail(`a second run passed the audit gate on the first run's audit:\n${secondRun.slice(0, 400)}`);
    await call("scout_close", { all: true });
    console.log("✓ a run's shared state ends with its last session");
  } finally {
    fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * status.json is written asynchronously and can be caught mid-write, which is
 * what `scenescout status` reports as truncated. A check reads it the way a
 * patient reader does: until it parses.
 */
async function readStatusWhenWhole<T>(projectDir: string): Promise<T> {
  const file = path.join(projectDir, ".scenescout", "status.json");
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** ADR 7: the token outlives nothing. Checked after the client has closed the connection, which is how most clients leave. */
async function tokenGoneCheck(projectDir: string): Promise<void> {
  const tokenFile = path.join(projectDir, ".scenescout", "live-token");
  try {
    const deadline = Date.now() + 8000;
    while (fs.existsSync(tokenFile)) {
      if (Date.now() > deadline) fail("the live view's token file is still there after the client closed the connection");
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log("✓ the token file is removed once the client has gone");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/** SCENESCOUT_LIVE=off is a promise that no port opens. A switch that only hides the address would break it quietly. */
async function liveViewOffCheck(): Promise<void> {
  const fixture = await startFixtureServer();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-mcp-liveoff-"));
  const env = Object.fromEntries(Object.entries({ ...process.env, SCENESCOUT_LIVE: "off" }).filter((e): e is [string, string] => typeof e[1] === "string"));
  const client = new Client({ name: "ft-check-off", version: "0.0.1" });
  await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env }));
  try {
    const attached = textOf(await client.callTool({ name: "scout_attach", arguments: { url: fixture.baseUrl, projectPath: projectDir } }));
    if (attached.includes("Live view")) fail(`SCENESCOUT_LIVE=off still handed over an address:\n${attached}`);
    const status = await readStatusWhenWhole<{ live?: unknown; detail?: unknown[] }>(projectDir);
    if (status.live) fail(`SCENESCOUT_LIVE=off still advertises a port: ${JSON.stringify(status.live)}`);
    if (fs.existsSync(path.join(projectDir, ".scenescout", "live-token"))) fail("SCENESCOUT_LIVE=off still wrote a token file");
    if (!Array.isArray(status.detail) || status.detail.length !== 1) fail("status.json lost its per-session entries when the live view is off");
    await client.callTool({ name: "scout_close", arguments: { all: true } });
    console.log("✓ SCENESCOUT_LIVE=off opens no port and still writes per-session status");
  } finally {
    await client.close();
    fixture.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: "node", args: [serverPath] });
  const client = new Client({ name: "ft-check", version: "0.0.1" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length > 0) {
    console.error(`MCP CHECK FAILED — missing tools: ${missing.join(", ")}\nGot: ${names.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ server exposes ${names.length} tools`);

  // A client with no skill loader gets the method from the server, three ways.
  // Each is checked over the wire, because each is a different client's only route to it.
  const skillBody = fs.readFileSync(path.join(packageRoot, "skills", "scenescout", "SKILL.md"), "utf8");
  const instructions = client.getInstructions() ?? "";
  if (!instructions.includes("scout_playbook")) {
    console.error(`MCP CHECK FAILED — the server instructions do not point at scout_playbook. Got: ${JSON.stringify(instructions.slice(0, 200))}`);
    process.exit(1);
  }
  // Called with no `arguments` field at all: "takes no input" invites exactly that call.
  const played = (await client.callTool({ name: "scout_playbook" })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const playbook = played.content.find((c) => c.type === "text")?.text ?? "";
  if (played.isError || !playbook.includes("## Setup (in order)") || !playbook.startsWith("# SceneScout")) {
    console.error(`MCP CHECK FAILED — scout_playbook did not return the method (without front matter). Got: ${JSON.stringify(playbook.slice(0, 200))}`);
    process.exit(1);
  }
  if (!skillBody.endsWith(playbook)) {
    console.error("MCP CHECK FAILED — scout_playbook returned text that is not the skill file's body; the two must be one text.");
    process.exit(1);
  }
  const { prompts } = await client.listPrompts();
  const prompt = await client.getPrompt({ name: "explore", arguments: { url: "http://localhost:3000", level: "minimal" } });
  const promptText = prompt.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
  if (
    !prompts.some((p) => p.name === "explore") ||
    !promptText.startsWith("# SceneScout") ||
    !/Target: http:\/\/localhost:3000\nLevel: minimal$/.test(promptText)
  ) {
    console.error(`MCP CHECK FAILED — the explore prompt is missing, or lacks the method or what was asked. Got: ${JSON.stringify(promptText.slice(-200))}`);
    process.exit(1);
  }
  // A client sends no `arguments` object when the person typed none; every argument is optional.
  const bare = await client.getPrompt({ name: "explore" });
  const bareText = bare.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
  if (!bareText.includes("Target: ask me for the URL")) {
    console.error(`MCP CHECK FAILED — the explore prompt without arguments did not ask for a target. Got: ${JSON.stringify(bareText.slice(-200))}`);
    process.exit(1);
  }
  // A level the method does not know is refused, and the server survives refusing it.
  const refused = await client.getPrompt({ name: "explore", arguments: { level: "deep" } }).then(
    () => "",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  if (!/minimal, medium, extensive/.test(refused)) {
    console.error(`MCP CHECK FAILED — an unknown level was not refused with the choices. Got: ${JSON.stringify(refused)}`);
    process.exit(1);
  }
  console.log("✓ the method reaches a client through instructions, scout_playbook and the explore prompt");

  // The SKILL is the agent's entire methodology — a tool it never mentions is
  // effectively unshipped, however well the engine implements it. scout_scroll
  // shipped a whole version before the skill described it, and nothing caught
  // that but a human noticing.
  const skillPath = path.join(packageRoot, "skills", "scenescout", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");
  const undocumented = names.filter((t) => !skill.includes(t));
  if (undocumented.length > 0) {
    console.error(
      `MCP CHECK FAILED — the skill never mentions: ${undocumented.join(", ")}\n` +
        `Every registered tool must appear in skills/scenescout/SKILL.md, or the agent will never use it.`,
    );
    process.exit(1);
  }
  console.log(`✓ skill documents all ${names.length} tools`);

  // The reverse direction: a tool name the skill mentions but the server does
  // not register. The skill's first step stops the run when its probe tool is
  // missing, so one stale name there halts every run at setup.
  const mentioned = new Set([...skill.matchAll(/\b(?:mcp__[a-z_]+__)?((?:scout|ft)_[a-z_]+)\b/g)].map((m) => m[1]).filter((n) => !n.endsWith("_")));
  const unknown = [...mentioned].filter((n) => !names.includes(n));
  if (unknown.length > 0) {
    console.error(`MCP CHECK FAILED — the skill refers to tools the server does not register: ${unknown.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ skill names no tool the server lacks`);

  // Tool-NAME coverage is the floor, not the ceiling. A parameter added to an
  // already-documented tool leaves the name present, so the check above stays
  // green while the agent has no idea the parameter exists — which is exactly
  // how scout_type's `value` alias shipped undocumented. Check the parameters too.
  //
  // Deliberately advisory-by-exception: `session` is on nearly every tool and
  // explaining it once is correct, and a handful of params are genuinely
  // internal detail. Everything else must be findable in the skill.
  const PARAM_EXEMPT = new Set(["session", "projectPath", "force", "full"]);
  const paramGaps: string[] = [];
  for (const tool of tools) {
    const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
    for (const param of Object.keys(schema?.properties ?? {})) {
      if (PARAM_EXEMPT.has(param)) continue;
      if (!skill.includes(param)) paramGaps.push(`${tool.name}.${param}`);
    }
  }
  if (paramGaps.length > 0) {
    console.error(
      `MCP CHECK FAILED — the skill never mentions these parameters: ${paramGaps.join(", ")}\n` +
        `A parameter the skill doesn't name is a parameter the agent will never pass. Document it in\n` +
        `skills/scenescout/SKILL.md, or add it to PARAM_EXEMPT in this script if it is genuinely internal.`,
    );
    process.exit(1);
  }
  console.log(`✓ skill documents every non-exempt tool parameter`);

  const result = await client.callTool({ name: "scout_scan", arguments: { projectPath: packageRoot } });
  const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
  if (!text.includes("Project:")) {
    console.error(`MCP CHECK FAILED — scout_scan returned unexpected output:\n${text}`);
    process.exit(1);
  }
  console.log("✓ scout_scan round-trip works");

  await laneCheck(client);
  const liveProject = await liveViewCheck(client);
  await client.close();
  await tokenGoneCheck(liveProject);
  await liveViewOffCheck();
  console.log("\nMCP CHECK PASSED");
}

main().catch((err) => {
  console.error("MCP CHECK CRASHED:", err);
  process.exit(1);
});
